// The dashboard's tickets table (§ 5.1 "How the phases are shown", § 7.2, § 7.11): under its
// `Tickets` label, a rounded frame with a row per ticket the run picked up but those Current shows,
// whatever their phase, so that no ticket is shown twice, in the order of what they want of you
// (byAttention): Blocked, Asked, set aside, then the rest. Where Current isn't drawn (the end-of-run
// box), the running tickets keep their rows. A row's glyph, word and ID take its
// state's tone, as RunView worked it out (marks.ts); the rest of a finished ticket's row is faint, and a ticket set aside shows the
// triage organ's verdict, `◆ …`, once it is in.
//
// The table is as tall as the pane makes it, not as its tickets do: what the lines Current is kept
// leave it (Dashboard.tsx), room for 3 to 10 tickets, blank rows filling it until the run has that
// many, after which the oldest of the rest give way to a `+N earlier tickets` row at the bottom,
// which says how many more want you where those don't fit either. Only a resize changes it.
// The run's summary prints the same table, every row of it and no blank one, in the order their
// tickets came to an end, a record of the run with nothing to fold (print/summary.ts).
// On the dashboard an Asked row says its question (RunView's note). Every row is a click target,
// and the keys reach it inside the panel (TableReach, § 7.3): a click or ↑↓ selects it, drawn in
// the focus's look, and Enter opens it. A row's ID cell is a click target of its own, which copies
// the ID (tutti-vkuj); for a moment after, it says `✓ copied` in its place. With the focus on the
// panel, its frame is drawn bright.
import type { Attention, Card, Row } from "../run/runView.ts"
import type { TicketId } from "../services/Beads.ts"
import {
  fit,
  framed,
  framedWidth,
  padded,
  type Segments,
  sectionLabel,
  seg,
  targeting,
} from "./line.tsx"
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

/** The pointer's gutter before the state on the dashboard: `▸ ` on the row selected, else blank. */
const pointerWidth = 2

/** The narrowest an ID column and the last column are. */
const minIdWidth = 7
const minAboutWidth = 8

/**
 * How tall the table is: `lines` in all with its label, by attention, blank rows filling it and the
 * last rows giving way to `+N earlier tickets` (the dashboard's); or, `fill: false`, as tall as its
 * rows, every one of them shown in the order it is given them (the summary's).
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

/**
 * The groups' places, and their times' direction (§ 5.1): what waits on you oldest first, the one
 * waiting longest having cost the most; what no longer does newest first, what just happened on top.
 */
const attentionOrder: {
  readonly [A in Attention]: { readonly place: number; readonly time: 1 | -1 }
} = {
  blocked: { place: 0, time: 1 },
  asked: { place: 1, time: 1 },
  setAside: { place: 2, time: -1 },
  rest: { place: 3, time: -1 },
}

/** `rows`, the order their tickets came to an end, as the dashboard's table lists them. */
export const byAttention = (rows: ReadonlyArray<Row>): ReadonlyArray<Row> =>
  rows
    .map((row, at) => ({ row, at }))
    .sort((a, b) => {
      const { place, time } = attentionOrder[a.row.attention]
      return (
        place - attentionOrder[b.row.attention].place ||
        time * (a.row.since - b.row.since || a.at - b.at)
      )
    })
    .map(({ row }) => row)

/**
 * The rows a table `size` tall draws: the first by attention, where the last give way to a row
 * saying how many, so that the oldest of the rest go first and what wants you goes last. Rows that
 * want you and just fill the table keep every line, the rest going unsaid: the totals count them.
 */
export const shownRows = (rows: ReadonlyArray<Row>, size: TableSize): ReadonlyArray<Row> => {
  if (!("lines" in size)) return rows
  const limit = Math.max(size.lines - sectionChrome, 1)
  const ordered = byAttention(rows)
  if (ordered.length <= limit) return ordered
  const wanting = ordered.filter((row) => row.attention !== "rest").length
  return ordered.slice(0, wanting === limit ? limit : limit - 1)
}

/** What the row in place of the rows with no room says of a group of them. */
const foldedWords: ReadonlyArray<readonly [Attention, string]> = [
  ["blocked", "blocked"],
  ["asked", "asked"],
  ["setAside", "set aside"],
]

/**
 * The row in place of `hidden`, the rows with no room: `+N earlier tickets`, or, where rows that
 * want you are among them, how many of those by group, so that none goes unsaid. What waits on you
 * is drawn as it is on its own row, and what has only ended faint.
 */
const foldedCells = (
  hidden: ReadonlyArray<Row>,
  theme: Theme,
  aboutWidth: number,
): ReadonlyArray<Segments> => {
  const { styles } = theme
  const countOf = (attention: Attention) =>
    hidden.filter((row) => row.attention === attention).length
  const earlier = countOf("rest")
  const wanting = hidden.length - earlier
  if (wanting === 0) {
    return [
      [],
      [seg(`+${earlier}`, styles.dim)],
      [seg(fit("earlier tickets, see the log", aboutWidth), styles.dim)],
    ]
  }
  const style = countOf("blocked") + countOf("asked") > 0 ? styles.stop : styles.deferred
  const groups = foldedWords.flatMap(([attention, word]) => {
    const count = countOf(attention)
    return count === 0 ? [] : [`${count} ${word}`]
  })
  const rest = earlier === 0 ? [] : [`+${earlier} earlier`]
  return [
    [],
    [seg(`+${wanting}`, style)],
    [seg(fit(`more: ${[...groups, ...rest].join(", ")}`, aboutWidth), style)],
  ]
}

