// The dashboard (§ 7.2), drawn from RunView alone: the title line, the totals strip, the tickets
// table, the workers' cards (Current) and at the foot the warning line and the hint.
//
// As orchestra lays it out, the tickets table's height comes from the pane's alone, and the table is
// left out of a pane too short for it and a line for each worker the run may have, so it stays put
// while workers come and go. Below the minimum size, 60×16 (§ 7.7), only the totals, on one line,
// and the hint are drawn.
import { useTerminalDimensions } from "@opentui/react"
import type { Key } from "../run/runView.ts"
import { Box, useInput, useLayer } from "./keys.ts"
import { cut, Lines, type Segments, seg } from "./line.tsx"
import { sectionChrome, TicketsTable, tableLines, ticketsLines } from "./TicketsTable.tsx"
import { TitleLine } from "./TitleLine.tsx"
import { Totals, totalsLines } from "./Totals.tsx"
import type { Theme } from "./theme.ts"
import { useRunView, useTheme } from "./useRunView.ts"

/** The smallest pane the whole dashboard is drawn in (§ 7.7). */
export const minWidth = 60
export const minHeight = 16

/** The title line and the blank line above it. */
const titleLines = 2

/** The foot's lines besides the warnings: the wind-down line, there or not, and the hint. */
const footLines = 2

/** The hint `width` wide: each key `emphasis` bold, its words faint, ` · ` faint. */
export const hintSegments = (keys: ReadonlyArray<Key>, theme: Theme, width: number): Segments => {
  const { styles } = theme
  return cut(
    [
      seg("  "),
      ...keys.flatMap((key, i) => [
        ...(i === 0 ? [] : [seg(" · ", styles.dim)]),
        seg(key.keys, styles.key),
        seg(` ${key.does}`, styles.dim),
      ]),
    ],
    width,
  )
}

/** The warning line's lines, ` ! …` `notice`, one a warning. */
export const warningLines = (
  warnings: ReadonlyArray<string>,
  theme: Theme,
  width: number,
): ReadonlyArray<Segments> =>
  warnings.map((warning) => cut([seg(` ! ${warning}`, theme.styles.deferred)], width))

/** Whether a pane `height` tall has room for the tickets table, besides what it always shows. */
export const showsTable = (height: number, totals: number, slots: number, foot: number): boolean =>
  titleLines + totals + Math.max(slots, 1) + sectionChrome + foot + tableLines(height) <= height

export const Dashboard = () => {
  const view = useRunView()
  const theme = useTheme()
  const { box } = useInput()
  // The stop question: stop after the running tickets, or, winding down, keep taking tickets.
  useLayer("view", [
    { key: "s", run: () => box.set(Box.Stop({ windingDown: view.windDown !== null })) },
  ])
  const { width, height } = useTerminalDimensions()
  const hint = hintSegments(view.hint, theme, width)
  if (width < minWidth || height < minHeight) {
    return (
      <box flexDirection="column" width={width} height={height}>
        <Totals lines={totalsLines(view.totals, theme, width, true)} />
        <box flexGrow={1} />
        <Lines lines={[hint]} />
      </box>
    )
  }
  const totals = totalsLines(view.totals, theme, width, false)
  const warnings = warningLines(view.warnings, theme, width)
  const table = showsTable(height, totals.length, view.totals.slots, footLines + warnings.length)
  return (
    <box flexDirection="column" width={width} height={height}>
      <TitleLine width={width} />
      <Totals lines={totals} />
      {table ? (
        <TicketsTable lines={ticketsLines(view.rows, theme, width, tableLines(height))} />
      ) : null}
      <box flexGrow={1} />
      <Lines lines={warnings} />
      <Lines lines={[hint]} />
    </box>
  )
}
