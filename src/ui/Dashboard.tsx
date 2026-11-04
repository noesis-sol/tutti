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
// The keys (§ 7.3), in the view's input layer (keys.ts), work at two levels (panelFocus.ts). At the
// top level the arrows move the focus between the panels, Tickets top left, Needs you top right,
// Current below, `Tab` and `Shift+Tab` through them, and the focused panel's frame is drawn bright;
// where there is no panel beside the table, the totals' Needs you cell takes its place over the
// table, and `Enter` on it, or a click, opens the list of what needs you (NeedsList.tsx). `Enter`
// goes into the focused panel, as a click does to what it clicked, and `Esc` comes out, an open box
// closing first. Inside Tickets `↑↓` select a row, a click on one too, and `Enter` opens it: an
// Asked row's question in the questions box, a Blocked row's box saying what clears it, another's
// worker view. Inside Needs you `↑↓` move through its options and `Enter` picks one. Inside Current
// the arrows move across the cards' grid and `Enter` opens the card, as a click does, as an
// OpenWorker command naming the card's ticket. The highlight names a ticket too, so it stays on its
// card as other cards come and go. Coming back from a worker's view finds the keys where they were
// (DashboardMemory), so switching workers is `Esc`, the arrows and `Enter`; opening one from the top
// is `↓ Enter Enter`, with no shortcut, as `Enter` on Current means one thing whatever it shows.
// `1`–`9` answer Needs you's question at once, unless the focus is on Current with an attention card
// highlighted, whose keys they are. `s` opens the stop question.
// `Shift+A` opens the questions box (QuestionsBox.tsx), the open questions in the run's scope put
// one by one; the hint names it while a ticket waits on one. With the key help open, `?` and `Esc`
// close it and the other keys do nothing. A click on a row's ID, on every row, copies it
// (useCopyOnClick, tutti-vkuj): the one click target with no key, as a drag's copy has none.
//
// Attention cards (§ 4.5, AttentionCard.tsx): at the top level the card of the oldest open request
// is highlighted, and its request is the target, so that a worker waiting on you is answered from
// anywhere but inside Tickets or Needs you. Inside Current on an attention card, `Tab`, `Shift+Tab`,
// `→` and `←` move between its buttons before moving on, `Enter` presses the focused one and `1`–`4`
// pick a question's option; `d`, `Shift+D`, `a` and `r` answer the highlighted card's request. They
// answer only a request drawn with its buttons, which only the full cards
// draw: on a compact line, below the minimum size and behind the end-of-run box, `Enter` and the
// answer keys open the Answer box instead, the 500 ms guard starts only once the buttons are drawn,
// and the hint offers neither `d` nor `a`.
//
// With everything else done and workers waiting on you (D19), the end-of-run box (EndOfRunBox.tsx)
// replaces the cards, and `q` ends the run (EndRun). Going into Current in its place, `Enter` opens a
// worker's view to answer there. The box is placed before the tickets table: the table gives up rows for it, down
// to its fewest, and is left out below them; the box then keeps to the room left (EndOfRunBox.tsx).
import type { MouseEvent } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { useEffect, useMemo, useRef, useState } from "react"
import { UiCommand } from "../run/commands.ts"
import {
  type Card,
  isConflict,
  type Key,
  type Need,
  type Row,
  type RunView,
} from "../run/runView.ts"
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
import { clickable } from "./click.ts"
import { useCopyOnClick } from "./clipboard.ts"
import { endOfRunLines } from "./EndOfRunBox.tsx"
import { hintLines } from "./Hint.tsx"
import { KeyHelp } from "./KeyHelp.tsx"
import { type Command, type HelpRow, hintOf, useCommands } from "./keyCommands.ts"
import { Box, useInput } from "./keys.ts"
import { loadSegments } from "./LoadLine.tsx"
import { type Border, cut, Line, Lines, Section, type Segments, seg } from "./line.tsx"
import {
  type Direction,
  type Focus,
  focusAmong,
  gridMove,
  type Panel,
  panelAfter,
  panelTowards,
  startFocus,
} from "./panelFocus.ts"
import {
  beside,
  blockedCut,
  needsLines,
  type PanelAt,
  panelTargets,
  panelWidth,
  tableWidth,
  upNextLines,
} from "./SidePanel.tsx"
import {
  fewestTableLines,
  rowsBesideCurrent,
  shownRows,
  tableLines,
  ticketsLines,
} from "./TicketsTable.tsx"
import { TitleLine } from "./TitleLine.tsx"
import { useLinesUnderToasts } from "./Toasts.tsx"
import { totalsLines } from "./Totals.tsx"
import type { Theme } from "./theme.ts"
import { useKeyState } from "./useKeyState.ts"
import { useCommand, useEvent, useRunView, useTheme } from "./useRunView.ts"
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

