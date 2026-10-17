// Session lifetime (§ 4.8's Lifetime and Resume limits, § 4.7). A ticket's session's subprocess is
// kept only while the ticket needs it, and lifetime() is § 4.8's table:
//
// - open while the ticket runs, waits to merge, merges or is handed back;
// - closed, keeping its ID, once it is merged or closed with no change, asked (its turn has ended
//   by then: its worker settled), waits for a merge, is deferred or left for review;
// - open until the run ends when it was set aside after a failed check that may be checked again,
//   since a recheck may hand it a conflict;
// - suspended as the run ends when it stopped the run (the run's end does that).
//
// fit() closes the ticket's session when its phase no longer needs it. It is called wherever a
// ticket leaves a phase with its session open: once its worker's outcome is read (work.ts), and
// once its merge, or the hand-back of its conflicts, is over (mergequeue.ts).
//
// A session tutti closed may be resumed any number of times: for a hand-back, an answered question,
// the next run. A session that ended unexpectedly (Gone) with its ticket still in progress is
// resumed once per ticket per run, as orchestra resumes a worker gone from its tab, and told to
// carry on; gone again, the run holds with PAUSED (settle.ts), and the next run resumes it again.
// Resuming fails when the ticket has no saved session, its worktree is gone, the spawn fails, the
// transcript is gone, or Claude Code reports a startup_failure_reason (cwd_unavailable, …): the
// ticket is then warned about (WORKER_GONE), noted, and dropped, left for review.
import { Data, Effect, Result, Schema } from "effect"
import { AgentHost } from "../agent/AgentHost.ts"
import { Beads } from "../services/Beads.ts"
import { Store } from "../services/Store.ts"
import { leaveForReview } from "./aside.ts"
import type { resumedWhy } from "./events.ts"
import { EventStream } from "./eventstream.ts"
import { Ledger } from "./ledger.ts"
import { type Line, Log, line, Tag, ticketLine } from "./log.ts"
import type { TicketPhase } from "./phase.ts"
import type { Rechecks } from "./recheck.ts"

/**
 * What a ticket's session is in a phase (§ 4.8): open; closed, keeping its ID; open until the run
 * ends; or suspended as the run ends.
 */
export type Lifetime = "open" | "closed" | "untilRunEnds" | "suspended"

/**
 * What the ticket's session is while the ticket is in `phase`; `recheck` says whether a ticket set
 * aside after a failed check may be checked again.
 */
export const lifetime = (phase: TicketPhase, recheck = false): Lifetime => {
  switch (phase._tag) {
    case "Working":
    case "ToMerge":
    case "Merging":
    case "Resolving":
    case "Fixing":
      return "open"
    case "Review":
      return phase.why === Tag.checksFailed && recheck ? "untilRunEnds" : "closed"
    case "Stopped":
      return "suspended"
  }
  return "closed"
}

/**
 * Closes the ticket's session when its phase no longer needs it (§ 4.8). `rechecks`, the merge
 * queue's, say whether a ticket set aside after a failed check may be checked again; without them,
 * it may not.
 */
export const fit = (
  ticket: string,
  rechecks?: Rechecks,
): Effect.Effect<void, never, AgentHost | Ledger> =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    const ledger = yield* Ledger
    const phase = (yield* ledger.current).tickets.get(ticket)?.phase
    if (phase === undefined) return
    const recheck =
      rechecks !== undefined &&
      (yield* rechecks.waiting).some((waiting) => waiting.ticket.id === ticket)
    if (lifetime(phase, recheck) === "closed") yield* host.close(ticket)
  })

/** Why a session is resumed, as the `resumed` record has it. */
export type ResumeWhy = (typeof resumedWhy)[number]

/** The ticket's session couldn't be resumed: why. */
export class ResumeFailed extends Schema.TaggedError<ResumeFailed>()("ResumeFailed", {
  ticket: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `${this.ticket}'s session could not be resumed: ${this.reason}`
  }
}

