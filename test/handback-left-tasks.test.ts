// A worker that leaves a background task running as its turns in a hand-back end (a dev server, a
// watch-mode test) has it stopped at once, as settle.ts' stopLeftTasks does for a closed ticket's
// worker, so that the hand-back isn't held to its time limit (tutti-k5pd). A background agent working
// beside it goes on: the ticket is closed throughout a hand-back, which says nothing of it.

import { describe, expect, test } from "bun:test"
import { Duration, Effect, Exit } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import type { Log } from "../src/core/log.ts"
import { Ledger } from "../src/run/ledger.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import type { FinishedTicket } from "../src/run/mergeShared.ts"
import { Move, type TicketPhase } from "../src/run/phase.ts"
import { untilSettled } from "../src/run/settle.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import {
  backgroundTasks,
  init,
  type LiveTask,
  result,
  run,
  type SessionScript,
  selfStartedTurn,
  sessionState,
  sleep,
  taskEnds,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { Repository } from "../src/testing/Git.ts"
import { advance, backlog, type Ran, scenario, type World } from "./harness.ts"
import { quiet, stoppedTask, stops, untilLogged } from "./leftTasks.ts"

const options = { repo: "/repo", base: "main" }

/** The default settings with a check command, which a hand-back needs to check a resolution. */
const defaults = appConfig().settings
const withCheck = {
  config: {
    settings: {
      ...defaults,
      checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: "check" } },
    },
  },
}

const phaseOf = (ran: Ran<TicketPhase | undefined>): TicketPhase | undefined => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

const devServer: LiveTask = { id: "b1", description: "npm run dev" }
const reviewer: LiveTask = { id: "a1", type: "local_agent", description: "Review the change" }

/** Where ticket a's worktree is, once `finished` has made it: for its worker's script. */
let worktree = ""

/** Ticket a, its worker finished and idle: closed in Beads with one commit on tutti/a, Working. */
const finished = Effect.gen(function* () {
  const git = yield* Git
  const repository = yield* Repository
  const prepared = yield* (yield* Worktrees).prepare("a" as TicketId)
  worktree = prepared.path
  yield* git.addWorktree(repository.dir, prepared.path, { branch: prepared.branch, base: "main" })
  yield* repository.commit(prepared.path, "Do a (a)", { "a.txt": "a\n" })
  yield* (yield* Beads).close("a" as TicketId, "done")
  const ledger = yield* Ledger
  yield* ledger.transition("a" as TicketId, Move.Ready(), { title: "Ticket a" })
  yield* ledger.transition("a" as TicketId, Move.Dispatched())
  yield* (yield* Store).saveSession("a" as TicketId, {
    session: "session-a",
    worktree: prepared.path,
    branch: prepared.branch,
  })
  yield* (yield* AgentHost).start("a" as TicketId, { sessionId: "session-a", cwd: prepared.path })
  yield* untilSettled("a" as TicketId)
  return {
    id: "a" as TicketId,
    title: "Ticket a",
    branch: prepared.branch,
    worktree: prepared.path,
  } satisfies FinishedTicket
})

/**
 * Ticket a, conflicting with main's change to a.txt, merged until the queue settles: its worker
 * resolves the conflict by skipping its commit, leaving `left` running as its turn ends, then
 * `after`; `during` runs beside the merge.
 */
const handedBack = (
  left: ReadonlyArray<LiveTask>,
  after: SessionScript,
  during: Effect.Effect<void, never, Log>,
) =>
  scenario(
    {
      backlog: backlog().ticket("a").seeds,
      ...withCheck,
      scripts: (world: World) => ({
        a: [
          [
            init(),
            sessionState("running"),
            result(),
            sessionState("idle"),
            ...turn([
              run(
                Effect.suspend(() =>
                  world.repository.continueRebase(worktree, { "a.txt": "main's a\n" }),
                ),
              ),
              backgroundTasks(...left),
            ]),
            ...after,
          ],
        ],
      }),
    },
    Effect.gen(function* () {
      const queue = yield* makeQueue(options)
      const ticket = yield* finished
      const repository = yield* Repository
      yield* repository.commit(repository.dir, "Land something else", { "a.txt": "main's a\n" })
      yield* Effect.forkChild(during)
      yield* queue.offer(ticket)
      yield* queue.settled
      return (yield* (yield* Ledger).current).tickets.get("a" as TicketId)?.phase
    }).pipe(Effect.scoped, Effect.provide(Ledger.layer)),
  )

describe("a worker that leaves a background task running as its hand-back's turns end", () => {
  test("has it stopped at once, and the hand-back goes on without waiting out its limit", async () => {
    const ran = await handedBack(
      [devServer],
      stoppedTask("b1"),
      // The turn reporting the stop starts 70 ms after it.
      Effect.andThen(untilLogged(/stopped them/), advance("1 second")),
    )
    expect(phaseOf(ran)).toEqual(
      expect.objectContaining({
        _tag: "Done",
        outcome: expect.objectContaining({ _tag: "NoChange" }),
      }),
    )
    expect(stops(ran)).toEqual(["a b1"])
    expect(ran.log).toContain(
      "  a's worker's turns in its hand-back are over, but background tasks it left running kept it from settling; stopped them: npm run dev",
    )
  })

  test("beside an agent: only the task is stopped, and the agent finishes by itself", async () => {
    const ran = await handedBack(
      [reviewer, devServer],
      [...stoppedTask("b1", reviewer), sleep("5 minutes"), ...taskEnds("a1"), ...selfStartedTurn()],
      Effect.gen(function* () {
        yield* untilLogged(/stopped them/)
        yield* advance("1 second")
        yield* quiet
        yield* advance(Duration.minutes(5))
        yield* quiet
        yield* advance("1 second")
      }),
    )
    expect(phaseOf(ran)).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(stops(ran)).toEqual(["a b1"])
  })
})