/** The click targets of the table's rows: a row's index among those drawn, past this. */
export const rowTarget = 1000

/** The click targets of the table's ID cells, which copy the ID: a row's index among those drawn, past this. */
export const idTarget = 2000

/** The click target of the totals' Needs you. */
export const needsTarget = 0

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
  /** The rows the tickets table draws, by attention (shownRows); none where it is left out. */
  readonly rows: ReadonlyArray<Row>
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
 * lines to the blank ones above the foot, as the shorter of its two levels does, so that nothing
 * moves as the focus goes into a panel. `focus` says which panel's frame is bright, and `row` which
 * row is selected inside the table. The ticket `copied` says `✓ copied` in its ID's place.
 */
export const dashboardLayout = (
  view: RunView,
  theme: Theme,
  width: number,
  height: number,
  highlighted: string | null = targetOf(view),
  side: SideState = {
    needs: view.needs,
    at: { index: 0, focused: false, inside: false, choice: 0 },
  },
  focus: Focus = startFocus,
  row: TicketId | null = null,
  copied: string | null = null,
): DashboardLayout => {
  // A section's lines: as many as it needs of those left.
  const { take, rest } = allot(height)
  const small = width < minWidth || height < minHeight
  const hintAt = (buttons: boolean, inside = focus.inside, card = highlighted) =>
    hintLines(dashboardHint(view, buttons, card, inside), theme, width)
  // Below the minimum size and behind the end-of-run box no card's buttons are drawn.
  const drawnButtons = !small && view.endOfRun === null
  const allHint = hintAt(drawnButtons)
  // As many lines at either level, a request's keys named or not, so that nothing over the hint
  // moves as the focus goes into a panel, where they aren't.
  const hintKept = take(
    Math.max(
      ...[false, true].flatMap((inside) =>
        [highlighted, targetOf(view)].map((card) => hintAt(drawnButtons, inside, card).length),
      ),
    ),
  )
  const hint = allHint.slice(0, hintKept)
  const hintSpare = hintKept - hint.length
  // Where there is no panel, the totals' Needs you is a click target, and the focus reaches it.
  const needsReach = { target: needsTarget, highlighted: focus.panel === "cell" }
  // A question answered on the panel has left it: it leaves Needs you with it, not at the next look.
  const counted = {
    ...view.totals,
    needsYou: view.totals.needsYou - (view.needs.length - side.needs.length),
  }
  // Beside the panel, the strip's bar before In queue is over the gap left of the panel.
  const totalsOf = (besidePanel: boolean) =>
    totalsLines(counted, theme, width, small, besidePanel ? undefined : needsReach, besidePanel)
  const allTotals = totalsOf(false)
  if (small) {
    const totals = allTotals.slice(0, take(allTotals.length))
    const cards: CardsLayout = { _tag: "Compact" }
    const none = { title: 0, load: 0, gap: 0, table: 0, panel: 0, current: 0, windDown: 0 }
    const blank = { loadLine: [], tickets: [], rows: [], windDownLine: null }
    return {
      ...none,
      ...blank,
      small,
      totals,
      cards,
      ending: null,
      spare: rest() + hintSpare,
      warnings: [],
      hint,
    }
  }
  const title = take(titleLines)
  const load = take(1)
  const totalsTaken = take(allTotals.length)
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
  const totals = (panel === 0 ? allTotals : totalsOf(true)).slice(0, totalsTaken)
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
    const shown = shownRows(rows, { lines: table })
    const lines = ticketsLines(
      rows,
      theme,
      narrower,
      { lines: table },
      {
        highlighted: focus.panel === "tickets" && focus.inside ? row : null,
        focused: focus.panel === "tickets",
        target: (each) => rowTarget + shown.indexOf(each),
        idTarget: (each) => idTarget + shown.indexOf(each),
        copied,
      },
    )
    if (panel === 0) return lines
    const shownSide =
      side.needs.length > 0
        ? needsLines(side.needs, side.at, theme, panel, table)
        : upNextLines(view.queue, view.totals, theme, panel, table)
    return beside(lines, shownSide, narrower)
  }
  const rowsOf = (rows: RunView["rows"]) => (table === 0 ? [] : shownRows(rows, { lines: table }))
  if (view.endOfRun !== null && whole !== null) {
    // The box keeps to the room left, naming fewer workers, but always saying what q does.
    const lit: Border = focus.panel === "current" ? "heavy" : "rounded"
    const ending = endOfRunLines(view.endOfRun, theme, width, room, lit)
    const compact: CardsLayout = { _tag: "Compact" }
    const tickets = ticketsOf(view.rows)
    const rows = rowsOf(view.rows)
    const spare = room - ending.length + hintSpare
    return { ...drawn, tickets, rows, current: ending.length, cards: compact, ending, spare }
  }
  const besideCurrent = rowsBesideCurrent(view.rows, cards)
  const tickets = ticketsOf(besideCurrent)
  const rows = rowsOf(besideCurrent)
  const layout = layoutOf(cards, width, room)
  const current = Math.min(sectionLines(layout, cards.length), room)
  const spare = room - current + hintSpare
  if (layout._tag === "Cards") {
    return { ...drawn, tickets, rows, current, cards: layout, ending: null, spare }
  }
  const fewer = hintAt(false).slice(0, hint.length)
  const freed = hint.length - fewer.length
  return {
    ...drawn,
    tickets,
    rows,
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
  /** Whether the focus has gone into a panel, as the hint is drawn: the top level when left out. */
  readonly inside?: boolean
  /**
   * The panel beside the tickets table: whether the focus is on it, its needs, whether `1`–`9`
   * answer its question as the key is pressed, and whether the need it shows is a ticket Blocked on
   * its merge conflict.
   */
  readonly panel?: {
    readonly on: () => boolean
    readonly needs: number
    readonly answers?: () => boolean
    readonly conflict?: () => boolean
  }
}

