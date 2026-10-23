// The dashboard (§ 7.2), drawn from RunView alone: the title line, the load line (LoadLine.tsx), a
// blank line between, the totals strip, the tickets table (without the tickets Current shows), the workers' cards (Current) and at the foot the
// wind-down line, the warning line and the hint; `?` opens the key help over it.
//
// The tickets table's height comes from the pane's and the workers the run may have alone, so it
// stays put while workers come and go: Current is kept room for a full card for each of up to 6 of
// them and a line for each of the rest (Card.tsx's keptLines), and the table takes what is left,
// 3 to 10 rows, where orchestra's takes a third of the pane (§ 7.2). The table is left out of a pane
// too short for it and a line for each worker. The cards take what is left, one line each when they
// don't fit. A pane
// too short for a line each drops the blank line above the load line first, before any line with
// something on it. Below the minimum size, 60×16 (§ 7.7), only the totals, on one line, and the hint
// are drawn.
//
// The keys (§ 7.3), in the view's input layer (keys.ts): `Tab`, `Shift+Tab` and the arrows move the
// highlight between cards, `Enter` opens the highlighted card, and a click opens the card under it,
// each as an OpenWorker command naming the card's ticket; `s` opens the stop question. The
// highlight names a ticket too, so it stays on its card as other cards come and go. With the key help open, `?` and `Esc` close it and the other keys do
// nothing.
//
// Attention cards (§ 4.5, AttentionCard.tsx): with no card chosen, the card of the oldest open
// request is highlighted, and its request is the target. Inside a highlighted attention card, `Tab`,
// `Shift+Tab`, `→` and `←` move between its buttons before moving on, `Enter` presses the focused
// one and `1`–`4` pick a question's option; `d`, `Shift+D`, `a` and `r` answer the highlighted
// card's request. They answer only a request drawn with its buttons, which only the full cards
// draw: on a compact line, below the minimum size and behind the end-of-run box, `Enter` and the
// answer keys open the Answer box instead, the 500 ms guard starts only once the buttons are drawn,
// and the hint offers neither `d` nor `a`.
//
// With everything else done and workers waiting on you (D19), the end-of-run box (EndOfRunBox.tsx)
// replaces the cards, and `q` ends the run (EndRun). `Tab` then `Enter` open a worker's view to
// answer there.
import { useTerminalDimensions } from "@opentui/react"
import { useCallback, useRef } from "react"
import { UiCommand } from "../run/commands.ts"
import type { Card, Key } from "../run/runView.ts"
import { answerBindings } from "./AttentionCard.tsx"
import { useAnswering } from "./attentionKeys.ts"
import { Cards, type CardsLayout, grows, keptLines, layoutOf, sectionLines } from "./Card.tsx"
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
import { useKeyState } from "./useKeyState.ts"
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

/**
 * The lines the tickets table takes in a pane `height` tall and `width` wide: what the title line,
 * the blank line under it, `totals` lines of totals, `foot` lines at the foot and the lines Current
 * is kept for `slots` workers leave it.
 */
export const tableHeight = (
  height: number,
  width: number,
  totals: number,
  slots: number,
  foot: number,
): number => tableLines(height - titleLines - 1 - totals - foot, keptLines(width, slots))

/**
 * Whether a pane `height` tall has room for `table` lines of tickets table, besides what it always
 * shows.
 */
export const showsTable = (
  height: number,
  totals: number,
  slots: number,
  foot: number,
  table: number,
): boolean => titleLines + totals + Math.max(slots, 1) + sectionChrome + foot + table <= height

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

/**
 * The hint's keys, as RunView names them, with `d` and `a` left out when the dashboard draws no
 * request's buttons (`buttons` false): there they open the Answer box, not answer (§ 4.5).
 */
export const drawnHint = (keys: ReadonlyArray<Key>, buttons: boolean): ReadonlyArray<Key> =>
  buttons ? keys : keys.filter((key) => key.keys !== "d" && key.keys !== "a")

/** The ticket of the card `step` cards on from `from`'s, round; the first or last from none. */
export const moveHighlight = (
  cards: ReadonlyArray<Card>,
  from: string | null,
  step: 1 | -1,
): string | null => {
  if (cards.length === 0) return null
  const at = cards.findIndex((card) => card.ticket === from)
  const next = at === -1 ? (step === 1 ? 0 : cards.length - 1) : at + step
  return cards[(next + cards.length) % cards.length]?.ticket ?? null
}

