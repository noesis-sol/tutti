// The wind-down line (§ 5.1 "How the phases are shown", § 7.2, § 7.11): a `■` for each ticket
// running when the wind-down began, `windingDown` while it runs, `done` once merged, `needsYou` (not
// bold) once set aside or waiting on you, faint once waiting for a blocker; then `Winding down`
// `windingDown` bold, and how many still run, faint. It never wraps, as orchestra's doesn't: a
// narrow pane drops `, no new tickets`, then the count, then the words, then all but the squares.
import type { WindDownMark } from "../run/phase.ts"
import type { WindDownView } from "../run/runView.ts"
import { firstFit } from "./fit.ts"
import { Line, type Look, type Segments, seg } from "./line.tsx"
import { marks } from "./marks.ts"
import type { Theme } from "./theme.ts"

const markLook = (mark: WindDownMark, theme: Theme): Look => {
  const { styles } = theme
  switch (mark) {
    case "windingDown":
      return styles.windDown
    case "done":
      return styles.done
    case "needsYou":
      return theme.look("needsYou")
    case "faint":
      return styles.dim
  }
}

/**
 * The line `width` wide: `■ ■ ■ ■  Winding down · 3 running, no new tickets`, or `· nothing
 * running, ending now` once none runs. With no ticket running when it began, one `windingDown` `■`.
 */
export const windDownSegments = (view: WindDownView, theme: Theme, width: number): Segments => {
  const squares =
    view.marks.length === 0
      ? [seg(marks.windingDown, theme.styles.windDown)]
      : view.marks.map((each) => seg(marks.windingDown, markLook(each.mark, theme)))
  const spaced = (count: number): Segments =>
    squares.slice(0, count).flatMap((each, i) => (i === 0 ? [each] : [seg(" "), each]))
  const lead = [seg("  "), ...spaced(squares.length), seg("  ")]
  const words = seg("Winding down", theme.look("windingDown", "bold"))
  const rests =
    view.running === 0
      ? ["nothing running, ending now"]
      : [`${view.running} running, no new tickets`, `${view.running} running`]
  // As many squares as fit, after the two spaces, where not even the words do.
  const fit = Math.min(Math.floor((width - 1) / 2), squares.length)
  const forms = function* () {
    for (const rest of rests) yield [...lead, words, seg(` · ${rest}`, theme.styles.dim)]
    yield [...lead, words]
    yield fit <= 0 ? [] : [seg("  "), ...spaced(fit)]
  }
  return firstFit(width, forms())
}

/** The wind-down line, as windDownSegments gives it. */
export const WindDown = ({ segments }: { readonly segments: Segments }) => (
  <Line segments={segments} />
)