/** What the dashboard's keys do. */
export interface DashboardActions {
  /** `?`: opens or closes the key help. */
  readonly help: () => void
  /** `Esc`: closes the key help, or comes out of the panel. */
  readonly escape: () => void
  /** An arrow: moves between the panels at the top level, and selects inside one. */
  readonly arrow: (direction: Direction) => void
  /** `Tab`, `Shift+Tab`: the next or previous panel; inside Current, the buttons, then the cards. */
  readonly tab: (by: 1 | -1) => void
  /** `Enter`: goes into the panel; inside one, opens or presses what is selected. */
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
  /** `h` on the panel: hands back the ticket Blocked on its merge conflict it shows (§ 4.3). */
  readonly panelHandBack: () => void
}

const nothing = () => {}

/** Keys that do nothing: the dashboard's commands as its hint and key help name them. */
const inertDashboard: DashboardActions = {
  help: nothing,
  escape: nothing,
  arrow: nothing,
  tab: nothing,
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
  panelHandBack: nothing,
}

const moveRow: HelpRow = [
  "Tab, Shift+Tab, arrows",
  "move between the panels; inside one, select in it",
]
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
  const inside = at.inside === true
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
    // The two levels (panelFocus.ts): the hint follows the one the focus is at.
    {
      keys: ["left"],
      run: () => act.arrow("left"),
      hint: { keys: "arrows", does: inside ? "select" : "panels" },
      help: moveRow,
    },
    { keys: ["right"], run: () => act.arrow("right"), help: moveRow },
    { keys: ["up"], run: () => act.arrow("up"), help: moveRow },
    { keys: ["down"], run: () => act.arrow("down"), help: moveRow },
    { keys: ["tab"], run: () => act.tab(1), help: moveRow },
    { keys: ["shift+tab"], run: () => act.tab(-1), help: moveRow },
    {
      keys: ["return", "enter"],
      run: act.enter,
      hint: { keys: "Enter", does: inside ? "open" : "go in" },
      help: ["Enter, a click", "go into the panel; inside it, open what is selected"],
    },
    {
      keys: ["escape"],
      run: act.escape,
      hint: named(inside, "Esc", "back"),
      help: ["Esc", "come out of the panel; an open box closes first"],
    },
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
    // `1`–`9` answer the question of the panel beside the tickets table with that option at once,
    // but with the focus on an attention card in Current; no number opens a worker.
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
      keys: [String(n)],
      when: () => at.panel?.answers?.() === true,
      run: () => act.panelPick(n),
      help: pickRow,
    })),
    // `1`–`4` pick an option of the highlighted card's question.
    ...[1, 2, 3, 4].map((n) => ({
      keys: [String(n)],
      when: () => inCard() !== undefined,
      run: on(inCard, (card) => act.pick(card, n)),
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
    {
      keys: ["h"],
      when: () => at.panel?.on() === true && at.panel.conflict?.() === true,
      run: act.panelHandBack,
      hint: { keys: "h", does: "hand it back" },
      help: ["h", "hand back a ticket blocked on its merge conflict"],
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
 * The dashboard's hint, `highlighted`'s card highlighted (the target's when left out), where
 * `buttons` a request's buttons drawn, and `inside` a panel or at the top level.
 */
export const dashboardHint = (
  view: RunView,
  buttons: boolean,
  highlighted: string | null = targetOf(view),
  inside = false,
): ReadonlyArray<Key> =>
  hintOf(
    dashboardCommands(view, {
      buttons,
      inside,
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

/** Where the dashboard's keys are, kept while it isn't drawn: a worker's view opened from it. */
export interface DashboardMemory {
  readonly focus: Focus
  readonly chosen: string | null
  readonly row: TicketId | null
  readonly upper: Panel
}

/** Where the dashboard's keys start. */
export const startOfDashboard: DashboardMemory = {
  focus: startFocus,
  chosen: null,
  row: null,
  upper: "tickets",
}

export const Dashboard = ({ memory }: { readonly memory?: { current: DashboardMemory } }) => {
  const view = useRunView()
  const theme = useTheme()
  const command = useCommand()
  const { width, height } = useTerminalDimensions()
  const own = useRef(startOfDashboard)
  const kept = memory ?? own
  // Which panel the keys are on, and whether they have gone into it (panelFocus.ts). It is key
  // state, as all of these, so that keys arriving together each see the one before them.
  const [focus, setFocus, focusState] = useKeyState<Focus>(() => kept.current.focus)
  // The panel above Current the focus last left, where ↑ goes back to.
  const [upper, setUpper, upperNow] = useKeyState<Panel>(() => kept.current.upper)
  // The highlight names a ticket; a card that has gone takes it with it.
  const [chosenShown, setChosen, chosen] = useKeyState<string | null>(() => kept.current.chosen)
  // The row selected inside Tickets, by its ticket, so that it stays on its row as rows re-sort.
  const [row, setRow, rowNow] = useKeyState<TicketId | null>(() => kept.current.row)
  const [help, setHelp, helpOpen] = useKeyState(() => false)
  useEffect(() => {
    kept.current = { focus, chosen: chosenShown, row, upper }
  }, [kept, focus, chosenShown, row, upper])
  // The panel beside the tickets table: the need it shows, by its ticket, and at which choice. A
  // question answered here leaves it at once, before the run's next look takes its ticket back.
  const [shownNeed, setShownNeed, shownNeedNow] = useKeyState<string | null>(() => null)
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
  const panelFocused = focus.panel === "needs" && needs.length > 0
  const panelInside = panelFocused && focus.inside
  const side: SideState = {
    needs,
    at: { index: needAt(shownNeed), focused: panelFocused, inside: panelInside, choice },
  }
  // A need's answer keys do nothing until it has been drawn for a moment, as a request's buttons.
  const drawnSince = useRef({ ticket: "", at: 0 })
  const drawnNeed = needs[side.at.index]?.ticket ?? ""
  if (drawnSince.current.ticket !== drawnNeed)
    drawnSince.current = { ticket: drawnNeed, at: Date.now() }
  const cards = view.cards
  // At the top level, the card of the oldest open request is the target, and highlighted (§ 4.5);
  // inside Current, the card chosen, while there is one.
  const target = targetOf(view)
  const current = () =>
    focusState().panel === "current" &&
    focusState().inside &&
    cards.some((card) => card.ticket === chosen())
      ? chosen()
      : target
  // Inside Tickets or Needs you no card is highlighted, as no answer key reaches one.
  const litNow = () => (focusState().inside && focusState().panel !== "current" ? null : current())
  const lit = litNow()
  const choose = (ticket: string | null) => setChosen(() => ticket)
  const open = (ticket: TicketId) => command(UiCommand.OpenWorker({ ticket }))

  // The view's keys, as bound: a key does nothing while the key help is open, but close it.
  const input = useInput()
  const { box } = input
  // A click on a ticket's ID copies it, its cell saying `✓ copied` for a moment (tutti-vkuj).
  const { copied, copy } = useCopyOnClick(input.toasts)

  // The hint names `d` and `a` for the highlighted card's request: the layout is the highlight's.
  const sideIndex = side.at.index
  const laid = useMemo(
    () =>
      dashboardLayout(
        view,
        theme,
        width,
        height,
        lit,
        { needs, at: { index: sideIndex, focused: panelFocused, inside: panelInside, choice } },
        focus,
        row,
        copied,
      ),
    [
      view,
      theme,
      width,
      height,
      lit,
      needs,
      sideIndex,
      panelFocused,
      panelInside,
      choice,
      focus,
      row,
      copied,
    ],
  )
  const { small, ending } = laid
  // Behind the end-of-run box no card's buttons are drawn: Enter opens the Answer box, as on a
  // compact line.
  const layout = laid.cards
  // Only the full cards draw a request's buttons: the answer keys and the guard are theirs alone.
  const buttons = layout._tag === "Cards"
  const answering = useAnswering(buttons ? cards.flatMap((card) => card.requests.slice(0, 1)) : [])

  // Toasts are drawn above the hint's lines, however many it wraps onto.
  useLinesUnderToasts(input.toasts, laid.hint.length)
  const showHelp = (shown: boolean) => setHelp(() => shown)
  const unlessHelp =
    <A extends ReadonlyArray<unknown>>(run: (...args: A) => void) =>
    (...args: A) => {
      if (!helpOpen()) run(...args)
    }
  // The panel shows what needs you, and the focus can go to it.
  const panelShown = () => laid.panel > 0 && needs.length > 0
  // The panels this pane has, and those with something to select.
  const panels: ReadonlyArray<Panel> = [
    ...(laid.table > 0 ? (["tickets"] as const) : []),
    ...(laid.panel === 0 ? (["cell"] as const) : needs.length > 0 ? (["needs"] as const) : []),
    "current",
  ]
  const filled: ReadonlyArray<Panel> = [
    ...(laid.rows.length > 0 ? (["tickets"] as const) : []),
    ...(panelShown() ? (["needs"] as const) : []),
    ...(cards.length > 0 ? (["current"] as const) : []),
  ]
  // A panel gone from the pane, or emptied, moves the focus off it.
  const focusNow = () => focusAmong(focusState(), panels, filled)
  const settled = focusAmong(focus, panels, filled)
  useEffect(() => {
    if (settled !== focus) {
      setFocus(() => settled)
      if (focus.panel === "current") answering.reset()
    }
  })
  // A row gone from the table takes the selection to the first drawn, the most urgent.
  const firstRow = laid.rows[0]?.ticket ?? null
  const rowGone = laid.table > 0 && !laid.rows.some((each) => each.ticket === row)
  useEffect(() => {
    if (focus.panel === "tickets" && focus.inside && rowGone) setRow(() => firstRow)
  }, [focus, rowGone, firstRow, setRow])
  const onPanel = () => focusNow().panel === "needs"
  const insideOf = (panel: Panel) => {
    const now = focusNow()
    return now.panel === panel && now.inside
  }
  const highlightedCard = () => {
    const now = focusNow()
    return now.inside && now.panel !== "current"
      ? undefined
      : cards.find((card) => card.ticket === current())
  }
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
  }
  // The focus goes to `panel`, at the top level or inside it, the last panel above Current kept.
  const focusOn = (panel: Panel, inside: boolean) => {
    const from = focusNow().panel
    if (from !== "current") setUpper(() => from)
    if (from === "current" && (panel !== "current" || !inside)) answering.reset()
    if (from !== panel || !inside) setChoice(() => 0)
    setFocus(() => ({ panel, inside }))
  }
  // The list of what needs you, where there is no panel.
  const openNeeds = () => box.set(Box.Needs({ at: 0, answered: [] }))
  // Goes into `panel`, at what it last selected, or what wants you most; onto one with nothing to
  // select. The cell has no inside: it opens what it stands for.
  const goIn = (panel: Panel) => {
    if (panel === "cell") {
      focusOn(panel, false)
      return openNeeds()
    }
    if (!filled.includes(panel)) return focusOn(panel, false)
    if (panel === "tickets" && !laid.rows.some((each) => each.ticket === rowNow())) {
      setRow(() => firstRow)
    }
    if (panel === "current") {
      const known = cards.some((card) => card.ticket === chosen()) ? chosen() : null
      choose(target ?? known ?? cards[0]?.ticket ?? null)
    }
    focusOn(panel, true)
  }
  // A click on a card opens it, and the keys are on it when its view closes.
  const openCard = useEvent((ticket: TicketId) => {
    choose(ticket)
    focusOn("current", true)
    open(ticket)
  })
  // Enter on a row: an Asked row's question, what clears a Blocked row, or its worker's view.
  const openRow = () => {
    const ticket = rowNow()
    if (ticket === null) return
    const need = needs.find((each) => each.ticket === ticket)
    if (need?._tag === "Question") {
      box.set(Box.Questions({ first: need.question?.id ?? (need.id as TicketId) }))
    } else if (need?._tag === "Blocked") box.set(Box.Blocked({ ticket }))
    else open(ticket)
  }
  // A click on a row selects it, going into the table; on its ID, copies it and stays put.
  const pressTable = (target: number) => {
    if (target >= idTarget) {
      const clicked = laid.rows[target - idTarget]
      if (clicked !== undefined) copy(clicked.ticket)
      return
    }
    if (target < rowTarget) return pressPanel(target)
    const clicked = laid.rows[target - rowTarget]
    if (clicked === undefined) return
    setRow(() => clicked.ticket)
    focusOn("tickets", true)
  }
  const pressTotals = (target: number) => {
    if (target === needsTarget && laid.panel === 0) goIn("cell")
  }
  // A click on what is no target beside the table's line: into the panel it is in.
  const pressUpper = (event: MouseEvent) => {
    if (event.x < tableWidth(width, laid.panel)) goIn("tickets")
    else if (panelShown()) goIn("needs")
  }
  // The questions box at the panel's question: to read it all, or to type your own answer.
  const readQuestion = () => {
    const { need } = shownNow()
    if (need?._tag !== "Question") return
    box.set(Box.Questions({ first: need.question?.id ?? (need.ticket as TicketId) }))
  }
  const panelEnter = () => {
    const { need } = shownNow()
    if (need?._tag === "Blocked") {
      if (blockedCut(need, laid.panel, laid.table)) box.set(Box.Blocked({ ticket: need.ticket }))
      else open(need.ticket)
      return
    }
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
    focusOn("needs", true)
    if (target === panelTargets.read) {
      const { need } = shownNow()
      if (need?._tag === "Blocked") return box.set(Box.Blocked({ ticket: need.ticket }))
    }
    if (target === panelTargets.other || target === panelTargets.read) return readQuestion()
    setChoice(() => target)
    answerWith(target)
  }
  const rowStep = (by: 1 | -1) => {
    const rows = laid.rows
    if (rows.length === 0) return
    const at = rows.findIndex((each) => each.ticket === rowNow())
    const next = at === -1 ? (by === 1 ? 0 : rows.length - 1) : at + by
    setRow(() => rows[(next + rows.length) % rows.length]?.ticket ?? null)
  }
  const arrow = (direction: Direction) => {
    const { panel, inside } = focusNow()
    if (!inside) return focusOn(panelTowards(panels, panel, direction, upperNow()), false)
    const across = direction === "left" || direction === "right"
    const by = direction === "right" || direction === "down" ? 1 : -1
    if (panel === "tickets") return across ? undefined : rowStep(by)
    if (panel === "needs") return across ? undefined : panelMove(by)
    // → and ← move between an attention card's buttons before moving on; ↑ and ↓ from card to card.
    const card = across ? inCard() : undefined
    if (card !== undefined && answering.step(card.requests[0], by)) return
    answering.reset()
    const at = cards.findIndex((each) => each.ticket === current())
    const rowSize = layout._tag === "Cards" ? layout.across : 1
    choose(cards[gridMove(cards.length, rowSize, at, direction)]?.ticket ?? null)
  }
  const tab = (by: 1 | -1) => {
    if (!insideOf("current")) return focusOn(panelAfter(panels, focusNow().panel, by), false)
    const card = inCard()
    if (card !== undefined && answering.step(card.requests[0], by)) return
    answering.reset()
    choose(moveHighlight(cards, current(), by))
  }
  const enter = () => {
    const { panel, inside } = focusNow()
    if (!inside) return goIn(panel)
    if (panel === "tickets") return openRow()
    if (panel === "needs") return panelEnter()
    const card = highlightedCard()
    if (card === undefined) return
    if (grows(card) && !buttons) box.set(Box.Answer({ ticket: card.ticket }))
    else if (inCard() === undefined || !answering.pressFocused(card.requests[0])) open(card.ticket)
  }
  const keys = useCommands(
    "view",
    dashboardCommands(
      view,
      {
        buttons,
        inside: focus.inside,
        highlighted: highlightedCard,
        panel: {
          on: onPanel,
          needs: needs.length,
          answers: () =>
            panelShown() &&
            (focusNow().panel !== "current" || inCard() === undefined) &&
            shownNow().need?._tag === "Question",
          conflict: () => isConflict(shownNow().need),
        },
      },
      {
        help: () => showHelp(!helpOpen()),
        escape: () => {
          if (helpOpen()) return showHelp(false)
          const { panel, inside } = focusNow()
          if (inside) focusOn(panel, false)
        },
        arrow: unlessHelp(arrow),
        tab: unlessHelp(tab),
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
        panelHandBack: unlessHelp(() => {
          const { need } = shownNow()
          if (isConflict(need)) command(UiCommand.HandBackNow({ ticket: need.ticket }))
        }),
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
          <Lines lines={laid.totals} press={pressTotals} />
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
        <Lines lines={laid.totals} press={pressTotals} />
      </Section>
      <Section lines={laid.table}>
        <box flexDirection="column" flexShrink={0} {...clickable(pressUpper)}>
          <Lines lines={laid.tickets} press={pressTable} />
        </box>
      </Section>
      <Section lines={laid.current}>
        <box flexDirection="column" flexShrink={0} {...clickable(() => goIn("current"))}>
          {ending !== null ? (
            <Lines lines={ending} />
          ) : (
            <Cards
              cards={cards}
              theme={theme}
              layout={layout}
              width={width}
              room={laid.current}
              stopping={
                view.title.stopping || view.title.quitting !== null || view.windDown !== null
              }
              fullCheck={view.fullCheck}
              highlighted={lit}
              focused={focus.panel === "current" && !focus.inside}
              open={openCard}
              focusOf={answering.focusOf}
              press={answering.press}
            />
          )}
        </box>
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
