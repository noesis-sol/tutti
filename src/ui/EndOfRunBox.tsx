// The end-of-run box (D19, § 5 item 14, § 7.2): with everything else done and workers waiting on
// you, it replaces the Current cards. It names each such worker and what it asks, framed
// `needsYou`, and says what answering and `q` do; for a conflict hand-back waiting on a steered
// worker (§ 4.3), what handing it over does too. Its words are wrapped to the pane's width.
import { conflictWaits, type Waiting } from "../run/runView.ts"
import { boxed, Lines, roleLook, type Segments, seg } from "./line.tsx"
import { wrap } from "./Modal.tsx"
import type { Theme } from "./theme.ts"

/**
 * `Everything else is done. 2 workers wait for you: tut-9a1 (Allow Bash(rm -rf build)?), tut-7k2
 * (a question)`.
 */
export const endOfRunText = (waiting: ReadonlyArray<Waiting>): string => {
  const workers = waiting.length === 1 ? "1 worker waits" : `${waiting.length} workers wait`
  const each = waiting.map((worker) => `${worker.ticket} (${worker.asks.join(", ")})`).join(", ")
  return `Everything else is done. ${workers} for you: ${each}`
}

/** What answering and `q` do, under the box's first words. */
export const endOfRunAbout =
  "Answering lets them carry on. q ends the run, suspending them: the next run resumes them."

/** What handing a conflict over and `q` do, when the box names a hand-back waiting (§ 4.3). */
export const endOfRunConflict =
  "Hand it the conflict now (in its view) or Release sends it back to merge; q leaves it blocked."

/** The box's lines, `width` wide, its frame included. */
export const endOfRunLines = (
  waiting: ReadonlyArray<Waiting>,
  theme: Theme,
  width: number,
): ReadonlyArray<Segments> => {
  const inner = Math.max(width - 4, 1)
  return boxed(
    [
      ...wrap(endOfRunText(waiting), inner).map((text) => [seg(text)]),
      ...wrap(endOfRunAbout, inner).map((text) => [seg(text, theme.styles.dim)]),
      ...(waiting.some((worker) => worker.asks.includes(conflictWaits))
        ? wrap(endOfRunConflict, inner).map((text) => [seg(text, theme.styles.dim)])
        : []),
    ],
    width,
    roleLook(theme, "needsYou"),
  )
}

/** The box, as endOfRunLines gives it. */
export const EndOfRunBox = ({ lines }: { readonly lines: ReadonlyArray<Segments> }) => (
  <Lines lines={lines} />
)
