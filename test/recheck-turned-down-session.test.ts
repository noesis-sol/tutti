// A ticket set aside for a failed check, then touched so that its recheck is turned down (§ 5 item
// 8): it is no longer waiting to be checked again, so its session isn't kept open for one (§ 4.8),
// and its worker is ended, as a ticket's whose recheck the run gives up (dropRechecks).
import { describe, expect, test } from "bun:test"
import { Effect, type Scope, Stream } from "effect"
import { Ledger, type State } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import { Move, type PhaseTag } from "../src/run/phase.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
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
const finished = (id: TicketId, files: Files) =>
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

/** Waits until every ticket named is in its phase. */
const until = (phases: Readonly<Record<string, PhaseTag>>) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    yield* ledger.changes.pipe(
      Stream.filter((state: State) =>
        Object.entries(phases).every(
          ([id, phase]) => state.tickets.get(id as TicketId)?.phase._tag === phase,
        ),
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

describe("a ticket set aside as its check failed, whose recheck is turned down", () => {
  test("has its worker ended, as it won't be checked again", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("a").ticket("b").seeds, checks: { fast: [elsewhere] } },
      withQueue((queue) =>
        Effect.gen(function* () {
          const repository = yield* Repository
          const a = yield* finished("a" as TicketId, { "a/a.go": "a\n" })
          yield* repository.commit(repository.dir, "Land something else", { "main.txt": "moved\n" })
          yield* queue.offer(a)
          yield* until({ a: "Review" })
          yield* (yield* Beads).update(a.id, { status: "open" })
          yield* queue.offer(yield* finished("b" as TicketId, { "b/b.go": "b\n" }))
          yield* until({ b: "Done" })
          yield* queue.settled
        }),
      ),
    )
    expectLog(ran, [/^ {2}a is not checked again: it is open now; it stays set aside$/])
    const ended = ran.sent.flatMap((sent) => (sent._tag === "Ended" ? [String(sent.ticket)] : []))
    expect(ended.toSorted()).toEqual(["a", "b"])
  })
})
