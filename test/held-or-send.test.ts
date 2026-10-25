// Holding a message or sending it as one step (held.ts, § 4.3): the ticket's phase is read and the
// message sent under one permit, and a ticket the merge queue moves into its line is marked going
// under it until its phase has moved, so its message is held, never sent into its merge.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Result, type Scope } from "effect"
import { AgentHost, type MessageUuid } from "../src/agent/AgentHost.ts"
import { heldLine, makeHeld } from "../src/run/held.ts"
import { Ledger, make as makeLedger } from "../src/run/ledger.ts"
import { Tag } from "../src/run/log.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Move, TicketPhase } from "../src/run/phase.ts"
import { untilSettled } from "../src/run/settle.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { init, result, sessionState } from "../src/testing/AgentHost.ts"
import { Repository } from "../src/testing/Git.ts"
import { backlog, type Env, type Ran, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main" }
const yours = "11111111-2222-4333-8444-555555555555" as MessageUuid
const words = "Also cover the empty case 🙂"

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** What a's worker was sent of yours: the messages' uuids and texts. */
const yoursTo = (ran: Ran<unknown>) =>
  ran.sent.flatMap((sent) =>
    sent._tag === "Message" && sent.ticket === "a" && sent.message.client_composed !== true
      ? [{ uuid: sent.message.uuid, text: sent.message.message.content }]
      : [],
  )

const provided = <A>(effect: Effect.Effect<A, unknown, Env | Ledger | Scope.Scope>) =>
  effect.pipe(Effect.provide(Ledger.layer)) as Effect.Effect<A, unknown, Env | Scope.Scope>

/** Ticket a, Working, its worker's session started and settled idle. */
const working = Effect.gen(function* () {
  const git = yield* Git
  const repository = yield* Repository
  const worktree = yield* (yield* Worktrees).prepare("a" as TicketId)
  yield* git.addWorktree(repository.dir, worktree.path, { branch: worktree.branch, base: "main" })
  yield* repository.commit(worktree.path, "Do a (a)", { "a.txt": "a\n" })
  yield* (yield* Beads).close("a" as TicketId, "done")
  const ledger = yield* Ledger
  yield* ledger.transition("a" as TicketId, Move.Ready(), { title: "Ticket a" })
  yield* ledger.transition("a" as TicketId, Move.Dispatched())
  yield* (yield* Store).saveSession("a" as TicketId, {
    session: "session-a",
    worktree: worktree.path,
    branch: worktree.branch,
  })
  yield* (yield* AgentHost).start("a" as TicketId, { sessionId: "session-a", cwd: worktree.path })
  yield* untilSettled("a" as TicketId)
  return {
    id: "a" as TicketId,
    title: "Ticket a",
    branch: worktree.branch,
    worktree: worktree.path,
  } satisfies FinishedTicket
})

const session = [init(), sessionState("running"), result(), sessionState("idle")]

describe("holding a message or sending it", () => {
  test("sends it to a Working ticket's worker, steering it", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds, scripts: { a: [session] } },
      provided(
        Effect.gen(function* () {
          const held = yield* makeHeld
          yield* working
          yield* held.holdOrSend("a" as TicketId, { text: words, uuid: yours })
          return {
            steered: (yield* (yield* Ledger).current).tickets.get("a" as TicketId)?.steered,
            held: yield* held.messages,
          }
        }),
      ),
    )
    const ended = resultOf(ran)
    expect(ended.steered).toBe(true)
    expect(ended.held.size).toBe(0)
    expect(yoursTo(ran)).toEqual([{ uuid: yours, text: words }])
    expect(ran.log).toContain(`  ${Tag.message}: you → a (27 characters)`)
  })

  test("holds it for a ticket going to merge whose phase hasn't moved yet", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds, scripts: { a: [session] } },
      provided(
        Effect.gen(function* () {
          const ledger = yield* Ledger
          const held = yield* makeHeld
          yield* working
          const kept = yield* held.entering(
            "a" as TicketId,
            Effect.gen(function* () {
              yield* held.holdOrSend("a" as TicketId, { text: words, uuid: yours })
              const kept = (yield* held.messages).get("a")
              yield* ledger.transition("a" as TicketId, Move.Verified({ place: 1 }))
              return kept
            }),
          )
          return { kept, after: (yield* held.messages).get("a") }
        }),
      ),
    )
    const ended = resultOf(ran)
    expect(ended.kept).toEqual([{ text: words, uuid: yours }])
    expect(ended.after).toEqual([{ text: words, uuid: yours }])
    expect(yoursTo(ran)).toEqual([])
    // Its line says it waits to merge, as it will once its phase has moved.
    expect(ran.log).toContain(heldLine("a" as TicketId, words, TicketPhase.ToMerge({ place: 1 })))
  })

  test("sends what it held once a move the ledger refused leaves the ticket Working", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds, scripts: { a: [session] } },
      provided(
        Effect.gen(function* () {
          const ledger = yield* Ledger
          const held = yield* makeHeld
          yield* working
          const moved = yield* held.entering(
            "a" as TicketId,
            Effect.andThen(
              held.holdOrSend("a" as TicketId, { text: words, uuid: yours }),
              ledger.transition("a" as TicketId, Move.ItsTurn()),
            ),
          )
          return { refused: Result.isFailure(moved), after: yield* held.messages }
        }),
      ),
    )
    const ended = resultOf(ran)
    expect(ended.refused).toBe(true)
    expect(ended.after.size).toBe(0)
    expect(yoursTo(ran)).toEqual([{ uuid: yours, text: words }])
  })

  test("holds it for a ticket the merge queue's offer is moving into its line", async () => {
    const entered = Deferred.makeUnsafe<void>()
    const open = Deferred.makeUnsafe<void>()
    // The ledger, a's move into the queue held until the test opens it.
    const gated = Layer.effect(
      Ledger,
      Effect.map(makeLedger, (ledger) => ({
        ...ledger,
        transition: (
          ticket: TicketId,
          cause: Move,
          more?: Parameters<typeof ledger.transition>[2],
        ) => {
          const moved = ledger.transition(ticket, cause, more)
          return ticket === "a" && cause._tag === "Verified"
            ? Effect.andThen(
                Deferred.succeed(entered, undefined),
                Effect.andThen(Deferred.await(open), moved),
              )
            : moved
        },
      })),
    )
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds, scripts: { a: [session] } },
      Effect.gen(function* () {
        const ledger = yield* Ledger
        const queue = yield* makeQueue(options)
        const a = yield* working
        const offered = yield* Effect.forkChild(queue.offer(a, undefined, false))
        yield* Deferred.await(entered)
        yield* queue.held.holdOrSend("a" as TicketId, { text: words, uuid: yours })
        const before = (yield* ledger.current).tickets.get("a" as TicketId)?.phase._tag
        yield* Deferred.succeed(open, undefined)
        yield* Fiber.join(offered)
        return {
          before,
          after: (yield* ledger.current).tickets.get("a" as TicketId)?.phase._tag,
          held: (yield* queue.held.messages).get("a"),
        }
      }).pipe(Effect.provide(gated)) as Effect.Effect<unknown, unknown, Env | Scope.Scope>,
    )
    const ended = resultOf(ran) as { before: string; after: string; held: unknown }
    expect(ended.before).toBe("Working")
    expect(ended.after).toBe("ToMerge")
    expect(ended.held).toEqual([{ text: words, uuid: yours }])
    expect(yoursTo(ran)).toEqual([])
  })
})
