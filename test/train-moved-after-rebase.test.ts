// A branch its train rebased onto the branch ahead, that moved since (a commit landed on it, its
// worker's or by hand): it still sits on top of the branch ahead, so putting it back as its worker
// left it isn't the train's to do (mergetrain.ts's putBack, putBackLeft). Its checked_ahead mark is
// kept, with a line saying so, and its merge (merge.ts's Enter step) sets it aside rather than merge
// the commits of the branch ahead with it, unless the branch ahead merged as it was checked, when
// it is checked in its turn as any other. The same on a quit, the next run leaving it as it is.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Stream } from "effect"
import { Ledger, type State } from "../src/run/ledger.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import type { FinishedTicket } from "../src/run/mergeShared.ts"
import { aheadKey, putBackLeft } from "../src/run/mergetrain.ts"
import { Move, type PhaseTag } from "../src/run/phase.ts"
import { makeSetUps } from "../src/run/setup.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type CheckRun, passed, type Scripted } from "../src/testing/Checks.ts"
import { Repository } from "../src/testing/Git.ts"
import { backlog, expectLog, type Ran, scenario } from "./harness.ts"

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings

/** A check command, failed checks set aside at once, one ticket checked ahead. */
const settings = {
  ...defaults,
  checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
  merge: { ...defaults.merge, check_hand_backs: 0, train: 1 },
}

