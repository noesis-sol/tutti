// What the run's summary is made from (§ 7.1, § 5 item 14 "Then"), as the end of the run gathers it
// (endOfRun.ts) for src/print/summary.ts to print: the summary's fields, how the run ended, and
// the lines on what --auto-answer answered, which the log says as the summary does.
import { Data } from "effect"
import type { FiguresLine } from "../services/figures.ts"
import type { Row, Totals } from "./runView.ts"

/** A question tutti answered by --auto-answer, as the summary lists it. */
export interface AutoAnsweredItem {
  /** The ticket whose worker asked it. */
  readonly ticket: string
  /** The question ticket's ID; absent for a question asked in the worker's session. */
  readonly question?: string
  /** The question ticket's title, or what the session's question asked. */
  readonly title: string
  /** The option chosen: the recommended one, each question's, `, ` apart. */
  readonly choice: string
}

/** How to find the question tickets --auto-answer answered, once the run is over. */
export const autoAnsweredHint = "bd list --all --label auto-answered"

/** The heading of the summary's list of what --auto-answer answered. */
export const autoAnsweredHeading = "Answered by --auto-answer, not by you"

/** The lines listing what --auto-answer answered under its heading: each, then the hint. */
export const autoAnsweredTexts = (
  items: ReadonlyArray<AutoAnsweredItem>,
): ReadonlyArray<string> => {
  if (items.length === 0) return []
  const each = items.map((item) =>
    item.question === undefined
      ? `${item.ticket}'s worker: ${item.title} → ${item.choice}`
      : `${item.question} (${item.title}), for ${item.ticket} → ${item.choice}`,
  )
  const tickets = items.some((item) => item.question !== undefined)
  return [...each, ...(tickets ? [`find them later with: ${autoAnsweredHint}`] : [])]
}

/** What the summary is made from. */
export interface Summary {
  readonly version: string
  /** Where finished tickets landed. */
  readonly branch: string
  /** The ticket a scoped run (`--ticket`) worked on; null for none. */
  readonly scope: string | null
  /** A spec run's spec, named in place of its root epic; none for another run. */
  readonly spec?: string | null
  /** How long the run took, in milliseconds. */
  readonly took: number
  readonly totals: Totals
  /** The run's figures, each line with something to say (figures.ts); none shown without rows. */
  readonly figures: ReadonlyArray<FiguresLine>
  /** Every ticket the run took up, in the order it took them up. */
  readonly rows: ReadonlyArray<Row>
  /** The questions --auto-answer answered, in the order it did; none without it. */
  readonly autoAnswered?: ReadonlyArray<AutoAnsweredItem>
  /** How a spec run's checks gate went (src/run/checksGate.ts); none where it didn't run. */
  readonly checksGate?: string
}

/** What the summary's line on a spec run's checks gate starts with. */
export const checksGateLabel = "Checks gate:"

/** How the run ended, for its closing line. */
export type Ending = Data.TaggedEnum<{
  /**
   * By itself: `text` starts READY_EMPTY, LIMIT_REACHED or DRAINED, and a scoped run's is followed
   * by `; SCOPE_DONE: …` or `; SCOPE_OPEN: …`.
   */
  Done: {
    readonly text: string
    /** The tickets the run started. */
    readonly tickets: number
    /** The ticket limit, if any. */
    readonly limit: number | null
    /** How long the run took, in milliseconds. */
    readonly took: number
  }
  /** On a stop: `text` is the stops' line, `PAUSED: …`, with a scoped run's part as above. */
  Stopped: { readonly text: string }
}>

export const Ending = Data.taggedEnum<Ending>()
