import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Ref, Scope, Stream } from "effect"
import { AppConfig } from "../src/cli/AppConfig.ts"
import type { EventRecord } from "../src/run/events.ts"
import { Ledger, type State } from "../src/run/ledger.ts"
import {
  type FinishedTicket,
  gitAgainAfter,
  gitTries,
  type MergeStop,
  maxPasses,
} from "../src/run/merge.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import { Cause, type PhaseTag, type TicketPhase } from "../src/run/phase.ts"
import { Beads } from "../src/services/Beads.ts"
import { CheckFailed, Checks, CheckTimedOut } from "../src/services/Checks.ts"
import { ProcessGroups } from "../src/services/exec.ts"
import { Git } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { passed, type Scripted } from "../src/testing/Checks.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { advance, backlog, type Env, expectLog, type Ran, type Setup, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main" }

/** What a merge scenario hands back: each ticket's phase, and the queue's stop. */
interface Merged {
  readonly phases: Readonly<Record<string, TicketPhase>>
  readonly stop: MergeStop | null
}

const tags = (merged: Merged): Record<string, PhaseTag> =>
  Object.fromEntries(Object.entries(merged.phases).map(([id, phase]) => [id, phase._tag]))

/** The scenario's value, or a test failure saying why it gave none. */
const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

const phasesOf = (state: State): Record<string, TicketPhase> =>
  Object.fromEntries([...state.tickets.values()].map((entry) => [entry.ticket, entry.phase]))

/** Waits until the ledger's state satisfies `ready`. */
const until = (ready: (state: State) => boolean) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    yield* ledger.changes.pipe(Stream.filter(ready), Stream.runHead)
  })

const phaseOf = (state: State, id: string) => state.tickets.get(id)?.phase

/**
 * A ticket its worker finished: its worktree on tutti/<id> with a commit naming it, closed in Beads,
 * Working in the ledger.
 */
const finished = (id: string, files: Files) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const worktree = yield* (yield* Worktrees).prepare(id)
    yield* git.addWorktree(repository.dir, worktree.path, { branch: worktree.branch, base: "main" })
    yield* repository.commit(worktree.path, `Do ${id} (${id})`, files)
    yield* (yield* Beads).close(id, "done")
    const ledger = yield* Ledger
    yield* ledger.transition(id, Cause.Ready(), { title: `Ticket ${id}` })
    yield* ledger.transition(id, Cause.Dispatched())
    return {
      id,
      title: `Ticket ${id}`,
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

/** Another ticket's merge, landing on main while the tickets ran. */
const moveMain = (files: Files = { "main.txt": "moved\n" }) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    yield* repository.commit(repository.dir, "Land something else", files)
  })

/**
 * Runs `body` with a merge queue in a scope of its own, which it closes as body ends, and hands
 * back each ticket's phase and the queue's stop.
 */
const withQueue = <E>(
  body: (queue: MergeQueue) => Effect.Effect<void, E, Env | Ledger | Scope.Scope>,
  around: (
    queue: Effect.Effect<MergeQueue, never, Env | Ledger | Scope.Scope>,
  ) => Effect.Effect<MergeQueue, never, Env | Ledger | Scope.Scope> = (queue) => queue,
) =>
  Effect.gen(function* () {
    const queue = yield* around(makeQueue(options))
    yield* body(queue)
    const state = yield* queue.state
    return {
      phases: phasesOf(yield* (yield* Ledger).current),
      stop: state.stop,
    } satisfies Merged
  }).pipe(Effect.provide(Ledger.layer))

/** Merges the tickets each `make` finishes, offered in that order, until the queue settles. */
const mergeAll = (
  setup: Setup,
  make: ReadonlyArray<Effect.Effect<FinishedTicket, unknown, Env | Ledger>>,
  before: Effect.Effect<void, unknown, Env | Ledger> = Effect.void,
) =>
  scenario(
    setup,
    withQueue((queue) =>
      Effect.gen(function* () {
        const tickets = yield* Effect.all(make)
        yield* before
        for (const ticket of tickets) yield* queue.offer(ticket)
        yield* queue.settled
      }),
    ),
  )

const records = (ran: Ran<unknown>, kind: EventRecord["kind"]) =>
  ran.events.filter((record) => record.kind === kind)

const failedCheck = new CheckFailed({
  check: "fast",
  command: "scripts/check-fast.sh",
  exitCode: 1,
  outputFile: "/dev/fd/9",
  failingLines: ["error: a.test.ts: expected 1"],
  lastLines: ["error: a.test.ts: expected 1", "1 fail"],
  suites: [],
  suite: null,
  flaky: [],
  flakyCount: 0,
})

