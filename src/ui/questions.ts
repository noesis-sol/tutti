// The words of the questions tutti asks before a run (§ 5 item 3, § 7.1): the start question and
// the plan confirmation, as the renderer draws them (StartQuestion.tsx, PlanConfirmation.tsx) and
// as the line forms ask them (plain/forms.ts). Both say the same, so each says it from here.
//
// A plan is an organ's words, or tickets' from bd: each of its texts is sanitised (§ 7.10) before
// it is shown, and kept on one line where a line is all it has.
import { Data, Schema } from "effect"
import { type Segments, seg } from "./line.tsx"
import { sanitize, sanitizeLine } from "./sanitize.ts"
import type { Theme } from "./theme.ts"

/** A form was cancelled: Esc or Ctrl+C in the renderer, the end of input (Ctrl+D) in a line form. */
export class FormCancelled extends Schema.TaggedError<FormCancelled>()("FormCancelled", {}) {}

/** What the run works on, as the start question's answer gives it. */
export type Work = Data.TaggedEnum<{
  /** The current tickets, as --tickets runs them. */
  Tickets: Record<never, never>
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
  'tutti --tickets runs the current tickets without asking, and tutti --feature "<request>" plans a feature.'

/** The current tickets' option: how many are ready, or why none is. */
export const ticketsOption = (count: TicketCount): string =>
  TicketCount.$match(count, {
    Ready: ({ n }) => `Current tickets: ${n} ready`,
    AllDone: () => "Current tickets: none, all done",
    NoneReady: ({ open }) => `Current tickets: none ready (${open} open)`,
    Unknown: () => "Current tickets",
  })

export const featureOption = "New feature: describe it, talk it through, run its tickets"

/** The start question's options, in order: the current tickets, then a new feature. */
export const startOptions = (count: TicketCount): ReadonlyArray<string> => [
  ticketsOption(count),
  featureOption,
]

export const describeTitle = "Describe the feature"

export const describeDescription =
  "What it should do, and why. An interview about it then files the tickets you agree on; tutti then runs them."

/** In the renderer, under the description's field. */
export const newLineHint = "Alt+Enter or Ctrl+J starts a new line."

/** The description's error while it is empty; `cancel` names the key that cancels. */
export const noDescription = (cancel: string): string =>
  `describe the feature first, or press ${cancel} to cancel`

/** What stays in sight once the start question is answered: a feature's description. */
export const chosenLines = (work: Work): ReadonlyArray<string> =>
  Work.$match(work, {
    Tickets: () => [],
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
