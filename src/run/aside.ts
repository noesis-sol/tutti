// Setting a ticket aside (§ 5.1, Working → Deferred by tutti), as orchestra's putAside does: the
// ticket's notes say what happened and how to bring it back, bd defers it, and its phase moves to
// Deferred with a `deferred` record and its log line. A ticket bd can't defer is still kept out of
// this run: DEFER_FAILED says so, in the log and in a `warn` record with `aside`.
import { Effect, Result } from "effect"
import { Beads } from "../services/Beads.ts"
import { Ledger } from "./ledger.ts"
import * as log from "./log.ts"
import { type Line, Log } from "./log.ts"
import { Cause } from "./phase.ts"

/** The ticket set aside: its ID and title, as its records name it. */
export interface AsideTicket {
  readonly id: string
  readonly title: string
}

/** What setting a ticket aside says, and where. */
export interface Aside {
  /** Appended to the ticket's notes: what happened, and how to bring it back. */
  readonly note: string
  /** bd defer's reason. */
  readonly reason: string
  /** Why, in a few words: the Deferred phase's `why` and the records' `detail`. */
  readonly detail: string
  /** The log's line once it is deferred. */
  readonly deferred: Line
  /** What DEFER_FAILED says before bd's error, as in `<why>, and bd could not defer <id>`. */
  readonly failed: string
  /** What DEFER_FAILED says after `kept out of this run, `: what to do instead. */
  readonly instead: string
}

/** Sets the ticket aside; whether bd deferred it. */
export const putAside = (
  ticket: AsideTicket,
  aside: Aside,
): Effect.Effect<boolean, never, Beads | Ledger | Log> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const ledger = yield* Ledger
    const logs = yield* Log
    const deferred = yield* Effect.result(
      Effect.andThen(
        beads.update(ticket.id, { appendNotes: aside.note }),
        beads.defer(ticket.id, { reason: aside.reason }),
      ),
    )
    const cause = Cause.Defer({ why: aside.detail })
    if (Result.isSuccess(deferred)) {
      yield* ledger.transition(ticket.id, cause, {
        beside: [
          {
            kind: "deferred",
            ticket: ticket.id,
            title: ticket.title,
            detail: aside.detail,
            text: aside.deferred,
          },
        ],
      })
      yield* logs.write(aside.deferred)
      return true
    }
    const text = log.ticketLine(
      log.Tag.deferFailed,
    )`${aside.failed}: ${deferred.failure.message}; kept out of this run, ${aside.instead}`
    yield* ledger.transition(ticket.id, cause, {
      beside: [{ kind: "warn", ticket: ticket.id, aside: true, detail: aside.detail, text }],
    })
    yield* logs.write(text)
    return false
  })
