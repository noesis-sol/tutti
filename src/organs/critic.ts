// The critic (§ 5 item 13, § 6.2, tutti-5fs7.2): the organ that reviews a ticket's work once it has
// merged, mid-run, and reports what it finds as findings tutti may file as follow-up tickets. It
// builds a checklist from the evidence first, as Agentic Rubrics (arXiv 2601.04171) does: the
// project's conventions (CLAUDE.md, AGENTS.md), the ticket's acceptance criteria and what the diff
// must keep; then it checks the merged diff against it, each finding with its criterion, a path:line
// and a severity. Its prompt is prompts/critic.md; its evidence the ticket as bd show gives it, its
// scorecard, the conventions, the files the merge changed and the merged diff, the ticket named by
// its ID outside the tags at the end, as Claude reads long inputs best with the request last.
//
// Its answer is text a model wrote, so tutti reads it warily (findingsOf): a title is one line, cut
// to a ticket title's length; a finding without a path:line tutti can read, or with an empty title,
// is dropped; two findings alike are one. When it is asked, and what becomes of its findings, is
// run/critic.ts's.
import { Effect, Schema } from "effect"
import { titleOf } from "../run/fileTicket.ts"
import type { TicketId } from "../services/Beads.ts"
import { oneLine } from "../ui/oneLine.ts"
import { sanitize, sanitizeLine } from "../ui/sanitize.ts"
import { type InputPart, section } from "./evidence.ts"
import { make, type OrganError, Organs } from "./Organs.ts"
import prompt from "./prompts/critic.md" with { type: "text" }

/** How bad a finding is, worst first: a severe one needs the maintainer, not a ticket. */
export const severities = ["severe", "high", "medium", "low"] as const
export type Severity = (typeof severities)[number]

/** How sure the critic is of a finding. */
export const confidences = ["high", "medium", "low"] as const
export type Confidence = (typeof confidences)[number]

/** One finding, as the critic answers it. */
export const CriticFinding = Schema.Struct({
  title: Schema.String,
  severity: Schema.Literals(severities),
  criterion: Schema.String,
  evidence: Schema.String,
  detail: Schema.String,
  confidence: Schema.Literals(confidences),
})

/** The critic's answer: the checklist it built, and the findings against it. */
export const CriticAnswer = Schema.Struct({
  checklist: Schema.Array(Schema.String),
  findings: Schema.Array(CriticFinding),
})

export type CriticAnswer = typeof CriticAnswer.Type

export const critic = make("critic", { prompt, answer: CriticAnswer })

// ---------------------------------------------------------------------------------------------
// The evidence

/** What the critic is given about one merged ticket. */
export interface Evidence {
  readonly ticket: TicketId
  /** The ticket, as bd show gives it (predictor.ts's ticketText). */
  readonly shown: string
  /** Its scorecard, as the reviewer's lines give it; empty when it has none. */
  readonly scorecard: string
  /** The project's conventions: CLAUDE.md and AGENTS.md at the merged commit, each titled. */
  readonly conventions: string
  /** The files the merge changed, one a line. */
  readonly files: string
  /** The merged diff, cut to `diffCharacters`. */
  readonly diff: string
  /** The merge, in tutti's words: `merged at 1a2b3c4 onto 9f8e7d6`. */
  readonly merge: string
}

/** The most of the merged diff the critic reads. */
export const diffCharacters = 60_000

/** The most of one file's diff, so one large file doesn't crowd the others out. */
export const fileDiffCharacters = 12_000

/** The most of each conventions file. */
export const conventionsCharacters = 20_000

/** The files the critic is given as the project's conventions, when the merged tree has them. */
export const conventionFiles = ["CLAUDE.md", "AGENTS.md"] as const

/** `text`'s start, at most `most` characters, saying how much was left out. */
export const cut = (text: string, most: number): string =>
  text.length <= most ? text : `${text.slice(0, most)}\n… (${text.length - most} more characters)`

