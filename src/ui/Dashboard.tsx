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
// highlight names a ticket too, so it stays on its card as other cards come and go. `Shift+A` opens
// the questions box (QuestionsBox.tsx), the open questions in the run's scope put one by one; the
// hint names it while a ticket waits on one. With the key help open, `?` and `Esc` close it and the other keys do
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
import { useCallback, useMemo, useRef, useState } from "react"
import { UiCommand } from "../run/commands.ts"
import type { Card, Key, Need, RunView } from "../run/runView.ts"
import type { TicketId } from "../services/Beads.ts"
import { allot } from "./allot.ts"
import { type AnswerKey, keyAnswer, settle, useAnswering } from "./attentionKeys.ts"
import {
  Cards,
  type CardsLayout,
  fewestCurrentLines,
  grows,
  keptLines,
  layoutOf,
  sectionLines,
} from "./Card.tsx"
import { endOfRunLines } from "./EndOfRunBox.tsx"
import { hintLines } from "./Hint.tsx"
import { KeyHelp } from "./KeyHelp.tsx"
import { type Command, type HelpRow, hintOf, useCommands } from "./keyCommands.ts"
import { Box, useInput } from "./keys.ts"
import { loadSegments } from "./LoadLine.tsx"
import { cut, Line, Lines, Section, type Segments, seg } from "./line.tsx"
import {
  beside,
  needsLines,
  type PanelAt,
  panelTargets,
  panelWidth,
  tableWidth,
  upNextLines,
} from "./SidePanel.tsx"
import { fewestTableLines, rowsBesideCurrent, tableLines, ticketsLines } from "./TicketsTable.tsx"
import { TitleLine } from "./TitleLine.tsx"
import { useLinesUnderToasts } from "./Toasts.tsx"
import { totalsLines } from "./Totals.tsx"
import type { Theme } from "./theme.ts"
import { useKeyState } from "./useKeyState.ts"
import { useCommand, useRunView, useTheme } from "./useRunView.ts"
import { windDownSegments } from "./WindDown.tsx"

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

/** What the panel beside the tickets table shows: the needs not answered here, and where it is at. */
export interface SideState {
  readonly needs: ReadonlyArray<Need>
  readonly at: PanelAt
}

