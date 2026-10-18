// The wind-down line (§ 5.1 "How the phases are shown", § 7.2, § 7.11): a `■` for each ticket
// running when the wind-down began, `windingDown` while it runs, `done` once merged, `needsYou` (not
// bold) once set aside or waiting on you, faint once waiting for a blocker; then `Winding down`
// `windingDown` bold, and how many still run, faint.
import type { WindDownMark, WindDownView } from "../run/runView.ts"
import { cut, Line, type Look, roleLook, type Segments, seg } from "./line.tsx"
import type { Theme } from "./theme.ts"

const markLook = (mark: WindDownMark, theme: Theme): Look => {
  const { styles } = theme
  switch (mark) {
    case "windingDown":
      return styles.windDown
    case "done":
      return styles.done
    case "needsYou":
      return roleLook(theme, "needsYou")
    case "faint":
      return styles.dim
  }
}

/** The line `width` wide: `■ ■ ■ ■  Winding down · 3 running, no new tickets`. */
export const windDownSegments = (view: WindDownView, theme: Theme, width: number): Segments =>
  cut(
    [
      seg("  "),
      ...view.marks.flatMap((each, i) => [
        ...(i === 0 ? [] : [seg(" ")]),
        seg("■", markLook(each.mark, theme)),
      ]),
      ...(view.marks.length === 0 ? [] : [seg("  ")]),
      seg("Winding down", roleLook(theme, "windingDown", true)),
      seg(` · ${view.running} running, no new tickets`, theme.styles.dim),
    ],
    width,
  )

/** The wind-down line, as windDownSegments gives it. */
export const WindDown = ({ segments }: { readonly segments: Segments }) => (
  <Line segments={segments} />
)