/**
 * What the dashboard's keys and clicks reach in the table (§ 7.2): the row selected, drawn in the
 * focus's look, whether the focus is on the table, which draws its frame bright, and each row's
 * click target; each row's ID cell's, which copies its ID, and the row whose ID was just copied.
 */
export interface TableReach {
  readonly highlighted: TicketId | null
  readonly focused?: boolean
  readonly target: (row: Row) => number | undefined
  readonly idTarget: (row: Row) => number
  readonly copied: string | null
}

/** What an ID cell says once its ID is copied: `✓ copied`, or `✓` where the column is narrower. */
export const copiedCell = (width: number): string => {
  const said = `${marks.done} copied`
  return Bun.stringWidth(said) <= width ? said : marks.done
}

/**
 * A row's last column: its verdict in `organ` bold, its note faint or plain. The row selected lifts
 * it to the pointer's look, what `bold` alone can't do for a faint note, which stays dim, or for a
 * verdict, already bold; a verdict's mark keeps `organ`, so that it still reads as one.
 */
const aboutCell = (row: Row, theme: Theme, width: number, selected: boolean): Segments => {
  const { styles } = theme
  if (row.verdict === null) {
    const note = fit(row.note, width)
    return [seg(note, selected ? styles.key : row.faint ? styles.dim : null)]
  }
  const verdict = fit(`${marks.verdict} ${row.verdict}`, width)
  if (!selected) return [seg(verdict, styles.organ)]
  return verdict.startsWith(marks.verdict)
    ? [seg(marks.verdict, styles.organ), seg(verdict.slice(marks.verdict.length), styles.key)]
    : [seg(verdict, styles.key)]
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
  // On the dashboard the state column has the pointer's gutter before it.
  const gutter = reach === undefined ? 0 : pointerWidth
  const stateColumn = stateWidth + gutter
  // What the table `width` wide leaves a column beside columns `others` wide.
  const room = (others: ReadonlyArray<number>) => width - framedWidth([...others, 0])
  // A worker files tickets, so an ID is untrusted, and one longer than a third of the table is cut.
  const idWidth = Math.max(
    Math.min(
      Math.max(minIdWidth, ...rows.map((row) => Bun.stringWidth(row.label))),
      Math.max(Math.floor(width / 3), minIdWidth),
      room([stateColumn, minAboutWidth]),
    ),
    1,
  )
  const aboutWidth = Math.max(room([stateColumn, idWidth]), 1)
  const limit = "lines" in size ? Math.max(size.lines - sectionChrome, 1) : rows.length
  const shown = shownRows(rows, size)
  const drawnRows = new Set(shown)
  const hidden = rows.filter((row) => !drawnRows.has(row))
  const cells: Array<ReadonlyArray<Segments>> = []
  for (const row of shown) {
    const style = lookOf(row.tone, theme)
    // The highlighted row has the pointer in its gutter, its state and ID go bold in their own
    // colours, and its note lifts to the pointer's look: no fill hides them, and neither is colour
    // alone (§ 7.11).
    const selected = reach?.highlighted === row.ticket
    const about = aboutCell(row, theme, aboutWidth, selected)
    const pointer =
      gutter === 0
        ? []
        : [selected ? seg(`${marks.selected} `, styles.key) : seg(" ".repeat(gutter))]
    const drawn: ReadonlyArray<Segments> = [
      [...pointer, seg(fit(`${marks[row.mark]} ${row.word}`, stateWidth), style)],
      [
        reach?.copied === row.ticket
          ? seg(copiedCell(idWidth), styles.closed)
          : seg(fit(row.label, idWidth), style),
      ],
      about,
    ]
    const bold = (cell: Segments): Segments =>
      cell.map((each) => ({ ...each, look: each.look?.bold() ?? theme.look(null, "bold") }))
    // A click anywhere on a row with a target presses it, but on its ID cell, which copies the ID;
    // the cells with a target are padded to their widths.
    const target = reach?.target(row)
    const targets = [target, reach?.idTarget(row), target]
    const widths = [stateColumn, idWidth, aboutWidth]
    cells.push(
      drawn.map((shown, i) => {
        const cell = selected ? bold(shown) : shown
        const each = targets[i]
        return each === undefined ? cell : targeting(padded(cell, widths[i] ?? 0), each)
      }),
    )
  }
  if (hidden.length > 0 && cells.length < limit) cells.push(foldedCells(hidden, theme, aboutWidth))
  while (cells.length < limit) cells.push([[], [], []])
  // With the focus on the table its lines go bright, those between its columns and their joins with
  // the frame too, so that no column line starts and ends in a bright stub. Its label goes with them;
  // printed, where nothing has the focus, it stays lit over the dim frame.
  return [
    sectionLabel("Tickets", theme, { lit: reach === undefined || reach.focused === true }),
    ...framed(
      cells,
      [stateColumn, idWidth, aboutWidth],
      reach?.focused === true ? theme.look("emphasis", "bold") : theme.look("frame"),
    ),
  ]
}
