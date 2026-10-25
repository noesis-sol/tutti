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
//   (Resolving, Fixing) to a worker you released meanwhile, before the hand-back's message. A
//   ticket merged, closed, set aside or blocked has a worker that has finished: its held messages
//   aren't sent, and the log says so.
// - An interrupt (Ctrl+X) cancels them, as it cancels the messages queued behind a turn: the log
//   says so, and none of them is sent.
// - A merge that goes back in line (a quit before the fast-forward) is not over: they stay held, and
//   the run's end, stopping the ticket ToMerge, drops them with its session suspended.
//
// Holding and the end of a merge read the ticket's phase under one permit, so a message is never
// held after the merge's `over` has run: the queue moves the phase on before it calls `over`. A
// message not held is sent under that permit too, and a ticket the queue moves into its line is
// marked going under it until its phase has moved (`entering`), its messages held meanwhile: so a
// message is never sent to a ticket that went to merge after its phase was read. The mark, not the
// permit, spans the move, so a merge's `over` doesn't wait on an offer that waits on the ledger.
import { Effect, Ref, Semaphore } from "effect"
import type { MessageUuid } from "../agent/AgentHost.ts"
import type { TicketId } from "../services/Beads.ts"
import type { EventStream } from "./eventstream.ts"
import { Ledger, showsCard } from "./ledger.ts"
import { detail, type Log } from "./log.ts"
import type { TicketPhase } from "./phase.ts"
import { info } from "./say.ts"
import { lengthOf, type SteerEnv, sendMessage, steer } from "./steer.ts"

/** A message you sent a merging ticket's worker, held under the uuid the composer drew for it. */
export interface HeldMessage {
  readonly text: string
  readonly uuid: MessageUuid
}

/** Whether a ticket in `phase` holds your messages: waiting to merge or merging. */
export const holdsMessages = (phase: TicketPhase): boolean =>
  phase._tag === "ToMerge" || phase._tag === "Merging"

/** The line a message held says: its length, never its text, as its MESSAGE line will. */
export const heldLine = (id: TicketId, text: string, phase: TicketPhase) =>
  detail`your message to ${id}'s worker (${lengthOf(text)} characters) is held, as ${id} ${phase._tag === "Merging" ? "is merging" : "waits to merge"}: tutti sends it once the merge is over, so that its branch doesn't move under its check`

/** The line the messages held for a worker that finished as its merge ended say. */
export const notSentLine = (id: TicketId, count: number) =>
  detail`${count === 1 ? "your message" : `your ${count} messages`} held for ${id}'s worker ${count === 1 ? "was" : "were"} not sent: its merge is over, and its worker has finished`

/** The line the messages held for a worker you interrupted say. */
export const cancelledLine = (id: TicketId, count: number) =>
  detail`${count === 1 ? "your message" : `your ${count} messages`} held for ${id}'s worker ${count === 1 ? "is" : "are"} cancelled by your interrupt: ${count === 1 ? "it is" : "they are"} not sent`

/** The messages held for merging tickets' workers. */
export interface Held {
  /**
   * Holds your message to the ticket's worker when its ticket waits to merge or merges, its worker
   * steered first: whether it did. One that isn't held is for steer.ts to send.
   */
  hold(ticket: TicketId, message: HeldMessage): Effect.Effect<boolean, never, SteerEnv>
  /**
   * Holds your message as `hold` does, or sends it to the ticket's worker as steer.ts does, its
   * ticket's phase read and the message sent under one permit: no ticket goes to merge between.
   */
  holdOrSend(ticket: TicketId, message: HeldMessage): Effect.Effect<void, never, SteerEnv>
  /**
   * Runs `effect`, which moves the ticket into the merge queue, the ticket marked going meanwhile:
   * a message `holdOrSend` decided to send is sent before it, and one after it is held. A move the
   * ledger refused leaves the ticket where it was: what was held meanwhile goes as at `over`.
   */
  entering<A, E, R>(
    ticket: TicketId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R | SteerEnv>
  /**
   * The ticket's merge is over: its held messages are sent if it keeps its card, and dropped with a
   * line saying so if it doesn't. A ticket still waiting to merge or merging keeps them held.
   */
  over(ticket: TicketId): Effect.Effect<void, never, SteerEnv>
  /** Cancels the ticket's held messages, as you interrupted its worker: none of them is sent. */
  cancel(ticket: TicketId): Effect.Effect<void, never, Log | EventStream>
  /** The messages held now, by ticket. */
  readonly messages: Effect.Effect<ReadonlyMap<string, ReadonlyArray<HeldMessage>>>
}

/** A run's held messages: none yet. */
export const makeHeld: Effect.Effect<Held> = Effect.gen(function* () {
  const ref = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<HeldMessage>>>(new Map())
  const permit = yield* Semaphore.make(1)
  // The tickets going into the merge queue, their phases not moved yet (`entering`).
  const going = yield* Ref.make<ReadonlySet<string>>(new Set())
  // Holds the message when its ticket's phase does, or it is going, under the permit its caller took.
  const holding = (ticket: TicketId, message: HeldMessage) =>
    Effect.gen(function* () {
      const entry = (yield* (yield* Ledger).current).tickets.get(ticket)
      if (entry === undefined) return false
      if (!holdsMessages(entry.phase) && !(yield* Ref.get(going)).has(ticket)) return false
      yield* steer(ticket, "message")
      yield* Ref.update(
        ref,
        (all) => new Map([...all, [ticket, [...(all.get(ticket) ?? []), message]]]),
      )
      const said = heldLine(ticket, message.text, entry.phase)
      yield* info(said, ticket)
      return true
    })
  const hold: Held["hold"] = (ticket, message) => permit.withPermit(holding(ticket, message))
  const holdOrSend: Held["holdOrSend"] = (ticket, message) =>
    permit.withPermit(
      Effect.gen(function* () {
        if (yield* holding(ticket, message)) return
        yield* sendMessage(ticket, message)
      }),
    )
  const over: Held["over"] = (ticket) =>
    permit.withPermit(
      Effect.gen(function* () {
        const entry = (yield* (yield* Ledger).current).tickets.get(ticket)
        if (entry !== undefined && holdsMessages(entry.phase)) return
        if ((yield* Ref.get(going)).has(ticket)) return
        const held = (yield* Ref.get(ref)).get(ticket) ?? []
        if (held.length === 0) return
        yield* Ref.update(ref, (all) => new Map([...all].filter(([id]) => id !== ticket)))
        if (entry !== undefined && showsCard(entry)) {
          for (const message of held) yield* sendMessage(ticket, message)
          return
        }
        const said = notSentLine(ticket, held.length)
        yield* info(said, ticket)
      }),
    )
  const cancel: Held["cancel"] = (ticket) =>
    permit.withPermit(
      Effect.gen(function* () {
        const held = (yield* Ref.get(ref)).get(ticket) ?? []
        if (held.length === 0) return
        yield* Ref.update(ref, (all) => new Map([...all].filter(([id]) => id !== ticket)))
        const said = cancelledLine(ticket, held.length)
        yield* info(said, ticket)
      }),
    )
  const entering: Held["entering"] = (ticket, effect) =>
    Effect.acquireUseRelease(
      permit.withPermit(Ref.update(going, (all) => new Set([...all, ticket]))),
      () => effect,
      () =>
        Effect.andThen(
          permit.withPermit(
            Ref.update(going, (all) => new Set([...all].filter((id) => id !== ticket))),
          ),
          over(ticket),
        ),
    )
  return {
    hold,
    holdOrSend,
    entering,
    over,
    cancel,
    messages: Ref.get(ref),
  }
})
