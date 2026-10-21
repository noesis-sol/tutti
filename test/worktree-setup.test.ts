// The setup in each new worktree before its worker starts (§ 5 item 6, setup.ts's setUpWorktree), as
// orchestra 0.8.2 to 0.9.0 has it: workers start with their dependencies installed and are told so;
// a setup that fails starts no worker (SETUP_FAILED), its ticket back in the queue, Waiting{setup},
// until a ticket merges or a probe passes; setups failing in a row hold the run for the
// environment; the run's end names the tickets still waiting on one (SETUP_WAITS, held_by.setup,
// SCOPE_OPEN's `its setup failed`); a mark left by a setup cut short has it run again; a merge
// that changes the setup settings has the run use them; and a conflict handed back after a rebase
// that brings in a setup file tells its worker to run the setup.
import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { probeFile, probeWorker } from "../src/run/environment.ts"
import { line } from "../src/run/log.ts"
import { countsUnder, TicketPhase } from "../src/run/phase.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { emptyView } from "../src/run/runView.ts"
import { makeSetUps, setUpWorktree, setupMarkName } from "../src/run/setup.ts"
import { CheckFailed, setupLogName } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { runFolder, writeRunFile } from "../src/services/Worktrees.ts"
import {
  bash,
  result,
  type SessionScript,
  sleep,
  run as step,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type Script as ChecksScript, passed } from "../src/testing/Checks.ts"
import type { Files } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import { totalsLine } from "../src/ui/Totals.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  advance,
  backlog,
  type Env,
  expectEvents,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  type Scripts,
  scenario,
  type World,
} from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-worktree-setup-${name}-`)))

const check = "scripts/check-fast.sh"
const setup = "bun install --frozen-lockfile"
const defaults = appConfig().settings
type Settings = typeof defaults

interface Places {
  readonly repo: string
  readonly root: string
}

/** Claims its ticket, does `first`, commits `files` and closes it, as a worker does. */
const works = (
  world: World,
  places: Places,
  id: string,
  options: { readonly files?: Files; readonly first?: SessionScript } = {},
): SessionScript =>
  turn(
    [
      ...bash(
        `bd update ${id} --claim`,
        Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
      ),
      ...(options.first ?? [sleep(0)]),
      ...bash(
        `git commit -am "Change (${id})"`,
        Effect.asVoid(
          Effect.orDie(
            world.repository.commit(
              join(places.root, id),
              `Change (${id})`,
              options.files ?? { [`${id}.txt`]: `${id}\n` },
            ),
          ),
        ),
      ),
      ...bash(`bd close ${id}`, Effect.asVoid(Effect.orDie(world.beads.close(id, "done")))),
    ],
    result(`Closed ${id}.`),
  )

/** A hand-back turn: the worker resolves its rebase's conflicts, writing `files`. */
const resolves = (world: World, places: Places, id: string, files: Files): SessionScript =>
  turn(
    bash(
      "git add -A && git rebase --continue",
      Effect.asVoid(world.repository.continueRebase(join(places.root, id), files)),
    ),
  )

/** The probe's session running its command, which writes `.tutti/run/probe` in the checkout. */
const probeRuns = (places: Places): SessionScript =>
  turn(
    bash("echo ok > .tutti/run/probe", Effect.orDie(writeRunFile(places.repo, probeFile, "ok\n"))),
  )

/** The setup failing, saying npm's error. */
const setupFails = (command = setup) =>
  new CheckFailed({
    check: "setup",
    command,
    exitCode: 1,
    outputFile: "/dev/null",
    failingLines: ["npm ERR! offline"],
    lastLines: ["npm ERR! offline"],
    suites: [],
    suite: null,
    flaky: [],
    flakyCount: 0,
  })

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}:\n${(yield* texts).join("\n")}`)
  })

/** Waits, in real time, until `id`'s worker has claimed it: the run has dispatched it. */
const untilClaimed = (world: World, id: string) =>
  Effect.orDie(
    Effect.gen(function* () {
      for (let i = 0; i < 2000; i++) {
        if ((yield* world.beads.show(id)).status === "in_progress") return
        yield* Effect.promise(() => Bun.sleep(2))
      }
      throw new Error(`${id} was never claimed`)
    }),
  )

