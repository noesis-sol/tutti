import { describe, expect, test } from "bun:test"
import { Effect, Exit, type Scope, Stream } from "effect"
import { hear } from "../src/run/drain.ts"
import type { EventRecord } from "../src/run/events.ts"
import { Ledger, type State } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import { Move, type PhaseTag } from "../src/run/phase.ts"
import { dropRechecks } from "../src/run/recheck.ts"
import { Beads } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
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
    yield* ledger.transition(id, Move.Ready(), { title: `Ticket ${id}` })
    yield* ledger.transition(id, Move.Dispatched())
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

/** `files` squash-merged onto main by hand, the commit naming `id`. */
const squashed = (id: string, files: Files) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    yield* repository.commit(repository.dir, `Squash-merge ${id} (${id})`, files)
  })

const phaseOf = (state: State, id: string) => state.tickets.get(id)?.phase._tag

/** Waits until every ticket named is in its phase. */
const until = (phases: Readonly<Record<string, PhaseTag>>) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    yield* ledger.changes.pipe(
      Stream.filter((state) =>
        Object.entries(phases).every(([id, phase]) => phaseOf(state, id) === phase),
      ),
      Stream.runHead,
    )
  })

/** Each ticket's phase once `body` is over. */
type Phases = Readonly<Record<string, PhaseTag | undefined>>

/** Runs `body` with a merge queue; the tickets' phases after it. */
const withQueue = (
  body: (queue: MergeQueue) => Effect.Effect<void, unknown, Env | Ledger | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const queue = yield* makeQueue(options)
    yield* body(queue)
    const state = yield* (yield* Ledger).current
    return Object.fromEntries(
      [...state.tickets.values()].map((entry) => [entry.ticket, entry.phase._tag]),
    ) as Phases
  }).pipe(Effect.provide(Ledger.layer))

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

const records = (ran: Ran<unknown>, kind: EventRecord["kind"]) =>
  ran.events.filter((record) => record.kind === kind)

/**
 * `a` finishes after main moved and its check fails on main, so it is set aside, kept to be checked
 * once more; then `between` runs, and the queue looks for the tickets due a recheck.
 */
const setAsideThen = (
  between: (queue: MergeQueue) => Effect.Effect<void, unknown, Env | Ledger>,
  seeds = backlog().ticket("a").seeds,
) =>
  scenario(
    { backlog: seeds, checks: { fast: [elsewhere] } },
    withQueue((queue) =>
      Effect.gen(function* () {
        const a = yield* finished("a", { "a/a.go": "a\n" })
        yield* moveMain
        yield* queue.offer(a)
        yield* until({ a: "Review" })
        yield* between(queue)
        yield* queue.recheck
        yield* queue.settled
      }),
    ),
  )

describe("a ticket set aside and merged by hand during the run", () => {
  test("is found as the base moves: Done, not checked again, its worktree and branch removed", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds, checks: { fast: [elsewhere] } },
      withQueue((queue) =>
        Effect.gen(function* () {
          const a = yield* finished("a", { "a/a.go": "a\n" })
          yield* moveMain
          yield* queue.offer(a)
          yield* until({ a: "Review" })
          expect((yield* queue.rechecks.waiting).map((each) => each.ticket.id)).toEqual(["a"])
          yield* squashed("a", { "a/a.go": "a\n" })
          expect(yield* queue.recheck).toEqual([])
          expect(yield* queue.rechecks.waiting).toEqual([])
          yield* queue.settled
        }),
      ),
    )
    expect(resultOf(ran)).toEqual({ a: "Done" })
    expectLog(ran, [
      /^ {2}CHECKS_FAILED: a closed, .*; checked once more if main moves on in this run$/,
      /^ {2}a, set aside in this run, is on main now \([0-9a-f]{7} Squash-merge a \(a\)\): merged by hand, so no longer set aside; worktree and branch removed$/,
    ])
    expect(ran.log.some((line) => line.includes("RECHECK"))).toBe(false)
    expect(ran.checkRuns).toHaveLength(1)
    expect(ran.worktreeCalls).toContainEqual({ op: "remove", id: "a", force: false })
    expect(records(ran, "closed")).toEqual([
      expect.objectContaining({ ticket: "a", detail: expect.stringMatching(/ merged by hand$/) }),
    ])
    expect(records(ran, "phase")).toContainEqual(
      expect.objectContaining({ ticket: "a", from: "Review", to: "Done", cause: "MergedByHand" }),
    )
  })

  test("with uncommitted changes in its worktree, is Done and its worktree left, saying so", async () => {
    const ran = await setAsideThen(() =>
      Effect.gen(function* () {
        const repository = yield* Repository
        const worktree = (yield* (yield* Git).worktrees(options.repo)).find(
          (each) => each.branch === "tutti/a",
        )
        yield* repository.write(worktree?.path ?? "", { "notes.txt": "mine\n" })
        yield* squashed("a", { "a/a.go": "a\n" })
      }),
    )
    expect(resultOf(ran)).toEqual({ a: "Done" })
    expectLog(ran, [
      /^ {2}a, set aside in this run, is on main now \([0-9a-f]{7} Squash-merge a \(a\)\): merged by hand, so no longer set aside; worktree \S+ has uncommitted changes \(notes\.txt\), so it and tutti\/a are left as they are \(commit or remove them, then remove it\)$/,
    ])
    expect(ran.worktreeCalls.some((call) => call.op === "remove")).toBe(false)
  })

  test("loses the 'unmerged' label an earlier run gave it", async () => {
    const ran = await setAsideThen(
      () => squashed("a", { "a/a.go": "a\n" }),
      backlog().ticket("a", { labels: ["unmerged"] }).seeds,
    )
    expect(resultOf(ran)).toEqual({ a: "Done" })
    expectLog(ran, [
      /^ {2}a, set aside in this run, .*: merged by hand, so no longer set aside; worktree and branch removed; its 'unmerged' label is removed$/,
    ])
    expect(ran.issues.find((issue) => issue.id === "a")?.labels).toEqual([])
  })

  test("not merged, is checked once more", async () => {
    const ran = await setAsideThen(() => moveMain)
    expect(resultOf(ran)).toEqual({ a: "Done" })
    expectLog(ran, [/^ {2}RECHECK: a's check failed on main/])
    expect(ran.log.some((line) => line.includes("merged by hand"))).toBe(false)
  })

  test("isn't asked of again while the base stays where it was", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds, checks: { fast: [elsewhere] } },
      withQueue((queue) =>
        Effect.gen(function* () {
          const a = yield* finished("a", { "a/a.go": "a\n" })
          yield* moveMain
          yield* queue.offer(a)
          yield* until({ a: "Review" })
          yield* queue.mergedByHand
          const asked = (yield* (yield* Repository).calls).length
          yield* queue.mergedByHand
          expect((yield* (yield* Repository).calls).length - asked).toBe(1)
          yield* queue.settled
        }),
      ),
    )
    expect(resultOf(ran)).toEqual({ a: "Review" })
  })
})

