// The dashboard (§ 7.2), drawn from RunView alone: the title line, the totals strip, the tickets
// table, the workers' cards (Current) and at the foot the wind-down line, the warning line and the
// hint; `?` opens the key help over it.
//
// As orchestra lays it out, the tickets table's height comes from the pane's alone, and the table is
// left out of a pane too short for it and a line for each worker the run may have, so it stays put
// while workers come and go. The cards take what is left, one line each when they don't fit. Below
// the minimum size, 60×16 (§ 7.7), only the totals, on one line, and the hint are drawn.
//
// The keys (§ 7.3), in the view's input layer (keys.ts): `Tab`, `Shift+Tab` and the arrows move the
// highlight between cards, `Enter` opens the highlighted card, `1`–`9` open that worker, and a click
// opens the card under it, each as an OpenWorker command naming the worker's stable number; `s`
// opens the stop question. With the key help open, `?` and `Esc` close it and the other keys do
// nothing.
import { useTerminalDimensions } from "@opentui/react"
import { useCallback, useRef, useState } from "react"
import { UiCommand } from "../run/commands.ts"
import type { Card } from "../run/runView.ts"
import { Cards, layoutOf, sectionLines } from "./Card.tsx"
import { Hint, hintSegments } from "./Hint.tsx"
import { KeyHelp } from "./KeyHelp.tsx"
import { Box, type KeyBinding, useInput, useLayer } from "./keys.ts"
import { cut, Lines, type Segments, seg } from "./line.tsx"
import { sectionChrome, TicketsTable, tableLines, ticketsLines } from "./TicketsTable.tsx"
import { TitleLine } from "./TitleLine.tsx"
import { Totals, totalsLines } from "./Totals.tsx"
import type { Theme } from "./theme.ts"
import { useCommand, useNow, useRunView, useSpinner, useTheme } from "./useRunView.ts"
import { WindDown, windDownSegments } from "./WindDown.tsx"

/** The smallest pane the whole dashboard is drawn in (§ 7.7). */
export const minWidth = 60
export const minHeight = 16

/** The title line and the blank line above it. */
const titleLines = 2

/** The foot's lines besides the warnings: the wind-down line, there or not, and the hint. */
const footLines = 2

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

/** The worker `step` cards on from `from` in number order, round; the first or last from none. */
export const moveHighlight = (
  cards: ReadonlyArray<Card>,
  from: number | null,
  step: 1 | -1,
): number | null => {
  if (cards.length === 0) return null
  const at = cards.findIndex((card) => card.worker === from)
  const next = at === -1 ? (step === 1 ? 0 : cards.length - 1) : at + step
  return cards[(next + cards.length) % cards.length]?.worker ?? null
}

export const Dashboard = () => {
  const view = useRunView()
  const theme = useTheme()
  const now = useNow()
  const command = useCommand()
  const { width, height } = useTerminalDimensions()
  // The highlight names a worker; one that has finished takes it with it. It is kept in a ref, so
  // that keys arriving together each see the one before them, and drawn from state.
  const chosen = useRef<number | null>(null)
  const [, redraw] = useState<number | null>(null)
  const [help, setHelp] = useState(false)
  const cards = view.cards
  const current = () =>
    cards.some((card) => card.worker === chosen.current) ? chosen.current : null
  const highlighted = current()
  const choose = (worker: number | null) => {
    chosen.current = worker
    redraw(worker)
  }
  const spin = useSpinner(cards.length === 0 || cards.some((card) => card.motion === "spinner"))
  const open = useCallback((worker: number) => command(UiCommand.OpenWorker({ worker })), [command])

  // The view's keys, as bound: a key does nothing while the key help is open, but close it.
  const { box } = useInput()
  const helpOpen = useRef(false)
  const showHelp = (shown: boolean) => {
    helpOpen.current = shown
    setHelp(shown)
  }
  const key = (keys: ReadonlyArray<string>, run: () => void): ReadonlyArray<KeyBinding> =>
    keys.map((each) => ({ key: each, run: () => (helpOpen.current ? undefined : run()) }))
  const enter = () => {
    const worker = current()
    if (worker !== null) open(worker)
  }
  const number = (worker: number) => () => {
    if (cards.some((card) => card.worker === worker)) open(worker)
  }
  useLayer("view", [
    { key: "?", run: () => showHelp(!helpOpen.current) },
    { key: "escape", run: () => showHelp(false) },
    // The stop question: stop after the running tickets, or, winding down, keep taking tickets.
    ...key(["s"], () => box.set(Box.Stop({ windingDown: view.windDown !== null }))),
    ...key(["tab", "right", "down"], () => choose(moveHighlight(cards, current(), 1))),
    ...key(["shift+tab", "left", "up"], () => choose(moveHighlight(cards, current(), -1))),
    ...key(["return", "enter"], enter),
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((worker) => key([String(worker)], number(worker))),
  ])

  const hint = hintSegments(view.hint, theme, width)
  if (width < minWidth || height < minHeight) {
    return (
      <box flexDirection="column" width={width} height={height}>
        <Totals lines={totalsLines(view.totals, theme, width, true)} />
        <box flexGrow={1} />
        <Hint segments={hint} />
        {help ? <KeyHelp theme={theme} width={width} height={height} /> : null}
      </box>
    )
  }
  const totals = totalsLines(view.totals, theme, width, false)
  const warnings = warningLines(view.warnings, theme, width)
  const foot = footLines + warnings.length
  const table = showsTable(height, totals.length, view.totals.slots, foot)
  const room = height - titleLines - totals.length - (table ? tableLines(height) : 0) - foot
  const layout = layoutOf(cards, width, room)
  return (
    <box flexDirection="column" width={width} height={height}>
      <TitleLine width={width} />
      <Totals lines={totals} />
      {table ? (
        <TicketsTable lines={ticketsLines(view.rows, theme, width, tableLines(height))} />
      ) : null}
      <box height={Math.min(sectionLines(layout, cards.length), Math.max(room, 0))} flexShrink={0}>
        <Cards
          cards={cards}
          theme={theme}
          layout={layout}
          width={width}
          now={now}
          spin={spin}
          stopping={view.title.stopping || view.windDown !== null}
          highlighted={highlighted}
          open={open}
        />
      </box>
      <box flexGrow={1} />
      {view.windDown === null ? null : (
        <WindDown segments={windDownSegments(view.windDown, theme, width)} />
      )}
      <Lines lines={warnings} />
      <Hint segments={hint} />
      {help ? <KeyHelp theme={theme} width={width} height={height} /> : null}
    </box>
  )
}
