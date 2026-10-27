// The words of the questions tutti asks before a run (§ 5 item 3, § 7.1): the start question and
// the plan confirmation, as the renderer draws them (StartQuestion.tsx, PlanConfirmation.tsx) and
// as the line forms ask them (plain/forms.ts). Both say the same, so each says it from here.
//
// A plan is an organ's words, or tickets' from bd: each of its texts is sanitised (§ 7.10) before
// it is shown, and kept on one line where a line is all it has.
import { Data, type Effect, Schema } from "effect"
import { isSpecUrl, shownUrl } from "../run/specSource.ts"
import type { QuestionOption, TicketId } from "../services/Beads.ts"
import { type Segments, seg } from "./line.tsx"
import { sanitize, sanitizeLine } from "./sanitize.ts"
import type { Where } from "./specPath.ts"
import type { Theme } from "./theme.ts"

/** A form was cancelled: Esc or Ctrl+C in the renderer, the end of input (Ctrl+D) in a line form. */
export class FormCancelled extends Schema.TaggedError<FormCancelled>()("FormCancelled", {}) {}

/** What the run works on, as the start question's answer gives it. */
export type Work = Data.TaggedEnum<{
  /** The current tickets, as --tickets runs them. */
  Tickets: Record<never, never>
  /**
   * A spec, as --spec runs it (§ 4.14): its file, absolute, or its URL as typed; refined with
   * Claude first, as --refine, or run as it is.
   */
  Spec: { readonly given: string; readonly refine: boolean }
  /** A new feature, talked through in the interview (§ 4.10): its description, trimmed. */
  Feature: { readonly description: string }
}>

export const Work = Data.taggedEnum<Work>()

/** What the start question says of the current tickets. */
export type TicketCount = Data.TaggedEnum<{
  /** `n` tickets are ready to run. */
  Ready: { readonly n: number }
  /** None is left to run: all done. */
  AllDone: Record<never, never>
  /** None is ready, `open` are open but held or waiting. */
  NoneReady: { readonly open: number }
  /** bd couldn't say. */
  Unknown: Record<never, never>
}>

export const TicketCount = Data.taggedEnum<TicketCount>()

const plural = (n: number, noun: string): string => (n === 1 ? `1 ${noun}` : `${n} ${noun}s`)

export const startTitle = "What should this run work on?"

export const startDescription =
  'tutti --tickets runs the current tickets without asking, tutti --spec <file or URL> builds a spec, and tutti --feature "<request>" plans a feature.'

/** The current tickets' option: how many are ready, or why none is. */
export const ticketsOption = (count: TicketCount): string =>
  TicketCount.$match(count, {
    Ready: ({ n }) => `Current tickets: ${n} ready`,
    AllDone: () => "Current tickets: none, all done",
    NoneReady: ({ open }) => `Current tickets: none ready (${open} open)`,
    Unknown: () => "Current tickets",
  })

export const specOption = "Spec: build what a spec file describes"

export const featureOption = "New feature: describe it, talk it through, run its tickets"

/** The start question's options, in order: the current tickets, a spec, then a new feature. */
export const startOptions = (count: TicketCount): ReadonlyArray<string> => [
  ticketsOption(count),
  specOption,
  featureOption,
]

/** Where each work is among the start question's options. */
export const optionAt = { tickets: 0, spec: 1, feature: 2 } as const

/** What the start question needs to ask for a spec, in the renderer and as lines. */
export interface SpecAsk {
  /** Where a path typed starts: the repository, and the home folder for `~`. */
  readonly where: Where
  /** Fetches the spec at a URL and checks it: its problem, or null where it can be run. */
  readonly checkUrl: (url: string) => Effect.Effect<string | null>
}

export const specTitle = "Spec file"

export const specDescription =
  "The Markdown or text file that describes what to build, or its https:// URL. A relative path starts at the repository, and ~ is your home folder."

/** In the renderer, under the spec's description: its keys. */
export const specKeysHint = "Tab completes its path, and Ctrl+O browses for it."

/** The spec's error while nothing is typed; `browse` says Ctrl+O browses, as in the renderer. */
export const noSpecPath = (browse: boolean): string =>
  browse
    ? "type the spec's path or URL, or press Ctrl+O to browse for it"
    : "type the spec's path or URL"

/** The spinner's words while the spec at a URL is fetched. */
export const fetchingLine = (url: string): string => {
  const host = URL.canParse(url) ? new URL(url).host : url
  return `Fetching ${sanitizeLine(host)}…`
}

