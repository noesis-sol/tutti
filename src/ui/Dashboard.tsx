// The dashboard (§ 7.2), drawn from RunView alone: the title line, the load line (LoadLine.tsx), a
// blank line between, the totals strip, the tickets table (without the tickets Current shows), the workers' cards (Current) and at the foot the
// wind-down line, the warning line and the hint; `?` opens the key help over it.
//
// As orchestra lays it out, the tickets table's height comes from the pane's alone, and the table is
// left out of a pane too short for it and a line for each worker the run may have, so it stays put
// while workers come and go. The cards take what is left, one line each when they don't fit. A pane
// too short for a line each drops the blank line above the load line first, before any line with
// something on it. Below the minimum size, 60×16 (§ 7.7), only the totals, on one line, and the hint
// are drawn.
//
// The keys (§ 7.3), in the view's input layer (keys.ts): `Tab`, `Shift+Tab` and the arrows move the
// highlight between cards, `Enter` opens the highlighted card, `1`–`9` open that worker, and a click
// opens the card under it, each as an OpenWorker command naming the worker's stable number; `s`
// opens the stop question. With the key help open, `?` and `Esc` close it and the other keys do
// nothing.
//
// Attention cards (§ 4.5, AttentionCard.tsx): with no card chosen, the card of the oldest open
// request is highlighted, and its request is the target. Inside a highlighted attention card, `Tab`,
// `Shift+Tab`, `→` and `←` move between its buttons before moving on, `Enter` presses the focused
// one and `1`–`4` pick a question's option; `d`, `Shift+D`, `a` and `r` answer the highlighted
// card's request. On a compact line, `Enter` opens the Answer box.
//
// With everything else done and workers waiting on you (D19), the end-of-run box (EndOfRunBox.tsx)
// replaces the cards, and `q` ends the run (EndRun). The answer keys still answer the target
// request, and `1`–`9` open a worker's view to answer there.
import { useTerminalDimensions } from "@opentui/react"
import { useCallback, useRef, useState } from "react"
import { UiCommand } from "../run/commands.ts"
import type { Card } from "../run/runView.ts"
import { answerBindings } from "./AttentionCard.tsx"
import { optionKeys, useAnswering } from "./attentionKeys.ts"
import { Cards, type CardsLayout, grows, layoutOf, sectionLines } from "./Card.tsx"
import { EndOfRunBox, endOfRunLines } from "./EndOfRunBox.tsx"
import { Hint, hintSegments } from "./Hint.tsx"
import { KeyHelp } from "./KeyHelp.tsx"
import { Box, type KeyBinding, useInput, useLayer } from "./keys.ts"
import { LoadLine, loadSegments } from "./LoadLine.tsx"
import { cut, Line, Lines, type Segments, seg } from "./line.tsx"
import {
  rowsBesideCurrent,
  sectionChrome,
  TicketsTable,
  tableLines,
  ticketsLines,
} from "./TicketsTable.tsx"
import { TitleLine } from "./TitleLine.tsx"
import { Totals, totalsLines } from "./Totals.tsx"
import type { Theme } from "./theme.ts"
import { useCommand, useNow, useRunView, useSpinner, useTheme } from "./useRunView.ts"
import { WindDown, windDownSegments } from "./WindDown.tsx"

/** The smallest pane the whole dashboard is drawn in (§ 7.7). */
export const minWidth = 60
export const minHeight = 16

/** The title line and the blank line above it, and the load line under it. */
const titleLines = 3

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

/**
 * Whether a pane `height` tall has room for the blank line between the title line and the load
 * line, besides the rest, `table` lines of tickets table among them, and a line for each worker.
 */