describe("a clean merge", () => {
  test("a ticket on top of the base fast-forwards it, unchecked, and is cleaned up", async () => {
    const ran = await mergeAll({ backlog: backlog().ticket("a").seeds }, [
      finished("a", { "a.txt": "a\n" }),
    ])
    const merged = resultOf(ran)
    expect(tags(merged)).toEqual({ a: "Done" })
    expect(merged.stop).toBeNull()
    const done = merged.phases.a
    expect(done?._tag === "Done" && done.outcome._tag === "Merged").toBe(true)
    expect(ran.checkRuns).toEqual([])
    expect(ran.worktreeCalls.filter((call) => call.op === "remove")).toEqual([
      { op: "remove", id: "a", force: false },
    ])
    expectLog(ran, [
      /^ {2}a closed \([0-9a-f]{7} Do a \(a\)\); merged into main, worktree and branch removed$/,
    ])
    expect(
      records(ran, "phase").map((record) => record.kind === "phase" && `${record.to}`),
    ).toEqual(["Queued", "Working", "ToMerge", "Merging", "Done"])
    const closed = records(ran, "closed")[0]
    expect(closed).toMatchObject({ ticket: "a", title: "Ticket a" })
    expect(closed?.kind === "closed" && closed.detail).toMatch(/^[0-9a-f]{7} merged into main$/)
  })

  test("main has the ticket's commit, and the Done phase names it", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds },
      withQueue((queue) =>
        Effect.gen(function* () {
          const ticket = yield* finished("a", { "a.txt": "a\n" })
          const tip = yield* (yield* Repository).head(ticket.branch)
          yield* queue.offer(ticket)
          yield* queue.settled
          expect(yield* (yield* Repository).head("main")).toBe(tip)
          expect((yield* (yield* Repository).tree("main")).get("a.txt")).toBe("a\n")
          const phase = phaseOf(yield* (yield* Ledger).current, "a")
          expect(phase).toEqual(
            expect.objectContaining({ outcome: expect.objectContaining({ commit: tip }) }),
          )
        }),
      ),
    )
    resultOf(ran)
  })

  test("a ticket behind the base is rebased and checked, its check.log in its worktree", async () => {
    const ran = await mergeAll(
      { backlog: backlog().ticket("a").seeds },
      [finished("a", { "a.txt": "a\n" })],
      moveMain(),
    )
    expect(tags(resultOf(ran))).toEqual({ a: "Done" })
    expect(ran.checkRuns).toHaveLength(1)
    const run = ran.checkRuns[0]
    expect(run?.check).toBe("fast")
    expect(run?.cwd).toEqual(expect.stringMatching(/\/a$/))
    expect(run?.outputFile).toBe(`${run?.cwd}/.tutti/run/check.log`)
    expect(run?.outputFd).toEqual(expect.any(Number))
    expectLog(ran, [
      "  rebased tutti/a onto main, which moved on while it ran",
      /^ {2}a closed \(.*\); merged into main, worktree and branch removed$/,
    ])
  })

  test("FLAKY: lines of a passing check are warnings naming the ticket", async () => {
    const ran = await mergeAll(
      {
        backlog: backlog().ticket("a").seeds,
        checks: {
          fast: [
            {
              ...passed("fast", { flaky: ["test/x.test.ts retries"], flakyCount: 2 }),
              command: "scripts/check-fast.sh",
            },
          ],
        },
      },
      [finished("a", { "a.txt": "a\n" })],
      moveMain(),
    )
    expect(tags(resultOf(ran))).toEqual({ a: "Done" })
    expectLog(ran, [
      "  FLAKY: a's check 'scripts/check-fast.sh' passed, but a test failed and then passed on a rerun: test/x.test.ts retries",
      "  FLAKY: a's check 'scripts/check-fast.sh' passed, but 1 more tests failed and then passed on a rerun",
      /^ {2}a closed/,
    ])
    expect(records(ran, "warn")).toHaveLength(2)
  })

  test("without a check command, a rebased ticket merges unchecked and the log says so", async () => {
    const ran = await mergeAll(
      {
        backlog: backlog().ticket("a").seeds,
        checks: { fast: [{ _tag: "NoCheckCommand", check: "fast" }] },
      },
      [finished("a", { "a.txt": "a\n" })],
      moveMain(),
    )
    expect(tags(resultOf(ran))).toEqual({ a: "Done" })
    expectLog(ran, [
      "  no check command in .tutti/settings.json: merging tutti/a without checking the rebased code",
      /^ {2}a closed/,
    ])
  })
})

