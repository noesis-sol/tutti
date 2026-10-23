// A ticket set aside for a failed check whose worktree has a file left untracked since (§ 5 item 8):
// the check once more would run in the worktree and see it, but the merge of its branch wouldn't
// bring it in, so the ticket stays set aside and the log names the file.
import { describe, expect, test } from "bun:test"
import { Effect, type Scope, Stream } from "effect"
import { Ledger, type State } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import { Cause, type PhaseTag } from "../src/run/phase.ts"
import { Beads } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { backlog, type Env, expectLog, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main" }

/** A failure in a file no ticket here changes. */
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

/** Waits until every ticket named is in its phase. */
const until = (phases: Readonly<Record<string, PhaseTag>>) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    yield* ledger.changes.pipe(
      Stream.filter((state: State) =>
        Object.entries(phases).every(([id, phase]) => state.tickets.get(id)?.phase._tag === phase),
      ),
      Stream.runHead,
    )
  })

/** Runs `body` with a merge queue. */
const withQueue = (
  body: (queue: MergeQueue) => Effect.Effect<void, unknown, Env | Ledger | Scope.Scope>,
) =>
  Effect.gen(function* () {
    yield* body(yield* makeQueue(options))
  }).pipe(Effect.provide(Ledger.layer))

/**
 * `a` finishes after main moved and its check fails, `left` is written in its worktree, then `b`
 * finishes and merges on top of main, which puts `a` back to be checked once more if nothing stops it.
 */
const leftInA = (left: Files, phases: Readonly<Record<string, PhaseTag>>) =>
  scenario(
    { backlog: backlog().ticket("a").ticket("b").seeds, checks: { fast: [elsewhere] } },
    withQueue((queue) =>
      Effect.gen(function* () {
        const repository = yield* Repository
        const a = yield* finished("a", { "a/a.go": "a\n" })
        yield* repository.commit(repository.dir, "Land something else", { "main.txt": "moved\n" })
        yield* queue.offer(a)
        yield* until({ a: "Review" })
        yield* repository.write(a.worktree, left)
        yield* queue.offer(yield* finished("b", { "b/b.go": "b\n" }))
        yield* until({ b: "Done" })
        yield* until(phases)
        yield* queue.settled
      }),
    ),
  )

describe("a ticket set aside as its check failed, a file left untracked in its worktree since", () => {
  test("stays set aside and the log names the file", async () => {
    const ran = await leftInA({ "a/extra.go": "extra\n" }, { a: "Review", b: "Done" })
    expectLog(ran, [
      /^ {2}a is not checked again: \S+ has untracked files: a\/extra\.go; it stays set aside$/,
    ])
    expect(ran.log.some((line) => line.includes("RECHECK"))).toBe(false)
    expect(ran.checkRuns).toHaveLength(1)
  })

  test("is checked once more when the only untracked file is under .tutti/run/", async () => {
    const ran = await leftInA({ ".tutti/run/worker-check.log": "ok\n" }, { a: "Done", b: "Done" })
    expectLog(ran, [/^ {2}RECHECK: a's check failed on main at [0-9a-f]{7}/])
    expect(ran.checkRuns).toHaveLength(2)
  })
})