/** Waits, in real time, until main holds `files`: the ticket that wrote them has merged. */
const untilOnMain = (world: World, files: Files) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      const tree = yield* world.repository.tree("main")
      if (Object.entries(files).every(([path, text]) => tree.get(path) === text)) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`main never held ${Object.keys(files).join(", ")}`)
  }).pipe(Effect.orDie)

interface Plan {
  readonly tickets: ReadonlyArray<string>
  /** Each ticket blocked by the one before it, so that it starts once that one has merged. */
  readonly chain?: boolean
  /** Laid over the settings: the defaults with the check `check`, the setup `setup`, 1 worker. */
  readonly settings?: (settings: Settings) => Partial<Settings>
  /** Laid over the run's configuration besides its settings, as --ticket. */
  readonly ticket?: string
  readonly checks?: ChecksScript
  readonly scripts: (world: World, places: Places) => Scripts
  /** Runs before the run starts, its worktrees made in git. */
  readonly before?: (places: Places) => void
  /** Runs beside the run, before it is joined. */
  readonly during?: Effect.Effect<void, unknown, Env>
}

/** A whole run on main, each ticket's worktree made in git first, and where it ran. */
const runs = (plan: Plan): Promise<Ran<Outcome> & Places> => {
  const places = { repo: folder("repo"), root: folder("worktrees") }
  const base: Settings = {
    ...defaults,
    concurrent: 1,
    checks: {
      ...defaults.checks,
      fast: { ...defaults.checks.fast, command: check },
      setup: { ...defaults.checks.setup, command: setup },
    },
  }
  return scenario(
    {
      config: {
        repo: places.repo,
        settings: { ...base, ...plan.settings?.(base) },
        ...(plan.ticket === undefined ? {} : { ticket: plan.ticket }),
      },
      backlog: (plan.chain === true
        ? backlog().chain(...plan.tickets)
        : plan.tickets.reduce((b, id) => b.ticket(id), backlog())
      ).seeds,
      git: { dir: places.repo },
      worktrees: { root: places.root },
      ...(plan.checks === undefined ? {} : { checks: plan.checks }),
      scripts: (world: World) => plan.scripts(world, places),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of plan.tickets) {
        yield* git.addWorktree(places.repo, join(places.root, id), {
          branch: `tutti/${id}`,
          base: "main",
        })
      }
      plan.before?.(places)
      const fiber = yield* Effect.forkChild(
        run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
      )
      if (plan.during !== undefined) yield* plan.during
      return yield* Fiber.join(fiber)
    }),
  ).then((ran) => ({ ...ran, ...places }))
}

/** The phases the ticket moved through, from its `phase` records. */
const pathOf = (ran: Ran<unknown>, id: string): ReadonlyArray<string> =>
  ran.events.flatMap((record) =>
    record.kind === "phase" && record.ticket === id ? [record.to ?? "outside"] : [],
  )

/** The run ended with `code`, with no PHASE_BUG logged and nothing left behind. */
const expectClean = (ran: Ran<Outcome>, code: number) => {
  expectExitCode(ran, code)
  expect(ran.log.filter((text) => text.includes("PHASE_BUG"))).toEqual([])
  expect(ran.leaks).toEqual({ fibers: [], processes: [] })
  expect(ran.events.at(-1)).toMatchObject({ kind: "end", code })
}

/** The client_composed messages the ticket's worker was sent, its first message first. */
const sentTo = (ran: Ran<unknown>, id: string): ReadonlyArray<string> =>
  ran.sent.flatMap((item) =>
    item._tag === "Message" && item.ticket === id && item.message.client_composed === true
      ? [String(item.message.message.content)]
      : [],
  )

/** The worktrees the setup ran in before a worker, by ticket, in order. */
const setUpIn = (ran: Ran<unknown> & Places): ReadonlyArray<string> =>
  ran.checkRuns.flatMap((each) =>
    each.check === "setup" && each.before === "fast" ? [each.cwd.slice(ran.root.length + 1)] : [],
  )

