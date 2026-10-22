// Steering (§ 4.3, § 7.5, § 10): what the run does with the worker view's SendMessage, Interrupt,
// Release and HandBackNow commands, once run.ts has resolved them.
//
// - A message you type goes into the worker's inbox as you typed it: without client_composed and
//   with origin human (§ 4.1), under the uuid the composer drew, so its `queued` mark can follow it.
//   The log has its length, never its text (MESSAGE: you → <id> (212 characters)), as does its
//   `message` record, and the ledger tallies it for the reviewer and notes its time: the idle grace
//   for PAUSED counts from your last message (settle.ts).
// - An interrupt stops the worker's turn, and the host cancels the messages still queued behind it
//   (interrupt_cancel_queued_v1 where the CLI has it, else cancel_async_message, AgentHost § 4.8).
// - Either makes the worker steered, first, so that nothing tutti sends races your message: the
//   STEERED line and its `steered` record, once until it is released. A steered worker is sent
//   nothing automatically: no continue nudges (settle.ts), no hand-backs (handback.ts,
//   checkback.ts), no "carry on" (usageLimit.ts, settle.ts).
// - Release makes it unsteered, wherever its ticket is: the RELEASED line and its `released` record.
//   A hand-back that waited for it is handed over then, as HandBackNow does but with no waiver: it
//   waited only because the worker was steered. Leaving its view doesn't release it: nothing here
//   hears the view close.
// - HandBackNow hands over the conflict that waited for a steered worker: the ticket, Blocked on
//   MERGE_CONFLICT, goes back in the merge queue (Blocked → ToMerge, HandedOver), is rebased again,
//   and its conflict is handed back with the steered check waived for that once (handback.ts).
import { Effect, Result } from "effect"
import { AgentHost } from "../agent/AgentHost.ts"
import { EventStream } from "./eventstream.ts"
import type { RebaseStop } from "./handback.ts"
import { Ledger } from "./ledger.ts"
import * as log from "./log.ts"
import { detail, type Line, Log, Tag } from "./log.ts"
import type { MergeOptions } from "./merge.ts"
import type { MergeQueue } from "./mergequeue.ts"
import { Cause } from "./phase.ts"

/** What steering reads and writes through. */
export type SteerEnv = AgentHost | Ledger | Log | EventStream

/** How long a message is, as its MESSAGE line and `message` record say: its characters. */
export const lengthOf = (text: string): number => [...text].length

/**
 * Marks the ticket's worker steered by `by`: the STEERED line and its `steered` record when it
 * wasn't steered already. A ticket the run no longer has is left alone.
 */
export const steer = (ticket: string, by: "message" | "interrupt") =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const logs = yield* Log
    const events = yield* EventStream
    const entry = (yield* ledger.current).tickets.get(ticket)
    if (entry === undefined) return
    yield* ledger.steer(ticket, by)
    if (entry.steered) return
    const text = log.steered(ticket)
    yield* logs.writeWith([text], events.emit({ kind: "steered", ticket, text }))
  })

/**
 * Sends your message `text` to the ticket's worker under `uuid`, the worker steered first: its
 * MESSAGE line and `message` record, with its length only, and one more message in its tallies.
 * Whether the worker took it; one whose session has ended didn't, and nothing is recorded.
 */
export const sendMessage = (
  ticket: string,
  text: string,
  uuid: string,
): Effect.Effect<boolean, never, SteerEnv> =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    const ledger = yield* Ledger
    const logs = yield* Log
    const events = yield* EventStream
    yield* steer(ticket, "message")
    const sent = yield* Effect.result(host.send(ticket, text, "human", uuid))
    if (Result.isFailure(sent)) {
      yield* Effect.logDebug(`dropped SendMessage: ${sent.failure.message}`)
      return false
    }
    yield* ledger.count(ticket, "messages")
    const said = log.message(ticket, text)
    yield* logs.writeWith(
      [said],
      events.emit({ kind: "message", ticket, length: lengthOf(text), text: said }),
    )
    return true
  })

/**
 * Interrupts the turn of the ticket's worker, the worker steered first; the host cancels the
 * messages queued behind it. Whether it was interrupted.
 */