/** How the dashboard's lines are handed out (dashboardLayout): each section's, adding up to the pane's. */
export interface DashboardLayout {
  /** Below the minimum size (§ 7.7): only the totals, on one line, and the hint are drawn. */
  readonly small: boolean
  /** The title line and the blank line above it; none when small. */
  readonly title: number
  /** The load line; none when small. */
  readonly load: number
  /** The load line's segments, as loadSegments gives them; none when small. */
  readonly loadLine: Segments
  /** The blank line between the title line and the load line: 1, or 0 where the pane is short. */
  readonly gap: number
  /** The totals' lines that fit. */
  readonly totals: ReadonlyArray<Segments>
  /** The tickets table's lines, its label and frame included; 0 where it is left out. */
  readonly table: number
  /** The panel beside the table's width (SidePanel.tsx); 0 where it has none. */
  readonly panel: number
  /**
   * The tickets table's `table` lines: the tickets beside Current's (rowsBesideCurrent), or all of
   * them beside the end-of-run box, which shows none.
   */
  readonly tickets: ReadonlyArray<Segments>
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
  /** The wind-down line, as windDownSegments gives it; null while the run doesn't wind down. */
  readonly windDownLine: Segments | null
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
 * The hint (dashboardHint, with `highlighted`'s card highlighted) is laid out with `d` and `a`
 * where a request's buttons may be drawn; where they aren't, a hint the shorter for it gives its
 * lines to the blank ones above the foot.
 */
export const dashboardLayout = (
  view: RunView,
  theme: Theme,
  width: number,
  height: number,
  highlighted: string | null = targetOf(view),
  side: SideState = { needs: view.needs, at: { index: 0, focused: false, choice: 0 } },
): DashboardLayout => {
  // A section's lines: as many as it needs of those left.
  const { take, rest } = allot(height)
  const small = width < minWidth || height < minHeight
  const hintAt = (buttons: boolean) =>
    hintLines(dashboardHint(view, buttons, highlighted), theme, width)
  // Below the minimum size and behind the end-of-run box no card's buttons are drawn.
  const allHint = hintAt(!small && view.endOfRun === null)
  const hint = allHint.slice(0, take(allHint.length))
  const allTotals = totalsLines(view.totals, theme, width, small)
  if (small) {
    const totals = allTotals.slice(0, take(allTotals.length))
    const cards: CardsLayout = { _tag: "Compact" }
    const none = { title: 0, load: 0, gap: 0, table: 0, panel: 0, current: 0, windDown: 0 }
    const blank = { loadLine: [], tickets: [], windDownLine: null }
    return {
      ...none,
      ...blank,
      small,
      totals,
      cards,
      ending: null,
      spare: rest(),
      warnings: [],
      hint,
    }
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
  const tall = tableLines(rest() + kept - 1, keptLines(width, slots, cards.length))
  const fits = whole === null ? tall <= rest() : Math.min(tall, rest()) >= fewestTableLines
  const table = fits ? take(tall) : 0
  const gap = take(1)
  const room = kept + take(rest())
  // In a wide pane the panel beside the table (SidePanel.tsx) takes a share of its width.
  const panel = table === 0 ? 0 : panelWidth(width)
  const drawn = {
    small,
    panel,
    title,
    load,
    loadLine: loadSegments(view.totals, view.load, theme, width),
    gap,
    totals,
    table,
    windDown,
    windDownLine: view.windDown === null ? null : windDownSegments(view.windDown, theme, width),
    warnings,
    hint,
  }
  const ticketsOf = (rows: RunView["rows"]) => {
    if (table === 0) return []
    const narrower = tableWidth(width, panel)
    const lines = ticketsLines(rows, theme, narrower, { lines: table })
    if (panel === 0) return lines
    const shown =
      side.needs.length > 0
        ? needsLines(side.needs, side.at, theme, panel, table)
        : upNextLines(view.queue, view.totals, theme, panel, table)
    return beside(lines, shown, narrower)
  }
  if (view.endOfRun !== null && whole !== null) {
    // The box keeps to the room left, naming fewer workers, but always saying what q does.
    const ending = whole.length <= room ? whole : endOfRunLines(view.endOfRun, theme, width, room)
    const compact: CardsLayout = { _tag: "Compact" }
    const tickets = ticketsOf(view.rows)
    const spare = room - ending.length
    return { ...drawn, tickets, current: ending.length, cards: compact, ending, spare }
  }
  const tickets = ticketsOf(rowsBesideCurrent(view.rows, cards))
  const layout = layoutOf(cards, width, room)
  const current = Math.min(sectionLines(layout, cards.length), room)
  const spare = room - current
  if (layout._tag === "Cards") {
    return { ...drawn, tickets, current, cards: layout, ending: null, spare }
  }
  const fewer = hintAt(false).slice(0, hint.length)
  const freed = hint.length - fewer.length
  return {
    ...drawn,
    tickets,
    hint: fewer,
    current,
    cards: layout,
    ending: null,
    spare: spare + freed,
  }
}

/** A need's key: its ticket, and an Asked one's question, so that a new question is a new need. */
const needKey = (need: Need): string =>
  need._tag === "Question" ? `${need.ticket} ${need.id}` : need.ticket

/** The card highlighted while none is chosen: that of the oldest open request (§ 4.5). */
export const targetOf = (view: RunView): string | null =>
  view.cards.find((card) => card.ticket === view.requests[0]?.ticket)?.ticket ?? null

/** Where the dashboard's keys are: the card they act on, and whether a request's buttons are drawn. */
export interface DashboardAt {
  /** Whether the full cards are drawn, and with them a request's buttons (§ 4.5). */
  readonly buttons: boolean
  /** The highlighted card, as the key is pressed. */
  readonly highlighted: () => Card | undefined
  /** The panel beside the tickets table: whether the highlight is on it, and its needs. */
  readonly panel?: { readonly on: () => boolean; readonly needs: number }
}

/** What the dashboard's keys do. */
export interface DashboardActions {
  /** `?`: opens or closes the key help. */
  readonly help: () => void
  /** `Esc`: closes the key help. */
  readonly escape: () => void
  /** Moves the highlight `by` cards, or, `buttons`, first between an attention card's buttons. */
  readonly step: (by: 1 | -1, buttons: boolean) => void
  readonly enter: () => void
  readonly answer: (card: Card, key: AnswerKey) => void
  readonly denyWithReason: (card: Card) => void
  /** Opens the Answer box on the card, drawn on a compact line, to read its request first. */
  readonly openAnswer: (card: Card) => void
  readonly pick: (card: Card, n: number) => void
  /** `s`: the stop question. */
  readonly stop: () => void
  /** `q`, with the end-of-run box shown: ends the run. */
  readonly endRun: () => void
  /** `Shift+A`: the questions box, the open questions put one by one. */
  readonly questions: () => void
  /** `1`–`9` on the panel: answers its question with that option. */
  readonly panelPick: (n: number) => void
  /** `]` and `[`: the next or previous need in the panel. */
  readonly panelNext: (by: 1 | -1) => void
}

const nothing = () => {}

/** Keys that do nothing: the dashboard's commands as its hint and key help name them. */
const inertDashboard: DashboardActions = {
  help: nothing,
  escape: nothing,
  step: nothing,
  enter: nothing,
  answer: nothing,
  denyWithReason: nothing,
  openAnswer: nothing,
  pick: nothing,
  stop: nothing,
  endRun: nothing,
  questions: nothing,
  panelPick: nothing,
  panelNext: nothing,
}

const moveRow: HelpRow = ["Tab, Shift+Tab, arrows", "move the highlight between cards"]
const denyRow: HelpRow = ["d, Shift+D", "deny the request; deny with a reason"]
const pickRow: HelpRow = ["1–4, 1–9 on the panel", "pick a question's option"]

/** Whether a ticket waits on your answer to a question: one Asked. */
export const questionsWaiting = (view: RunView): boolean => view.totals.asked > 0

/**
 * The dashboard's keys (§ 7.3), its hint's and its key help's. The answer keys answer only a
 * request drawn with its buttons, which only the full cards draw (`at.buttons`): the highlighted
 * attention card's, where the key answers it (keyAnswer), so that the hint names `d` and `a` only
 * there. On a compact line they open the Answer box instead, and the hint names neither (§ 4.5).
 * With the end-of-run box shown, `q` ends the run, and the hint names it in place of `s`.
 */
export const dashboardCommands = (
  view: RunView,
  at: DashboardAt,
  act: DashboardActions = inertDashboard,
): ReadonlyArray<Command> => {
  const cards = view.cards.length > 0
  const ending = view.endOfRun !== null
  // The highlighted attention card, with its buttons drawn or on a compact line.
  const attention = (buttons: boolean) => () => {
    const card = at.highlighted()
    return at.buttons === buttons && card !== undefined && grows(card) ? card : undefined
  }
  const inCard = attention(true)
  const onLine = attention(false)
  const answers = (key: AnswerKey) => () => {
    const request = inCard()?.requests[0]
    return request !== undefined && keyAnswer(request, key) !== null
  }
  const on = (card: () => Card | undefined, run: (card: Card) => void) => () => {
    const found = card()
    if (found !== undefined) run(found)
  }
  const named = (shown: boolean, keys: string, does: string) => (shown ? { keys, does } : undefined)
  return [
    // Tab and → move between an attention card's buttons, and on to the next card; ↓ and ↑ from
    // card to card.
    {
      keys: ["tab", "right"],
      run: () => act.step(1, true),
      hint: named(cards, "Tab", "select"),
      help: moveRow,
    },
    { keys: ["shift+tab", "left"], run: () => act.step(-1, true), help: moveRow },
    { keys: ["down"], run: () => act.step(1, false), help: moveRow },
    { keys: ["up"], run: () => act.step(-1, false), help: moveRow },
    {
      keys: ["return", "enter"],
      run: act.enter,
      hint: named(cards, "Enter", "open"),
      help: ["Enter, a click", "open the highlighted card; press the focused button"],
    },
    { keys: ["escape"], run: act.escape, help: ["Esc", "close an open box"] },
    {
      keys: ["d"],
      when: answers("d"),
      run: on(inCard, (card) => act.answer(card, "d")),
      hint: { keys: "d", does: "deny" },
      help: denyRow,
    },
    {
      keys: ["shift+d"],
      when: () => inCard() !== undefined,
      run: on(inCard, act.denyWithReason),
      help: denyRow,
    },
    {
      keys: ["a"],
      when: answers("a"),
      run: on(inCard, (card) => act.answer(card, "a")),
      hint: { keys: "a", does: "allow" },
      help: ["a", "allow the request, unless it opens on Deny"],
    },
    {
      keys: ["r"],
      when: answers("r"),
      run: on(inCard, (card) => act.answer(card, "r")),
      help: ["r", "allow for this run"],
    },
    // On a compact line an answer key opens the Answer box, where you read the request first.
    {
      keys: ["d", "shift+d", "a", "r"],
      when: () => onLine() !== undefined,
      run: on(onLine, act.openAnswer),
      help: denyRow,
    },
    // `1`–`4` pick an option of the highlighted card's question; no number opens a worker.
    ...[1, 2, 3, 4].map((n) => ({
      keys: [String(n)],
      when: () => inCard() !== undefined,
      run: on(inCard, (card) => act.pick(card, n)),
      help: pickRow,
    })),
    // On the panel beside the tickets table, `1`–`9` answer its question with that option.
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
      keys: [String(n)],
      when: () => at.panel?.on() === true,
      run: () => act.panelPick(n),
      help: pickRow,
    })),
    {
      keys: ["]"],
      when: () => (at.panel?.needs ?? 0) > 1,
      run: () => act.panelNext(1),
      help: ["] and [", "the next or previous of what needs you, in the panel"],
    },
    {
      keys: ["["],
      when: () => (at.panel?.needs ?? 0) > 1,
      run: () => act.panelNext(-1),
      help: ["] and [", "the next or previous of what needs you, in the panel"],
    },
    // The stop question: stop after the running tickets, or, winding down, keep taking tickets.
    {
      keys: ["s"],
      run: act.stop,
      hint: named(
        !ending,
        "s",
        view.windDown !== null ? "keep taking tickets" : "stop after current",
      ),
      help: ["s", "stop after current, or keep taking tickets"],
    },
    // The questions box: the open questions in the run's scope, whether a ticket waits on one or
    // not; the hint names it while one does.
    {
      keys: ["shift+a"],
      run: act.questions,
      hint: named(questionsWaiting(view), "A", "answer questions"),
      help: ["A", "answer the open questions, one by one"],
    },
    {
      keys: ["q"],
      when: () => ending,
      run: act.endRun,
      hint: { keys: "q", does: "end the run" },
      help: ["q", "end the run, from the end-of-run box"],
    },
    { keys: ["?"], run: act.help, hint: { keys: "?", does: "keys" }, help: ["?", "these keys"] },
  ]
}