const startsLine = (id: string, what = `running '${setup}' in its new worktree`) =>
  `  ${id}: ${what} before its worker starts`

const note = `This worktree's dependencies are installed with '${setup}'. Run it again only after changing a file it reads, such as a manifest or a lockfile.`

const outputOf = (places: Places, id: string) => join(places.root, id, runFolder, setupLogName)

const markOf = (places: Places, id: string) => join(places.root, id, runFolder, setupMarkName)

const failedLine = (places: Places, id: string) =>
  `  SETUP_FAILED: '${setup}' fails in ${join(places.root, id)} for ${id}; the whole output is in ${outputOf(places, id)}`

describe("the setup before a worker", () => {
  test("runs in a new worktree before its worker starts, which is told so", async () => {
    let marked: boolean | undefined
    const ran = await runs({
      tickets: ["a"],
      scripts: (world, places) => ({
        a: [
          works(world, places, "a", {
            first: [step(Effect.sync(() => (marked = existsSync(markOf(places, "a")))))],
          }),
        ],
      }),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done" })
    expectLog(ran, ["[1/40] a dispatching: a", startsLine("a"), /^ {2}a closed /])
    expect(setUpIn(ran)).toEqual(["a"])
    expect(ran.checkRuns[0]).toMatchObject({ check: "setup", command: setup, before: "fast" })
    expect(sentTo(ran, "a")[0]).toContain(note)
    // The mark of the setup under way was gone once it worked.
    expect(marked).toBe(false)
  })

  test("without a setup, nothing runs and the worker is told nothing of one", async () => {
    const ran = await runs({
      tickets: ["a"],
      settings: (settings) => ({
        checks: { ...settings.checks, setup: { ...settings.checks.setup, command: null } },
      }),
      scripts: (world, places) => ({ a: [works(world, places, "a")] }),
    })
    expectClean(ran, 0)
    expect(ran.checkRuns.filter((each) => each.check === "setup")).toEqual([])
    expect(sentTo(ran, "a")[0]).not.toContain("dependencies are installed")
  })

  test("a worktree left with no setup mark and nothing changed isn't set up again", async () => {
    const ran = await runs({
      tickets: ["a"],
      before: (places) => mkdirSync(join(places.root, "a"), { recursive: true }),
      scripts: (world, places) => ({ a: [works(world, places, "a")] }),
    })
    expectClean(ran, 0)
    expect(setUpIn(ran)).toEqual([])
    expect(ran.log.some((text) => text.includes("before its worker starts"))).toBe(false)
  })

  test("a worktree whose last setup didn't finish is set up again (orchestra-pwnf)", async () => {
    let marked: boolean | undefined
    const ran = await runs({
      tickets: ["a"],
      before: (places) => {
        mkdirSync(join(places.root, "a", runFolder), { recursive: true })
        writeFileSync(markOf(places, "a"), "")
      },
      scripts: (world, places) => ({
        a: [
          works(world, places, "a", {
            first: [step(Effect.sync(() => (marked = existsSync(markOf(places, "a")))))],
          }),
        ],
      }),
    })
    expectClean(ran, 0)
    expectLog(ran, [
      startsLine(
        "a",
        `the last setup in its worktree didn't finish; running '${setup}' there again`,
      ),
    ])
    expect(setUpIn(ran)).toEqual(["a"])
    expect(marked).toBe(false)
  })

  test("a setup cut short leaves its mark for the next run; one that fails says so", async () => {
    const root = folder("cut")
    const path = join(root, "a")
    mkdirSync(path, { recursive: true })
    const worktree = {
      id: "a",
      branch: "tutti/a",
      path,
      reused: false,
      fresh: true,
      earlier: { commits: [], status: [] },
    }
    const settings = {
      ...defaults,
      checks: { ...defaults.checks, setup: { ...defaults.checks.setup, command: setup } },
    }
    await scenario(
      // The first setup never ends, and is interrupted; the second fails.
      { config: { settings }, checks: { setup: [Effect.never, setupFails()] } },
      Effect.gen(function* () {
        const setUps = yield* makeSetUps
        const fiber = yield* Effect.forkChild(setUpWorktree(worktree, setUps, root))
        yield* Effect.promise(() => Bun.sleep(20))
        yield* Fiber.interrupt(fiber)
        expect(readFileSync(join(path, runFolder, setupMarkName), "utf8")).toBe("")
        const failed = yield* setUpWorktree(worktree, setUps, root)
        expect(failed).toMatchObject({ _tag: "Failed", command: setup })
        expect(readFileSync(join(path, runFolder, setupMarkName), "utf8")).toBe("failed")
        // Taken up again, not new, its last setup failed: it runs again, and works.
        const again = yield* setUpWorktree({ ...worktree, fresh: false }, setUps, root)
        expect(again).toEqual({ _tag: "Passed" })
        expect(existsSync(join(path, runFolder, setupMarkName))).toBe(false)
        expect(yield* texts).toContain(
          startsLine("a", `the last setup in its worktree failed; running '${setup}' there again`),
        )
      }),
    )
  })
})

describe("a setup that fails before a worker", () => {
  test("starts no worker, puts the ticket back until a merge, then sets it up again", async () => {
    const ran = await runs({
      tickets: ["a", "b"],
      checks: { setup: [setupFails()] },
      scripts: (world, places) => ({
        a: [works(world, places, "a")],
        b: [works(world, places, "b")],
      }),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done" })
    expect(pathOf(ran, "a")).toEqual([
      "Queued",
      "Working",
      "Waiting",
      "Queued",
      "Working",
      "ToMerge",
      "Merging",
      "Done",
    ])
    expectLog(ran, [
      "[1/40] a dispatching: a",
      startsLine("a"),
      failedLine(ran, "a"),
      "[1/40] b dispatching: b",
      /^ {2}b closed /,
      "  a: a ticket merged since its setup failed; back in the queue",
      "[2/40] a dispatching: a",
      startsLine("a", `the last setup in its worktree failed; running '${setup}' there again`),
      /^ {2}a closed /,
      "READY_EMPTY after 2 tickets",
    ])
    expect(setUpIn(ran)).toEqual(["a", "b", "a"])
    expect(ran.events.find((r) => r.kind === "warn")).toMatchObject({
      ticket: "a",
      detail: "setup failed",
      text: failedLine(ran, "a"),
    })
    // It wasn't set aside: no deferral, and its notes say what happened.
    expect(ran.events.some((r) => r.kind === "deferred")).toBe(false)
    expect(ran.issues.find((issue) => issue.id === "a")?.notes).toContain(
      `tutti: the setup '${setup}' fails in worktree ${join(ran.root, "a")}, so no worker was started; back in the queue`,
    )
    // a's worker started once, after its setup worked.
    expect(sentTo(ran, "a")).toHaveLength(1)
  })

  test("the run's end names the tickets still waiting on it, and the queue counts them", async () => {
    const ran = await runs({
      tickets: ["a", "b"],
      // a's setup fails each time; b's works.
      checks: { setup: [setupFails(), passed("setup"), setupFails()] },
      scripts: (world, places) => ({ b: [works(world, places, "b")] }),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Waiting", b: "Done" })
    const end = `READY_EMPTY after 1 tickets; SETUP_WAITS: a waits on the setup that failed in its worktree (the whole output is in ${outputOf(ran, "a")}); fix the setup, then run again`
    expectLog(ran, [failedLine(ran, "a"), /^ {2}b closed /, failedLine(ran, "a"), end])
    expect(ran.events.find((r) => r.kind === "done")).toMatchObject({ text: end })
    // b was dispatched with a held back for its setup.
    expect(ran.events.find((r) => r.kind === "dispatch" && r.ticket === "b")).toMatchObject({
      queued: 0,
      held: 1,
      held_by: { setup: 1 },
    })
    expect(ran.issues.find((issue) => issue.id === "a")?.status).toBe("open")
  })

  test("a scoped run says its ticket waits on a failed setup", async () => {
    const ran = await runs({
      tickets: ["a"],
      ticket: "a",
      checks: { setup: [setupFails()] },
      scripts: () => ({}),
    })
    expectClean(ran, 0)
    const output = outputOf(ran, "a")
    expectLog(ran, [
      `READY_EMPTY after 0 tickets; SETUP_WAITS: a waits on the setup that failed in its worktree (the whole output is in ${output}); fix the setup, then run again; SCOPE_OPEN: a: its 0 subtickets are merged, but a itself is not done (its setup failed; the whole output is in ${output})`,
    ])
  })

  test("setups failing in a row hold the run; the probe passing takes them again", async () => {
    const ran = await runs({
      tickets: ["a", "b", "c"],
      checks: { setup: [setupFails(), setupFails()] },
      scripts: (world, places) => ({
        a: [works(world, places, "a")],
        b: [works(world, places, "b")],
        c: [works(world, places, "c")],
        [probeWorker]: [probeRuns(places)],
      }),
      during: Effect.gen(function* () {
        yield* untilLogged(/^PROBE: /)
        yield* advance("10 minutes")
      }),
    })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done", c: "Done" })
    expectLog(ran, [
      failedLine(ran, "a"),
      failedLine(ran, "b"),
      /^PROBE: /,
      /^PROBE_OK: /,
      "  a: the probe passed; back in the queue",
      "  b: the probe passed; back in the queue",
      /^ {2}a closed /,
      /^ {2}b closed /,
      /^ {2}c closed /,
    ])
    // Back in the queue already, they were never reopened.
    expect(ran.events.some((r) => r.kind === "reopened")).toBe(false)
    expect(ran.log.some((text) => text.includes("c dispatching"))).toBe(true)
    expectEvents(ran, ["warn", "warn", "hold", "probed", "closed", "closed", "closed", "end"])
  })
})

describe("the hold for setups failing", () => {
  const probing = Effect.gen(function* () {
    yield* untilLogged(/^PROBE: /)
    yield* advance("10 minutes")
  })

  test("says the setup failed in their worktrees, and ends ENVIRONMENT if the probe fails", async () => {
    const ran = await runs({
      tickets: ["a", "b", "c"],
      checks: { setup: [setupFails(), setupFails()] },
      scripts: () => ({ [probeWorker]: [turn([])] }),
      during: probing,
    })
    expectClean(ran, 7)
    expectPhases(ran, { a: "Waiting", b: "Waiting", c: "Queued" })
    expectLog(ran, [
      `ENVIRONMENT: the setup '${setup}' failed in the worktrees of the last 2 tickets (a, b); a session probing the machine 10m later failed too: it stopped without running its command; check the machine, then restart`,
    ])
    expect(ran.events.some((r) => r.kind === "reopened")).toBe(false)
  })

  test("a worker failing at once and a setup failing after it are one row", async () => {
    const ran = await runs({
      tickets: ["a", "b", "c"],
      // a's setup works and its worker fails at once; b's setup fails.
      checks: { setup: [passed("setup"), setupFails()] },
      scripts: () => ({
        a: [turn([], result("Every command was refused."))],
        [probeWorker]: [turn([])],
      }),
      during: probing,
    })
    expectClean(ran, 7)
    expectPhases(ran, { a: "Waiting", b: "Waiting", c: "Queued" })
    expectLog(ran, [
      "  a reopened: its worker failed at once, like the tickets before it",
      `ENVIRONMENT: the last 2 tickets (a, b) each failed at once: the setup '${setup}' failed in their worktree, or their worker settled within 2m of starting without being claimed or changed; a session probing the machine 10m later failed too: it stopped without running its command; check the machine, then restart`,
    ])
    // Only a, whose worker failed, was reopened; b was back in the queue already.
    expect(ran.events.flatMap((r) => (r.kind === "reopened" ? [r.ticket] : []))).toEqual(["a"])
  })
})

describe("the setup settings a merge changes", () => {
  const settingsFile = ".tutti/settings.json"

  test("are the run's from then on: the next new worktree is set up with them", async () => {
    const ran = await runs({
      tickets: ["a", "b"],
      chain: true,
      settings: (settings) => ({
        checks: { ...settings.checks, setup: { ...settings.checks.setup, command: null } },
      }),
      scripts: (world, places) => ({
        a: [
          works(world, places, "a", {
            files: { [settingsFile]: JSON.stringify({ checks: { setup: { command: "npm ci" } } }) },
          }),
        ],
        b: [works(world, places, "b")],
      }),
    })
    expectClean(ran, 0)
    expectLog(ran, [
      /^ {2}a closed /,
      `  SETUP: a's merge changed ${settingsFile} on main: the setup is 'npm ci' from now on`,
      "  b: running 'npm ci' in its new worktree before its worker starts",
      /^ {2}b closed /,
    ])
    expect(ran.checkRuns.filter((each) => each.check === "setup")).toEqual([
      expect.objectContaining({ command: "npm ci", cwd: join(ran.root, "b") }),
    ])
    expect(sentTo(ran, "b")[0]).toContain(
      "This worktree's dependencies are installed with 'npm ci'.",
    )
  })

  test("that can't be read are warned of, and the setup stays as it was", async () => {
    const ran = await runs({
      tickets: ["a", "b"],
      chain: true,
      scripts: (world, places) => ({
        a: [works(world, places, "a", { files: { [settingsFile]: "{ not json" } })],
        b: [works(world, places, "b")],
      }),
    })
    expectClean(ran, 0)
    expectLog(ran, [
      /^ {2}a closed /,
      new RegExp(
        `^ {2}SETTINGS_UNREAD: a's merge changed \\.tutti/settings\\.json on main, but it could not be read: it isn't valid JSON: .*; the setup stays '${setup}'$`,
      ),
      startsLine("b"),
    ])
  })
})

describe("a conflict handed back", () => {
  /** a lands first, writing `aFiles`; b, dispatched beside it, then conflicts with it. */
  const conflict = (aFiles: Files) =>
    runs({
      tickets: ["a", "b"],
      settings: () => ({ concurrent: 2 }),
      scripts: (world, places) => ({
        a: [works(world, places, "a", { files: aFiles, first: [step(untilClaimed(world, "b"))] })],
        b: [
          [
            ...works(world, places, "b", {
              files: { "shared.txt": "b\n" },
              first: [step(untilOnMain(world, aFiles))],
            }),
            ...resolves(world, places, "b", { "shared.txt": "a and b\n" }),
          ],
        ],
      }),
    })

  test("after a rebase that brings in a lockfile tells its worker to run the setup", async () => {
    const ran = await conflict({ "shared.txt": "a\n", "bun.lock": "left-pad 2\n" })
    expectClean(ran, 0)
    expectPhases(ran, { a: "Done", b: "Done" })
    const why = "the rebase brings in a change to bun.lock, which the project's setup reads"
    expectLog(ran, [
      `  RESOLVING: tutti/b conflicts with main in shared.txt; handed back to its worker to resolve (up to 20m); told to run '${setup}' once the rebase has finished, as ${why}`,
    ])
    expect(sentTo(ran, "b")[1]).toContain(
      `As ${why}, once the rebase has finished run the setup, '${setup}', in the foreground before the check`,
    )
  })

  test("after a rebase that brings in no file the setup reads says nothing of it", async () => {
    const ran = await conflict({ "shared.txt": "a\n" })
    expectClean(ran, 0)
    expectLog(ran, [
      "  RESOLVING: tutti/b conflicts with main in shared.txt; handed back to its worker to resolve (up to 20m)",
    ])
    expect(sentTo(ran, "b")[1]).not.toContain("run the setup")
  })
})

describe("the dashboard", () => {
  test("counts a ticket whose setup failed apart in In queue", () => {
    expect(countsUnder(TicketPhase.Waiting({ for: "setup" }))).toEqual(["setupFailed"])
    expect(countsUnder(TicketPhase.Waiting({ for: "probe" }))).toEqual([])
    expect(countsUnder(TicketPhase.Waiting({ for: "tut-b1" }))).toEqual([])
    const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })
    const totals = { ...emptyView.totals, slots: 2, queued: 1, unclosed: 3, setupFailed: 1 }
    const segments = totalsLine(totals, theme, 80)
    expect(segments.map((each) => each.text).join("")).toContain("queue 1 of 3 · 1 setup failed")
    expect(segments.find((each) => each.text === " · 1 setup failed")?.look).toBe(
      theme.styles.deferred,
    )
  })
})