const failing = new CheckFailed({
  check: "fast",
  command: check,
  exitCode: 1,
  outputFile: "/dev/fd/9",
  failingLines: ["error: a.test.ts: expected 1"],
  lastLines: ["1 fail"],
  suites: [],
  suite: null,
  flaky: [],
  flakyCount: 0,
})

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** A ticket its worker finished: a commit naming it on tutti/<id>, closed, in no phase yet. */
const closed = (id: TicketId) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    const worktree = yield* (yield* Worktrees).prepare(id)
    yield* (yield* Git).addWorktree(repository.dir, worktree.path, {
      branch: worktree.branch,
      base: "main",
    })
    yield* repository.commit(worktree.path, `Do ${id} (${id})`, { [`${id}.txt`]: `${id}\n` })
    yield* (yield* Beads).close(id, "done")
    return {
      id,
      title: `Ticket ${id}`,
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

/** A ticket its worker finished, Working. */
const finished = (id: TicketId) =>
  Effect.gen(function* () {
    const ticket = yield* closed(id)
    const ledger = yield* Ledger
    yield* ledger.transition(id, Move.Ready(), { title: ticket.title })
    yield* ledger.transition(id, Move.Dispatched())
    return ticket
  })

const tagsOf = (state: State): Record<string, PhaseTag> =>
  Object.fromEntries([...state.tickets.values()].map((entry) => [entry.ticket, entry.phase._tag]))

/** Which ticket a check ran for: its worktree's name. */
const whose = (run: CheckRun): string => run.cwd.split("/").at(-1) ?? ""

/** b's mark in state.json. */
const markOf = Effect.flatMap(Store, (store) =>
  Effect.map(store.metadata("b" as TicketId), (metadata) => metadata[aheadKey]),
)

/**
 * a and b finished, main moved on, offered in order; a's check waits for `release`, then ends as
 * `aEnds` says, b's checks pass. Once b's train has passed its check on top of tutti/a, a commit
 * lands on tutti/b; `then` goes on from there, the queue settled after it unless it says otherwise.
 */
const movedOnTrain = <A>(
  aEnds: "fails" | "passes",
  then: (
    queue: MergeQueue,
    release: Deferred.Deferred<void>,
  ) => Effect.Effect<A, unknown, Git | Store | Ledger | Repository>,
) => {
  const release = Deferred.makeUnsafe<void>()
  const one: Scripted = (run) =>
    whose(run) === "a"
      ? Effect.andThen(
          Deferred.await(release),
          aEnds === "fails"
            ? Effect.fail(failing)
            : Effect.succeed({ ...passed("fast"), command: check }),
        )
      : Effect.succeed({ ...passed("fast"), command: check })
  return scenario(
    {
      config: { settings },
      backlog: backlog().ticket("a").ticket("b").seeds,
      checks: { fast: Array.from({ length: 4 }, () => one) },
    },
    Effect.gen(function* () {
      const repository = yield* Repository
      const a = yield* finished("a" as TicketId)
      const b = yield* finished("b" as TicketId)
      const queue = yield* makeQueue({ repo: repository.dir, base: "main" })
      yield* repository.commit(repository.dir, "Land something else", { "main.txt": "moved\n" })
      const before = yield* repository.head(b.branch)
      yield* queue.offer(a)
      yield* queue.offer(b)
      yield* queue.checksAhead.pipe(
        Stream.filter((shown) => shown.get("b")?.step === "passed"),
        Stream.runHead,
      )
      const rebased = yield* repository.head(b.branch)
      yield* repository.commit(b.worktree, "More of b (b)", { "b2.txt": "b2\n" })
      const moved = yield* repository.head(b.branch)
      const result = yield* then(queue, release)
      return {
        b,
        before,
        rebased,
        moved,
        result,
        after: yield* repository.head(b.branch),
        onBranch: yield* repository.tree(b.branch),
        mark: yield* markOf,
        phases: tagsOf(yield* (yield* Ledger).current),
        main: yield* repository.tree("main"),
      }
    }).pipe(Effect.scoped, Effect.provide(Ledger.layer)),
  )
}

const trainLine = (moved: string, orig: string) =>
  `  tutti/b was rebased onto tutti/a to be checked ahead of its turn, but has moved since, to ${moved.slice(0, 7)}, so it is not put back as its worker left it, at ${orig.slice(0, 7)}: its turn sets it aside unless tutti/a has merged as it was checked`

describe("a branch its train rebased onto the branch ahead, that moved since", () => {
  test("is left as it is, its mark kept, and set aside in its turn when the branch ahead didn't merge", async () => {
    const ran = await movedOnTrain("fails", (queue, release) =>
      Effect.andThen(Deferred.succeed(release, undefined), queue.settled),
    )
    const ended = resultOf(ran)
    expect(ended.rebased).not.toBe(ended.before)
    expect(ended.moved).not.toBe(ended.rebased)
    // Not put back: still on top of tutti/a, with the commit that landed on it.
    expect(ended.after).toBe(ended.moved)
    expect(ended.onBranch.get("a.txt")).toBe("a\n")
    expect(ended.onBranch.get("b2.txt")).toBe("b2\n")
    expect(ended.mark).toEqual(
      expect.objectContaining({ orig: ended.before, head: ended.rebased, behind: "tutti/a" }),
    )
    // a's commits don't merge with b: b is set aside, not checked in its turn.
    expect(ended.phases).toEqual({ a: "Review", b: "Review" })
    expect(ended.main.has("a.txt")).toBe(false)
    expect(ended.main.has("b.txt")).toBe(false)
    expect(ran.checkRuns.map(whose)).toEqual(["a", "b"])
    expectLog(ran, [
      trainLine(ended.moved, ended.before),
      new RegExp(
        `^ {2}REBASE_FAILED: b closed, but tutti/b was rebased onto tutti/a to be checked ahead of its turn and has moved since, so it was not put back as its worker left it, at ${ended.before.slice(0, 7)}, so it may have the commits of tutti/a; worktree .*/b left for review$`,
      ),
    ])
  })

  test("is checked in its turn as any other when the branch ahead merged as it was checked", async () => {
    const ran = await movedOnTrain("passes", (queue, release) =>
      Effect.andThen(Deferred.succeed(release, undefined), queue.settled),
    )
    const ended = resultOf(ran)
    expect(ended.after).toBe(ended.moved)
    expect(ended.mark).toBeUndefined()
    expect(ended.phases).toEqual({ a: "Done", b: "Done" })
    expect(ended.main.get("a.txt")).toBe("a\n")
    expect(ended.main.get("b.txt")).toBe("b\n")
    expect(ended.main.get("b2.txt")).toBe("b2\n")
    // b's pass ahead of its turn was on another commit: checked again in its turn.
    expect(ran.checkRuns.map(whose)).toEqual(["a", "b", "b"])
    expectLog(ran, [
      /^ {2}a closed .*; merged into main/,
      trainLine(ended.moved, ended.before),
      `  tutti/b was rebased onto tutti/a to be checked ahead of its turn and is not back as its worker left it, at ${ended.before.slice(0, 7)}, but tutti/a has merged as it was checked: checked in its turn as any other`,
      /^ {2}b closed .*; merged into main/,
    ])
    expect(ran.log.some((text) => text.includes("REBASE_FAILED"))).toBe(false)
  })

  test("on a quit, keeps its mark, and the next run leaves it as it is and sets it aside in its turn", async () => {
    const ran = await movedOnTrain("fails", (queue) =>
      Effect.gen(function* () {
        // The run quits as a's check still runs: the trains are left, their branches put back.
        yield* queue.hold
        yield* queue.stopMerges
        return { markOnQuit: yield* markOf }
      }),
    )
    const ended = resultOf(ran)
    expect(ended.after).toBe(ended.moved)
    expect(ended.result.markOnQuit).toEqual(
      expect.objectContaining({ orig: ended.before, head: ended.rebased }),
    )
    expect(ended.mark).toEqual(ended.result.markOnQuit)
    expect(ended.main.has("a.txt")).toBe(false)
    expect(ended.main.has("b.txt")).toBe(false)
    expectLog(ran, [trainLine(ended.moved, ended.before)])
    expect(ran.log.some((text) => text.includes(": put back as its worker left it"))).toBe(false)

    // The next run: the branch is left as it is as the run starts, and b's turn sets it aside.
    const next = await scenario(
      {
        config: { settings },
        backlog: backlog().ticket("a").ticket("b").seeds,
        checks: { fast: [passed("fast")] },
        state: {
          version: 1,
          tickets: { b: { resumes: 0, metadata: { [aheadKey]: ended.mark as never } } },
        },
      },
      Effect.gen(function* () {
        const git = yield* Git
        const repository = yield* Repository
        const store = yield* Store
        // tutti/a and tutti/b as the quit left them: b rebased onto a, a commit landed on it since.
        // b, closed and unmerged, is carried over into the queue, as run.ts does (carry.ts).
        const b = yield* closed("b" as TicketId)
        yield* git.addWorktree(repository.dir, "/worktrees/a", { branch: "tutti/a", base: "main" })
        yield* repository.commit("/worktrees/a", "Do a (a)", { "a.txt": "a\n" })
        yield* repository.commit(repository.dir, "Land something else", { "main.txt": "moved\n" })
        const orig = yield* repository.head(b.branch)
        const onto = yield* repository.head("tutti/a")
        yield* git.rebase(b.worktree, onto)
        const head = yield* repository.head(b.branch)
        yield* repository.commit(b.worktree, "More of b (b)", { "b2.txt": "b2\n" })
        const moved = yield* repository.head(b.branch)
        yield* store.updateTicket("b" as TicketId, (record) => ({
          ...record,
          worktree: b.worktree,
          branch: b.branch,
          metadata: { [aheadKey]: { orig, onto, head, behind: "tutti/a", setUp: false } },
        }))
        yield* putBackLeft(repository.dir, yield* makeSetUps)
        const left = yield* repository.head(b.branch)
        const queue = yield* makeQueue({ repo: repository.dir, base: "main" })
        yield* queue.offer(b, (place) => Move.Unmerged({ place }))
        yield* queue.settled
        return {
          orig,
          head,
          moved,
          left,
          after: yield* repository.head(b.branch),
          mark: yield* markOf,
          phases: tagsOf(yield* (yield* Ledger).current),
          main: yield* repository.tree("main"),
        }
      }).pipe(Effect.scoped, Effect.provide(Ledger.layer)),
    )
    const run = resultOf(next)
    expect(run.left).toBe(run.moved)
    expect(run.after).toBe(run.moved)
    expect(run.phases).toEqual({ b: "Review" })
    expect(run.main.has("a.txt")).toBe(false)
    expect(run.main.has("b.txt")).toBe(false)
    expect(run.mark).toEqual(expect.objectContaining({ orig: run.orig, head: run.head }))
    expect(next.checkRuns).toEqual([])
    expectLog(next, [
      `  tutti/b was rebased onto tutti/a to be checked ahead of its turn by an earlier run, but has moved since, to ${run.moved.slice(0, 7)}, so it is not put back as its worker left it, at ${run.orig.slice(0, 7)}: its turn sets it aside unless tutti/a has merged as it was checked`,
      new RegExp(
        `^ {2}REBASE_FAILED: b closed, but tutti/b was rebased onto tutti/a to be checked ahead of its turn and has moved since, so it was not put back as its worker left it, at ${run.orig.slice(0, 7)}, so it may have the commits of tutti/a; worktree .*/b left for review$`,
      ),
    ])
  })
})
