// The end-of-run box (D19, § 5 item 14, § 7.2): with everything else done and workers waiting on
// you, it replaces the Current cards. It names each such worker and what it asks, framed
// `needsYou`, and says what answering and `q` do; for a conflict hand-back waiting on a steered
// worker (§ 4.3), what handing it over does too, and for a conflict set aside, what handing it back
// or rebasing it does. Its words are wrapped to the pane's width, and it keeps to the lines it is
// given: it names fewer workers, the rest as `+N more`, then leaves out the hand-backs' lines, then
// the frame and its first words, and always keeps what `q` does.
import { conflictSetAside, conflictWaits, type Waiting } from "../run/runView.ts"
import { firstFitting } from "./fit.ts"
import { type Border, boxed, cut, frameInner, padded, type Segments, seg, wrap } from "./line.tsx"
import type { Theme } from "./theme.ts"

/**
 * `Everything else is done. 2 workers wait for you: tut-9a1 (Allow Bash(rm -rf build)?), tut-7k2
 * (a question)`, the first `named` of them named and the rest counted: `…, +3 more`.
 */
export const endOfRunText = (
  waiting: ReadonlyArray<Waiting>,
  named: number = waiting.length,
): string => {
  const workers = waiting.length === 1 ? "1 worker waits" : `${waiting.length} workers wait`
  const shown = waiting.slice(0, Math.max(named, 0))
  if (shown.length === 0) return `Everything else is done. ${workers} for you.`
  const each = [
    ...shown.map((worker) => `${worker.ticket} (${worker.asks.join(", ")})`),
    ...(waiting.length > shown.length ? [`+${waiting.length - shown.length} more`] : []),
  ].join(", ")
  return `Everything else is done. ${workers} for you: ${each}`
}

/** What answering and `q` do, under the box's first words. */
export const endOfRunAbout =
  "Answering lets them carry on. q ends the run, suspending them: the next run resumes them."

/** What handing a conflict over and `q` do, when the box names a hand-back waiting (§ 4.3). */
export const endOfRunConflict =
  "Hand it the conflict now (in its view) or Release sends it back to merge; q leaves it blocked."

/** What handing back or rebasing a conflict set aside, and `q`, do, when the box names one (§ 4.3). */
export const endOfRunAside =
  "h in Needs you or its view hands it back once more; or rebase it in its worktree and it merges. q leaves it blocked, for the next run."

/**
 * The box's lines, `width` wide, its frame included, at most `height` of them: as many workers
 * named as fit, then the hand-backs' lines left out, then the box's first words and frame, the line
 * of what `q` does kept to the last, cut to one line where nothing else fits. Heavy where the focus
 * is on it, in Current's place.
 */
export const endOfRunLines = (
  waiting: ReadonlyArray<Waiting>,
  theme: Theme,
  width: number,
  height: number = Number.POSITIVE_INFINITY,
  border: Border = "rounded",
): ReadonlyArray<Segments> => {
  const inner = frameInner(width)
  const look = theme.look("needsYou")
  const about = wrap([seg(endOfRunAbout, theme.styles.dim)], inner, { long: "line" })
  const says = (what: string, line: string) =>
    waiting.some((worker) => worker.asks.includes(what))
      ? wrap([seg(line, theme.styles.dim)], inner, { long: "line" })
      : []
  const conflict = [
    ...says(conflictWaits, endOfRunConflict),
    ...says(conflictSetAside, endOfRunAside),
  ]
  const boxOf = (named: number, hand: boolean) =>
    boxed(
      [
        ...wrap([seg(endOfRunText(waiting, named))], inner, { long: "line" }),
        ...about,
        ...(hand ? conflict : []),
      ],
      width,
      look,
      border,
    )
  const forms = function* () {
    for (let named = waiting.length; named >= 0; named--) yield boxOf(named, true)
    yield boxOf(0, false)
    yield boxed(about, width, look, border)
    yield height >= 1 ? [padded(cut([seg(` ${endOfRunAbout}`, look)], width), width)] : []
  }
  return firstFitting(forms(), (lines) => lines.length <= height) ?? []
}
