// The hint at the foot of the dashboard and the views (§ 7.2, § 7.5, § 7.11): the keys there are
// now, as RunView names them, each `emphasis` bold, its words faint, ` · ` faint between them, on
// as many lines as it takes (hintLines), or cut to one (hintSegments).
import type { Key } from "../run/runView.ts"
import { cut, joined, type Segments, seg, separatorOf, widthOf, wrap } from "./line.tsx"
import { hintIndent } from "./spacing.ts"
import type { Theme } from "./theme.ts"

/** A key as the hint draws it: its keys bold, what it does faint. */
const keySegments = (key: Key, theme: Theme): Segments => [
  seg(key.keys, theme.styles.key),
  seg(` ${key.does}`, theme.styles.dim),
]

/** The hint `width` wide. */
export const hintSegments = (keys: ReadonlyArray<Key>, theme: Theme, width: number): Segments =>
  cut(
    [
      seg(hintIndent),
      ...joined(
        keys.map((key) => keySegments(key, theme)),
        theme,
      ),
    ],
    width,
  )

/**
 * The hint on as many lines `width` wide as it takes to show every key: a line breaks between two
 * keys, and inside one only when it is wider than a line, between its words.
 */
export const hintLines = (
  keys: ReadonlyArray<Key>,
  theme: Theme,
  width: number,
): ReadonlyArray<Segments> => {
  const lines: Array<Segments> = []
  let line: Segments = [seg(hintIndent)]
  let fresh = true
  for (const key of keys) {
    const each = keySegments(key, theme)
    const joined: Segments = fresh ? [...line, ...each] : [...line, separatorOf(theme), ...each]
    if (fresh || widthOf(joined) <= width) {
      line = joined
      fresh = false
      continue
    }
    lines.push(line)
    line = [seg(hintIndent), ...each]
  }
  lines.push(line)
  return lines.flatMap((each) =>
    widthOf(each) <= width ? [each] : wrap(each, width, { indent: 4, long: "line" }),
  )
}
