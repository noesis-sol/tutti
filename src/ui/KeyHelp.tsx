// The key-help overlay (§ 7.2, § 7.3): `?` opens it over the dashboard or a worker view, and `?` or
// `Esc` closes it. It lists the view's keys and mouse, as § 7.3's table gives them, each key
// `emphasis` bold and its words faint, in a rounded `frame` box in the middle of the pane.
import { RGBA } from "@opentui/core"
import { boxed, cut, frameLook, Lines, padded, type Segments, seg, widthOf } from "./line.tsx"
import type { Theme } from "./theme.ts"

/** The dashboard's keys, and what each does. */
export const dashboardKeys: ReadonlyArray<readonly [string, string]> = [
  ["Tab, Shift+Tab, arrows", "move the highlight between cards"],
  ["Enter, a click", "open the highlighted card; press the focused button"],
  ["Esc", "close an open box"],
  ["d, Shift+D", "deny the request; deny with a reason"],
  ["a", "allow the request, unless it opens on Deny"],
  ["r", "allow for this run"],
  ["1–4 in a question", "pick an option"],
  ["s", "stop after current, or keep taking tickets"],
  ["Ctrl+C", "quit: stop after current, or quit now"],
  ["a drag", "select text and copy it"],
  ["?", "these keys"],
]

/** The overlay's lines for `keys`, the dashboard's when left out, at most `width` wide. */
export const keyHelpLines = (
  theme: Theme,
  width: number,
  keys: ReadonlyArray<readonly [string, string]> = dashboardKeys,
): ReadonlyArray<Segments> => {
  const { styles } = theme
  const keyWidth = Math.max(...keys.map(([each]) => Bun.stringWidth(each)))
  const natural = Math.max(...keys.map(([, does]) => keyWidth + 2 + Bun.stringWidth(does)))
  const boxWidth = Math.min(natural + 4, width)
  const inner = Math.max(boxWidth - 4, 0)
  return boxed(
    [
      [seg("Keys", styles.tickets)],
      [],
      ...keys.map(([each, does]) =>
        cut(
          [...padded([seg(each, styles.key)], keyWidth), seg("  "), seg(does, styles.dim)],
          inner,
        ),
      ),
      [],
      [seg("Esc", styles.key), seg(" close", styles.dim)],
    ],
    boxWidth,
    frameLook(theme),
  )
}

/** The overlay of `keys` (the dashboard's when left out), over the pane `width` by `height`. */
export const KeyHelp = ({
  theme,
  width,
  height,
  keys,
}: {
  readonly theme: Theme
  readonly width: number
  readonly height: number
  readonly keys?: ReadonlyArray<readonly [string, string]>
}) => {
  const lines = keyHelpLines(theme, width, keys)
  const boxWidth = Math.max(...lines.map(widthOf))
  return (
    <box
      position="absolute"
      left={Math.max(Math.floor((width - boxWidth) / 2), 0)}
      top={Math.max(Math.floor((height - lines.length) / 2), 0)}
      width={boxWidth}
      height={lines.length}
      zIndex={10}
      backgroundColor={RGBA.defaultBackground()}
    >
      <Lines lines={lines} />
    </box>
  )
}
