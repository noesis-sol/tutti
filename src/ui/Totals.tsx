// The dashboard's totals (§ 7.2, § 7.11): a strip in a rounded frame, a cell a total with its count
// and its label faint beside it on one line, or on one line in a pane too narrow for the strip, or
// too small for the dashboard (below 60×16). `✓ n Completed`, `↷ n Set aside` with ` · ◆ n
// triaged`, ` · ◆ n` or neither as the pane narrows, `n Needs you`, and `n of N In queue` with
// ` · N held back`, ` · N setup failed` and ` · held`; zeros are faint.
// The workers are on the load line above the strip (LoadLine.tsx), and on the one line, `▶ n/N`,
// which is drawn without it.
import type { Totals as TotalsView } from "../run/runView.ts"
import { cut, framed, Lines, type Look, type Segments, seg, widthOf } from "./line.tsx"
import type { Theme } from "./theme.ts"

/** How much of Set aside's triage note the strip says: ` · ◆ n triaged`, ` · ◆ n`, or none. */
type Triage = "full" | "short" | "none"

/**
 * The strip's cells: each total's count in its style, then its label faint, a zero faint whole;
 * Set aside's triage note, as much of it as `triage` says, and the queue's notes after their labels.
 */
const cells = (t: TotalsView, theme: Theme, triage: Triage): ReadonlyArray<Segments> => {
  const { styles } = theme
  const faint = (text: string) => seg(text, styles.dim)
  const cell = (n: number, mark: string, look: Look, label: string): Segments =>
    n === 0
      ? [faint(`0 ${label}`)]
      : [seg(mark === "" ? String(n) : `${mark} ${n}`, look), faint(` ${label}`)]
  const note = { full: ` · ◆ ${t.triaged} triaged`, short: ` · ◆ ${t.triaged}`, none: "" }[triage]
  const triaged: Segments = t.triaged > 0 && note !== "" ? [seg(note, styles.organ)] : []
  return [
    cell(t.completed, "✓", styles.closed, "Completed"),
    [...cell(t.deferred + t.review, "↷", styles.deferred, "Set aside"), ...triaged],
    cell(t.needsYou, "", styles.stop, "Needs you"),
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
): Segments => {
  const { styles } = theme
  const dot = seg(" · ", styles.dim)
  const parts: ReadonlyArray<Segments> = [
    [seg(`✓ ${t.completed}`, styles.closed)],
    [
      seg(`↷ ${t.deferred + t.review}`, styles.deferred),
      ...(t.triaged > 0 ? [seg(` ◆ ${t.triaged}`, styles.organ)] : []),
    ],
    [seg(`? ${t.needsYou}`, styles.stop)],
    ...(workers ? [[seg(`▶ ${t.workers}`, styles.picked), seg(`/${t.slots}`, styles.dim)]] : []),
    [seg("queue ", styles.dim), ...queueCount(t, theme), ...queueNotes(t, theme, " ")],
  ]
  return cut([seg(" "), ...parts.flatMap((part, i) => (i === 0 ? part : [dot, ...part]))], width)
}

/**
 * The strip's line `width` wide, in its frame, or null when the pane is too narrow for it, even
 * with Set aside's triage note cut to ` · ◆ n` and then left out. The first three cells are as wide
 * as each other, up to a fifth of the strip, and the queue's takes the rest; where that leaves the
 * queue too little, they give up their width down to the widest's, then each down to its own, so
 * that they line up while they can. The triage note doesn't set the others' width: Set aside goes
 * past them where it makes the cell wider, so that the queue keeps the room (tutti-iolm).
 */
export const totalsStrip = (
  t: TotalsView,
  theme: Theme,
  width: number,
): ReadonlyArray<Segments> | null => {
  const bare = cells(t, theme, "none").slice(0, -1).map(widthOf)
  for (const triage of ["full", "short", "none"] as const) {
    const all = cells(t, theme, triage)
    const widths = cellWidths(all.map(widthOf), bare, width)
    if (widths !== null) return framed([all], widths, theme.look("frame"))
  }
  return null
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
  // Each cell's padding and the bar after it, and the frame's first bar.
  const room = width - 1 - 3 * natural.length
  const queue = natural.at(-1) ?? 0
  const firsts = natural.slice(0, -1)
  const widthsAt = (least: number) => firsts.map((n) => Math.max(n, least))
  const sum = (ns: ReadonlyArray<number>) => ns.reduce((total, n) => total + n, 0)
  if (sum(firsts) + queue > room) return null
  let least = Math.max(Math.floor(room / 5), ...aligned)
  while (least > 0 && sum(widthsAt(least)) + queue > room) least -= 1
  const widths = widthsAt(least)
  return [...widths, room - sum(widths)]
}

/**
 * The totals' lines: the strip, or the one line when `oneLine` (a pane too small for the dashboard,
 * which has no load line, so the line says the workers) or the pane is too narrow for the strip.
 */
export const totalsLines = (
  t: TotalsView,
  theme: Theme,
  width: number,
  oneLine: boolean,
): ReadonlyArray<Segments> =>
  oneLine
    ? [totalsLine(t, theme, width)]
    : (totalsStrip(t, theme, width) ?? [totalsLine(t, theme, width, false)])

/** The totals, as totalsLines gives them. */
export const Totals = ({ lines }: { readonly lines: ReadonlyArray<Segments> }) => (
  <Lines lines={lines} />
)
