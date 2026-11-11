// Each ticket counts once in the environment hold's row (§ 4.9, § 5 item 11): one ticket failing
// again, as its setup does after each merge (retrySetups), doesn't fill the row alone. A setup that
// fails in a worktree an earlier attempt left commits in isn't counted at all: those commits may be
// what breaks it, so its ticket is set aside (start.ts) rather than put back in the queue.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Layer, Ref } from "effect"
import { line } from "../src/core/log.ts"
import { make as makeHold, type Verdict } from "../src/run/environment.ts"
import type { StopReason } from "../src/run/holds.ts"
import { Ledger } from "../src/run/ledger.ts"
import { type Outcome, run } from "../src/run/run.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { CheckFailed, setupLogName } from "../src/services/Checks.ts"
import { Git, type Sha } from "../src/services/Git.ts"
import { runFolder } from "../src/services/Worktrees.ts"
import { claimsAndCloses } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import {
  backlog,
  type Env,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  scenario,
  type World,
} from "./harness.ts"

const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-row-${name}-`)))

const a = "a" as TicketId
const b = "b" as TicketId
const c = "c" as TicketId

describe("the environment hold's row", () => {
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
          base: "main",
          onHold: (stop) => Ref.update(held, (all) => [...all, stop]),
          setup: Effect.succeed("npm ci"),
        })
        return yield* use(hold, held)
      }).pipe(Effect.provide(Layer.fresh(Ledger.layer))),
    )

  const texts = (ran: Ran<ReadonlyArray<StopReason>>): ReadonlyArray<string> =>
    ran.exit._tag === "Success" ? ran.exit.value.map((stop): string => stop.text) : []

  test("counts a ticket whose setup fails twice once: a second ticket fills it", async () => {
    const ran = await withHold((hold, held) =>
      Effect.gen(function* () {
        yield* hold.settled(a, "setup")
        yield* hold.settled(a, "setup")
        const before = yield* Ref.get(held)
        expect(before).toEqual([])
        yield* hold.settled(b, "setup")
        return yield* Ref.get(held)
      }),
    )
    expect(texts(ran)).toEqual([
      "ENVIRONMENT: the setup 'npm ci' failed in the worktrees of the last 2 tickets (a, b); check the machine, then restart",
    ])
  })

  test("counts a ticket failing at once, then its setup failing, once", async () => {
    const ran = await withHold((hold, held) =>
      Effect.gen(function* () {
        yield* hold.settled(a, "atOnce")
        yield* hold.settled(a, "setup")
        yield* hold.settled(a, "start")
        return yield* Ref.get(held)
      }),
    )
    expect(texts(ran)).toEqual([])
  })

  test("counts triage blaming one ticket twice once", async () => {
    const verdict = (ticket: TicketId): Verdict => ({
      ticket,
      cause: "environment",
      confidence: "high",
      summary: "Classifier unavailable.",
      generation: 0,
    })
    const ran = await withHold((hold, held) =>
      Effect.gen(function* () {
        yield* hold.blamed(verdict(a))
        yield* hold.blamed(verdict(a))
        expect(yield* Ref.get(held)).toEqual([])
        yield* hold.blamed(verdict(c))
        return yield* Ref.get(held)
      }),
    )
    expect(texts(ran)).toEqual([
      "ENVIRONMENT: triage blamed the environment for the last 2 tickets (a, c) with high confidence (Classifier unavailable); check the machine, then restart",
    ])
  })
})

describe("a setup failing in a worktree with commits of its own", () => {
  const setup = "bun install --frozen-lockfile"

  const setupFails = new CheckFailed({
    check: "setup",
    command: setup,
    exitCode: 1,
    outputFile: "/dev/null",
    failingLines: ["error: lockfile had changes, but lockfile is frozen"],
    lastLines: ["error: lockfile had changes, but lockfile is frozen"],
    suites: [],
    suite: null,
    flaky: [],
    flakyCount: 0,
  })

  /** Claims, commits and closes its ticket, as a worker does. */
  const finishes = (world: World, root: string, id: TicketId) =>
    claimsAndCloses(id, {
      claim: Effect.asVoid(Effect.orDie(world.beads.update(id, { claim: true }))),
      commit: Effect.asVoid(
        Effect.orDie(
          world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" }),
        ),
      ),
      close: Effect.asVoid(Effect.orDie(world.beads.close(id, "done"))),
    })

  test("sets its ticket aside, uncounted, and the run goes on", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const defaults = appConfig().settings
    const own = { hash: "1234567890abcdef" as Sha, subject: "Bump (a)", message: "Bump (a)" }
    const ran: Ran<Outcome> = await scenario(
      {
        config: {
          repo,
          settings: {
            ...defaults,
            concurrent: 1,
            checks: {
              ...defaults.checks,
              setup: { ...defaults.checks.setup, command: setup },
            },
          },
        },
        backlog: backlog().ticket("a").ticket("b").ticket("c").seeds,
        git: { dir: repo },
        // a's branch was left by an earlier attempt, with a commit of its own.
        worktrees: { root, branchesLeft: ["a"], earlier: { a: { commits: [own], status: [] } } },
        // a's setup fails; then b's does, in its new worktree, and c's passes.
        checks: { setup: [setupFails, setupFails] },
        scripts: (world) => ({ b: [finishes(world, root, b)], c: [finishes(world, root, c)] }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const id of ["a", "b", "c"]) {
          yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
        }
        return yield* Fiber.join(
          yield* Effect.forkChild(
            run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
          ),
        )
      }),
    )
    // b alone in the row doesn't hold the run: c is taken and merges, then b, set up again.
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Deferred", b: "Done", c: "Done" })
    const output = (id: string) => join(root, id, runFolder, setupLogName)
    expectLog(ran, [
      `  SETUP_FAILED: '${setup}' fails in ${join(root, "a")} for a, whose branch has 1 commit of its own -> deferred without starting a worker; the whole output is in ${output("a")}`,
      `  SETUP_FAILED: '${setup}' fails in ${join(root, "b")} for b; the whole output is in ${output("b")}`,
      /^\[\d+\] c dispatching: c$/,
      "  b: a ticket merged since its setup failed; back in the queue",
    ])
    expect(ran.log.some((text) => text.includes("ENVIRONMENT"))).toBe(false)
    const issue = ran.issues.find((each) => each.id === "a")
    expect(issue?.status).toBe("deferred")
    expect(issue?.notes).toContain(
      `tutti: the setup '${setup}' fails in its worktree, whose branch has 1 commit of its own`,
    )
    expect(issue?.notes).toContain("bd undefer a")
    expect(ran.events.some((record) => record.kind === "reopened")).toBe(false)
  })
})
