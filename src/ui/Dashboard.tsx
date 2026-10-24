// The dashboard (§ 7.2), drawn from RunView alone: the title line, the load line (LoadLine.tsx), a
// blank line between, the totals strip, the tickets table (without the tickets Current shows), the workers' cards (Current) and at the foot the
// wind-down line, the warning line and the hint; `?` opens the key help over it.
//
// The tickets table's height comes from the pane's and the workers the run may have alone, so it
// stays put while workers come and go: Current is kept room for a full card for each of up to 6 of
// them and a line for each of the rest (Card.tsx's keptLines), and the table takes what is left,
// 3 to 10 rows, where orchestra's takes a third of the pane (§ 7.2). Tickets waiting to merge or
// merging have cards without a worker's slot (schedule.ts), so where the cards outnumber the slots,
// Current is kept a line for each card. The table is left out of a pane too short for it and a line
// for each worker or card. The cards take what is left, one line each when they don't fit, and a
// `+N more` line for those that don't fit even so; nothing of Current draws over the foot. A pane
// too short for a line each drops the blank line above the load line first, before any line with
// something on it. Below the minimum size, 60×16 (§ 7.7), only the totals, on one line, and the hint
// are drawn. One function, dashboardLayout, hands out every section's lines in priority order, so
// that they add up to the pane's height; each section is drawn in its lines and no more (Section).
// The cards' heads, the compact box and the idle box read the shell's clock and spinner, so a tick
// draws them alone, and none ticks below the minimum size or behind the end-of-run box.
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
// answer there. The box is placed before the tickets table: the table gives up rows for it, down
// to its fewest, and is left out below them; the box then keeps to the room left (EndOfRunBox.tsx).
import { useTerminalDimensions } from "@opentui/react"
import { useCallback, useMemo } from "react"
import { UiCommand } from "../run/commands.ts"
import type { Card, Key, RunView } from "../run/runView.ts"
import { answerBindings } from "./AttentionCard.tsx"
import { useAnswering } from "./attentionKeys.ts"
import {
  Cards,
  type CardsLayout,
  fewestCurrentLines,
  grows,
  keptLines,
  layoutOf,
  sectionLines,
} from "./Card.tsx"
import { EndOfRunBox, endOfRunLines } from "./EndOfRunBox.tsx"
import { hintLines } from "./Hint.tsx"
import { KeyHelp } from "./KeyHelp.tsx"
import { Box, type KeyBinding, useInput, useLayer } from "./keys.ts"
import { LoadLine, loadSegments } from "./LoadLine.tsx"
import { cut, Lines, Section, type Segments, seg } from "./line.tsx"
import {
  fewestTableLines,
  rowsBesideCurrent,
  TicketsTable,
  tableLines,
  ticketsLines,
} from "./TicketsTable.tsx"
import { TitleLine } from "./TitleLine.tsx"
import { useHintHeight } from "./Toasts.tsx"
import { Totals, totalsLines } from "./Totals.tsx"
import type { Theme } from "./theme.ts"
import { useKeyState } from "./useKeyState.ts"
import { useCommand, useEvent, useRunView, useTheme } from "./useRunView.ts"
import { WindDown, windDownSegments } from "./WindDown.tsx"

/** The smallest pane the whole dashboard is drawn in (§ 7.7). */
export const minWidth = 60
export const minHeight = 16

/** The title line and the blank line above it. */
const titleLines = 2

/** The warning line's lines, ` ! …` `notice`, one a warning. */
export const warningLines = (
  warnings: ReadonlyArray<string>,
  theme: Theme,
  width: number,
): ReadonlyArray<Segments> =>
  warnings.map((warning) => cut([seg(` ! ${warning}`, theme.styles.deferred)], width))