export const refineTitle = "Refine it with Claude first?"

export const refineDescription =
  "As it is, Claude breaks it down without asking, taking the spec as final. Refined, Claude first asks you about the gaps it leaves (tutti --spec <file> --refine)."

/** The refine step's options, in order: as it is (false), then refined (true). */
export const refineOptions: ReadonlyArray<string> = [
  "Run it as it is",
  "Refine it with Claude first",
]

/** What gave a spec chosen at the start question, as its problems name it: `(chosen at the start)`. */
export const specChosenFrom = "chosen at the start"

/** The spec `given` as it is shown: a path as it is, a URL without its query and fragment. */
export const shownSpec = (given: string): string => {
  if (isSpecUrl(given) && URL.canParse(given.trim())) return shownUrl(new URL(given.trim()))
  return sanitizeLine(given)
}

/** The line that keeps a chosen spec in sight: `Spec: <path or URL>, run as it is`. */
export const specLine = (given: string, refine: boolean): string =>
  `Spec: ${shownSpec(given)}, ${refine ? "refined with Claude first" : "run as it is"}`

export const describeTitle = "Describe the feature"

export const describeDescription =
  "What it should do, and why. An interview about it then files the tickets you agree on; tutti then runs them."

/** In the renderer, under the description's field. */
export const newLineHint = "Alt+Enter or Ctrl+J starts a new line."

/** The description's error while it is empty; `cancel` names the key that cancels. */
export const noDescription = (cancel: string): string =>
  `describe the feature first, or press ${cancel} to cancel`

/** What stays in sight once the start question is answered: a spec, or a feature's description. */
export const chosenLines = (work: Work): ReadonlyArray<string> =>
  Work.$match(work, {
    Tickets: () => [],
    Spec: ({ given, refine }) => [specLine(given, refine)],
    Feature: ({ description }) => [
      "New feature:",
      ...sanitize(description)
        .split("\n")
        .map((line) => `  ${line}`),
    ],
  })

/** A ticket of a plan, as the plan confirmation shows it. */
export interface PlanTicket {
  /** The plan's key for it, or its bd ID once filed. */
  readonly key: string
  readonly type: string
  readonly priority: number
  readonly title: string
  readonly files: ReadonlyArray<string>
  /** The keys of the tickets it waits for. */
  readonly after: ReadonlyArray<string>
}

/** A plan: the epic and its tickets, and what checking the plan changed. */
export interface Plan {
  readonly epic: { readonly title: string; readonly description: string }
  readonly tickets: ReadonlyArray<PlanTicket>
  readonly notes: ReadonlyArray<string>
}

/** The question after a --feature plan, before it is filed. */
export const fileQuestion = (plan: Plan): string =>
  plan.tickets.length === 1
    ? "File this ticket and start the run?"
    : `File these ${plan.tickets.length} tickets and start the run?`

/** The question after an interview filed the epic `epic` with `tickets` tickets. */
export const startOnQuestion = (epic: string, tickets: number): string =>
  `Start the run on ${sanitizeLine(epic)} (${plural(tickets, "ticket")})?`

/** The confirmation's answers: y or yes; n, no or nothing. */
export const confirmHint = "[y/N]"

/** `text`, a plan's, printable and on one line, its runs of white space one space. */
const oneLine = (text: string): string => sanitizeLine(text).split(/\s+/).filter(Boolean).join(" ")

/**
 * The plan's lines, in `theme`: the epic and its description, then each ticket with its type,
 * priority, files and the tickets it waits for, then the notes. As orchestra's showPlan.
 */
