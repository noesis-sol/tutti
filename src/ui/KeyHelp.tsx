// The key-help overlay (§ 7.2, § 7.3): `?` opens it over the dashboard or a worker view, and `?` or
// `Esc` closes it. It lists the view's keys and mouse, as § 7.3's table gives them, the view's
// rows from the list its keys are bound from (keyCommands.ts), then the global ones; each key
// `emphasis` bold and its words faint, in a rounded `frame` box in the middle of the pane. Taller
// than the pane (16 rows at the smallest, § 7.7), it leaves out its blank lines, then shows its keys
// a window at a time, which ↑↓, PgUp/PgDn, g/G and the wheel scroll (tutti-bnhb).
import { type MouseEvent, RGBA } from "@opentui/core"
import { useState } from "react"
import { globalHelp, type HelpRow } from "./keyCommands.ts"
import { useLayer } from "./keys.ts"
import { boxed, cut, Lines, padded, type Segments, seg, widthOf } from "./line.tsx"
import type { Theme } from "./theme.ts"

/** How the overlay of `count` keys fits `height` rows: with its blank lines, and how many keys show. */
export const keyHelpRoom = (
  count: number,
  height: number,
): { readonly spaced: boolean; readonly shown: number } => {
  // The frame's two lines, the title and the Esc line, and a blank line under the title and over Esc.
  const spaced = count + 6 <= height
  return { spaced, shown: spaced ? count : Math.max(Math.min(count, height - 4), 1) }
}

/**
 * The overlay's lines for `keys`, at most `width` wide and `height` tall: the keys from the `top`th
 * on, as many as fit, where they don't all.
 */
export const keyHelpLines = (
  theme: Theme,
  width: number,
  keys: ReadonlyArray<HelpRow>,
  height = Number.POSITIVE_INFINITY,
  top = 0,
): ReadonlyArray<Segments> => {
  const { styles } = theme
  const keyWidth = Math.max(...keys.map(([each]) => Bun.stringWidth(each)))
  const natural = Math.max(...keys.map(([, does]) => keyWidth + 2 + Bun.stringWidth(does)))
  const boxWidth = Math.min(natural + 4, width)
  const inner = Math.max(boxWidth - 4, 0)
  const { spaced, shown } = keyHelpRoom(keys.length, height)
  const from = Math.max(Math.min(top, keys.length - shown), 0)
  const scrolls = shown < keys.length
  const blank: ReadonlyArray<Segments> = spaced ? [[]] : []
  return boxed(
    [
      [
        seg("Keys", styles.tickets),
        ...(scrolls ? [seg(`  ${from + 1}–${from + shown} of ${keys.length}`, styles.dim)] : []),
      ],
      ...blank,
      ...keys
        .slice(from, from + shown)
        .map(([each, does]) =>
          cut(
            [...padded([seg(each, styles.key)], keyWidth), seg("  "), seg(does, styles.dim)],
            inner,
          ),
        ),
      ...blank,
      cut(
        [
          seg("Esc", styles.key),
          seg(" close", styles.dim),
          ...(scrolls
            ? [seg(" · ", styles.dim), seg("↑↓ PgUp PgDn", styles.key), seg(" scroll", styles.dim)]
            : []),
        ],
        inner,
      ),
    ],
    boxWidth,
    theme.look("frame"),
  )
}

/** A view's key help: its `rows`, from its commands (helpOf), then the global keys'. */
export const screenHelp = (rows: ReadonlyArray<HelpRow>): ReadonlyArray<HelpRow> => [
  ...rows,
  ...globalHelp,
]

/** The overlay of the view's `rows`, then the global keys', over the pane `width` by `height`. */
export const KeyHelp = ({
  theme,
  width,
  height,
  keys: rows,
}: {
  readonly theme: Theme
  readonly width: number
  readonly height: number
  readonly keys: ReadonlyArray<HelpRow>
}) => {
  const keys = screenHelp(rows)
  const { shown } = keyHelpRoom(keys.length, height)
  const last = keys.length - shown
  const [scrolled, setScrolled] = useState(0)
  const top = Math.min(scrolled, last)
  const scroll = (by: number) =>
    setScrolled((at) => Math.max(Math.min(Math.min(at, last) + by, last), 0))
  // Over the view's keys, which do nothing while the help is open: they scroll it instead.
  useLayer("help", [
    { key: "down", run: () => scroll(1) },
    { key: "up", run: () => scroll(-1) },
    { key: "pagedown", run: () => scroll(shown) },
    { key: "pageup", run: () => scroll(-shown) },
    { key: "g", run: () => scroll(-keys.length) },
    { key: "shift+g", run: () => scroll(keys.length) },
  ])
  const wheel = (event: MouseEvent) => {
    const step = event.scroll?.direction === "down" ? 1 : event.scroll?.direction === "up" ? -1 : 0
    scroll(step * Math.max(event.scroll?.delta ?? 1, 1))
  }
  const lines = keyHelpLines(theme, width, keys, height, top)
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
      onMouseScroll={wheel}
    >
      <Lines lines={lines} />
    </box>
  )
}