describe("finishing order", () => {
  test("tickets merge one at a time in the order they finished, their places kept current", async () => {
    const gates = [0, 1, 2].map(() => Deferred.makeUnsafe<void>())
    const gated = gates.map((gate): Scripted => Effect.as(Deferred.await(gate), passed("fast")))
    const placed = (state: State) =>
      Object.fromEntries(
        ["a", "b", "c"].map((id) => {
          const phase = phaseOf(state, id)
          return [
            id,
            phase?._tag === "ToMerge"
              ? `ToMerge ${phase.place}`
              : phase?._tag === "Merging"
                ? `Merging ${phase.step}`
                : phase?._tag,
          ]
        }),
      )
    const merging = (id: string) => (state: State) => {
      const phase = phaseOf(state, id)
      return phase?._tag === "Merging" && phase.step === "check"
    }
    const seen: Array<Record<string, string | undefined>> = []
    const ran = await scenario(
      { backlog: backlog().ticket("a").ticket("b").ticket("c").seeds, checks: { fast: gated } },
      withQueue((queue) =>
        Effect.gen(function* () {
          const ledger = yield* Ledger
          const c = yield* finished("c", { "c.txt": "c\n" })
          const a = yield* finished("a", { "a.txt": "a\n" })
          const b = yield* finished("b", { "b.txt": "b\n" })
          yield* moveMain()
          yield* queue.offer(c)
          yield* until(merging("c"))
          yield* queue.offer(a)
          yield* queue.offer(b)
          seen.push(placed(yield* ledger.current))
          yield* Deferred.succeed(gates[0] as Deferred.Deferred<void>, undefined)
          yield* until(merging("a"))
          seen.push(placed(yield* ledger.current))
          yield* Deferred.succeed(gates[1] as Deferred.Deferred<void>, undefined)
          yield* until(merging("b"))
          seen.push(placed(yield* ledger.current))
          yield* Deferred.succeed(gates[2] as Deferred.Deferred<void>, undefined)
          yield* queue.settled
        }),
      ),
    )
    expect(tags(resultOf(ran))).toEqual({ a: "Done", b: "Done", c: "Done" })
    expect(seen).toEqual([
      { c: "Merging check", a: "ToMerge 1", b: "ToMerge 2" },
      { c: "Done", a: "Merging check", b: "ToMerge 1" },
      { c: "Done", a: "Done", b: "Merging check" },
    ])
    expect(records(ran, "closed").map((record) => "ticket" in record && record.ticket)).toEqual([
      "c",
      "a",
      "b",
    ])
    expect(ran.checkRuns.map((run) => run.cwd.split("/").at(-1))).toEqual(["c", "a", "b"])
  })
})

/** One ticket, `a`, behind or on top of the base, merged with `script` run first. */
const mergeOne = (
  script: (ticket: FinishedTicket) => Effect.Effect<void, unknown, Env | Ledger>,
  setup: Setup = {},
) =>
  scenario(
    { backlog: backlog().ticket("a").ticket("b").seeds, ...setup },
    withQueue((queue) =>
      Effect.gen(function* () {
        const ticket = yield* finished("a", { "a.txt": "a\n" })
        yield* script(ticket)
        yield* queue.offer(ticket)
        yield* queue.settled
      }),
    ),
  )

