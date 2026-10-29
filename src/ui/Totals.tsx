// The dashboard's totals (§ 7.2, § 7.11): a strip in a rounded frame, a cell a total with its count
// and its label faint beside it on one line, or on one line in a pane too narrow for the strip, or
// too small for the dashboard (below 60×16). `✓ n Completed`, `↷ n Set aside` with ` · ◆ n
// triaged`, ` · ◆ n` or neither as the pane narrows, `n Needs you`, and `n of N In queue` with
// ` · N held back`, ` · N setup failed` and ` · held`; zeros are faint. Beside the panel the bar
// before In queue is over the panel's left border, both at queueDivider (tutti-ebra).
// The workers are on the load line above the strip (LoadLine.tsx), and on the one line, `▶ n/N`,
// which is drawn without it.
// Where there is no panel beside the tickets table, Needs you is a click target, and the highlight
// reaches it (NeedsReach, tutti-fdv1): it opens the list of what needs you (NeedsList.tsx).
import type { Totals as TotalsView } from "../run/runView.ts"
import { firstFitting } from "./fit.ts"
import { cut, framed, type Look, type Segments, seg, targeting, widthOf } from "./line.tsx"
import { marks } from "./marks.ts"
import type { Theme } from "./theme.ts"

/** How much of Set aside's triage note the strip says: ` · ◆ n triaged`, ` · ◆ n`, or none. */
type Triage = "full" | "short" | "none"

/**
 * What the dashboard's keys and clicks reach of the totals where there is no panel (§ 7.2): Needs
 * you, its click target, and whether the highlight is on it, drawn in the focus's look.
 */
export interface NeedsReach {
  readonly target: number
  readonly highlighted: boolean
}

/** `segments` as `reach` makes them: its click target, and the focus's look while highlighted. */
const reached = (segments: Segments, theme: Theme, reach: NeedsReach | undefined): Segments =>
  reach === undefined
    ? segments
    : targeting(
        reach.highlighted
          ? segments.map((each) => ({ ...each, look: theme.form.focusedButton }))
          : segments,
        reach.target,
      )

/**
 * The strip's cells: each total's count in its style, then its label faint, a zero faint whole;
 * Set aside's triage note, as much of it as `triage` says, and the queue's notes after their labels.
 */
const cells = (
  t: TotalsView,
  theme: Theme,
  triage: Triage,
  reach?: NeedsReach,
): ReadonlyArray<Segments> => {
  const { styles } = theme
  const faint = (text: string) => seg(text, styles.dim)
  const cell = (n: number, mark: string, look: Look, label: string): Segments =>
    n === 0
      ? [faint(`0 ${label}`)]
      : [seg(mark === "" ? String(n) : `${mark} ${n}`, look), faint(` ${label}`)]
  const verdict = `${marks.verdict} ${t.triaged}`
  const note = { full: ` · ${verdict} triaged`, short: ` · ${verdict}`, none: "" }[triage]
  const triaged: Segments = t.triaged > 0 && note !== "" ? [seg(note, styles.organ)] : []
  return [
    cell(t.completed, marks.done, styles.closed, "Completed"),
    [...cell(t.deferred + t.review, marks.setAside, styles.deferred, "Set aside"), ...triaged],
    reached(cell(t.needsYou, "", styles.stop, "Needs you"), theme, reach),
    [...queueCount(t, theme), faint(" In queue"), ...queueNotes(t, theme, " · ")],
  ]
}

/** The queue's count, out of the tickets not closed: `9 of 16`, faint at 0. */
const queueCount = (t: TotalsView, theme: Theme): Segments => {
  const { styles } = theme
  const of = t.unclosed === null ? "" : ` of ${t.unclosed}`
  return t.queued === 0
    ? [seg(`0${of}`, styles.dim)]
    : [seg(String(t.queued)), ...(of === "" ? [] : [seg(of, styles.dim)])]
}

/** What the queue's count leaves out: those held back, those whose setup failed, and `held`. */
const queueNotes = (t: TotalsView, theme: Theme, held: string): Segments => {
  const { styles } = theme
  return [
    ...(t.heldBack > 0 ? [seg(` · ${t.heldBack} held back`, styles.heldBack)] : []),
    ...(t.setupFailed > 0 ? [seg(` · ${t.setupFailed} setup failed`, styles.deferred)] : []),
    ...(t.queueHeld ? [seg(`${held}held`, styles.windDown)] : []),
  ]
}

/**
 * The totals on one line, `width` wide: `✓ 2 · ↷ 1 · ? 1 · ▶ 3/3 · queue 9 of 16`, the workers left
 * out when not `workers`, as the load line says them.
 */
