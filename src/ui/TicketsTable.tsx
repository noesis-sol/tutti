// The dashboard's tickets table (§ 5.1 "How the phases are shown", § 7.2, § 7.11): under its
// `Tickets` label, a rounded frame with a row per ticket the run picked up but those Current shows,
// whatever their phase, so that no ticket is shown twice: the tickets that came to an end, in that
// order, a ticket's row coming in under the others as it leaves Current. Where Current isn't drawn
// (the end-of-run box), the running tickets keep their rows. A row's glyph, word and ID take its
// state's style; the rest of a finished ticket's row is faint, and a ticket set aside shows the
// triage organ's verdict, `◆ …`, once it is in.
//
// The table is as tall as the pane makes it, not as its tickets do: what the lines Current is kept
// leave it (Dashboard.tsx), room for 3 to 10 tickets, blank rows filling it until the run has that
// many, after which the oldest give way to a `+N earlier tickets` row. Only a resize changes it.
// The run's summary prints the same table, every row of it and no blank one (print/summary.ts).
import type { Card, Row } from "../run/runView.ts"
import { fit, framed, Lines, type Segments, seg } from "./line.tsx"
import type { StyleName, Theme } from "./theme.ts"

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

/** The row style of each status word, as § 7.11's ticket rows give them, and whether the rest of
 * the row is faint, as a finished ticket's is. */
export const rowLooks: Readonly<
  Record<string, { readonly style: StyleName; readonly faint: boolean }>
> = {
  working: { style: "picked", faint: false },
  editing: { style: "picked", faint: false },
  reading: { style: "picked", faint: false },
  subagent: { style: "picked", faint: false },
  starting: { style: "picked", faint: false },
  testing: { style: "testing", faint: false },
  done: { style: "closed", faint: true },
  deferred: { style: "deferred", faint: true },
  review: { style: "deferred", faint: true },
  resolving: { style: "deferred", faint: false },
  fixing: { style: "deferred", faint: false },
  retrying: { style: "deferred", faint: false },
  limit: { style: "deferred", faint: false },
  stopped: { style: "stop", faint: false },
  blocked: { style: "stop", faint: false },
  "for you": { style: "stop", faint: false },
  "allow?": { style: "stop", faint: false },
  "answer?": { style: "stop", faint: false },
  "to merge": { style: "toMerge", faint: false },
  merging: { style: "merging", faint: false },
  waiting: { style: "dim", faint: true },
  queued: { style: "dim", faint: true },
  "held back": { style: "dim", faint: true },
}

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

/** The table's lines with its label, `width` wide, as tall as `size` says. */
export const ticketsLines = (
  rows: ReadonlyArray<Row>,
  theme: Theme,
  width: number,
  size: TableSize,
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
  const hidden = rows.length > limit ? rows.length - (limit - 1) : 0
  const cells: Array<ReadonlyArray<Segments>> = []
  if (hidden > 0) {
    cells.push([
      [],
      [seg(`+${hidden}`, styles.dim)],
      [seg(fit("earlier tickets, see the log", aboutWidth), styles.dim)],
    ])
  }
  for (const row of rows.slice(hidden)) {
    const look = rowLooks[row.word] ?? { style: "dim", faint: false }
    const style = styles[look.style]
    const about =
      row.verdict !== null
        ? seg(fit(`◆ ${row.verdict}`, aboutWidth), styles.organ)
        : seg(fit(row.note, aboutWidth), look.faint ? styles.dim : null)
    cells.push([
      [seg(fit(`${row.mark} ${row.word}`, stateWidth), style)],
      [seg(fit(row.label, idWidth), style)],
      [about],
    ])
  }
  while (cells.length < limit) cells.push([[], [], []])
  return [
    [seg("  "), seg("Tickets", styles.tickets)],
    ...framed(cells, [stateWidth, idWidth, aboutWidth], theme.look("frame")),
  ]
}

/** The tickets table, as ticketsLines gives it. */
export const TicketsTable = ({ lines }: { readonly lines: ReadonlyArray<Segments> }) => (
  <Lines lines={lines} />
)