/** How the dashboard's lines are handed out (dashboardLayout): each section's, adding up to the pane's. */
export interface DashboardLayout {
  /** Below the minimum size (§ 7.7): only the totals, on one line, and the hint are drawn. */
  readonly small: boolean
  /** The title line and the blank line above it; none when small. */
  readonly title: number
  /** The load line; none when small. */
  readonly load: number
  /** The blank line between the title line and the load line: 1, or 0 where the pane is short. */
  readonly gap: number
  /** The totals' lines that fit. */
  readonly totals: ReadonlyArray<Segments>
  /** The tickets table's lines, its label and frame included; 0 where it is left out. */
  readonly table: number
  /** The lines of Current, its label included, or of the end-of-run box in its place. */
  readonly current: number
  /** How Current is laid out in them: Compact behind the end-of-run box and when small. */
  readonly cards: CardsLayout
  /** The end-of-run box's lines, kept to `current`; null with no box. */
  readonly ending: ReadonlyArray<Segments> | null
  /** The blank lines between the sections and the foot. */
  readonly spare: number
  /** The wind-down line's: 1, there or not, so the table stays put as it comes; none when small. */
  readonly windDown: number
  /** The warning lines that fit. */
  readonly warnings: ReadonlyArray<Segments>
  /** The hint's lines that fit, every key it names, wrapped as the views wrap theirs (§ 7.5). */
  readonly hint: ReadonlyArray<Segments>
}

/**
 * The dashboard's lines in a pane `width` × `height`, handed out in priority order, each section
 * as many as it needs of what is left, so that they add up to `height` (§ 7.2, § 7.7): the hint,
 * the title and load lines, the totals, the wind-down line, Current at its fewest (a line in its
 * box) or the end-of-run box's, the warnings, then Current kept a line for each worker or card, or
 * the box whole; then the tickets table, as tall as what Current is kept leaves it (keptLines,
 * tableLines), or left out where that doesn't fit (beside the box, where its fewest don't); then
 * the blank line over the load line, the first to go, before any line with something on it; and
 * Current, or the box, takes the rest. Below the minimum size, the hint and the totals on one line.
 * The hint is laid out with `d` and `a` where a request's buttons may be drawn; where they aren't
 * (drawnHint), a hint the shorter for it gives its lines to the blank ones above the foot.
 */
