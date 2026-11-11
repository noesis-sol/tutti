// The auditor (§ 5 item 13, § 6.2, tutti-5fs7.5): the organ that reads an ended ticket's worker
// transcript against a fixed rubric of behaviours a transcript shows (Critic Rubrics, arXiv
// 2603.03800), each answered yes, no or unclear with a line of the transcript quoted as evidence.
// Each item names a behaviour to avoid, so a yes is a flag. Its prompt is prompts/auditor.md; its
// evidence the ticket as bd show gives it, the files its ticket names, where its worker worked and
// the main checkout, and its transcript as triage reads one (triage.ts's itemLines), the whole of it
// when it fits in `transcriptCharacters`, else its start and its end, the ticket named by its ID
// outside the tags at the end.
//
// Its answer is text a model wrote, so tutti reads it warily (auditOf): each item's evidence is one
// line, sanitised and cut; a yes whose quote the transcript it was given doesn't hold is unclear,
// marked ungrounded. When it is asked, and what becomes of its answer, is run/auditor.ts's.
import { Effect, Schema } from "effect"
import type { Item } from "../agent/Transcripts.ts"
import { asRecord, asString } from "../agent/untrusted.ts"
import type { Issue, TicketId } from "../services/Beads.ts"
import { type AuditItemName, type auditAnswers, auditItems } from "../services/events.ts"
import { oneLine } from "../text/oneLine.ts"
import { sanitizeLine } from "../text/sanitize.ts"
import { type InputPart, section } from "./evidence.ts"
import { make, type OrganError, Organs } from "./Organs.ts"
import prompt from "./prompts/auditor.md" with { type: "text" }
import { itemLines } from "./triage.ts"

/** One item's answer, as the auditor gives it. */
export const Judgement = Schema.Struct({
  answer: Schema.Literals(["yes", "no", "unclear"]),
  evidence: Schema.String,
})

/** The auditor's answer: each rubric item judged. */
export const AuditorAnswer = Schema.Struct({
  verifier_before_checks: Judgement,
  background_left_running: Judgement,
  outside_footprint: Judgement,
  asked_what_ticket_said: Judgement,
  repeated_failing_command: Judgement,
  wrote_main_checkout: Judgement,
})

export type AuditorAnswer = typeof AuditorAnswer.Type

export const auditor = make("auditor", { prompt, answer: AuditorAnswer })

// ---------------------------------------------------------------------------------------------
// The transcript, as text

/** The most of a transcript's text the auditor reads. */
export const transcriptCharacters = 60_000

/** How much of that is its start, where the ticket was read and the work planned. */
export const headCharacters = 15_000

/**
 * A transcript as the auditor reads it: the lines of all its items, or, past
 * `most` characters, its first `first` and its last ones, each cut at a line's end, with how much
 * was left out between them.
 */
export const transcriptText = (
  items: ReadonlyArray<Item>,
  most = transcriptCharacters,
  first = headCharacters,
): string => {
  const text = items.flatMap(itemLines).join("\n")
  if (text.length <= most) return text
  const start = text.slice(0, first)
  const head = start.slice(0, Math.max(0, start.lastIndexOf("\n")))
  const end = text.slice(text.length - (most - first))
  const tail = end.slice(end.indexOf("\n") + 1)
  const left = text.length - head.length - tail.length
  return `${head}\n… (${left} characters of the transcript left out) …\n${tail}`
}