export const totalsLine = (
  t: TotalsView,
  theme: Theme,
  width: number,
  workers = true,
  reach?: NeedsReach,
): Segments => {
  const { styles } = theme
  const dot = seg(" · ", styles.dim)
  const parts: ReadonlyArray<Segments> = [
    [seg(`${marks.done} ${t.completed}`, styles.closed)],
    [
      seg(`${marks.setAside} ${t.deferred + t.review}`, styles.deferred),
      ...(t.triaged > 0 ? [seg(` ${marks.verdict} ${t.triaged}`, styles.organ)] : []),
    ],
    reached([seg(`${marks.asked} ${t.needsYou}`, styles.stop)], theme, reach),
    ...(workers
      ? [[seg(`${marks.working} ${t.workers}`, styles.picked), seg(`/${t.slots}`, styles.dim)]]
      : []),
    [seg("queue ", styles.dim), ...queueCount(t, theme), ...queueNotes(t, theme, " ")],
  ]
  return cut([seg(" "), ...parts.flatMap((part, i) => (i === 0 ? part : [dot, ...part]))], width)
}

/**
 * The room a strip `width` wide has for its four cells: each one's padding and the bar after it,
 * and the frame's first bar, taken out.
 */
const roomOf = (width: number): number => width - 1 - 3 * 4

/** The first three cells' width where they line up: a fifth of a strip `width` wide's room. */
const fifthOf = (width: number): number => Math.floor(roomOf(width) / 5)

/**
 * The column, from 0, of the bar before In queue in a strip `width` wide whose first three cells
 * are a fifth of it each, as beside the panel (SidePanel.tsx's panelWidth reads it, tutti-ebra).
 */
export const queueDivider = (width: number): number => 3 * (fifthOf(width) + 3)

/**
 * The strip's line `width` wide, in its frame, or null when the pane is too narrow for it, even
 * with Set aside's triage note cut to ` · ◆ n` and then left out. The first three cells are as wide
 * as each other, up to a fifth of the strip, and the queue's takes the rest; where that leaves the
 * queue too little, they give up their width down to the widest's, then each down to its own, so
 * that they line up while they can. The triage note doesn't set the others' width: Set aside goes
 * past them where it makes the cell wider, so that the queue keeps the room (tutti-iolm).
 * `besidePanel`, the cells are a fifth each whatever they say, so that the bar before In queue stays
 * at queueDivider, over the panel's left border: Set aside's triage note is cut to ` · ◆ n`, then
 * left out, where it would widen its cell past the fifth (tutti-ebra).
 */
export const totalsStrip = (
  t: TotalsView,
  theme: Theme,
  width: number,
  reach?: NeedsReach,
  besidePanel = false,
): ReadonlyArray<Segments> | null => {
  const bare = cells(t, theme, "none").slice(0, -1).map(widthOf)
  const forms = function* () {
    for (const triage of ["full", "short", "none"] as const) {
      const all = cells(t, theme, triage, reach)
      const natural = all.map(widthOf)
      const widths = besidePanel
        ? natural.slice(0, -1).every((n) => n <= fifthOf(width))
          ? fifths(width)
          : null
        : cellWidths(natural, bare, width)
      yield widths === null ? null : framed([all], widths, theme.look("frame"))
    }
  }
  const strip = firstFitting(forms(), (strip) => strip !== null) ?? null
  if (strip !== null || !besidePanel) return strip
  // A cell wider than its fifth even without the note is cut to it.
  return framed([cells(t, theme, "none", reach)], fifths(width), theme.look("frame"))
}

/** The cells' widths beside the panel, in a strip `width` wide: a fifth each, and the queue's the rest. */
const fifths = (width: number): ReadonlyArray<number> => {
  const fifth = fifthOf(width)
  return [fifth, fifth, fifth, roomOf(width) - 3 * fifth]
}

/**
 * The cells' widths in a strip `width` wide, from their own, or null where they don't fit; the
 * first three line up at a fifth of the strip, or the widest of `aligned`, their widths without the
 * triage note, where that is wider.
 */
const cellWidths = (
  natural: ReadonlyArray<number>,
  aligned: ReadonlyArray<number>,
  width: number,
): ReadonlyArray<number> | null => {
  const room = roomOf(width)
  const queue = natural.at(-1) ?? 0
  const firsts = natural.slice(0, -1)
  const widthsAt = (least: number) => firsts.map((n) => Math.max(n, least))
  const sum = (ns: ReadonlyArray<number>) => ns.reduce((total, n) => total + n, 0)
  if (sum(firsts) + queue > room) return null
  let least = Math.max(fifthOf(width), ...aligned)
  while (least > 0 && sum(widthsAt(least)) + queue > room) least -= 1
  const widths = widthsAt(least)
  return [...widths, room - sum(widths)]
}

/**
 * The totals' lines: the strip, or the one line when `oneLine` (a pane too small for the dashboard,
 * which has no load line, so the line says the workers) or the pane is too narrow for the strip;
 * `besidePanel`, the strip's bar before In queue over the panel's left border.
 */
export const totalsLines = (
  t: TotalsView,
  theme: Theme,
  width: number,
  oneLine: boolean,
  reach?: NeedsReach,
  besidePanel = false,
): ReadonlyArray<Segments> =>
  oneLine
    ? [totalsLine(t, theme, width, true, reach)]
    : (totalsStrip(t, theme, width, reach, besidePanel) ?? [
        totalsLine(t, theme, width, false, reach),
      ])
