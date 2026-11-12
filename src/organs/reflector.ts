// The reflector (§ 5 item 13, § 6.2, tutti-5fs7.3): the organ that reads the scorecards of a run's
// ended tickets and excerpts of its worst and best tickets' transcripts, and proposes lessons for the
// playbook (run/playbook.ts), each with the tickets and records that show it. Its prompt is
// prompts/reflector.md; its evidence the scorecards, the lessons the pool has, and each ticket's
// bd show, footprint, records and transcript excerpt, the request outside the tags at the end.
//
// Its answer is text a model wrote, read from text a worker read, so tutti reads it warily: lessonsOf
// keeps the first so many on one line each, and the gate (run/playbook.ts) decides what comes of
// them. When it is asked is run/playbookRun.ts's.
import { Effect, Schema } from "effect"
import type { Candidate } from "../run/playbook.ts"
import { LessonEvidence, lessonKinds } from "../services/events.ts"
import { oneLine } from "../text/oneLine.ts"
import { sanitizeLine } from "../text/sanitize.ts"
import { type InputPart, section } from "./evidence.ts"
import { make, type OrganError, Organs } from "./Organs.ts"
import prompt from "./prompts/reflector.md" with { type: "text" }

/** The reflector's answer: the lessons it proposes. */
export const ReflectorAnswer = Schema.Struct({
  lessons: Schema.Array(
    Schema.Struct({
      text: Schema.String,
      kind: Schema.Literals(lessonKinds),
      scope: Schema.Array(Schema.String),
      evidence: Schema.Array(LessonEvidence),
      /** Read from pairs: where the tickets that went badly and well parted (tutti-5fs7.4). */
      record: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
})

export type ReflectorAnswer = typeof ReflectorAnswer.Type

export const reflector = make("reflector", { prompt, answer: ReflectorAnswer })

/** The most of a transcript the reflector reads of one ticket, and how much of that its start. */
export const excerptCharacters = 12_000
export const excerptHeadCharacters = 3_000

/** The most of one line of its answer tutti keeps: past the gate's length, which then refuses it. */
const lineCharacters = 2_000

/** The most of a lesson's evidence tutti keeps. */
const evidenceRead = 8

/** One ticket the reflector reads closely. */
export interface TicketEvidence {
  readonly ticket: string
  /** Among the worst of the tickets it was called for, or the best; in a pair, the bad or the good. */
  readonly standing: "worst" | "best" | "bad" | "good"
  /** The ticket, as bd show gives it (ticketText.ts's ticketText). */
  readonly shown: string
  /** The files its ticket names, and those predicted for it. */
  readonly footprint: string
  /** The records it can cite (scorecard.ts's recordRef), one a line. */
  readonly records: string
  /** An excerpt of its worker's transcript. */
  readonly transcript: string
}

/**
 * A pair the reflector reads by contrast (tutti-5fs7.4; XRepoSkill, arXiv 2609.36807; SWE-Exp,
 * 2507.23361): a ticket that didn't go clean and one that did, in the same area.
 */
export interface PairEvidence {
  readonly bad: TicketEvidence
  readonly good: TicketEvidence
  /** The folders and files their footprints share, one a line. */
  readonly area: string
}

/** What the reflector is given. */
export interface Evidence {
  /** The run's scorecards, one a line. */
  readonly scorecards: string
  /** The lessons the pool has, one a line. */
  readonly lessons: string
  /** The worst and the best, read alone; none when it reads pairs. */
  readonly tickets: ReadonlyArray<TicketEvidence>
  /** The pairs it reads by contrast; none when it reads the worst and the best. */
  readonly pairs?: ReadonlyArray<PairEvidence>
  /** The most lessons it may propose. */
  readonly most: number
  /** Reading pairs: how many a lesson must cite tickets of. */
  readonly recurring?: number
}

const ticketSections = (t: TicketEvidence, standing: string): ReadonlyArray<InputPart> => [
  section(`Ticket ${t.ticket}, ${standing} (bd show)`, t.shown),
  section(`${t.ticket}'s footprint`, t.footprint),
  section(`${t.ticket}'s records, as evidence cites them`, t.records),
  section(`${t.ticket}'s worker's transcript, an excerpt`, t.transcript),
]

/** The reflector's input: the evidence in sections, the request last. */
export const reflectorInput = (e: Evidence): ReadonlyArray<InputPart> => {
  const pairs = e.pairs ?? []
  return [
    section("The run's scorecards, best first, the worst last", e.scorecards),
    section("The lessons the playbook has", e.lessons === "" ? "(none yet)" : e.lessons),
    ...e.tickets.flatMap((t) => ticketSections(t, `among the ${t.standing}`)),
    ...pairs.flatMap((pair, i) => [
      section(
        `Pair ${i + 1}: ${pair.bad.ticket} went badly and ${pair.good.ticket} went well, in the same area`,
        pair.area,
      ),
      ...ticketSections(pair.bad, `the one of pair ${i + 1} that went badly`),
      ...ticketSections(pair.good, `the one of pair ${i + 1} that went well`),
    ]),
    pairs.length === 0
      ? `Propose at most ${e.most} lessons, or none.\n`
      : `Propose at most ${e.most} lessons, or none, each from where the two tickets of a pair ` +
        `parted, and only where it recurs: its evidence cites tickets of at least ${e.recurring ?? 2} of the ` +
        `${pairs.length} pairs. Give each its record.\n`,
  ]
}

// One line, sanitised, and bounded, in the characters a model may have put anywhere.
const line = (text: string): string => oneLine(sanitizeLine(text), lineCharacters)

// A scope's glob as the pool keeps it: a path from the top, a folder as all that is under it.
const scopeGlob = (glob: string): string => {
  const bare = line(glob).replace(/^\.\//u, "")
  return bare.endsWith("/") ? `${bare}**` : bare
}

/** The first `most` lessons of `answer`, for the gate to read; a record kept on a line, bounded. */
export const lessonsOf = (answer: ReflectorAnswer, most: number): ReadonlyArray<Candidate> =>
  answer.lessons.slice(0, most).map((lesson) => ({
    text: line(lesson.text),
    kind: lesson.kind,
    scope: lesson.scope.map(scopeGlob),
    evidence: lesson.evidence.slice(0, evidenceRead).map((each) => ({
      ticket: line(each.ticket),
      event: line(each.event),
    })),
    ...(typeof lesson.record === "string" && lesson.record.trim() !== ""
      ? { record: line(lesson.record) }
      : {}),
  }))

/** The reflector's answer on the evidence. */
export const reflect = (e: Evidence): Effect.Effect<ReflectorAnswer, OrganError, Organs> =>
  Effect.flatMap(Organs, (organs) => organs.ask(reflector, reflectorInput(e)))