export const interrupt = (ticket: string): Effect.Effect<boolean, never, SteerEnv> =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    yield* steer(ticket, "interrupt")
    const done = yield* Effect.result(host.interrupt(ticket))
    if (Result.isFailure(done)) {
      yield* Effect.logDebug(`dropped Interrupt: ${done.failure.message}`)
      return false
    }
    return true
  })

/**
 * Releases the ticket's steered worker: the RELEASED line and its `released` record. Whether it
 * was steered, and so released.
 */
export const release = (ticket: string): Effect.Effect<boolean, never, SteerEnv> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const logs = yield* Log
    const events = yield* EventStream
    if ((yield* ledger.current).tickets.get(ticket)?.steered !== true) return false
    yield* ledger.release(ticket)
    const text = log.released(ticket)
    yield* logs.writeWith([text], events.emit({ kind: "released", ticket, text }))
    return true
  })

type HandBackQueue = Pick<MergeQueue, "offer" | "handBacks">

/**
 * Puts the ticket, Blocked on the conflict that waited for its steered worker, back in the merge
 * queue: Blocked → ToMerge by HandedOver, `said` logged first. `waive`: its next rebase's conflict
 * is handed back to its worker though it is steered. Whether it went back; a ticket with no
 * hand-back waiting, or no longer Blocked on its conflict, stays as it is.
 */
const handOver = (
  ticket: string,
  queue: HandBackQueue,
  said: (stop: RebaseStop) => Line,
  waive: boolean,
  why: string,
): Effect.Effect<boolean, never, Ledger | Log | EventStream> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const logs = yield* Log
    const events = yield* EventStream
    const stop = yield* queue.handBacks.take(ticket)
    if (stop === undefined) {
      yield* Effect.logDebug(`dropped ${why}: ${ticket} has no hand-back waiting`)
      return false
    }
    const phase = (yield* ledger.current).tickets.get(ticket)?.phase
    if (phase?._tag !== "Blocked" || phase.why !== Tag.mergeConflict) {
      yield* Effect.logDebug(`dropped ${why}: ${ticket} is not blocked on its conflict`)
      yield* queue.handBacks.wait(stop)
      return false
    }
    // Said before the queue can take it up, so its merge's lines come after.
    const text = said(stop)
    yield* logs.writeWith([text], events.emit({ kind: "info", ticket, text }))
    if (waive) yield* queue.handBacks.waive(ticket)
    const moved = yield* queue.offer(stop.ticket, (place) => Cause.HandedOver({ place }), false)
    if (Result.isSuccess(moved)) return true
    // The ledger refused (PHASE_BUG, logged): the hand-back waits as it did.
    if (waive) yield* queue.handBacks.waived(ticket)
    yield* queue.handBacks.wait(stop)
    return false
  })

/**
 * Hands the ticket's steered worker the conflict that waited for it: back in the merge queue,
 * Blocked → ToMerge by HandedOver, its next rebase's conflict handed back to it though it is steered.
 * Whether it went back; a ticket with no hand-back waiting, or no longer Blocked on its conflict,
 * stays as it is.
 */
export const handBackNow = (
  ticket: string,
  queue: HandBackQueue,
  options: MergeOptions,
): Effect.Effect<boolean, never, Ledger | Log | EventStream> =>
  handOver(
    ticket,
    queue,
    (stop) =>
      detail`you handed ${ticket}'s conflict with ${options.base} to its worker; ${stop.ticket.branch} is back in the merge queue, to be rebased again and the conflict handed back`,
    true,
    "HandBackNow",
  )

/**
 * Releases the ticket's steered worker, as `release` does, and hands over the conflict that waited
 * for it, if one did (§ 4.3): it waited only because the worker was steered. The ticket goes back
 * in the merge queue as for HandBackNow, with no waiver: steered again before its rebase, the
 * hand-back waits again. Whether it went back.
 */
export const releaseAndHandOver = (
  ticket: string,
  queue: HandBackQueue,
  options: MergeOptions,
): Effect.Effect<boolean, never, SteerEnv> =>
  Effect.gen(function* () {
    if (!(yield* release(ticket))) return false
    if ((yield* queue.handBacks.waiting).every((stop) => stop.ticket.id !== ticket)) return false
    return yield* handOver(
      ticket,
      queue,
      (stop) =>
        detail`you released ${ticket}'s worker; ${stop.ticket.branch} is back in the merge queue, to be rebased onto ${options.base} again and its conflict handed back`,
      false,
      "Release",
    )
  })
