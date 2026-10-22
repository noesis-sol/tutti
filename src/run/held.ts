// Messages held while their ticket merges (§ 4.3, § 7.5). A ticket waiting to merge or merging is
// checked at a commit of its branch, and merges only at that one (merge.ts): a commit its worker
// makes meanwhile is checked again first. So that its branch doesn't move under its check at all,
// a message you send its worker then isn't sent: it is held, and the worker has no turn to commit
// in, as it settled before its ticket went to merge.
//
// - Holding it makes the worker steered, as sending it would, so that nothing tutti sends races it
//   (steer.ts): a conflict or a failed check its merge stops on waits for you, not handed back.
// - Once the merge is over (mergequeue.ts calls `over` before it fits the ticket's session), the
//   held messages are sent in the order you wrote them, each as steer.ts sends one, when the ticket
//   keeps its card: blocked with its hand-back waiting for its steered worker, or handed back
//   (Resolving, Fixing) to a worker you released meanwhile. A ticket merged, closed, set aside or
//   blocked has a worker that has finished: its held messages aren't sent, and the log says so.
// - A merge that goes back in line (a quit before the fast-forward) is not over: they stay held, and
//   the run's end, stopping the ticket ToMerge, drops them with its session suspended.
//
// Holding and the end of a merge read the ticket's phase under one permit, so a message is never
// held after the merge's `over` has run: the queue moves the phase on before it calls `over`.
import { Effect, Ref, Semaphore } from "effect"
import { EventStream } from "./eventstream.ts"
import { Ledger, showsCard } from "./ledger.ts"
import { detail, Log } from "./log.ts"
import type { TicketPhase } from "./phase.ts"
import { lengthOf, type SteerEnv, sendMessage, steer } from "./steer.ts"

/** A message you sent a merging ticket's worker, held under the uuid the composer drew for it. */
export interface HeldMessage {
  readonly text: string
  readonly uuid: string
}

/** Whether a ticket in `phase` holds your messages: waiting to merge or merging. */
export const holdsMessages = (phase: TicketPhase): boolean =>
  phase._tag === "ToMerge" || phase._tag === "Merging"

/** The line a message held says: its length, never its text, as its MESSAGE line will. */
export const heldLine = (id: string, text: string, phase: TicketPhase) =>
  detail`your message to ${id}'s worker (${lengthOf(text)} characters) is held, as ${id} ${phase._tag === "Merging" ? "is merging" : "waits to merge"}: tutti sends it once the merge is over, so that its branch doesn't move under its check`

/** The line the messages held for a worker that finished as its merge ended say. */
export const notSentLine = (id: string, count: number) =>
  detail`${count === 1 ? "your message" : `your ${count} messages`} held for ${id}'s worker ${count === 1 ? "was" : "were"} not sent: its merge is over, and its worker has finished`

/** The messages held for merging tickets' workers. */
export interface Held {
  /**
   * Holds your message to the ticket's worker when its ticket waits to merge or merges, its worker
   * steered first: whether it did. One that isn't held is for steer.ts to send.
   */
  hold(ticket: string, text: string, uuid: string): Effect.Effect<boolean, never, SteerEnv>
  /**
   * The ticket's merge is over: its held messages are sent if it keeps its card, and dropped with a
   * line saying so if it doesn't. A ticket still waiting to merge or merging keeps them held.
   */
  over(ticket: string): Effect.Effect<void, never, SteerEnv>
  /** The messages held now, by ticket. */
  readonly messages: Effect.Effect<ReadonlyMap<string, ReadonlyArray<HeldMessage>>>
}

/** A run's held messages: none yet. */
export const makeHeld: Effect.Effect<Held> = Effect.gen(function* () {
  const ref = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<HeldMessage>>>(new Map())
  const permit = yield* Semaphore.make(1)
  const hold: Held["hold"] = (ticket, text, uuid) =>
    permit.withPermit(
      Effect.gen(function* () {
        const entry = (yield* (yield* Ledger).current).tickets.get(ticket)
        if (entry === undefined || !holdsMessages(entry.phase)) return false
        yield* steer(ticket, "message")
        yield* Ref.update(
          ref,
          (all) => new Map([...all, [ticket, [...(all.get(ticket) ?? []), { text, uuid }]]]),
        )
        const said = heldLine(ticket, text, entry.phase)
        yield* (yield* Log).writeWith(
          [said],
          (yield* EventStream).emit({ kind: "info", ticket, text: said }),
        )
        return true
      }),
    )
  const over: Held["over"] = (ticket) =>
    permit.withPermit(
      Effect.gen(function* () {
        const entry = (yield* (yield* Ledger).current).tickets.get(ticket)
        if (entry !== undefined && holdsMessages(entry.phase)) return
        const held = (yield* Ref.get(ref)).get(ticket) ?? []
        if (held.length === 0) return
        yield* Ref.update(ref, (all) => new Map([...all].filter(([id]) => id !== ticket)))
        if (entry !== undefined && showsCard(entry)) {
          for (const message of held) yield* sendMessage(ticket, message.text, message.uuid)
          return
        }
        const said = notSentLine(ticket, held.length)
        yield* (yield* Log).writeWith(
          [said],
          (yield* EventStream).emit({ kind: "info", ticket, text: said }),
        )
      }),
    )
  return { hold, over, messages: Ref.get(ref) }
})
