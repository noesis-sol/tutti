// Setting a ticket aside (§ 2, § 5.1), as orchestra does, either way with a note on the ticket:
//
// - deferred (Working → Deferred by tutti), as orchestra's putAside: the ticket's notes say what
//   happened and how to bring it back, bd defers it, and its phase moves to Deferred with a
//   `deferred` record and its log line. A ticket bd can't defer is still kept out of this run:
//   DEFER_FAILED says so, in the log and in a `warn` record with `aside`.
// - left for review (Working or Merging → Review{why}), as orchestra's leaveFor: the log's line goes
//   in the ticket's notes too, and its phase moves to Review with a `warn` record with `aside`. A
//   note bd can't add doesn't keep it from review. Its record in state.json gets the phase at once,
//   so a crash after it doesn't have the next run take it up as a worker still at it (carry.ts).
//
// A ticket set aside as its worker settled (deferred by its worker, or by tutti for a worker that
// left it unfinished) with nothing done, no commits beyond the base and a clean worktree, has its
// worktree and branch removed once triage has its evidence, as orchestra 0.8.1's dropNothingDone:
// nothing there is left to review. Its lines say so (nothingLeft) in place of `left open`.
import { Effect, Result } from "effect"
import { Beads, beadsWhy } from "../services/Beads.ts"
import { Store } from "../services/Store.ts"
import { cleanupWhy, Worktrees } from "../services/Worktrees.ts"
import type { EventStream } from "./eventstream.ts"
import { Ledger } from "./ledger.ts"
import type { Line, Log } from "./log.ts"
import * as log from "./log.ts"
import { Move } from "./phase.ts"
import { warn } from "./say.ts"

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

/** What leaving a ticket for review says, and where. */
export interface Review {
  /** The log's tag for it, as in CHECKS_FAILED: the Review phase's `why`. */
  readonly why: string
  /** Why, in a few words: the `warn` record's `detail`. */
  readonly detail: string
  /** The log's line, which the ticket's notes have too. */
  readonly text: Line
}

/** The note a ticket left for review gets: the log's line, without its indent. */
export const reviewNote = (text: Line): string => `tutti: ${text.trimStart()}`

/** Leaves the ticket for review: its note, Review{why} by Aside with its `warn` record, its line. */
export const leaveForReview = (
  id: string,
  review: Review,
): Effect.Effect<void, never, Beads | Ledger | Log | Store> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const ledger = yield* Ledger
    const store = yield* Store
    yield* Effect.ignore(beads.update(id, { appendNotes: reviewNote(review.text) }))
    yield* ledger.transition(id, Move.Aside({ why: review.why }), {
      said: [{ kind: "warn", ticket: id, aside: true, detail: review.detail, text: review.text }],
    })
    const record = yield* store.ticket(id)
    if (record !== undefined && record.suspended === undefined) {
      yield* Effect.ignore(store.updateTicket(id, (ticket) => ({ ...ticket, phase: "Review" })))
    }
  })

/** Sets the ticket aside; whether bd deferred it. */
export const putAside = (
  ticket: AsideTicket,
  aside: Aside,
): Effect.Effect<boolean, never, Beads | Ledger | Log> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const ledger = yield* Ledger
    const deferred = yield* Effect.result(
      Effect.andThen(
        beads.update(ticket.id, { appendNotes: aside.note }),
        beads.defer(ticket.id, { reason: aside.reason }),
      ),
    )
    const move = Move.Defer({ why: aside.detail })
    if (Result.isSuccess(deferred)) {
      yield* ledger.transition(ticket.id, move, {
        said: [
          {
            kind: "deferred",
            ticket: ticket.id,
            title: ticket.title,
            detail: aside.detail,
            text: aside.deferred,
          },
        ],
      })
      return true
    }
    const text = log.ticketLine(
      log.Tag.deferFailed,
    )`${aside.failed}: ${beadsWhy(deferred.failure)}; kept out of this run, ${aside.instead}`
    yield* ledger.transition(ticket.id, move, {
      said: [{ kind: "warn", ticket: ticket.id, aside: true, detail: aside.detail, text }],
    })
    return false
  })

/** What a set-aside ticket's lines say of a worker that left nothing done. */
export const nothingLeft = "nothing done, so its worktree and branch are removed"

/**
 * Removes the worktree and branch of a ticket set aside with nothing done, once triage has its
 * evidence. A failure is CLEANUP_FAILED, in the log and a `warn` record, as its line said they were
 * removed.
 */
export const dropNothingDone = (worktree: {
  readonly id: string
  readonly path: string
  readonly branch: string
}): Effect.Effect<void, never, EventStream | Log | Worktrees> =>
  Effect.gen(function* () {
    const { id, path, branch } = worktree
    const removed = yield* Effect.result((yield* Worktrees).remove(id))
    if (Result.isSuccess(removed)) return
    const text = log.detail`${log.Tag.cleanupFailed} for ${path} / ${branch}: ${cleanupWhy(removed.failure)}`
    yield* warn(text, id)
  })
