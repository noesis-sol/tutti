import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber, Layer, Ref } from "effect"
import { noServers } from "../src/agent/mcp.ts"
import { workerOptions } from "../src/agent/options.ts"
import { AppConfig } from "../src/cli/AppConfig.ts"
import {
  make as makeHold,
  probeFile,
  probeLimit,
  probeWorker,
  type Verdict,
} from "../src/run/environment.ts"
import type { StopReason } from "../src/run/holds.ts"
import { Ledger } from "../src/run/ledger.ts"
import { line } from "../src/run/log.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { emptyStatus, emptyView, project } from "../src/run/runView.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { runFolder, writeRunFile } from "../src/services/Worktrees.ts"
import {
  bash,
  claimsAndCloses,
  gone,
  hitsUsageLimit,
  result,
  type SessionScript,
  sleep,
  turn,
  wait,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  type Env,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-env-${name}-`)))

/** A worker its environment fails: it ends its turn at once, without claiming or changing anything. */
const givesUp: SessionScript = turn([], result("Every command was refused."))

/** Claims, commits and closes its ticket, as a worker does. */
const finishes = (world: World, root: string, id: TicketId): SessionScript =>
  claimsAndCloses(id, {
    claim: Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
    commit: Effect.asVoid(
      Effect.orDie(
        world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
      ),
    ),
    close: Effect.asVoid(Effect.orDie(world.beads.close(id, "done"))),
  })

/** The probe's session running its command, which writes `.tutti/run/probe` in `repo`. */
const probeRuns = (repo: string): SessionScript =>
  turn(bash("echo ok > .tutti/run/probe", Effect.orDie(writeRunFile(repo, probeFile, "ok\n"))))

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}`)
  })

interface Plan {
  readonly tickets: ReadonlyArray<string>
  readonly settings?: Partial<ReturnType<typeof appConfig>["settings"]>
  readonly scripts: (world: World, root: string, repo: string) => Scripts
  /** Runs beside the run, before it is joined. */
  readonly during?: (repo: string) => Effect.Effect<void, unknown, Env>
}

/** A whole run on main, one ticket at a time, each ticket's worktree made in git first. */
const runs = (plan: Plan): Promise<Ran<Outcome> & { readonly repo: string }> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  const settings = { ...appConfig().settings, concurrent: 1, ...plan.settings }
  return scenario(
    {
      config: { repo, settings },
      backlog: plan.tickets.reduce((b, id) => b.ticket(id), backlog()).seeds,
      git: { dir: repo },
      worktrees: { root },
      scripts: (world: World) => plan.scripts(world, root, repo),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of plan.tickets) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
      )
      if (plan.during !== undefined) yield* plan.during(repo)
      return yield* Fiber.join(fiber)
    }),
  ).then((ran) => ({ ...ran, repo }))
}

/** Waits for the PROBE line, then moves the clock on to the probe. */
const toTheProbe = () =>
  Effect.gen(function* () {
    yield* untilLogged(/^PROBE: /)
    yield* advance("10 minutes")
  })

const holdLine =
  "ENVIRONMENT: the last 2 tickets (t-1, t-2) each settled within 2m of starting without being claimed or changed; check the machine, then restart"

