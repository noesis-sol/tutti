// HandBackNow on a ticket set aside, its conflict not handed back once more (§ 4.3): a ticket no
// longer Blocked on its conflict stays set aside, and one the ledger refuses to put back in the merge
// queue is left as it was, its hand-backs' limit, its taking up and its waiver all undone.
import { describe, expect, test } from "bun:test"
import { Effect, Exit, type Scope } from "effect"
import { makeHandBacks, maxHandBacks } from "../src/run/handback.ts"
import { makeHeld } from "../src/run/held.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { emptyQueue, type MergeQueue } from "../src/run/mergequeue.ts"
import { Move } from "../src/run/phase.ts"
import { makeRechecks } from "../src/run/recheck.ts"
import { handBackNow } from "../src/run/steer.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { Repository } from "../src/testing/Git.ts"
import { backlog, type Env, type Ran, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main" }
const a = "a" as TicketId

/**
 * A merge queue whose offer puts the ticket in line by Verified, whatever move it is given: from
 * Blocked, the ledger refuses it (PHASE_BUG).
 */
const refusing: Effect.Effect<MergeQueue, never, Ledger> = Effect.gen(function* () {
  const ledger = yield* Ledger
  return {
    offer: (finished) => ledger.transition(finished.id, Move.Verified({ place: 1 })),
    state: Effect.succeed(emptyQueue),
    changes: undefined as never,
    settled: Effect.succeed(emptyQueue),
    rechecks: yield* makeRechecks,
    handBacks: yield* makeHandBacks,
    held: yield* makeHeld,
    checksAhead: undefined as never,
    recheck: Effect.succeed([]),
    mergedByHand: Effect.succeed([]),
    hold: Effect.void,
    stopMerges: Effect.void,
  } satisfies MergeQueue
})

/** Ticket a's branch, committed in a clean worktree of its own: nobody works in it. */
const committed = Effect.gen(function* () {
  const repository = yield* Repository
  const worktree = yield* (yield* Worktrees).prepare(a)
  yield* (yield* Git).addWorktree(repository.dir, worktree.path, {
    branch: worktree.branch,
    base: "main",
  })
  yield* repository.commit(worktree.path, "Do a (a)", { "a.txt": "a\n" })
  return {
    id: a,
    title: "Ticket a",
    branch: worktree.branch,
    worktree: worktree.path,
  } satisfies FinishedTicket
})

interface After {
  readonly handed: boolean
  readonly aside: ReadonlyArray<TicketId>
  readonly limit: number
  readonly takenUp: boolean
  readonly waived: boolean
}

/** Ticket a, set aside and moved by `moves`, its hand-backs used up and taken up; then `h`. */
const handedBack = (moves: ReadonlyArray<Move>): Promise<Ran<After>> =>
  scenario(
    { backlog: backlog().ticket("a").seeds, scripts: () => ({}) },
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const queue = yield* refusing
      const ticket = yield* committed
      yield* ledger.transition(a, Move.Ready(), { title: "Ticket a" })
      for (const move of moves) yield* ledger.transition(a, move)
      for (let i = 0; i < maxHandBacks; i++) yield* queue.handBacks.next(a)
      yield* queue.handBacks.takeUp(a)
      yield* queue.handBacks.keepAside(ticket)
      const handed = yield* handBackNow(a, queue, options)
      return {
        handed,
        aside: (yield* queue.handBacks.setAside).map((each) => each.id),
        limit: yield* queue.handBacks.limit(a),
        takenUp: yield* queue.handBacks.takenUp(a),
        waived: yield* queue.handBacks.waived(a),
      } satisfies After
    }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<After, unknown, Env | Scope.Scope>,
  )

const afterIn = (ran: Ran<After>): After => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

const unchanged = {
  handed: false,
  aside: [a],
  limit: maxHandBacks,
  takenUp: true,
  waived: false,
} satisfies After

describe("handed back once more, to no effect", () => {
  test("a ticket set aside but no longer Blocked on its conflict stays set aside", async () => {
    const ran = await handedBack([Move.Dispatched()])
    expect(afterIn(ran)).toEqual(unchanged)
    expect(ran.log).toEqual([])
  })

  test("one the ledger refuses to put back in line is left as it was", async () => {
    const ran = await handedBack([
      Move.Dispatched(),
      Move.Verified({ place: 1 }),
      Move.ItsTurn(),
      Move.Block({ why: "MERGE_CONFLICT" }),
    ])
    expect(afterIn(ran)).toEqual(unchanged)
    expect(ran.log.filter((each) => each.includes("PHASE_BUG"))).toHaveLength(1)
  })
})
