// The dashboard's tickets table (§ 5.1 "How the phases are shown", § 7.2, § 7.11): under its
// `Tickets` label, a rounded frame with a row per ticket the run picked up, in the order it picked
// them up, each keeping its place as its phase changes. A row's glyph, word and ID take its state's
// style; the rest of a finished ticket's row is faint, and a ticket set aside shows the triage
// organ's verdict, `◆ …`, once it is in.
//
// The table is as tall as the pane makes it, not as its tickets do: about a third of the pane, room
// for 3 to 10 tickets, blank rows filling it until the run has that many, after which the oldest
// give way to a `+N earlier tickets` row. Only a resize changes it.
import { fit, rowLooks } from "../print/summary.ts"
import type { Row } from "../run/runView.ts"
import { framed, frameLook, Lines, type Segments, seg } from "./line.tsx"
import type { Theme } from "./theme.ts"

/** The lines a section takes besides its rows: its label, and its frame's top and bottom. */
export const sectionChrome = 3

/** How many tickets the table has rows for, in a pane short or tall. */
const minRows = 3
const maxRows = 10

/** The lines the table takes in a pane `height` lines tall, its label and frame included. */
export const tableLines = (height: number): number =>
  Math.min(Math.max(Math.floor(height / 3) - 1 - sectionChrome, minRows), maxRows) + sectionChrome

/** The state column's width: its glyph and its longest word, `⟳ resolving`. */
const stateWidth = 11

/** The narrowest an ID column and the last column are. */
const minIdWidth = 7
const minAboutWidth = 8

/** The table's lines, `lines` in all with its label, `width` wide. */
export const ticketsLines = (
  rows: ReadonlyArray<Row>,
  theme: Theme,
  width: number,
  lines: number,
): ReadonlyArray<Segments> => {
  const { styles } = theme
  // A worker files tickets, so an ID is untrusted, and one longer than a third of the table is cut.
  const idWidth = Math.max(
    Math.min(
      Math.max(minIdWidth, ...rows.map((row) => Bun.stringWidth(row.ticket))),
      Math.max(Math.floor(width / 3), minIdWidth),
      width - 4 - (stateWidth + 2) - 2 - (minAboutWidth + 2),
    ),
    1,
  )
  const aboutWidth = Math.max(width - 4 - (stateWidth + 2) - (idWidth + 2) - 2, 1)
  const limit = Math.max(lines - sectionChrome, 1)
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
      [seg(fit(row.ticket, idWidth), style)],
      [about],
    ])
  }
  while (cells.length < limit) cells.push([[], [], []])
  return [
    [seg("  "), seg("Tickets", styles.tickets)],
    ...framed(cells, [stateWidth, idWidth, aboutWidth], frameLook(theme)),
  ]
}

/** The tickets table, as ticketsLines gives it. */
export const TicketsTable = ({ lines }: { readonly lines: ReadonlyArray<Segments> }) => (
  <Lines lines={lines} />
)
