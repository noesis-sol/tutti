// Quitting as a ticket's fiber removes its worktree: the removal and the ledger's transition after it
// go together, so that a ticket closed with no change ends Done, not Working with its worktree gone
// (stopped as the run ends, its resume failing, left for review as WORKER_GONE), and one that waits
// for a blocker, or goes back in the queue for one merged since its cut, ends Waiting or Queued.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Exit, Fiber, type Scope } from "effect"
import { Ledger } from "../src/run/ledger.ts"
import { emptyQueue, type MergeQueue } from "../src/run/mergequeue.ts"
import { Move, type PhaseTag } from "../src/run/phase.ts"
import type { StartTicket } from "../src/run/start.ts"
import { work } from "../src/run/work.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { bash, run, type SessionScript, turn } from "../src/testing/AgentHost.ts"
import { Repository } from "../src/testing/Git.ts"
import { backlog, type Env, type Ran, scenario, type World } from "./harness.ts"

const id = "t-1" as TicketId
const blocker = "t-0" as TicketId
const ticket: StartTicket = { id, title: "One ticket", metadata: {} }

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** A merge queue that is never offered anything: none of these tickets has a change to merge. */
const noQueue = {
  offer: () => Effect.die("offered"),
  state: Effect.succeed(emptyQueue),
} as unknown as MergeQueue

/** Merges the blocker on main, as the run's merge queue does: its commit, Done{merged} in the ledger. */
const mergeBlocker = Effect.gen(function* () {
  const ledger = yield* Ledger
  const repository = yield* Repository
  const commit = yield* repository.commit(repository.dir, `Change (${blocker})`, {
    "t-0.txt": "t-0\n",
  })
  yield* (yield* Beads).close(blocker, "done")
  yield* ledger.transition(blocker, Move.Ready(), { title: "t-0" })
  yield* ledger.transition(blocker, Move.Dispatched())
  yield* ledger.transition(blocker, Move.Verified({ place: 1 }))
  yield* ledger.transition(blocker, Move.ItsTurn())
  yield* ledger.transition(blocker, Move.FastForwarded({ commit }))
})

/**
 * Runs the ticket's fiber with its worktree's removal held until the fiber has been interrupted;
 * its phase in the ledger once the interrupted fiber has ended.
 */
const quitAsItRemoves = (
  scripts: (world: World) => Readonly<Record<string, ReadonlyArray<SessionScript>>>,
  options: { readonly afterCut?: Effect.Effect<void, unknown, Env | Ledger> } = {},
): Promise<Ran<PhaseTag | undefined>> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-remove-interrupt-")))
  return scenario(
    {
      backlog: backlog().ticket("t-0").ticket(id, { title: "One ticket" }).seeds,
      scripts,
      worktrees: { root },
    },
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const git = yield* Git
      const repository = yield* Repository
      yield* git.addWorktree(repository.dir, join(root, id), {
        branch: `tutti/${id}`,
        base: "main",
      })
      if (options.afterCut !== undefined) yield* options.afterCut
      yield* ledger.transition(id, Move.Ready(), { title: ticket.title })
      yield* ledger.transition(id, Move.Dispatched())
      const removing = yield* Deferred.make<void>()
      const removed = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(
        work(ticket, { base: "main", queue: noQueue }).pipe(
          Effect.updateService(Worktrees, (worktrees) =>
            Worktrees.of({
              ...worktrees,
              remove: (ticket, removal) =>
                Effect.andThen(
                  Effect.andThen(Deferred.succeed(removing, undefined), Deferred.await(removed)),
                  worktrees.remove(ticket, removal),
                ),
            }),
          ),
        ),
      )
      yield* Deferred.await(removing)
      // Quitting: the run interrupts the ticket's fiber, and waits for it to end.
      const quit = yield* Effect.forkChild(Fiber.interrupt(fiber))
      yield* Effect.yieldNow
      yield* Deferred.succeed(removed, undefined)
      yield* Fiber.join(quit)
      return (yield* ledger.current).tickets.get(id)?.phase._tag
    }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<
      PhaseTag | undefined,
      unknown,
      Env | Scope.Scope
    >,
  )
}

const phaseOf = (ran: Ran<PhaseTag | undefined>): PhaseTag | undefined => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** Its worker claims it and links the blocker, leaving it open. */
const links = (world: World) => ({
  [id]: [
    turn([
      run(orDie(world.beads.update(id, { claim: true }))),
      run(orDie(world.beads.addDependency(id, blocker))),
      run(orDie(world.beads.update(id, { status: "open" }))),
    ]),
  ],
})

describe("quitting as a ticket's worktree is removed", () => {
  test("closed with no change: Done, not left Working with its worktree gone", async () => {
    const ran = await quitAsItRemoves((world) => ({
      [id]: [turn([...bash(`bd close ${id}`, orDie(world.beads.close(id, "done")))])],
    }))
    expect(phaseOf(ran)).toBe("Done")
    expect(ran.worktreeCalls).toContainEqual({ op: "remove", id, force: false })
  })

  test("waiting for a blocker to merge: Waiting", async () => {
    const ran = await quitAsItRemoves(links)
    expect(phaseOf(ran)).toBe("Waiting")
  })

  test("a blocker merged since its cut: back in the queue", async () => {
    const ran = await quitAsItRemoves(links, { afterCut: mergeBlocker })
    expect(phaseOf(ran)).toBe("Queued")
  })
})
