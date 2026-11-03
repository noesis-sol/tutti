// A one-ticket scenario for the background tasks a worker leaves running as its turns end
// (src/run/settle.ts' stopLeftTasks): test/left-tasks.test.ts and test/left-agents.test.ts.

import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Fiber, type Scope } from "effect"
import { makeHandBacks } from "../src/run/handback.ts"
import { makeHeld } from "../src/run/held.ts"
import { Ledger } from "../src/run/ledger.ts"
import { emptyQueue, type MergeQueue } from "../src/run/mergequeue.ts"
import { Move } from "../src/run/phase.ts"
import { makeRechecks } from "../src/run/recheck.ts"
import type { StartTicket } from "../src/run/start.ts"
import { type Worked, work } from "../src/run/work.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import {
  awaitStopTask,
  type LiveTask,
  type SessionScript,
  selfStartedTurn,
  taskStopped,
} from "../src/testing/AgentHost.ts"
import { Repository } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import { backlog, type Env, type Ran, scenario, type World } from "./harness.ts"

export const id = "t-1" as TicketId
const ticket: StartTicket = { id, title: "One ticket", metadata: {} }

/** A merge queue that only puts the ticket in line, ToMerge. */
const lineOnly: Effect.Effect<MergeQueue, never, Ledger> = Effect.gen(function* () {
  const ledger = yield* Ledger
  return {
    offer: (finished, cause = (place) => Move.Verified({ place })) =>
      ledger.transition(finished.id, cause(1)),
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

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** What the worker's commands do to the in-memory Beads and git, its worktree in `root`. */
const commands = (world: World, root: string) => ({
  claim: orDie(world.beads.update(id, { claim: true })),
  commit: orDie(world.repository.commit(join(root, id), `Change (${id})`, { "a.txt": "a\n" })),
  close: orDie(world.beads.close(id, "done")),
})

export type Commands = ReturnType<typeof commands>

/**
 * A stop of `task`: the CLI's notification, the set left with `left`, and the turn it starts to
 * report it.
 */
export const stoppedTask = (task: string, ...left: ReadonlyArray<LiveTask>): SessionScript => [
  awaitStopTask,
  ...taskStopped(task, ...left),
  ...selfStartedTurn(),
]

/**
 * Dispatches the ticket and runs its fiber on main, its worktree in a new folder, its worker's one
 * session `session`; `during` runs beside it before it is joined.
 */
export const working = (
  session: (c: Commands) => SessionScript,
  during: (fiber: Fiber.Fiber<Worked, unknown>) => Effect.Effect<void, unknown, Env | Ledger>,
): Promise<Ran<Worked>> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-left-tasks-")))
  return scenario(
    {
      backlog: backlog().ticket(id, { title: "One ticket" }).seeds,
      worktrees: { root },
      scripts: (world) => ({ [id]: [session(commands(world, root))] }),
    },
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const git = yield* Git
      const repository = yield* Repository
      yield* git.addWorktree(repository.dir, join(root, id), {
        branch: `tutti/${id}`,
        base: "main",
      })
      yield* ledger.transition(id, Move.Ready(), { title: ticket.title })
      yield* ledger.transition(id, Move.Dispatched())
      const fiber = yield* Effect.forkChild(work(ticket, { base: "main", queue: yield* lineOnly }))
      yield* during(fiber)
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<Worked, unknown, Env | Scope.Scope>,
  )
}

export const workedOf = (ran: Ran<Worked>): Worked => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** The tasks the worker's session was asked to stop, in order. */
export const stops = (ran: Ran<unknown>) =>
  ran.sent.flatMap((sent) => (sent._tag === "StopTask" ? [`${sent.ticket} ${sent.task}`] : []))

/** Waits, yielding, until the log has a line matching `pattern`, then a little more. */
export const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 20_000; i++) {
      if ((yield* texts).some((each) => pattern.test(each))) break
      yield* Effect.yieldNow
    }
    for (let i = 0; i < 200; i++) yield* Effect.yieldNow
  })

/** Lets every fiber run as far as it can without the clock moving. */
export const quiet = Effect.gen(function* () {
  for (let i = 0; i < 2_000; i++) yield* Effect.yieldNow
})