describe("each failure lands in its phase, with orchestra's log line", () => {
  test("OFF_BRANCH: the worktree on a detached HEAD is set aside before anything is done", async () => {
    let worktree = ""
    const ran = await mergeOne((ticket) =>
      Effect.gen(function* () {
        worktree = ticket.worktree
        const repository = yield* Repository
        yield* repository.checkout(ticket.worktree, yield* repository.head("HEAD", ticket.worktree))
      }),
    )
    const merged = resultOf(ran)
    expect(merged.phases.a).toEqual(expect.objectContaining({ _tag: "Review", why: "OFF_BRANCH" }))
    expectLog(ran, [
      `  OFF_BRANCH: a closed, but its worktree ${worktree} has a detached HEAD, not tutti/a; worktree left for review`,
    ])
    expect(records(ran, "warn")[0]).toMatchObject({
      ticket: "a",
      aside: true,
      detail: "worktree not on tutti/a",
    })
    expect(ran.checkRuns).toEqual([])
  })

  test("OFF_BRANCH: another branch checked out", async () => {
    const ran = await mergeOne((ticket) =>
      Effect.gen(function* () {
        yield* (yield* Git).createBranch("/repo", "other", "main")
        yield* (yield* Repository).checkout(ticket.worktree, "other")
      }),
    )
    expect(resultOf(ran).phases.a).toEqual(
      expect.objectContaining({ _tag: "Review", why: "OFF_BRANCH" }),
    )
    expectLog(ran, [/^ {2}OFF_BRANCH: a closed, but its worktree .* has other checked out, not/])
  })

  test("DIRTY_WORKTREE: uncommitted changes keep the branch from its rebase", async () => {
    let worktree = ""
    const ran = await mergeOne((ticket) =>
      Effect.gen(function* () {
        worktree = ticket.worktree
        yield* moveMain()
        yield* (yield* Repository).write(ticket.worktree, { "a.txt": "changed\n" })
      }),
    )
    expect(resultOf(ran).phases.a).toEqual(
      expect.objectContaining({ _tag: "Review", why: "DIRTY_WORKTREE" }),
    )
    expectLog(ran, [
      `  DIRTY_WORKTREE: a closed, but ${worktree} has uncommitted changes to a.txt, so tutti/a can't be rebased onto main, which moved on while it ran; worktree left for review (commit or undo them, rebase onto main, check, merge)`,
    ])
  })

  test("REBASE_FAILED: git refuses the rebase without stopping on conflicts", async () => {
    let tip = ""
    const ran = await mergeOne((ticket) =>
      Effect.gen(function* () {
        const repository = yield* Repository
        tip = yield* repository.head(ticket.branch)
        yield* moveMain()
        yield* repository.fail("rebase", { stderr: "fatal: something broke\nmore" })
      }),
    )
    expect(resultOf(ran).phases.a).toEqual(
      expect.objectContaining({ _tag: "Review", why: "REBASE_FAILED" }),
    )
    expectLog(ran, [
      /^ {2}REBASE_FAILED: a closed, but git could not rebase tutti\/a onto main, which moved on while it ran: fatal: something broke; worktree .* left for review$/,
    ])
    expect(tip).not.toBe("")
  })

  test("MERGE_CONFLICT: the rebase is aborted, the branch put back, and the ticket Blocked", async () => {
    let tip = ""
    let worktree = ""
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds },
      withQueue((queue) =>
        Effect.gen(function* () {
          const git = yield* Git
          const repository = yield* Repository
          const ticket = yield* finished("a", { "a.txt": "a\n" })
          worktree = ticket.worktree
          tip = yield* repository.head(ticket.branch)
          yield* moveMain({ "a.txt": "main's a\n" })
          yield* queue.offer(ticket)
          yield* queue.settled
          expect(yield* git.rebaseInProgress(ticket.worktree)).toBe(false)
          expect(yield* repository.head(ticket.branch)).toBe(tip)
        }),
      ),
    )
    expect(resultOf(ran).phases.a).toEqual(
      expect.objectContaining({ _tag: "Blocked", why: "MERGE_CONFLICT" }),
    )
    expectLog(ran, [
      `  MERGE_CONFLICT: a closed, but tutti/a conflicts with main in a.txt, which moved on while it ran (not handed back to its worker: there is no check command in .tutti/settings.json to check a resolution with); worktree ${worktree} left for review (rebase onto main, check, merge)`,
    ])
    expect(records(ran, "warn")[0]).toMatchObject({
      ticket: "a",
      aside: true,
      blocked: "merge conflict in a.txt",
    })
    expect(ran.checkRuns).toEqual([])
  })

  test("CHECKS_FAILED: the check fails on the rebased branch; what it said goes in the log", async () => {
    let worktree = ""
    const ran = await mergeOne(
      (ticket) =>
        Effect.gen(function* () {
          worktree = ticket.worktree
          yield* moveMain()
        }),
      { checks: { fast: [failedCheck] } },
    )
    expect(resultOf(ran).phases.a).toEqual(
      expect.objectContaining({ _tag: "Review", why: "CHECKS_FAILED" }),
    )
    expectLog(ran, [
      `  CHECKS_FAILED: a closed, but 'scripts/check-fast.sh' fails on tutti/a rebased onto main; not handed back to its worker: its worker has no session to resume; worktree ${worktree} left for review (output is in ${join(worktree, ".tutti/run/check.log")}); checked once more if main moves on in this run`,
      "    error: a.test.ts: expected 1",
    ])
    expect(records(ran, "warn")[0]).toMatchObject({ aside: true, detail: "checks failed" })
    // The whole output stays in the worktree, left for review with it.
    expect(existsSync(join(worktree, ".tutti/run/check.log"))).toBe(true)
  })

  test("CHECKS_FAILED: a check past its time limit", async () => {
    const timedOut = new CheckTimedOut({
      check: "fast",
      command: "scripts/check-fast.sh",
      timeLimit: Duration.minutes(30),
      outputFile: "/dev/fd/9",
      failingLines: [],
      lastLines: ["running suite 4"],
      suites: [],
      suite: null,
      flaky: [],
      flakyCount: 0,
    })
    const ran = await mergeOne(() => moveMain(), { checks: { fast: [timedOut] } })
    expect(resultOf(ran).phases.a).toEqual(
      expect.objectContaining({ _tag: "Review", why: "CHECKS_FAILED" }),
    )
    expectLog(ran, [
      /^ {2}CHECKS_FAILED: a closed, but 'scripts\/check-fast.sh' did not finish within 30m on tutti\/a rebased onto main; /,
      "    running suite 4",
    ])
    expect(records(ran, "warn")[0]).toMatchObject({ detail: "checks timed out" })
  })

  test("DIRTY_TREE: uncommitted changes in the main checkout block it and hold the run", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("a").ticket("b").seeds },
      withQueue((queue) =>
        Effect.gen(function* () {
          const a = yield* finished("a", { "a.txt": "a\n" })
          const b = yield* finished("b", { "b.txt": "b\n" })
          yield* (yield* Repository).write("/repo", { "README.md": "edited by hand\n" })
          yield* queue.offer(a)
          yield* queue.offer(b)
          yield* queue.settled
        }),
      ),
    )
    const merged = resultOf(ran)
    expect(merged.phases.a).toEqual(expect.objectContaining({ _tag: "Blocked", why: "DIRTY_TREE" }))
    // Nothing merges after a stop: b waits where it was.
    expect(merged.phases.b).toEqual(expect.objectContaining({ _tag: "ToMerge", place: 1 }))
    expect(merged.stop).toMatchObject({ why: "DIRTY_TREE", code: 5, ticket: "a" })
    const line =
      /^HOLD: DIRTY_TREE: uncommitted changes in \/repo; tutti\/a is not merged, its worktree .* left for review\. Inspect with: git status$/
    expectLog(ran, [line])
    expect(records(ran, "hold")[0]).toMatchObject({
      ticket: "a",
      blocked: "main checkout has uncommitted changes",
      text: expect.stringMatching(line),
    })
  })

  test("DIRTY_TREE: the main checkout off the base", async () => {
    const ran = await mergeOne(() =>
      Effect.gen(function* () {
        yield* (yield* Git).createBranch("/repo", "elsewhere", "main")
        yield* (yield* Repository).checkout("/repo", "elsewhere")
      }),
    )
    expect(resultOf(ran).stop).toMatchObject({ why: "DIRTY_TREE", code: 5 })
    expectLog(ran, [/^HOLD: DIRTY_TREE: \/repo is no longer on main; tutti\/a is not merged/])
  })

  test("GIT_FAILED: git can't read the main checkout, asked gitTries times", async () => {
    const ran = await mergeOne(() =>
      Effect.gen(function* () {
        const repository = yield* Repository
        yield* repository.fail("status", {
          dir: "/repo",
          stderr: "fatal: index file corrupt",
          times: gitTries,
        })
        // git is asked again a few seconds after each failure.
        yield* Effect.forkChild(
          Effect.gen(function* () {
            for (let i = 0; i < 3 * gitTries; i++) {
              for (let j = 0; j < 200; j++) yield* Effect.yieldNow
              yield* advance(gitAgainAfter)
            }
          }),
        )
      }),
    )
    const merged = resultOf(ran)
    expect(merged.phases.a).toEqual(expect.objectContaining({ _tag: "Blocked", why: "GIT_FAILED" }))
    expect(merged.stop).toMatchObject({ why: "GIT_FAILED", code: 4 })
    expectLog(ran, [
      /^HOLD: GIT_FAILED: could not read the state of \/repo \(3 tries\): fatal: index file corrupt; tutti\/a is not merged/,
    ])
  })

  test("MERGE_FAILED: the branch doesn't fast-forward; Blocked, exit 6", async () => {
    let worktree = ""
    const ran = await mergeOne((ticket) =>
      Effect.gen(function* () {
        worktree = ticket.worktree
        yield* (yield* Repository).fail("merge --ff-only", {
          exitCode: 128,
          stderr: "fatal: Not possible to fast-forward, aborting.",
        })
      }),
    )
    const merged = resultOf(ran)
    expect(merged.phases.a).toEqual(
      expect.objectContaining({ _tag: "Blocked", why: "MERGE_FAILED" }),
    )
    expect(merged.stop).toMatchObject({ why: "MERGE_FAILED", code: 6, ticket: "a" })
    const line = `MERGE_FAILED: tutti/a does not fast-forward onto main: fatal: Not possible to fast-forward, aborting.; its worktree ${worktree} left for review`
    expectLog(ran, [line])
    expect(records(ran, "stop")[0]).toMatchObject({
      detail: "MERGE_FAILED",
      ticket: "a",
      blocked: "does not fast-forward onto main",
      text: line,
    })
    expect(ran.worktreeCalls.filter((call) => call.op === "remove")).toEqual([])
  })

  test("the base moving on during every check blocks the ticket after the last pass", async () => {
    let n = 0
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds },
      withQueue(
        (queue) =>
          Effect.gen(function* () {
            const ticket = yield* finished("a", { "a.txt": "a\n" })
            yield* moveMain()
            yield* queue.offer(ticket)
            yield* queue.settled
          }),
        (queue) =>
          Effect.gen(function* () {
            const repository = yield* Repository
            const checks = yield* Checks
            return yield* Effect.provideService(queue, Checks, {
              ...checks,
              fast: (run) =>
                Effect.flatMap(
                  repository.commit("/repo", `By hand ${++n}`, { [`hand${n}.txt`]: "x\n" }),
                  () => checks.fast(run),
                ),
            })
          }),
      ),
    )
    expect(resultOf(ran).phases.a).toEqual(
      expect.objectContaining({ _tag: "Blocked", why: "MERGE_CONFLICT" }),
    )
    expect(n).toBe(maxPasses)
    expectLog(ran, [
      /^ {2}MERGE_CONFLICT: a closed, but main kept changing while its checks ran \(commits made by hand\?\)/,
    ])
  })
})