/**
 * Resumes the ticket's saved session in its worktree for `why`, sending it `message`
 * (client_composed), and records it: the RESUMED line, which starts with `what`, its `resumed`
 * record, and one more resume in state.json. The message's uuid. Fails when the ticket has no saved
 * session or the session doesn't start.
 */
export const resume = (
  ticket: string,
  why: ResumeWhy,
  message: string,
  what: Line,
): Effect.Effect<string, ResumeFailed, AgentHost | Store | Log | EventStream> =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    const store = yield* Store
    const logs = yield* Log
    const events = yield* EventStream
    const saved = yield* store.ticket(ticket)
    const session = saved?.session
    const worktree = saved?.worktree
    if (session === undefined || worktree === undefined) {
      return yield* new ResumeFailed({ ticket, reason: "it has no session to resume" })
    }
    const uuid = yield* host
      .resume(
        ticket,
        { sessionId: session, cwd: worktree },
        { text: message, from: "clientComposed" },
      )
      .pipe(Effect.mapError((error) => new ResumeFailed({ ticket, reason: error.reason })))
    yield* Effect.ignore(store.resumed(ticket))
    const text = ticketLine(
      Tag.resumed,
    )`${what}; resuming its session ${session} (worktree ${worktree})`
    yield* events.emit({ kind: "resumed", ticket, session, why, text })
    yield* logs.write(text)
    return uuid
  })

/** What a worker whose session went is told as it is resumed. */
export const carryOnText = (id: string): string =>
  `tutti: your session ended unexpectedly with ${id} still in progress, and this is it resumed. ` +
  `Carry on with ${id} where you left off, as your instructions say.`

/** How the resume of a session that ended unexpectedly went. */
export type GoneResume = Data.TaggedEnum<{
  /** Resumed and told to carry on: the message's uuid. */
  Resumed: { readonly message: string }
  /** It was resumed once in this run already. */
  Spent: Record<never, never>
  /** It couldn't be resumed: why. */
  Failed: { readonly reason: string }
}>

export const GoneResume = Data.taggedEnum<GoneResume>()

/**
 * Resumes the ticket's session, which ended unexpectedly (`why`) with the ticket still in
 * progress, telling it to carry on: once per ticket per run (§ 4.8).
 */
export const resumeGone = (
  ticket: string,
  why: string,
): Effect.Effect<GoneResume, never, AgentHost | Beads | Ledger | Store | Log | EventStream> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const ledger = yield* Ledger
    if (!(yield* ledger.claimGoneResume(ticket))) return GoneResume.Spent()
    const resumed = yield* Effect.result(
      resume(
        ticket,
        "gone",
        carryOnText(ticket),
        line`${ticket}'s worker is gone (${why}) with the ticket in progress`,
      ),
    )
    if (Result.isFailure(resumed)) return GoneResume.Failed({ reason: resumed.failure.reason })
    yield* Effect.ignore(
      beads.update(ticket, {
        appendNotes: `tutti: its worker's session ended unexpectedly (${why}) with the ticket still in_progress; the session was resumed and told to carry on.`,
      }),
    )
    return GoneResume.Resumed({ message: resumed.success })
  })

/**
 * Drops the ticket, in progress with its worker gone and its session not resumed (`why`): warned
 * about (WORKER_GONE), noted, and left for review, no longer followed.
 */
export const workerGone = (
  ticket: string,
  worktree: string,
  why: string,
): Effect.Effect<void, never, Beads | Ledger | Log> =>
  leaveForReview(ticket, {
    why: Tag.workerGone,
    detail: "in progress, its worker gone",
    text: ticketLine(
      Tag.workerGone,
    )`${ticket} is in progress, but its worker is gone and its session could not be resumed (${why}); worktree ${worktree} left for review, no longer followed; reopen it to run it again (bd update ${ticket} --status open), or finish it by hand`,
  })
