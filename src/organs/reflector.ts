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
import { LessonEvidence, lessonKinds } from "../run/events.ts"
import type { Candidate } from "../run/playbook.ts"
import { oneLine } from "../ui/oneLine.ts"
import { sanitizeLine } from "../ui/sanitize.ts"
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
  /** Among the worst of the tickets it was called for, or the best. */
  readonly standing: "worst" | "best"
  /** The ticket, as bd show gives it (predictor.ts's ticketText). */
  readonly shown: string
  /** The files its ticket names, and those predicted for it. */
  readonly footprint: string
  /** The records it can cite (scorecard.ts's recordRef), one a line. */
  readonly records: string
  /** An excerpt of its worker's transcript. */
  readonly transcript: string
}

/** What the reflector is given. */
export interface Evidence {
  /** The run's scorecards, one a line. */
  readonly scorecards: string
  /** The lessons the pool has, one a line. */
  readonly lessons: string
  readonly tickets: ReadonlyArray<TicketEvidence>
  /** The most lessons it may propose. */
  readonly most: number
}

/** The reflector's input: the evidence in sections, the request last. */
export const reflectorInput = (e: Evidence): ReadonlyArray<InputPart> => [
  section("The run's scorecards, best first, the worst last", e.scorecards),
  section("The lessons the playbook has", e.lessons === "" ? "(none yet)" : e.lessons),
  ...e.tickets.flatMap((t) => [
    section(`Ticket ${t.ticket}, among the ${t.standing} (bd show)`, t.shown),
    section(`${t.ticket}'s footprint`, t.footprint),
    section(`${t.ticket}'s records, as evidence cites them`, t.records),
    section(`${t.ticket}'s worker's transcript, an excerpt`, t.transcript),
  ]),
  `Propose at most ${e.most} lessons, or none.\n`,
]

// One line, sanitised, and bounded, in the characters a model may have put anywhere.
const line = (text: string): string => oneLine(sanitizeLine(text), lineCharacters)

// A scope's glob as the pool keeps it: a path from the top, a folder as all that is under it.
const scopeGlob = (glob: string): string => {
  const bare = line(glob).replace(/^\.\//u, "")
  return bare.endsWith("/") ? `${bare}**` : bare
}

/** The first `most` lessons of `answer`, for the gate to read. */
export const lessonsOf = (answer: ReflectorAnswer, most: number): ReadonlyArray<Candidate> =>
  answer.lessons.slice(0, most).map((lesson) => ({
    text: line(lesson.text),
    kind: lesson.kind,
    scope: lesson.scope.map(scopeGlob),
    evidence: lesson.evidence.slice(0, evidenceRead).map((each) => ({
      ticket: line(each.ticket),
      event: line(each.event),
    })),
  }))

/** The reflector's answer on the evidence. */
export const reflect = (e: Evidence): Effect.Effect<ReflectorAnswer, OrganError, Organs> =>
  Effect.flatMap(Organs, (organs) => organs.ask(reflector, reflectorInput(e)))