describe("epics", () => {
  test("close as their last subticket merges, up the tree", async () => {
    const seeds = backlog()
      .ticket("E", { type: "epic" })
      .ticket("F", { type: "epic", parent: "E" })
      .ticket("a", { parent: "F" })
      .ticket("b", { parent: "F" }).seeds
    const ran = await scenario(
      { backlog: seeds },
      withQueue((queue) =>
        Effect.gen(function* () {
          const beads = yield* Beads
          yield* queue.offer(yield* finished("a", { "a.txt": "a\n" }))
          yield* queue.settled
          expect((yield* beads.show("F")).status).not.toBe("closed")
          yield* queue.offer(yield* finished("b", { "b.txt": "b\n" }))
          yield* queue.settled
        }),
      ),
    )
    resultOf(ran)
    const status = Object.fromEntries(ran.issues.map((issue) => [issue.id, issue.status]))
    expect(status).toEqual({ E: "closed", F: "closed", a: "closed", b: "closed" })
    expect(ran.issues.find((issue) => issue.id === "F")?.closeReason).toBe(
      "All 2 subtickets are merged; closed by tutti after b",
    )
    expectLog(ran, [
      /^ {2}b closed/,
      "  closed epic F: all 2 subtickets are merged",
      "  closed epic E: its 1 subticket is merged",
    ])
    expect(records(ran, "info").map((record) => "ticket" in record && record.ticket)).toEqual([
      "F",
      "E",
    ])
  })

  test("stay open while a subticket is closed but not merged", async () => {
    const inA = new CheckFailed({ ...failedCheck, failingLines: ["a.txt:1: expected 1"] })
    const seeds = backlog().epic("E", ["a", "b"]).seeds
    const ran = await scenario(
      { backlog: seeds, checks: { fast: [inA] } },
      withQueue((queue) =>
        Effect.gen(function* () {
          const a = yield* finished("a", { "a.txt": "a\n" })
          const b = yield* finished("b", { "b.txt": "b\n" })
          yield* moveMain()
          // a's check fails in its own a.txt, so it isn't checked again; b merges after it.
          yield* queue.offer(a)
          yield* queue.offer(b)
          yield* queue.settled
        }),
      ),
    )
    expect(tags(resultOf(ran))).toEqual({ a: "Review", b: "Done" })
    expect(ran.issues.find((issue) => issue.id === "E")?.status).not.toBe("closed")
    expect(ran.log.some((each) => each.includes("closed epic"))).toBe(false)
  })
})

