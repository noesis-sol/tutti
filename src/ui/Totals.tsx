// The dashboard's totals (§ 7.2, § 7.11): a strip in a rounded frame, a column a total with its
// label faint over its count, or on one line in a pane too narrow for the strip, or too small for
// the dashboard (below 60×16). Completed `✓ n`, Set aside `↷ n` with ` ◆ n` triaged, Needs you,
// Workers `n of N`, and In queue `n of N` with ` · N held back`, ` · N setup failed` and ` · held`;
// zeros are faint.
import type { Totals as TotalsView } from "../run/runView.ts"
import { cut, framed, frameLook, Lines, type Look, type Segments, seg, widthOf } from "./line.tsx"
import type { Theme } from "./theme.ts"

/** The strip's columns: each total's label and its count. */
const columns = (t: TotalsView, theme: Theme): ReadonlyArray<readonly [string, Segments]> => {
  const { styles } = theme
  const zero = (text: string) => seg(text, styles.dim)
  const count = (n: number, mark: string, look: Look): Segments =>
    n === 0 ? [zero("0")] : [seg(mark === "" ? String(n) : `${mark} ${n}`, look)]
  const triaged: Segments = t.triaged > 0 ? [seg(` ◆ ${t.triaged}`, styles.organ)] : []
  const of = ` of ${t.slots}`
  const workers: Segments =
    t.workers === 0
      ? [zero(`0${of}`)]
      : [seg(String(t.workers), styles.picked), seg(of, styles.dim)]
  return [
    ["Completed", count(t.completed, "✓", styles.closed)],
    ["Set aside", [...count(t.deferred + t.review, "↷", styles.deferred), ...triaged]],
    ["Needs you", count(t.needsYou, "", styles.stop)],
    ["Workers", workers],
    ["In queue", queue(t, theme, " · ")],
  ]
}

/**
 * The queue's count, out of the tickets not closed, then those held back, those whose setup failed
 * and `held`.
 */
const queue = (t: TotalsView, theme: Theme, held: string): Segments => {
  const { styles } = theme
  const of = t.unclosed === null ? "" : ` of ${t.unclosed}`
  return [
    ...(t.queued === 0
      ? [seg(`0${of}`, styles.dim)]
      : [seg(String(t.queued)), ...(of === "" ? [] : [seg(of, styles.dim)])]),
    ...(t.heldBack > 0 ? [seg(` · ${t.heldBack} held back`, styles.heldBack)] : []),
    ...(t.setupFailed > 0 ? [seg(` · ${t.setupFailed} setup failed`, styles.deferred)] : []),
    ...(t.queueHeld ? [seg(`${held}held`, styles.windDown)] : []),
  ]
}

/** The totals on one line, `width` wide: `✓ 2 · ↷ 1 · ? 1 · ▶ 3/3 · queue 9 of 16`. */
export const totalsLine = (t: TotalsView, theme: Theme, width: number): Segments => {
  const { styles } = theme
  const dot = seg(" · ", styles.dim)
  const parts: ReadonlyArray<Segments> = [
    [seg(`✓ ${t.completed}`, styles.closed)],
    [
      seg(`↷ ${t.deferred + t.review}`, styles.deferred),
      ...(t.triaged > 0 ? [seg(` ◆ ${t.triaged}`, styles.organ)] : []),
    ],
    [seg(`? ${t.needsYou}`, styles.stop)],
    [seg(`▶ ${t.workers}`, styles.picked), seg(`/${t.slots}`, styles.dim)],
    [seg("queue ", styles.dim), ...queue(t, theme, " ")],
  ]
  return cut([seg(" "), ...parts.flatMap((part, i) => (i === 0 ? part : [dot, ...part]))], width)
}

/** The strip's lines `width` wide, or null when the pane is too narrow for it. */
export const totalsStrip = (
  t: TotalsView,
  theme: Theme,
  width: number,
): ReadonlyArray<Segments> | null => {
  const all = columns(t, theme)
  const natural = all.map(([label, value]) => Math.max(Bun.stringWidth(label), widthOf(value)))
  // Each column's padding and the bar after it, and the frame's first bar.
  const need = natural.reduce((sum, n) => sum + n + 3, 1)
  if (need > width) return null
  const extra = width - need
  const widths = natural.map(
    (n, i) => n + Math.floor(extra / natural.length) + (i < extra % natural.length ? 1 : 0),
  )
  return framed(
    [all.map(([label]) => [seg(label, theme.styles.dim)]), all.map(([, value]) => value)],
    widths,
    frameLook(theme),
  )
}

/** The totals' lines: the strip, or the one line when `oneLine` or the pane is too narrow for it. */
export const totalsLines = (
  t: TotalsView,
  theme: Theme,
  width: number,
  oneLine: boolean,
): ReadonlyArray<Segments> =>
  (oneLine ? null : totalsStrip(t, theme, width)) ?? [totalsLine(t, theme, width)]

/** The totals, as totalsLines gives them. */
export const Totals = ({ lines }: { readonly lines: ReadonlyArray<Segments> }) => (
  <Lines lines={lines} />
)
