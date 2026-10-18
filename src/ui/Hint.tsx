// The hint at the dashboard's foot (§ 7.2, § 7.11): the keys there are now, as RunView names them,
// each `emphasis` bold, its words faint, ` · ` faint between them.
import type { Key } from "../run/runView.ts"
import { cut, Line, type Segments, seg } from "./line.tsx"
import type { Theme } from "./theme.ts"

/** The hint `width` wide. */
export const hintSegments = (keys: ReadonlyArray<Key>, theme: Theme, width: number): Segments => {
  const { styles } = theme
  return cut(
    [
      seg("  "),
      ...keys.flatMap((key, i) => [
        ...(i === 0 ? [] : [seg(" · ", styles.dim)]),
        seg(key.keys, styles.key),
        seg(` ${key.does}`, styles.dim),
      ]),
    ],
    width,
  )
}

/** The hint, as hintSegments gives it. */
export const Hint = ({ segments }: { readonly segments: Segments }) => <Line segments={segments} />