describe("the environment hold", () => {
  test("two quick failures hold the run, reopen the tickets, and PROBE_OK takes them again", async () => {
    const ran = await runs({
      tickets: ["t-1", "t-2", "t-3"],
      scripts: (world, root, repo) => ({
        "t-1": [givesUp, finishes(world, root, "t-1" as TicketId)],
        "t-2": [givesUp, finishes(world, root, "t-2" as TicketId)],
        "t-3": [finishes(world, root, "t-3" as TicketId)],
        [probeWorker]: [probeRuns(repo)],
      }),
      during: toTheProbe,
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done", "t-3": "Done" })
    expectLog(ran, [
      "[1] t-1 dispatching: t-1",
      "[2] t-2 dispatching: t-2",
      "  t-1 reopened: its worker failed at once, like the tickets before it",
      "  t-2 reopened: its worker failed at once, like the tickets before it",
      /^PROBE: the run holds for the environment; in 10m a session without a ticket runs a command/,
      `  probe session started in ${ran.repo}`,
      "PROBE_OK: a session without a ticket ran a command 10m after the hold; taking tickets again",
      "  t-1: the probe passed; back in the queue",
      "  t-2: the probe passed; back in the queue",
      /^READY_EMPTY after \d+ tickets$/,
    ])
    // t-3 started only once the probe had passed.
    const lines = ran.log
    expect(lines.findIndex((l) => l.includes("t-3 dispatching"))).toBeGreaterThan(
      lines.findIndex((l) => l.startsWith("PROBE_OK")),
    )
    const kinds = ran.events.map((record) => record.kind)
    expect(kinds.filter((kind) => kind === "reopened")).toHaveLength(2)
    expect(kinds).toContain("probed")
    // The probe ran in the main checkout, with no ticket, and was told to write its file.
    const probeStart = ran.sent.find(
      (sent) => sent._tag === "Started" && sent.ticket === probeWorker,
    )
    expect(probeStart).toMatchObject({ session: { cwd: ran.repo, kind: { _tag: "Probe" } } })
    expect(readFileSync(join(ran.repo, runFolder, probeFile), "utf8")).toBe("ok\n")
    for (const id of ["t-1", "t-2"]) {
      const issue = ran.issues.find((each) => each.id === id)
      expect(issue?.notes).toContain("tutti: reopened; its worker failed at once")
    }
  })

  test("a probe that runs no command ends the run ENVIRONMENT, exit 7, the tickets reopened", async () => {
    const ran = await runs({
      tickets: ["t-1", "t-2", "t-3"],
      scripts: (_world, _root) => ({
        "t-1": [givesUp],
        "t-2": [givesUp],
        [probeWorker]: [turn([])],
      }),
      during: toTheProbe,
    })
    expectExitCode(ran, 7)
    // t-3 never started; the reopened tickets wait, open in bd, for the next run.
    expectPhases(ran, { "t-1": "Waiting", "t-2": "Waiting", "t-3": "Queued" })
    expectLog(ran, [
      /^PROBE: /,
      `${holdLine.replace("; check the machine, then restart", "")}; a session probing the machine 10m later failed too: it stopped without running its command; check the machine, then restart`,
    ])
    expect(ran.log.some((l) => l.includes("t-3 dispatching"))).toBe(false)
    for (const id of ["t-1", "t-2"]) {
      expect(ran.issues.find((each) => each.id === id)?.status).toBe("open")
    }
    expect(ran.events.find((record) => record.kind === "end")).toMatchObject({ code: 7 })
  })

  test("a probe with no result within its limit fails too", async () => {
    const ran = await runs({
      tickets: ["t-1", "t-2"],
      scripts: () => ({
        "t-1": [givesUp],
        "t-2": [givesUp],
        [probeWorker]: [[]],
      }),
      during: () =>
        Effect.gen(function* () {
          yield* toTheProbe()
          yield* untilLogged(/probe session started/)
          yield* advance(probeLimit)
        }),
    })
    expectExitCode(ran, 7)
    expectLog(ran, [/later failed too: it ran no command within 5m; check the machine/])
  })

  test("with environment_hold.probe 0 the run ends ENVIRONMENT without probing", async () => {
    const ran = await runs({
      tickets: ["t-1", "t-2"],
      settings: {
        environment_hold: { ...appConfig().settings.environment_hold, probe: Duration.zero },
      },
      scripts: () => ({ "t-1": [givesUp], "t-2": [givesUp] }),
    })
    expectExitCode(ran, 7)
    expectLog(ran, [holdLine])
    expect(ran.log.some((l) => l.startsWith("PROBE"))).toBe(false)
  })

  test("one quick failure, then a ticket done, holds nothing", async () => {
    const ran = await runs({
      tickets: ["t-1", "t-2", "t-3"],
      scripts: (world, root) => ({
        "t-1": [givesUp],
        "t-2": [finishes(world, root, "t-2" as TicketId)],
        "t-3": [givesUp],
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Deferred", "t-2": "Done", "t-3": "Deferred" })
    expect(ran.log.some((l) => l.includes("ENVIRONMENT"))).toBe(false)
  })

  test("a worker failing after the window doesn't count", async () => {
    const late: SessionScript = turn([sleep("3 minutes")])
    const ran = await runs({
      tickets: ["t-1", "t-2"],
      scripts: () => ({ "t-1": [late], "t-2": [late] }),
      during: () =>
        Effect.gen(function* () {
          for (let i = 0; i < 2; i++) {
            for (let j = 0; j < 200; j++) yield* Effect.yieldNow
            yield* Effect.promise(() => Bun.sleep(20))
            yield* advance("3 minutes")
          }
        }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Deferred", "t-2": "Deferred" })
  })

  test("a usage-limited worker doesn't count", async () => {
    // The limit resets 30s into the run (TestClock starts at the epoch), and the hold lifts a minute
    // after: t-1's session ends once the lifted hold tells it to carry on, within the window of its
    // dispatch, its ticket open and nothing done. Counted, it would make two in a row with t-2.
    // Still UsageLimited as the run watches it for the limit, not gone before, as one ending on
    // real time could be under load.
    const limited: SessionScript = [...hitsUsageLimit(30), wait, gone("its session ended")]
    const ran = await runs({
      tickets: ["t-1", "t-2", "t-3"],
      // Without the probe, a hold would end the run at once, ENVIRONMENT.
      settings: {
        environment_hold: { ...appConfig().settings.environment_hold, probe: Duration.zero },
      },
      scripts: (world, root) => ({
        "t-1": [limited],
        "t-2": [givesUp],
        "t-3": [finishes(world, root, "t-3" as TicketId)],
      }),
      during: () =>
        Effect.andThen(untilLogged(/^USAGE_LIMIT: nothing else runs/), advance("100 seconds")),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Deferred", "t-2": "Deferred", "t-3": "Done" })
    expect(ran.log.some((l) => l.includes("ENVIRONMENT"))).toBe(false)
  })
})

describe("triage's blame", () => {
  /** The hold, in the test layers, and the stops it held the run with. */
  const withHold = <A>(
    use: (
      hold: Effect.Success<ReturnType<typeof makeHold>>,
      held: Ref.Ref<ReadonlyArray<StopReason>>,
    ) => Effect.Effect<A, never, Env | Ledger>,
  ) =>
    scenario(
      {},
      Effect.gen(function* () {
        const held = yield* Ref.make<ReadonlyArray<StopReason>>([])
        const hold = yield* makeHold({
          onHold: (stop) => Ref.update(held, (all) => [...all, stop]),
        })
        return yield* use(hold, held)
      }).pipe(Effect.provide(Layer.fresh(Ledger.layer))),
    )

  const verdict = (ticket: TicketId, fields: Partial<Verdict> = {}): Verdict => ({
    ticket,
    cause: "environment",
    confidence: "high",
    summary: "Classifier unavailable.",
    generation: 0,
    ...fields,
  })

  test("two verdicts in a row blaming the environment with high confidence hold the run", async () => {
    const ran = await withHold((hold, held) =>
      Effect.gen(function* () {
        yield* hold.blamed(verdict("a" as TicketId))
        yield* hold.blamed(verdict("b" as TicketId))
        return yield* Ref.get(held)
      }),
    )
    const stops = ran.exit._tag === "Success" ? ran.exit.value : []
    expect(stops.map((stop): string => stop.text)).toEqual([
      "ENVIRONMENT: triage blamed the environment for the last 2 tickets (a, b) with high confidence (Classifier unavailable); check the machine, then restart",
    ])
    expect(stops[0]?.code).toBe(7)
  })

  test("another verdict ends the row, and one from before a probe counts for nothing", async () => {
    const ran = await withHold((hold, held) =>
      Effect.gen(function* () {
        yield* hold.blamed(verdict("a" as TicketId))
        yield* hold.blamed(verdict("b" as TicketId, { cause: "ticket" }))
        yield* hold.blamed(verdict("c" as TicketId, { confidence: "medium" }))
        yield* hold.blamed(verdict("d" as TicketId))
        yield* hold.blamed(verdict("e" as TicketId, { generation: 1 }))
        return { stops: yield* Ref.get(held), generation: yield* hold.generation }
      }),
    )
    const seen = ran.exit._tag === "Success" ? ran.exit.value : undefined
    expect(seen).toEqual({ stops: [], generation: 0 })
  })

  test("off with environment_hold.count 0", async () => {
    const ran = await withHold((hold, held) =>
      Effect.gen(function* () {
        const config = yield* AppConfig
        const off = yield* makeHold({
          onHold: (stop) => Ref.update(held, (all) => [...all, stop]),
        }).pipe(
          Effect.provideService(AppConfig, {
            ...config,
            settings: {
              ...config.settings,
              environment_hold: { ...config.settings.environment_hold, count: 0 },
            },
          }),
        )
        void hold
        yield* off.blamed(verdict("a" as TicketId))
        yield* off.blamed(verdict("b" as TicketId))
        yield* off.settled("c" as TicketId, "atOnce")
        yield* off.settled("d" as TicketId, "atOnce")
        return yield* Ref.get(held)
      }),
    )
    expect(ran.exit._tag === "Success" ? ran.exit.value : undefined).toEqual([])
  })
})

describe("the probe's session", () => {
  test("has no MCP servers and no worker prompt", () => {
    const config = appConfig()
    const options = workerOptions({
      config,
      ticket: probeWorker,
      worktree: config.repo,
      prompt: null,
      servers: noServers,
      skills: false,
      callbacks: {
        canUseTool: async () => ({ behavior: "deny", message: "" }),
        onElicitation: async () => ({ action: "decline" }),
        hooks: {},
        stderr: () => {},
      },
      session: { _tag: "New", sessionId: "s" } as never,
    })
    expect(options.mcpServers).toEqual({})
    expect(options.systemPrompt).toEqual({ type: "preset", preset: "claude_code", snapshot: true })
  })

  test("shows as a card labelled probe while it runs", () => {
    const view = project(
      {
        ledger: { tickets: new Map(), rows: 0, windDown: null, bugs: [] },
        workers: new Map(),
        requests: [],
        status: { ...emptyStatus, probe: { since: 5 } },
      },
      emptyView,
    )
    expect(view.cards).toEqual([
      expect.objectContaining({ ticket: "probe", title: "probe", worker: 0, since: 5 }),
    ])
  })
})
