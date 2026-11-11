// The auditor in the run (§ 5 item 13, § 6.2, tutti-5fs7.5): with organs.auditor on, each ticket
// whose part in the run ends (merged, closed with no change, set aside or waiting on you; not one
// stopped by a quit, nor one the run ends with back in the queue) is handed to the auditor organ
// (organs/auditor.ts), which reads its worker's transcript against a fixed rubric of behaviours,
// each answered yes, no or unclear with a quoted line. The run tells it of each end as the ledger
// changes (`endsBetween`); a ticket that ends again is audited again, the later audit standing.
//
// Its evidence is gathered as its audit starts: the ticket as bd show gives it, the files it names
// and those predicted for it, its worker's whole transcript as triage reads one (its start and its
// end past auditor.ts's cap), the folder its worker worked in, as the transcript's init says, and
// the main checkout. A ticket with no transcript is not audited. One fiber in the run's scope audits
// the queue one ticket at a time, so the run never waits for a model's answer, but it doesn't end
// while one waits (pending).
//
// Each answer, read warily (auditOf), is an `audit` record, which the ticket's scorecard takes
// (scorecard.ts: its flagged and unclear items), and a line in the log. One that fails is
// AUDIT_FAILED, in the log and a `warn` record, and changes nothing; one skipped for the usage
// limit is logged by Organs already. Off with the settings' organs.auditor false, its default, as
// it costs a model turn a ticket, or a run without organs. A quit interrupts the audit under way,
// and those queued are dropped.
import { Cause, Effect, FiberSet, Queue, Ref, Result, type Scope, Stream } from "effect"
import { type Item, Transcripts } from "../agent/Transcripts.ts"
import { AppConfig } from "../core/AppConfig.ts"
import { causeWhy, detail, type Line, type Log, line, Tag } from "../core/log.ts"
import {
  audit,
  auditOf,
  type Evidence,
  footprintText,
  type Judged,
  transcriptText,
  whereText,
  workedIn,
} from "../organs/auditor.ts"
import { type OrganError, Organs } from "../organs/Organs.ts"
import { ticketText } from "../organs/predictor.ts"
import { Beads, beadsWhy, type TicketId } from "../services/Beads.ts"
import type { EventStream } from "./eventstream.ts"
import { RunFibers } from "./fibers.ts"
import type { State } from "./ledger.ts"
import { factsOf, type TicketOutcome } from "./phase.ts"
import { sayer } from "./say.ts"
import { auditWords } from "./scorecard.ts"

/** A ticket whose part in the run ended. */
export interface Ended {
  readonly ticket: TicketId
  readonly outcome: TicketOutcome
}

export interface Auditor {
  /** The ticket's part in the run ended: an audit is queued for it, unless its outcome has none. */
  ended(end: Ended): Effect.Effect<void>
  /** The audit under way, and those queued. */
  readonly pending: Effect.Effect<number>
  /** Aborts the audit under way and starts no more, as quitting does (quit.ts). */
  readonly interrupt: Effect.Effect<void>
}

/** The auditor turned off: it audits nothing. */
export const off: Auditor = {
  ended: () => Effect.void,
  pending: Effect.succeed(0),
  interrupt: Effect.void,
}

/** Whether an end of `outcome` is audited: not a quit's stop, nor a ticket back in the queue. */
export const audited = (outcome: TicketOutcome): boolean =>
  outcome !== "stopped" && outcome !== "queued"

/**
 * The tickets whose part in the run ended between ledger states `before` and `after`, as the
 * ledger writes their ticket_end: each in `before` that moved to a phase ending it, not in the
 * queue.
 */
export const endsBetween = (before: State, after: State): ReadonlyArray<Ended> =>
  [...after.tickets.values()].flatMap((entry) => {
    const was = before.tickets.get(entry.ticket)
    if (was === undefined || was.phase._tag === entry.phase._tag) return []
    const facts = factsOf(entry.phase)
    const outcome = facts.inQueue ? null : facts.ends(entry.phase)
    return outcome === null ? [] : [{ ticket: entry.ticket, outcome }]
  })

/** A worker's whole transcript, read back a page at a time from its end. */
export const allItems = (transcripts: Transcripts["Service"], id: TicketId) =>
  Effect.gen(function* () {
    const pages: Array<ReadonlyArray<Item>> = []
    let before: number | undefined
    for (;;) {
      const page = yield* transcripts.page(id, before)
      if (page.length === 0) break
      pages.unshift(page)
      const first = page[0]?.seq ?? 0
      if (first <= 1 || first === before) break
      before = first
    }
    return pages.flat()
  })

/** Tells `auditor` of each ticket whose part in the run ends, from the ledger's `changes`. */
export const followEnds = (
  changes: Stream.Stream<State>,
  auditor: Pick<Auditor, "ended">,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const last = yield* Ref.make<State | undefined>(undefined)
    yield* Stream.runForEach(changes, (state) =>
      Effect.gen(function* () {
        const before = yield* Ref.getAndSet(last, state)
        if (before === undefined) return
        for (const end of endsBetween(before, state)) yield* auditor.ended(end)
      }),
    )
  })

