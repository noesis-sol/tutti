// bd failing for a moment as the run looks for the tickets set aside: the ticket keeps its look
// for a hand merge and its one recheck, asked again at the next look (tutti-rzr0).
import { describe, expect, test } from "bun:test"
import { Effect, Exit, type Scope, Stream } from "effect"
import { Ledger, type State } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import { Cause, type PhaseTag } from "../src/run/phase.ts"
import { Beads } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { Backlog } from "../src/testing/Beads.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { backlog, type Env, expectLog, type Ran, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main" }

/** A check that fails in a file no ticket here changes. */
const elsewhere = new CheckFailed({
  check: "fast",
  command: "scripts/check-fast.sh",
  exitCode: 1,
  outputFile: "/dev/fd/9",
  failingLines: ["shared/b.go:12: expected 1"],
  lastLines: ["shared/b.go:12: expected 1", "1 fail"],
  suites: [],
  suite: null,
  flaky: [],
  flakyCount: 0,
})

/** A ticket its worker finished: its worktree on tutti/<id> with a commit naming it, Working. */
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

/** Something landing on main, so that a ticket's merge rebases and checks it. */
const moveMain = Effect.gen(function* () {
  const repository = yield* Repository
  yield* repository.commit(repository.dir, "Land something else", { "main.txt": "moved\n" })
})

const phaseOf = (state: State, id: string) => state.tickets.get(id)?.phase._tag

/** Waits until ticket `id` is in `phase`. */
const until = (id: string, phase: PhaseTag) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    yield* ledger.changes.pipe(
      Stream.filter((state) => phaseOf(state, id) === phase),
      Stream.runHead,
    )
  })

/**
 * `a` finishes after main moved and its check fails on main, so it is set aside, kept to be checked
 * once more; then `body` runs. a's phase after it.
 */
const setAside = (body: (queue: MergeQueue) => Effect.Effect<void, unknown, Env | Ledger>) =>
  scenario(
    { backlog: backlog().ticket("a").seeds, checks: { fast: [elsewhere] } },
    Effect.gen(function* () {
      const queue = yield* makeQueue(options)
      const a = yield* finished("a", { "a/a.go": "a\n" })
      yield* moveMain
      yield* queue.offer(a)
      yield* until("a", "Review")
      yield* body(queue)
      yield* queue.settled
      return phaseOf(yield* (yield* Ledger).current, "a")
    }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<
      PhaseTag | undefined,
      unknown,
      Env | Scope.Scope
    >,
  )

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

describe("bd failing as the run looks for a ticket merged by hand", () => {
  test("has the next look ask again, though the base hasn't moved", async () => {
    const ran = await setAside((queue) =>
      Effect.gen(function* () {
        const repository = yield* Repository
        yield* repository.commit(repository.dir, "Squash-merge a (a)", { "a/a.go": "a\n" })
        yield* (yield* Backlog).fail("show", { id: "a" })
        expect(yield* queue.mergedByHand).toEqual([])
        expect(yield* queue.mergedByHand).toEqual(["a"])
      }),
    )
    expect(resultOf(ran)).toBe("Done")
    expectLog(ran, [/^ {2}a, set aside in this run, is on main now .*: merged by hand/])
  })

  test("once bd answers for every ticket, a look while the base stays asks nothing of it", async () => {
    const ran = await setAside((queue) =>
      Effect.gen(function* () {
        const repository = yield* Repository
        yield* (yield* Backlog).fail("show", { id: "a" })
        yield* queue.mergedByHand
        yield* queue.mergedByHand
        const asked = (yield* repository.calls).length
        yield* queue.mergedByHand
        expect((yield* repository.calls).length - asked).toBe(1)
      }),
    )
    expect(resultOf(ran)).toBe("Review")
  })
})

describe("bd failing as the run looks for the tickets due a recheck", () => {
  test("leaves the ticket waiting, and the next look checks it once more", async () => {
    const ran = await setAside((queue) =>
      Effect.gen(function* () {
        yield* moveMain
        // The look for a hand merge asks first, then the recheck.
        yield* (yield* Backlog).fail("show", { id: "a", times: 2 })
        expect(yield* queue.recheck).toEqual([])
        expect((yield* queue.rechecks.waiting).map((each) => each.ticket.id)).toEqual(["a"])
        expect(yield* queue.rechecks.rechecked("a")).toBe(false)
        expect(yield* queue.recheck).toEqual(["a"])
      }),
    )
    expect(resultOf(ran)).toBe("Done")
    expectLog(ran, [
      /^ {2}a is not checked again yet: bd could not say whether it is still closed: .*; it is asked again at the next look$/,
      /^ {2}RECHECK: a's check failed on main/,
    ])
    expect(ran.log.some((line) => line.includes("it stays set aside"))).toBe(false)
  })
})
