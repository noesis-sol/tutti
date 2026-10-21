// The hint at the dashboard's foot (§ 7.2, § 7.11): the keys there are now, as RunView names them,
// each `emphasis` bold, its words faint, ` · ` faint between them.
import type { Key } from "../run/runView.ts"
import { cut, Line, type Segments, seg, widthOf, wrapped } from "./line.tsx"
import type { Theme } from "./theme.ts"

/** A key as the hint draws it: its keys bold, what it does faint. */
const keySegments = (key: Key, theme: Theme): Segments => [
  seg(key.keys, theme.styles.key),
  seg(` ${key.does}`, theme.styles.dim),
]

/** The hint `width` wide. */
export const hintSegments = (keys: ReadonlyArray<Key>, theme: Theme, width: number): Segments => {
  const { styles } = theme
  return cut(
    [
      seg("  "),
      ...keys.flatMap((key, i) => [
        ...(i === 0 ? [] : [seg(" · ", styles.dim)]),
        ...keySegments(key, theme),
      ]),
    ],
    width,
  )
}

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
  let line: Segments = [seg("  ")]
  let fresh = true
  for (const key of keys) {
    const each = keySegments(key, theme)
    const joined: Segments = fresh
      ? [...line, ...each]
      : [...line, seg(" · ", theme.styles.dim), ...each]
    if (fresh || widthOf(joined) <= width) {
      line = joined
      fresh = false
      continue
    }
    lines.push(line)
    line = [seg("  "), ...each]
  }
  lines.push(line)
  return lines.flatMap((each) =>
    widthOf(each) <= width ? [each] : wrapped(each, width, { indent: "    " }),
  )
}

/** The hint, as hintSegments gives it. */
export const Hint = ({ segments }: { readonly segments: Segments }) => <Line segments={segments} />