/**
 * The dashboard's hint, `highlighted`'s card highlighted (the target's when left out) and, where
 * `buttons`, a request's buttons drawn.
 */
export const dashboardHint = (
  view: RunView,
  buttons: boolean,
  highlighted: string | null = targetOf(view),
): ReadonlyArray<Key> =>
  hintOf(
    dashboardCommands(view, {
      buttons,
      highlighted: () => view.cards.find((card) => card.ticket === highlighted),
    }),
  )

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
  // The panel beside the tickets table: the need it shows, by its ticket, whether the highlight is
  // on it and at which choice. A question answered here leaves it at once, before the run's next
  // look takes its ticket back.
  const [shownNeed, setShownNeed, shownNeedNow] = useKeyState<string | null>(() => null)
  const [onPanelShown, setOnPanel, onPanelNow] = useKeyState(() => false)
  const [choice, setChoice, choiceNow] = useKeyState(() => 0)
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set())
  const needs = useMemo(
    () => view.needs.filter((need) => !answered.has(needKey(need))),
    [view.needs, answered],
  )
  const needAt = (ticket: string | null) =>
    Math.max(
      needs.findIndex((need) => need.ticket === ticket),
      0,
    )
  const panelFocused = onPanelShown && needs.length > 0
  const side: SideState = {
    needs,
    at: { index: needAt(shownNeed), focused: panelFocused, choice },
  }
  // A need's answer keys do nothing until it has been drawn for a moment, as a request's buttons.
  const drawnSince = useRef({ ticket: "", at: 0 })
  const drawnNeed = needs[side.at.index]?.ticket ?? ""
  if (drawnSince.current.ticket !== drawnNeed)
    drawnSince.current = { ticket: drawnNeed, at: Date.now() }
  const cards = view.cards
  // With none chosen, the card of the oldest open request is the target, and highlighted (§ 4.5).
  const target = targetOf(view)
  const current = () => (cards.some((card) => card.ticket === chosen()) ? chosen() : target)
  const highlighted = current()
  const choose = (ticket: string | null) => setChosen(() => ticket)
  const open = useCallback(
    (ticket: TicketId) => command(UiCommand.OpenWorker({ ticket })),
    [command],
  )

  // The hint names `d` and `a` for the highlighted card's request: the layout is the highlight's.
  const sideIndex = side.at.index
  const laid = useMemo(
    () =>
      dashboardLayout(view, theme, width, height, panelFocused ? null : highlighted, {
        needs,
        at: { index: sideIndex, focused: panelFocused, choice },
      }),
    [view, theme, width, height, highlighted, needs, sideIndex, panelFocused, choice],
  )
  const { small, ending } = laid
  // Behind the end-of-run box no card's buttons are drawn: Enter opens the Answer box, as on a
  // compact line.
  const layout = laid.cards
  // Only the full cards draw a request's buttons: the answer keys and the guard are theirs alone.
  const buttons = layout._tag === "Cards"
  const answering = useAnswering(buttons ? cards.flatMap((card) => card.requests.slice(0, 1)) : [])

  // The view's keys, as bound: a key does nothing while the key help is open, but close it.
  const input = useInput()
  const { box } = input
  // Toasts are drawn above the hint's lines, however many it wraps onto.
  useLinesUnderToasts(input.toasts, laid.hint.length)
  const showHelp = (shown: boolean) => setHelp(() => shown)
  const unlessHelp =
    <A extends ReadonlyArray<unknown>>(run: (...args: A) => void) =>
    (...args: A) => {
      if (!helpOpen()) run(...args)
    }
  // The panel shows what needs you, and the highlight is on it.
  const panelShown = () => laid.panel > 0 && needs.length > 0
  const onPanel = () => onPanelNow() && panelShown()
  const highlightedCard = () =>
    onPanel() ? undefined : cards.find((card) => card.ticket === current())
  // The highlighted card's request is the target: its guard starts again as the highlight moves.
  answering.target(buttons ? highlightedCard()?.requests[0] : undefined)
  // The attention card highlighted, with its buttons drawn: the one Tab, Enter and 1–4 work in.
  const inCard = () => {
    const card = highlightedCard()
    return card !== undefined && grows(card) && buttons ? card : undefined
  }
  const shownNow = () => {
    const index = needAt(shownNeedNow())
    return { need: needs[index], index }
  }
  // Answers the panel's question with its option `n`, from 0, and shows the next need.
  const answerWith = (n: number) => {
    const { need, index } = shownNow()
    if (need?._tag !== "Question" || need.question === null) return
    if (Date.now() - drawnSince.current.at < settle) return
    const option = need.question.options?.[n]
    if (option === undefined) return
    command(
      UiCommand.AnswerQuestion({
        question: need.question.id,
        answer: option.label,
        uuid: crypto.randomUUID(),
      }),
    )
    setAnswered((all) => new Set(all).add(needKey(need)))
    const rest = needs.filter((each) => each !== need)
    setShownNeed(() => rest[Math.min(index, rest.length - 1)]?.ticket ?? null)
    setChoice(() => 0)
    if (rest.length === 0) setOnPanel(() => false)
  }
  // The questions box at the panel's question: to read it all, or to type your own answer.
  const readQuestion = () => {
    const { need } = shownNow()
    if (need?._tag !== "Question") return
    box.set(Box.Questions({ first: need.question?.id ?? (need.ticket as TicketId) }))
  }
  const panelEnter = () => {
    const { need } = shownNow()
    if (need?._tag === "Blocked") return open(need.ticket)
    if (need?._tag !== "Question" || need.question === null) return
    if (choiceNow() < (need.question.options?.length ?? 0)) answerWith(choiceNow())
    else readQuestion()
  }
  const panelMove = (by: 1 | -1) => {
    const { need } = shownNow()
    if (need?._tag !== "Question" || need.question === null) return
    const count = (need.question.options?.length ?? 0) + 1
    setChoice((now) => (now + by + count) % count)
  }
  const panelNext = (by: 1 | -1) => {
    if (needs.length < 2) return
    const { index } = shownNow()
    setShownNeed(() => needs[(index + by + needs.length) % needs.length]?.ticket ?? null)
    setChoice(() => 0)
  }
  // A click on the panel: an option answers with it, its title or Other opens the questions box.
  const pressPanel = (target: number) => {
    if (!panelShown()) return
    setOnPanel(() => true)
    if (target === panelTargets.other || target === panelTargets.read) return readQuestion()
    setChoice(() => target)
    answerWith(target)
  }
  const step = (by: 1 | -1, inside: boolean) => {
    // On the panel, ↑ and ↓ move between its choices, and Tab leaves it for the cards.
    if (onPanel()) {
      if (!inside) return panelMove(by)
      setOnPanel(() => false)
      choose((by === 1 ? cards[0] : cards.at(-1))?.ticket ?? null)
      return
    }
    const card = inside ? inCard() : undefined
    if (card !== undefined && answering.step(card.requests[0], by)) return
    answering.reset()
    // Tab past the last card, or Shift+Tab before the first, goes on to the panel.
    if (inside && panelShown()) {
      const at = cards.findIndex((each) => each.ticket === current())
      if (cards.length === 0 || at === (by === 1 ? cards.length - 1 : 0)) {
        setOnPanel(() => true)
        setChoice(() => 0)
        return
      }
    }
    choose(moveHighlight(cards, current(), by))
  }
  const enter = () => {
    if (onPanel()) return panelEnter()
    const card = highlightedCard()
    if (card === undefined) return
    if (grows(card) && !buttons) box.set(Box.Answer({ ticket: card.ticket }))
    else if (inCard() === undefined || !answering.pressFocused(card.requests[0])) open(card.ticket)
  }
  const keys = useCommands(
    "view",
    dashboardCommands(
      view,
      { buttons, highlighted: highlightedCard, panel: { on: onPanel, needs: needs.length } },
      {
        help: () => showHelp(!helpOpen()),
        escape: () => (onPanel() && !helpOpen() ? setOnPanel(() => false) : showHelp(false)),
        step: unlessHelp(step),
        enter: unlessHelp(enter),
        answer: unlessHelp((card: Card, key: AnswerKey) => answering.key(card.requests[0], key)),
        denyWithReason: unlessHelp((card: Card) => answering.denyWithReason(card.requests[0])),
        openAnswer: unlessHelp((card: Card) => box.set(Box.Answer({ ticket: card.ticket }))),
        pick: unlessHelp((card: Card, n: number) => {
          answering.pick(card.requests[0], n)
        }),
        stop: unlessHelp(() => box.set(Box.Stop({ windingDown: view.windDown !== null }))),
        endRun: unlessHelp(() => command(UiCommand.EndRun())),
        questions: unlessHelp(() => box.set(Box.Questions({}))),
        panelPick: unlessHelp((n: number) => answerWith(n - 1)),
        panelNext: unlessHelp(panelNext),
      },
    ),
  )
  const keyHelp = help ? (
    <KeyHelp theme={theme} width={width} height={height} keys={keys.help} />
  ) : null

  if (small) {
    return (
      <box flexDirection="column" width={width} height={height}>
        <Section lines={laid.totals.length}>
          <Lines lines={laid.totals} />
        </Section>
        <Section lines={laid.spare} />
        <Section lines={laid.hint.length}>
          <Lines lines={laid.hint} />
        </Section>
        {keyHelp}
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
        <Line segments={laid.loadLine} />
      </Section>
      <Section lines={laid.totals.length}>
        <Lines lines={laid.totals} />
      </Section>
      <Section lines={laid.table}>
        <Lines lines={laid.tickets} press={pressPanel} />
      </Section>
      <Section lines={laid.current}>
        {ending !== null ? (
          <Lines lines={ending} />
        ) : (
          <Cards
            cards={cards}
            theme={theme}
            layout={layout}
            width={width}
            room={laid.current}
            stopping={view.title.stopping || view.windDown !== null}
            highlighted={panelFocused ? null : highlighted}
            open={open}
            focusOf={answering.focusOf}
            press={answering.press}
          />
        )}
      </Section>
      <Section lines={laid.spare} />
      <Section lines={laid.windDown}>
        {laid.windDownLine === null ? null : <Line segments={laid.windDownLine} />}
      </Section>
      <Section lines={laid.warnings.length}>
        <Lines lines={laid.warnings} />
      </Section>
      <Section lines={laid.hint.length}>
        <Lines lines={laid.hint} />
      </Section>
      {keyHelp}
    </box>
  )
}