/** `  audit <id>: 2 of 6 flagged (a, b); 1 unclear`, or `none of 6 flagged`. */
export const auditLine = (id: TicketId, items: ReadonlyArray<Judged>): Line => {
  const flagged = items.filter((each) => each.answer === "yes")
  const unclear = items.filter((each) => each.answer === "unclear").length
  const said =
    flagged.length === 0
      ? `none of ${items.length} flagged`
      : `${flagged.length} of ${items.length} flagged (${flagged.map((each) => auditWords[each.item]).join(", ")})`
  return detail`audit ${id}: ${said}${unclear === 0 ? "" : `; ${unclear} unclear`}`
}

/** `  AUDIT_FAILED for <id>: <why>`. */
export const auditFailedLine = (id: TicketId, why: string): Line =>
  `  ${Tag.auditFailed} for ${line`${id}: ${why}`}` as Line

/** Why the auditor gave no answer, on one line. */
const failure = (error: Exclude<OrganError, { _tag: "OrganSkipped" }>): string => {
  switch (error._tag) {
    case "OrganFailed":
    case "OrganRefused":
      return error.reason.split("\n")[0] ?? error.reason
    case "OrganTimedOut":
      return "the auditor ran past its time limit"
  }
}

const outcomeWords: Readonly<Record<TicketOutcome, string>> = {
  merged: "merged",
  no_change: "closed with no change to merge",
  set_aside: "set aside",
  needs_you: "waiting on the maintainer",
  stopped: "stopped",
  queued: "back in the queue",
}

/**
 * The run's auditor, its queue worked through by a fiber in the run's scope. `repo` is the main
 * checkout; `done` is told each time an audit ends, with an answer or without.
 */
export const make = (options: {
  readonly repo: string
  readonly done?: Effect.Effect<void>
}): Effect.Effect<
  Auditor,
  never,
  AppConfig | Organs | Beads | Transcripts | Log | EventStream | RunFibers | Scope.Scope
> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    if (!config.settings.organs.auditor) return off
    const organs = yield* Organs
    const beads = yield* Beads
    const transcripts = yield* Transcripts
    const { say, warn } = yield* sayer
    const queued = yield* Queue.unbounded<Ended>()
    const pending = yield* Ref.make(0)
    // Set once quitting began: no more audits.
    const stopped = yield* Ref.make(false)

    // The evidence for one ended ticket, gathered as its audit starts; none without a transcript.
    const gather = (end: Ended) =>
      Effect.gen(function* () {
        const id = end.ticket
        const items = yield* allItems(transcripts, id)
        const transcript = transcriptText(items)
        if (transcript.trim() === "") return undefined
        const shown = yield* Effect.result(beads.show(id))
        return {
          ticket: id,
          shown: Result.isSuccess(shown)
            ? ticketText(shown.success)
            : `${id}\n(bd show failed: ${beadsWhy(shown.failure)})`,
          footprint: Result.isSuccess(shown) ? footprintText(shown.success) : "(unknown)",
          where: whereText(workedIn(items), options.repo),
          transcript,
          outcome: outcomeWords[end.outcome],
        } satisfies Evidence
      })

    // A defect in one ticket's audit, AUDIT_FAILED; an interruption (a quit) goes on up.
    const survived = (id: TicketId, cause: Cause.Cause<never>) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : warn(auditFailedLine(id, causeWhy(cause)), id)

    const auditOne = (end: Ended) =>
      Effect.gen(function* () {
        const evidence = yield* gather(end)
        if (evidence === undefined) return
        const answer = yield* audit(evidence).pipe(
          Effect.provideService(Organs, organs),
          Effect.result,
        )
        if (Result.isFailure(answer)) {
          // A call skipped for the usage limit is logged as such already.
          if (answer.failure._tag === "OrganSkipped") return
          yield* warn(auditFailedLine(end.ticket, failure(answer.failure)), end.ticket)
          return
        }
        const items = auditOf(answer.success, evidence.transcript)
        yield* say({
          kind: "audit",
          ticket: end.ticket,
          outcome: end.outcome,
          items,
          text: auditLine(end.ticket, items),
        })
      }).pipe(
        Effect.catchCause((cause) => survived(end.ticket, cause)),
        Effect.ensuring(
          Effect.andThen(
            Ref.update(pending, (n) => n - 1),
            options.done ?? Effect.void,
          ),
        ),
      )

    const fibers = yield* (yield* RunFibers).make<never, never>("auditor")
    yield* FiberSet.run(fibers, Effect.forever(Effect.flatMap(Queue.take(queued), auditOne)))

    return {
      ended: (end) =>
        Effect.gen(function* () {
          if (!audited(end.outcome) || (yield* Ref.get(stopped))) return
          yield* Ref.update(pending, (n) => n + 1)
          yield* Queue.offer(queued, end)
        }),
      pending: Ref.get(pending),
      interrupt: Effect.gen(function* () {
        yield* Ref.set(stopped, true)
        yield* FiberSet.clear(fibers)
        yield* Queue.clear(queued)
        yield* Ref.set(pending, 0)
      }),
    } satisfies Auditor
  })