describe("an interrupt", () => {
  /** Runs `body` with a queue in a scope it closes partway, then reads the phases. */
  const interrupted = (
    setup: Setup,
    body: (
      queue: MergeQueue,
      close: Effect.Effect<void>,
    ) => Effect.Effect<void, unknown, Env | Ledger>,
    around: (
      queue: Effect.Effect<MergeQueue, never, Env | Ledger | Scope.Scope>,
    ) => Effect.Effect<MergeQueue, never, Env | Ledger | Scope.Scope> = (queue) => queue,
  ) =>
    scenario(
      setup,
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const queue = yield* Effect.provideService(around(makeQueue(options)), Scope.Scope, scope)
        yield* body(queue, Scope.close(scope, Exit.void))
        return phasesOf(yield* (yield* Ledger).current)
      }).pipe(Effect.provide(Ledger.layer)),
    )

  const merging = (step: "rebase" | "check") => (state: State) => {
    const phase = phaseOf(state, "a")
    return phase?._tag === "Merging" && phase.step === step
  }

  test("during the check kills it and leaves the ticket ToMerge, at the head of the line", async () => {
    const killed = Effect.runSync(Ref.make(false))
    const hanging: Scripted = Effect.never.pipe(
      Effect.onInterrupt(() => Ref.set(killed, true)),
    ) as Effect.Effect<never>
    const ran = await interrupted(
      { backlog: backlog().ticket("a").ticket("b").seeds, checks: { fast: [hanging] } },
      (queue, close) =>
        Effect.gen(function* () {
          const a = yield* finished("a", { "a.txt": "a\n" })
          const b = yield* finished("b", { "b.txt": "b\n" })
          yield* moveMain()
          yield* queue.offer(a)
          yield* until(merging("check"))
          yield* queue.offer(b)
          yield* close
          const main = yield* (yield* Repository).tree("main")
          expect(main.has("a.txt")).toBe(false)
        }),
    )
    const phases = resultOf(ran)
    expect(phases.a).toEqual(expect.objectContaining({ _tag: "ToMerge", place: 1 }))
    expect(phases.b).toEqual(expect.objectContaining({ _tag: "ToMerge", place: 2 }))
    expect(Effect.runSync(Ref.get(killed))).toBe(true)
    expect(records(ran, "phase").at(-1)).toMatchObject({
      ticket: "a",
      from: "Merging",
      to: "ToMerge",
      cause: "MergeInterrupted",
      place: 1,
    })
    expect(ran.worktreeCalls.filter((call) => call.op === "remove")).toEqual([])
  })

  test("during a real check kills its process group", async () => {
    const config = appConfig()
    const settings = {
      ...config.settings,
      checks: {
        ...config.settings.checks,
        fast: { ...config.settings.checks.fast, command: "echo started; exec sleep 30" },
      },
    }
    let worktree = ""
    const ran = await interrupted(
      { backlog: backlog().ticket("a").seeds, config: { settings } },
      (queue, close) =>
        Effect.gen(function* () {
          const groups = yield* ProcessGroups
          const a = yield* finished("a", { "a.txt": "a\n" })
          worktree = a.worktree
          yield* moveMain()
          yield* queue.offer(a)
          yield* until(merging("check"))
          while (groups.size === 0) yield* Effect.promise(() => Bun.sleep(5))
          const [pid] = [...groups]
          yield* close
          expect(groups.size).toBe(0)
          expect(() => process.kill(pid as number, 0)).toThrow()
        }),
      (queue) =>
        Effect.provide(
          queue,
          Checks.layer.pipe(Layer.provide(Layer.succeed(AppConfig, { ...appConfig(), settings }))),
        ),
    )
    expect(resultOf(ran).a).toEqual(expect.objectContaining({ _tag: "ToMerge" }))
    expect(existsSync(join(worktree, ".tutti/run/check.log"))).toBe(true)
  })

  test("during the rebase aborts it, putting the branch back, and leaves the ticket ToMerge", async () => {
    const started = Deferred.makeUnsafe<void>()
    let tip = ""
    const ran = await interrupted(
      { backlog: backlog().ticket("a").seeds },
      (queue, close) =>
        Effect.gen(function* () {
          const git = yield* Git
          const repository = yield* Repository
          const a = yield* finished("a", { "a.txt": "a\n" })
          tip = yield* repository.head(a.branch)
          yield* moveMain()
          // git stops partway, its rebase in progress, and hangs there.
          yield* repository.conflict(a.branch, ["a.txt"])
          yield* queue.offer(a)
          yield* Deferred.await(started)
          expect(yield* git.rebaseInProgress(a.worktree)).toBe(true)
          yield* close
          expect(yield* git.rebaseInProgress(a.worktree)).toBe(false)
          expect(yield* repository.head(a.branch)).toBe(tip)
          expect(yield* git.currentBranch(a.worktree)).toEqual(
            expect.objectContaining({ value: a.branch }),
          )
        }),
      (queue) =>
        Effect.gen(function* () {
          const git = yield* Git
          return yield* Effect.provideService(queue, Git, {
            ...git,
            rebase: (worktree, onto) =>
              git
                .rebase(worktree, onto)
                .pipe(
                  Effect.ignore,
                  Effect.andThen(Deferred.succeed(started, undefined)),
                  Effect.andThen(Effect.never),
                ),
          })
        }),
    )
    expect(resultOf(ran).a).toEqual(expect.objectContaining({ _tag: "ToMerge", place: 1 }))
    expect(tip).not.toBe("")
  })

  test("as a conflict's rebase is being aborted still puts the branch back", async () => {
    const aborting = Deferred.makeUnsafe<void>()
    const gate = Deferred.makeUnsafe<void>()
    let tip = ""
    let worktree = ""
    const ran = await interrupted(
      { backlog: backlog().ticket("a").seeds },
      (queue, close) =>
        Effect.gen(function* () {
          const git = yield* Git
          const repository = yield* Repository
          const a = yield* finished("a", { "a.txt": "a\n" })
          tip = yield* repository.head(a.branch)
          worktree = a.worktree
          yield* moveMain({ "a.txt": "main's a\n" })
          yield* queue.offer(a)
          yield* Deferred.await(aborting)
          yield* close
          expect(yield* git.rebaseInProgress(a.worktree)).toBe(false)
          expect(yield* repository.head(a.branch)).toBe(tip)
        }),
      (queue) =>
        Effect.gen(function* () {
          const git = yield* Git
          let first = true
          return yield* Effect.provideService(queue, Git, {
            ...git,
            // The first abort hangs, as git killed partway would never finish it.
            abortRebase: (dir) =>
              first
                ? Effect.sync(() => {
                    first = false
                  }).pipe(
                    Effect.andThen(Deferred.succeed(aborting, undefined)),
                    Effect.andThen(Deferred.await(gate)),
                    Effect.andThen(git.abortRebase(dir)),
                  )
                : git.abortRebase(dir),
          })
        }),
    )
    expect(resultOf(ran).a).toEqual(expect.objectContaining({ _tag: "ToMerge", place: 1 }))
    expect(worktree).not.toBe("")
  })

  test("as a ticket's turn starts puts it back in line, ToMerge", async () => {
    const inTurn = Deferred.makeUnsafe<void>()
    const gate = Deferred.makeUnsafe<void>()
    const ran = await interrupted(
      { backlog: backlog().ticket("a").seeds },
      (queue, close) =>
        Effect.gen(function* () {
          yield* queue.offer(yield* finished("a", { "a.txt": "a\n" }))
          yield* Deferred.await(inTurn)
          const closing = yield* Effect.forkChild(close)
          yield* Effect.yieldNow
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(closing)
          expect(yield* queue.state).toEqual({
            waiting: ["a"],
            merging: null,
            resolving: [],
            stop: null,
          })
        }),
      (queue) =>
        Effect.gen(function* () {
          const ledger = yield* Ledger
          return yield* Effect.provideService(queue, Ledger, {
            ...ledger,
            transition: (ticket, cause, transitionOptions) =>
              cause._tag === "ItsTurn"
                ? Deferred.succeed(inTurn, undefined).pipe(
                    Effect.andThen(Deferred.await(gate)),
                    Effect.andThen(ledger.transition(ticket, cause, transitionOptions)),
                  )
                : ledger.transition(ticket, cause, transitionOptions),
          })
        }),
    )
    expect(resultOf(ran).a).toEqual(expect.objectContaining({ _tag: "ToMerge", place: 1 }))
    expect(ran.checkRuns).toEqual([])
  })

  test("during the fast-forward waits for the merge to finish", async () => {
    const started = Deferred.makeUnsafe<void>()
    const gate = Deferred.makeUnsafe<void>()
    const ran = await interrupted(
      { backlog: backlog().ticket("a").seeds },
      (queue, close) =>
        Effect.gen(function* () {
          yield* queue.offer(yield* finished("a", { "a.txt": "a\n" }))
          yield* Deferred.await(started)
          const closing = yield* Effect.forkChild(close)
          yield* Effect.yieldNow
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(closing)
          const main = yield* (yield* Repository).tree("main")
          expect(main.get("a.txt")).toBe("a\n")
        }),
      (queue) =>
        Effect.gen(function* () {
          const git = yield* Git
          return yield* Effect.provideService(queue, Git, {
            ...git,
            fastForward: (repo, branch) =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(gate)),
                Effect.andThen(git.fastForward(repo, branch)),
              ),
          })
        }),
    )
    expect(resultOf(ran).a).toEqual(expect.objectContaining({ _tag: "Done" }))
    expectLog(ran, [/^ {2}a closed .*worktree and branch removed$/])
  })
})