/** The critic's input: the evidence in sections, the ticket by its ID last. */
export const criticInput = (e: Evidence): ReadonlyArray<InputPart> => [
  section("Ticket (bd show)", e.shown),
  section("Its scorecard from the run", e.scorecard),
  section("The project's conventions", e.conventions),
  section("Files the merge changed", e.files),
  section("The merged diff", e.diff),
  `Ticket ${e.ticket} was ${e.merge}. Review what it merged.\n`,
]

// ---------------------------------------------------------------------------------------------
// The answer, read warily

/** A finding as tutti keeps it: one-line text, its location read from its evidence. */
export interface Finding {
  /** One line, at most a ticket title's length. */
  readonly title: string
  readonly severity: Severity
  readonly criterion: string
  /** The path its evidence names, relative to the repository's top. */
  readonly file: string
  /** The line there, from 1. */
  readonly line: number
  readonly detail: string
  readonly confidence: Confidence
}

/** The most findings tutti reads of one answer, the most severe first. */
export const findingsRead = 8

/** The most of a finding's criterion or detail tutti keeps. */
export const textCharacters = 1_000

// A path:line: a path of no spaces with a dot or slash in it, a colon, a line number, maybe a range.
const located = /([^\s:`'"()[\]<>,]*[./][^\s:`'"()[\]<>,]*):(\d+)(?:[-–]\d+)?/

/** The path and line `evidence` names first, as `src/a.ts:12`; undefined when it names none. */
export const locationOf = (
  evidence: string,
): { readonly file: string; readonly line: number } | undefined => {
  const match = located.exec(evidence)
  if (match === null) return undefined
  const file = (match[1] ?? "").replace(/^\.\//, "")
  const line = Number(match[2])
  if (file === "" || file.startsWith("/") || file.split("/").includes("..")) return undefined
  if (!Number.isSafeInteger(line) || line < 1) return undefined
  return { file, line }
}

const words = (text: string): ReadonlySet<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2),
  )

/**
 * Whether two titles say the same: their words longer than two letters, the same at least
 * three-quarters of all of them; titles with none such alike when equal.
 */
export const alike = (one: string, other: string): boolean => {
  const a = words(one)
  const b = words(other)
  if (a.size === 0 || b.size === 0) {
    return one.trim().toLowerCase() === other.trim().toLowerCase()
  }
  const shared = [...a].filter((word) => b.has(word)).length
  return shared / (a.size + b.size - shared) >= 0.75
}

const rank = (severity: Severity): number => severities.indexOf(severity)

/**
 * The findings of `answer` tutti reads, the most severe first, at most `findingsRead`: each with a
 * title and a path:line, its text on one line, and none alike an earlier one (`alike`, or the same
 * criterion at the same place).
 */
export const findingsOf = (answer: CriticAnswer): ReadonlyArray<Finding> => {
  const kept: Array<Finding> = []
  const sorted = [...answer.findings].sort((a, b) => rank(a.severity) - rank(b.severity))
  for (const each of sorted) {
    if (kept.length >= findingsRead) break
    const where = locationOf(sanitizeLine(each.evidence))
    const title = titleOf(each.title)
    if (where === undefined || title === "") continue
    const finding: Finding = {
      title,
      severity: each.severity,
      criterion: oneLine(sanitize(each.criterion), textCharacters),
      file: where.file,
      line: where.line,
      detail: oneLine(sanitize(each.detail), textCharacters),
      confidence: each.confidence,
    }
    const twin = kept.some(
      (other) =>
        alike(other.title, finding.title) ||
        (other.file === finding.file &&
          other.line === finding.line &&
          other.criterion === finding.criterion),
    )
    if (!twin) kept.push(finding)
  }
  return kept
}

/** The priority of the ticket a finding is filed as: high P1, medium P2, low P3. */
export const priorityOf = (severity: Exclude<Severity, "severe">): number =>
  ({ high: 1, medium: 2, low: 3 })[severity]

/** The critic's answer on the merged ticket the evidence is about. */
export const rescore = (e: Evidence): Effect.Effect<CriticAnswer, OrganError, Organs> =>
  Effect.flatMap(Organs, (organs) => organs.ask(critic, criticInput(e), { ticket: e.ticket }))