export const dashboardLayout = (
  view: RunView,
  theme: Theme,
  width: number,
  height: number,
): DashboardLayout => {
  let rest = Math.max(height, 0)
  // A section's lines: as many as it needs of those left.
  const take = (lines: number): number => {
    const got = Math.min(Math.max(lines, 0), rest)
    rest -= got
    return got
  }
  const small = width < minWidth || height < minHeight
  const hintOf = (buttons: boolean) => hintLines(drawnHint(view.hint, buttons), theme, width)
  // Below the minimum size and behind the end-of-run box no card's buttons are drawn.
  const allHint = hintOf(!small && view.endOfRun === null)
  const hint = allHint.slice(0, take(allHint.length))
  const allTotals = totalsLines(view.totals, theme, width, small)
  if (small) {
    const totals = allTotals.slice(0, take(allTotals.length))
    const cards: CardsLayout = { _tag: "Compact" }
    const none = { title: 0, load: 0, gap: 0, table: 0, current: 0, windDown: 0 }
    return { ...none, small, totals, cards, ending: null, spare: rest, warnings: [], hint }
  }
  const title = take(titleLines)
  const load = take(1)
  const totals = allTotals.slice(0, take(allTotals.length))
  const windDown = take(1)
  const { cards } = view
  const slots = view.totals.slots
  const whole = view.endOfRun === null ? null : endOfRunLines(view.endOfRun, theme, width)
  // Current is kept a line for each worker, or each card where tickets merging without a slot
  // make them more; the end-of-run box in its place, its lines whole.
  const least = whole?.length ?? sectionLines({ _tag: "Compact" }, Math.max(slots, cards.length, 1))
  const fewest = take(Math.min(least, fewestCurrentLines))
  const allWarnings = warningLines(view.warnings, theme, width)
  const warnings = allWarnings.slice(0, take(allWarnings.length))
  const kept = fewest + take(least - fewest)
  // The table is as tall as Current's kept lines leave it, the blank line over the load line
  // counted out, so that it stays put as workers come and go.
  const tall = tableLines(rest + kept - 1, keptLines(width, slots, cards.length))
  const fits = whole === null ? tall <= rest : Math.min(tall, rest) >= fewestTableLines
  const table = fits ? take(tall) : 0
  const gap = take(1)
  const room = kept + take(rest)
  const drawn = { small, title, load, gap, totals, table, windDown, warnings, hint }
  if (view.endOfRun !== null && whole !== null) {
    // The box keeps to the room left, naming fewer workers, but always saying what q does.
    const ending = whole.length <= room ? whole : endOfRunLines(view.endOfRun, theme, width, room)
    const compact: CardsLayout = { _tag: "Compact" }
    return { ...drawn, current: ending.length, cards: compact, ending, spare: room - ending.length }
  }
  const layout = layoutOf(cards, width, room)
  const current = Math.min(sectionLines(layout, cards.length), room)
  const spare = room - current
  if (layout._tag === "Cards") return { ...drawn, current, cards: layout, ending: null, spare }
  const fewer = hintOf(false).slice(0, hint.length)
  const freed = hint.length - fewer.length
  return { ...drawn, hint: fewer, current, cards: layout, ending: null, spare: spare + freed }
}

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
  const open = useCallback((ticket: string) => command(UiCommand.OpenWorker({ ticket })), [command])

  const laid = useMemo(
    () => dashboardLayout(view, theme, width, height),
    [view, theme, width, height],
  )
  const { small, ending } = laid
  // Behind the end-of-run box no card's buttons are drawn: Enter opens the Answer box, as on a
  // compact line.
  const layout = laid.cards
  // Only the full cards draw a request's buttons: the answer keys and the guard are theirs alone.
  const buttons = layout._tag === "Cards"
  const answering = useAnswering(buttons ? cards : [])
  // Beside Current, the table leaves out the tickets it shows; the end-of-run box shows none.
  const rows = ending === null ? rowsBesideCurrent(view.rows, cards) : view.rows
  const endingNow = useEvent(() => ending !== null)

  // The view's keys, as bound: a key does nothing while the key help is open, but close it.
  const input = useInput()
  const { box } = input
  // Toasts are drawn above the hint's lines, however many it wraps onto.
  useHintHeight(input.toasts, laid.hint.length)
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
    ...key(["q"], () => (endingNow() ? command(UiCommand.EndRun()) : undefined)),
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

  if (small) {
    return (
      <box flexDirection="column" width={width} height={height}>
        <Section lines={laid.totals.length}>
          <Totals lines={laid.totals} />
        </Section>
        <Section lines={laid.spare} />
        <Section lines={laid.hint.length}>
          <Lines lines={laid.hint} />
        </Section>
        {help ? <KeyHelp theme={theme} width={width} height={height} /> : null}
      </box>
    )
  }
  return (
    <box flexDirection="column" width={width} height={height}>
      <Section lines={laid.title}>
        <TitleLine width={width} />
      </Section>
      <Section lines={laid.gap} />
      <Section lines={laid.load}>
        <LoadLine segments={loadSegments(view.totals, view.load, theme, width)} />
      </Section>
      <Section lines={laid.totals.length}>
        <Totals lines={laid.totals} />
      </Section>
      <Section lines={laid.table}>
        <TicketsTable lines={ticketsLines(rows, theme, width, laid.table)} />
      </Section>
      <Section lines={laid.current}>
        {ending !== null ? (
          <EndOfRunBox lines={ending} />
        ) : (
          <Cards
            cards={cards}
            theme={theme}
            layout={layout}
            width={width}
            room={laid.current}
            stopping={view.title.stopping || view.windDown !== null}
            highlighted={highlighted}
            open={open}
            focusOf={answering.focusOf}
            press={answering.press}
          />
        )}
      </Section>
      <Section lines={laid.spare} />
      <Section lines={laid.windDown}>
        {view.windDown === null ? null : (
          <WindDown segments={windDownSegments(view.windDown, theme, width)} />
        )}
      </Section>
      <Section lines={laid.warnings.length}>
        <Lines lines={laid.warnings} />
      </Section>
      <Section lines={laid.hint.length}>
        <Lines lines={laid.hint} />
      </Section>
      {help ? <KeyHelp theme={theme} width={width} height={height} /> : null}
    </box>
  )
}