export const planLines = (plan: Plan, theme: Theme): ReadonlyArray<Segments> => {
  const { form, styles } = theme
  const tickets = plan.tickets.map((ticket) => ({
    key: oneLine(ticket.key),
    type: oneLine(ticket.type),
    priority: ticket.priority,
    title: oneLine(ticket.title),
    files: ticket.files.map(oneLine),
    after: ticket.after.map(oneLine),
  }))
  const width = Math.max(0, ...tickets.map((ticket) => Bun.stringWidth(ticket.key)))
  const typeWidth = Math.max(7, ...tickets.map((ticket) => Bun.stringWidth(ticket.type)))
  const pad = (text: string, to: number) =>
    text + " ".repeat(Math.max(0, to - Bun.stringWidth(text)))
  const indent = " ".repeat(width + 4)
  const description = sanitize(plan.epic.description).replaceAll("\t", "  ").trim()
  const lines: Array<Segments> = [
    [seg("Epic: ", form.fieldTitle), seg(oneLine(plan.epic.title))],
    ...(description === "" ? [] : description.split("\n")).map((line) => [
      seg(`  ${line.trimEnd()}`, form.description),
    ]),
    [],
    [seg(`${plural(tickets.length, "ticket")}:`, form.fieldTitle)],
  ]
  for (const ticket of tickets) {
    lines.push([
      seg("  "),
      seg(pad(ticket.key, width), styles.picked),
      seg("  "),
      seg(pad(ticket.type, typeWidth), form.option),
      seg(" "),
      seg(`P${ticket.priority}`, form.option),
      seg("  "),
      seg(ticket.title),
    ])
    if (ticket.files.length > 0) {
      lines.push([seg(`${indent}files: `, form.description), seg(ticket.files.join(", "))])
    }
    if (ticket.after.length > 0) {
      lines.push([seg(`${indent}after: `, form.description), seg(ticket.after.join(", "))])
    }
  }
  if (plan.notes.length > 0) {
    lines.push([], [seg("Checking the plan:", form.fieldTitle)])
    for (const note of plan.notes) lines.push([seg(`  - ${oneLine(note)}`, form.description)])
  }
  return lines
}

/** An open question put before an overnight run (src/run/overnightQuestions.ts). */
export interface OpenQuestion {
  readonly id: TicketId
  /** Its title, on one line, sanitised (§ 7.10). */
  readonly title: string
  /** Its description, sanitised, its lines kept. */
  readonly description: string
  /** Its options, the recommended one first; none where the metadata gives no well-formed ones. */
  readonly options: ReadonlyArray<QuestionOption> | undefined
  readonly maintainerOnly: boolean
  /** The tickets it keeps waiting: those it blocks that aren't closed, within the run's scope. */
  readonly waiting: ReadonlyArray<TicketId>
}

/** Where an open question is among those put: `index` of `of`, from 0. */
export interface QuestionAt {
  readonly index: number
  readonly of: number
}

/**
 * What the maintainer said to an open question: an answer to record, to leave it open, or to talk
 * it through first (§ 4.11), where the form offers that.
 */
export type Reply =
  | { readonly _tag: "Answer"; readonly answer: string }
  | { readonly _tag: "LeaveOpen" }
  | { readonly _tag: "Talk" }

/** The label the recommended option is marked with, after its own. */
export const recommendedMark = "(recommended)"

/** The choice that leaves an open question open. */
export const leaveOpen = "Leave open"

/** The choice that types your own answer. */
export const otherChoice = "Other"

/** The choice that talks the question through in a session before answering it (§ 4.11). */
export const talkChoice = "Talk it through"

/**
 * One of the choices an open question is put with: an option of its own, Other, Talk it through,
 * or Leave open.
 */
export type Choice =
  | {
      readonly _tag: "Option"
      /** As shown: the recommended one marked. */
      readonly label: string
      readonly description: string
      /** What bd human respond records: the option's label. */
      readonly answer: string
    }
  | { readonly _tag: "Other" }
  | { readonly _tag: "Talk" }
  | { readonly _tag: "LeaveOpen" }

/**
 * The choices `question` is put with: its options, the recommended one first, Other, Talk it
 * through where `talk` offers it, Leave open.
 */
export const choicesOf = (question: OpenQuestion, talk = false): ReadonlyArray<Choice> => [
  ...(question.options ?? []).map(
    (option, at): Choice => ({
      _tag: "Option",
      label: at === 0 ? `${option.label} ${recommendedMark}` : option.label,
      description: option.description,
      answer: option.label,
    }),
  ),
  { _tag: "Other" },
  ...(talk ? [{ _tag: "Talk" } as const] : []),
  { _tag: "LeaveOpen" },
]

/** An open question's line above its title: `Open question 1 of 2 · tutti-9x`, and who alone answers it. */
export const questionHeading = (question: OpenQuestion, at: QuestionAt): string =>
  `Open question ${at.index + 1} of ${at.of} · ${question.id}${question.maintainerOnly ? " · only you can answer it" : ""}`

/** Under an open question in the renderer: what an answer does. */
export const questionDescription =
  "An answer closes the question and frees the tickets it keeps waiting, before the run starts."

/** What the form says to Other chosen with nothing typed; `cancel` names the key that stops. */
export const noAnswerTyped = (cancel: string): string =>
  `type your answer first, or press ${cancel} to stop before the run starts`