export const showsGap = (
  height: number,
  totals: number,
  table: number,
  slots: number,
  foot: number,
): boolean => titleLines + 1 + totals + table + Math.max(slots, 1) + sectionChrome + foot <= height

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
  // With none chosen, the card of the oldest open request is the target, and highlighted (§ 4.5).
  const oldest = view.requests[0]
  const target = cards.find((card) => card.ticket === oldest?.ticket)?.worker ?? null
  const current = () =>
    cards.some((card) => card.worker === chosen.current) ? chosen.current : target
  const highlighted = current()
  const choose = (worker: number | null) => {
    chosen.current = worker
    redraw(worker)
  }
  const spin = useSpinner(cards.length === 0 || cards.some((card) => card.motion === "spinner"))
  const open = useCallback((worker: number) => command(UiCommand.OpenWorker({ worker })), [command])
  const answering = useAnswering(cards)

  const small = width < minWidth || height < minHeight
  const totals = totalsLines(view.totals, theme, width, small)
  const warnings = warningLines(view.warnings, theme, width)
  const foot = footLines + warnings.length
  const table = showsTable(height, totals.length, view.totals.slots, foot)
  const tableHeight = table ? tableLines(height) : 0
  const gap = showsGap(height, totals.length, tableHeight, view.totals.slots, foot)
  const room = height - titleLines - (gap ? 1 : 0) - totals.length - tableHeight - foot
  const ending = view.endOfRun === null ? null : endOfRunLines(view.endOfRun, theme, width)
  // Behind the end-of-run box no card's buttons are drawn: Enter opens the Answer box, as on a
  // compact line.
  const layout: CardsLayout =
    small || ending !== null ? { _tag: "Compact" } : layoutOf(cards, width, room)
  // Beside Current, the table leaves out the tickets it shows; the end-of-run box shows none.
  const rows = ending === null ? rowsBesideCurrent(view.rows, cards) : view.rows
  const endingNow = useRef(false)
  endingNow.current = ending !== null

  // The view's keys, as bound: a key does nothing while the key help is open, but close it.
  const { box } = useInput()
  const helpOpen = useRef(false)
  const showHelp = (shown: boolean) => {
    helpOpen.current = shown
    setHelp(shown)
  }
  const key = (keys: ReadonlyArray<string>, run: () => void): ReadonlyArray<KeyBinding> =>
    keys.map((each) => ({ key: each, run: () => (helpOpen.current ? undefined : run()) }))
  const highlightedCard = () => cards.find((card) => card.worker === current())
  // The attention card highlighted, with its buttons drawn: the one Tab, Enter and 1–4 work in.
  const inCard = () => {
    const card = highlightedCard()
    return card !== undefined && grows(card) && layout._tag === "Cards" ? card : undefined
  }
  const step = (by: 1 | -1, buttons: boolean) => {
    const card = buttons ? inCard() : undefined
    if (card !== undefined && answering.step(card, by)) return
    answering.reset()
    choose(moveHighlight(cards, current(), by))
  }
  const enter = () => {
    const card = highlightedCard()
    if (card === undefined) return
    if (grows(card) && layout._tag !== "Cards") box.set(Box.Answer({ worker: card.worker }))
    else if (inCard() === undefined || !answering.pressFocused(card)) open(card.worker)
  }
  const number = (worker: number) => () => {
    const card = inCard()
    if (card !== undefined && worker <= optionKeys && answering.pick(card, worker)) return
    if (cards.some((card) => card.worker === worker)) open(worker)
  }
  const targetCard = () => {
    const card = highlightedCard()
    return card !== undefined && grows(card) ? card : undefined
  }
  useLayer("view", [
    { key: "?", run: () => showHelp(!helpOpen.current) },
    { key: "escape", run: () => showHelp(false) },
    // The stop question: stop after the running tickets, or, winding down, keep taking tickets.
    ...key(["s"], () => box.set(Box.Stop({ windingDown: view.windDown !== null }))),
    // With the end-of-run box shown, `q` ends the run.
    ...key(["q"], () => (endingNow.current ? command(UiCommand.EndRun()) : undefined)),
    // Tab and → move between an attention card's buttons, and on to the next card; ↓ and ↑ from
    // card to card.
    ...key(["tab", "right"], () => step(1, true)),
    ...key(["shift+tab", "left"], () => step(-1, true)),
    ...key(["down"], () => step(1, false)),
    ...key(["up"], () => step(-1, false)),
    ...key(["return", "enter"], enter),
    ...answerBindings(answering, targetCard).flatMap((binding) => key([binding.key], binding.run)),
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((worker) => key([String(worker)], number(worker))),
  ])

  const hint = hintSegments(view.hint, theme, width)
  if (small) {
    return (
      <box flexDirection="column" width={width} height={height}>
        <Totals lines={totals} />
        <box flexGrow={1} />
        <Hint segments={hint} />
        {help ? <KeyHelp theme={theme} width={width} height={height} /> : null}
      </box>
    )
  }
  return (
    <box flexDirection="column" width={width} height={height}>
      <TitleLine width={width} />
      {gap ? <Line segments={[]} /> : null}
      <LoadLine segments={loadSegments(view.totals, view.load, theme, width)} />
      <Totals lines={totals} />
      {table ? <TicketsTable lines={ticketsLines(rows, theme, width, tableLines(height))} /> : null}
      {ending !== null ? (
        <box height={Math.min(ending.length, Math.max(room, 0))} flexShrink={0}>
          <EndOfRunBox lines={ending} />
        </box>
      ) : (
        <box
          height={Math.min(sectionLines(layout, cards.length), Math.max(room, 0))}
          flexShrink={0}
        >
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
            focusOf={answering.focusOf}
            press={answering.press}
          />
        </box>
      )}
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