export const Dashboard = () => {
  const view = useRunView()
  const theme = useTheme()
  const now = useNow()
  const command = useCommand()
  const { width, height } = useTerminalDimensions()
  // The highlight names a ticket; a card that has gone takes it with it. It is key state, so that
  // keys arriving together each see the one before them.
  const [, setChosen, chosen] = useKeyState<string | null>(() => null)
  const [help, setHelp, helpOpen] = useKeyState(() => false)
  const cards = view.cards
  // With none chosen, the card of the oldest open request is the target, and highlighted (§ 4.5).
  const oldest = view.requests[0]
  const target = cards.find((card) => card.ticket === oldest?.ticket)?.ticket ?? null
  const current = () => (cards.some((card) => card.ticket === chosen()) ? chosen() : target)
  const highlighted = current()
  const choose = (ticket: string | null) => setChosen(() => ticket)
  const spin = useSpinner(cards.length === 0 || cards.some((card) => card.motion === "spinner"))
  const open = useCallback((ticket: string) => command(UiCommand.OpenWorker({ ticket })), [command])

  const small = width < minWidth || height < minHeight
  const totals = totalsLines(view.totals, theme, width, small)
  const warnings = warningLines(view.warnings, theme, width)
  const foot = footLines + warnings.length
  const tall = tableHeight(height, width, totals.length, view.totals.slots, foot)
  const table = showsTable(height, totals.length, view.totals.slots, foot, tall)
  const tableRows = table ? tall : 0
  const gap = showsGap(height, totals.length, tableRows, view.totals.slots, foot)
  const room = height - titleLines - (gap ? 1 : 0) - totals.length - tableRows - foot
  const ending = view.endOfRun === null ? null : endOfRunLines(view.endOfRun, theme, width)
  // Behind the end-of-run box no card's buttons are drawn: Enter opens the Answer box, as on a
  // compact line.
  const layout: CardsLayout =
    small || ending !== null ? { _tag: "Compact" } : layoutOf(cards, width, room)
  // Only the full cards draw a request's buttons: the answer keys and the guard are theirs alone.
  const buttons = layout._tag === "Cards"
  const answering = useAnswering(buttons ? cards : [])
  // Beside Current, the table leaves out the tickets it shows; the end-of-run box shows none.
  const rows = ending === null ? rowsBesideCurrent(view.rows, cards) : view.rows
  const endingNow = useRef(false)
  endingNow.current = ending !== null

  // The view's keys, as bound: a key does nothing while the key help is open, but close it.
  const { box } = useInput()
  const showHelp = (shown: boolean) => setHelp(() => shown)
  const key = (keys: ReadonlyArray<string>, run: () => void): ReadonlyArray<KeyBinding> =>
    keys.map((each) => ({ key: each, run: () => (helpOpen() ? undefined : run()) }))
  const highlightedCard = () => cards.find((card) => card.ticket === current())
  // The highlighted card's request is the target: its guard starts again as the highlight moves.
  answering.target(buttons ? highlightedCard() : undefined)
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
    if (grows(card) && layout._tag !== "Cards") box.set(Box.Answer({ ticket: card.ticket }))
    else if (inCard() === undefined || !answering.pressFocused(card)) open(card.ticket)
  }
  // `1`–`4` pick an option of the highlighted card's question; no number opens a worker.
  const pick = (n: number) => () => {
    const card = inCard()
    if (card !== undefined) answering.pick(card, n)
  }
  // An answer key answers the highlighted card's request with its buttons drawn; else it opens the
  // Answer box on the highlighted attention card, where you read the request first.
  const answerKey = (run: () => void) => () => {
    if (inCard() !== undefined) return run()
    const card = highlightedCard()
    if (card !== undefined && grows(card)) box.set(Box.Answer({ ticket: card.ticket }))
  }
  useLayer("view", [
    { key: "?", run: () => showHelp(!helpOpen()) },
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
    ...answerBindings(answering, inCard).flatMap((binding) =>
      key([binding.key], answerKey(binding.run)),
    ),
    ...[1, 2, 3, 4].flatMap((n) => key([String(n)], pick(n))),
  ])

  const hint = hintSegments(drawnHint(view.hint, buttons), theme, width)
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
      {table ? <TicketsTable lines={ticketsLines(rows, theme, width, tall)} /> : null}
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