/** The folder the worker's last session worked in, as its init message says; undefined if none. */
export const workedIn = (items: ReadonlyArray<Item>): string | undefined => {
  for (let i = items.length - 1; i >= 0; i--) {
    const m = asRecord(items[i]?.message)
    if (m?.type === "system" && m.subtype === "init") {
      const cwd = asString(m.cwd)
      if (cwd !== undefined && cwd.trim() !== "") return cwd
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------------------------
// The input

/** What the auditor is given about one ended ticket. */
export interface Evidence {
  readonly ticket: TicketId
  /** The ticket, as bd show gives it (predictor.ts's ticketText). */
  readonly shown: string
  /** The files its ticket names, and those predicted for it. */
  readonly footprint: string
  /** Its worker's worktree and the project's main checkout. */
  readonly where: string
  /** Its transcript (transcriptText). */
  readonly transcript: string
  /** How its part in the run ended, in tutti's words: `merged`. */
  readonly outcome: string
}

/** The footprint section's text: the files `issue` names, and those predicted for it. */
export const footprintText = (issue: Pick<Issue, "files" | "predictedFiles">): string =>
  [
    `Files the ticket names: ${issue.files.length === 0 ? "(none)" : issue.files.join(", ")}`,
    `Files predicted for it: ${issue.predictedFiles.length === 0 ? "(none)" : issue.predictedFiles.join(", ")}`,
  ].join("\n")

/** The where section's text: the worker's worktree, as its transcript says, and the main checkout. */
export const whereText = (worktree: string | undefined, repo: string): string =>
  `The worker's worktree: ${worktree ?? "(its transcript doesn't say)"}\n` +
  `The project's main checkout: ${repo}`

/** The auditor's input: the evidence in sections, the ticket by its ID last. */
export const auditorInput = (e: Evidence): ReadonlyArray<InputPart> => [
  section("Ticket (bd show)", e.shown),
  section("Its footprint", e.footprint),
  section("Where it worked", e.where),
  section("The worker's transcript (messages, tool calls, results)", e.transcript),
  `Ticket ${e.ticket}'s part in the run ended: ${e.outcome}. Answer each item of the rubric.\n`,
]

// ---------------------------------------------------------------------------------------------
// The answer, read warily

/** One item as tutti keeps it. */
export interface Judged {
  readonly item: AuditItemName
  readonly answer: (typeof auditAnswers)[number]
  /** One line, at most `evidenceCharacters`. */
  readonly evidence: string
  /** A yes whose quote the transcript doesn't hold, read as unclear. */
  readonly ungrounded?: true
}

/** The most of an item's evidence tutti keeps. */
export const evidenceCharacters = 300

/** The fewest characters a quote's pieces add up to for tutti to look for it in the transcript. */
export const quoteCharacters = 8

const normal = (text: string): string => text.toLowerCase().split(/\s+/u).join(" ").trim()

// Quote marks a model may wrap a quote, or a piece of one, in.
const quoteMarks = /^["'`“”‘’«»\s]+|["'`“”‘’«»\s]+$/gu

/**
 * Whether `transcript` holds what `evidence` quotes: each piece of it between ellipses, its quote
 * marks and its case aside, with at least `quoteCharacters` of them in all.
 */
export const quoted = (evidence: string, transcript: string): boolean => {
  const pieces = evidence
    .split(/…|\.\.\./u)
    .map((piece) => normal(piece.replace(quoteMarks, "")))
    .filter((piece) => piece !== "")
  const length = pieces.reduce((sum, piece) => sum + piece.length, 0)
  if (length < quoteCharacters) return false
  const haystack = normal(sanitizeLine(transcript))
  return pieces.every((piece) => haystack.includes(piece))
}

/**
 * The items of `answer` as tutti keeps them, in the rubric's order: each one's evidence on one
 * line, and a yes whose quote `transcript` (the text the auditor was given) doesn't hold unclear.
 */
export const auditOf = (answer: AuditorAnswer, transcript: string): ReadonlyArray<Judged> =>
  auditItems.map((item): Judged => {
    const given = (answer as Partial<AuditorAnswer>)[item]
    const evidence = oneLine(sanitizeLine(given?.evidence ?? ""), evidenceCharacters)
    const said = given?.answer ?? "unclear"
    if (said === "yes" && !quoted(evidence, transcript)) {
      return { item, answer: "unclear", evidence, ungrounded: true }
    }
    return { item, answer: said, evidence }
  })

/** The auditor's answer on the ended ticket the evidence is about. */
export const audit = (e: Evidence): Effect.Effect<AuditorAnswer, OrganError, Organs> =>
  Effect.flatMap(Organs, (organs) => organs.ask(auditor, auditorInput(e), { ticket: e.ticket }))
