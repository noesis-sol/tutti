// The dashboard's tickets table (§ 5.1 "How the phases are shown", § 7.2, § 7.11): under its
// `Tickets` label, a rounded frame with a row per ticket the run picked up but those Current shows,
// whatever their phase, so that no ticket is shown twice: the tickets that came to an end, in that
// order, a ticket's row coming in under the others as it leaves Current. Where Current isn't drawn
// (the end-of-run box), the running tickets keep their rows. A row's glyph, word and ID take its
// state's tone, as RunView worked it out (marks.ts); the rest of a finished ticket's row is faint, and a ticket set aside shows the
// triage organ's verdict, `◆ …`, once it is in.
//
// The table is as tall as the pane makes it, not as its tickets do: what the lines Current is kept
// leave it (Dashboard.tsx), room for 3 to 10 tickets, blank rows filling it until the run has that
// many, after which the oldest give way to a `+N earlier tickets` row. Only a resize changes it.
// The run's summary prints the same table, every row of it and no blank one (print/summary.ts).
// On the dashboard an Asked row says its question (RunView's note) and is a click target, and the
// highlight reaches it (TableReach, tutti-fdv1): it opens the questions box at its question.
import type { Card, Row } from "../run/runView.ts"
import type { TicketId } from "../services/Beads.ts"
import { fit, framed, padded, type Segments, seg, targeting } from "./line.tsx"
import { lookOf, marks } from "./marks.ts"
import type { Theme } from "./theme.ts"

/** The lines a section takes besides its rows: its label, and its frame's top and bottom. */
export const sectionChrome = 3

/** How many tickets the table has rows for, in a pane short or tall. */
const minRows = 3
const maxRows = 10

/**
 * The lines the table takes, its label and frame included, of `room` lines for it and Current: what
 * Current's `kept` lines leave, room for 3 to 10 tickets.
 */
export const tableLines = (room: number, kept: number): number =>
  Math.min(Math.max(room - kept - sectionChrome, minRows), maxRows) + sectionChrome

/** The fewest lines the table is drawn in, its label and frame included. */
export const fewestTableLines = minRows + sectionChrome

/** The state column's width: its glyph and its longest word, `⟳ resolving`. */
const stateWidth = 11

/** The narrowest an ID column and the last column are. */
const minIdWidth = 7
const minAboutWidth = 8

/**
 * How tall the table is: `lines` in all with its label, blank rows filling it and the oldest rows
 * giving way to `+N earlier tickets` (the dashboard's); or, `fill: false`, as tall as its rows,
 * every one of them shown (the summary's).
 */
export type TableSize = { readonly lines: number } | { readonly fill: false }

/** The rows the table has when Current is drawn with it: all but those of the tickets it shows. */
export const rowsBesideCurrent = (
  rows: ReadonlyArray<Row>,
  cards: ReadonlyArray<Card>,
): ReadonlyArray<Row> => {
  const current = new Set(cards.map((card) => card.ticket))
  return rows.filter((row) => !current.has(row.ticket))
}

/** The rows a table `size` tall draws: the newest, where the oldest give way to `+N earlier`. */
export const shownRows = (rows: ReadonlyArray<Row>, size: TableSize): ReadonlyArray<Row> => {
  const limit = "lines" in size ? Math.max(size.lines - sectionChrome, 1) : rows.length
  return rows.length > limit ? rows.slice(rows.length - (limit - 1)) : rows
}

/**
 * What the dashboard's keys and clicks reach in the table (§ 7.2): the row the highlight is on,
 * drawn in the focus's look, and each row's click target, where it has one (an Asked row's).
 */
export interface TableReach {
  readonly highlighted: TicketId | null
  readonly target: (row: Row) => number | undefined
}

/** The table's lines with its label, `width` wide, as tall as `size` says. */
export const ticketsLines = (
  rows: ReadonlyArray<Row>,
  theme: Theme,
  width: number,
  size: TableSize,
  reach?: TableReach,
): ReadonlyArray<Segments> => {
  const { styles } = theme
  // A worker files tickets, so an ID is untrusted, and one longer than a third of the table is cut.
  const idWidth = Math.max(
    Math.min(
      Math.max(minIdWidth, ...rows.map((row) => Bun.stringWidth(row.label))),
      Math.max(Math.floor(width / 3), minIdWidth),
      width - 4 - (stateWidth + 2) - 2 - (minAboutWidth + 2),
    ),
    1,
  )
  const aboutWidth = Math.max(width - 4 - (stateWidth + 2) - (idWidth + 2) - 2, 1)
  const limit = "lines" in size ? Math.max(size.lines - sectionChrome, 1) : rows.length
  const shown = shownRows(rows, size)
  const hidden = rows.length - shown.length
  const cells: Array<ReadonlyArray<Segments>> = []
  if (hidden > 0) {
    cells.push([
      [],
      [seg(`+${hidden}`, styles.dim)],
      [seg(fit("earlier tickets, see the log", aboutWidth), styles.dim)],
    ])
  }
  for (const row of shown) {
    const style = lookOf(row.tone, theme)
    const about =
      row.verdict !== null
        ? seg(fit(`${marks.verdict} ${row.verdict}`, aboutWidth), styles.organ)
        : seg(fit(row.note, aboutWidth), row.faint ? styles.dim : null)
    const drawn: ReadonlyArray<Segments> = [
      [seg(fit(`${marks[row.mark]} ${row.word}`, stateWidth), style)],
      [seg(fit(row.label, idWidth), style)],
      [about],
    ]
    // The highlighted row is drawn in the focus's look, which shows without colour (§ 7.11).
    const focused =
      reach?.highlighted === row.ticket
        ? drawn.map((cell) => cell.map((each) => ({ ...each, look: theme.form.focusedButton })))
        : drawn
    // A click anywhere on a row with a target presses it, its cells padded to their widths.
    const target = reach?.target(row)
    const widths = [stateWidth, idWidth, aboutWidth]
    cells.push(
      target === undefined
        ? focused
        : focused.map((cell, i) => targeting(padded(cell, widths[i] ?? 0), target)),
    )
  }
  while (cells.length < limit) cells.push([[], [], []])
  return [
    [seg("  "), seg("Tickets", styles.tickets)],
    ...framed(cells, [stateWidth, idWidth, aboutWidth], theme.look("frame")),
  ]
}