describe("a ticket left unmerged by an earlier run and merged by hand during the run", () => {
  test("loses its label as the base moves", async () => {
    const ran = await scenario(
      {
        backlog: backlog().ticket("x", { status: "closed", labels: ["unmerged"] }).seeds,
      },
      withQueue((queue) =>
        Effect.gen(function* () {
          const git = yield* Git
          const repository = yield* Repository
          const worktree = yield* (yield* Worktrees).prepare("x")
          yield* git.addWorktree(repository.dir, worktree.path, {
            branch: worktree.branch,
            base: "main",
          })
          yield* repository.commit(worktree.path, "Do x (x)", { "x.txt": "x\n" })
          yield* queue.mergedByHand
          yield* squashed("x", { "x.txt": "x\n" })
          expect(yield* queue.mergedByHand).toEqual(["x"])
        }),
      ),
    )
    resultOf(ran)
    expectLog(ran, [
      /^ {2}x, left unmerged by an earlier run, is on main now \([0-9a-f]{7} Squash-merge x \(x\)\): merged by hand; its 'unmerged' label is removed$/,
    ])
    expect(ran.issues.find((issue) => issue.id === "x")?.labels).toEqual([])
  })
})

describe("the tickets waiting to be checked once more", () => {
  test("a drain names each it keeps from its recheck", async () => {
    const ran = await setAsideThen((queue) =>
      Effect.gen(function* () {
        expect(yield* hear({ on: true, how: "by SIGUSR1" }, queue.rechecks)).toBe(true)
        expect(yield* queue.rechecks.waiting).toEqual([])
        yield* moveMain
      }),
    )
    expect(resultOf(ran)).toEqual({ a: "Review" })
    expectLog(ran, [
      "DRAIN: stopping now, as nothing is running, asked by SIGUSR1",
      "  a is not checked again in this run, as the run winds down; it stays set aside",
    ])
    expect(ran.log.some((line) => line.includes("RECHECK"))).toBe(false)
  })

  test("a ticket set aside while the run winds down isn't promised one", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds, checks: { fast: [elsewhere] } },
      withQueue((queue) =>
        Effect.gen(function* () {
          const a = yield* finished("a", { "a/a.go": "a\n" })
          yield* moveMain
          yield* hear({ on: true, how: "by SIGUSR1" }, queue.rechecks)
          yield* queue.offer(a)
          yield* until({ a: "Review" })
          expect(yield* queue.rechecks.waiting).toEqual([])
          yield* queue.settled
        }),
      ),
    )
    expect(resultOf(ran)).toEqual({ a: "Review" })
    expectLog(ran, [
      /^ {2}CHECKS_FAILED: a closed, .*; not checked again in this run, as it winds down$/,
    ])
  })

  test("a run that stops names each", async () => {
    const ran = await setAsideThen((queue) =>
      Effect.gen(function* () {
        expect(yield* dropRechecks(queue.rechecks, "the run stopped")).toEqual(["a"])
        expect(yield* dropRechecks(queue.rechecks, "the run stopped")).toEqual([])
      }),
    )
    expect(resultOf(ran)).toEqual({ a: "Review" })
    expectLog(ran, ["  a is not checked again in this run, as the run stopped; it stays set aside"])
  })
})
