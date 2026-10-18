// A line of the dashboard as segments of text, each in a style of the theme's, measured and cut to
// the pane's width before it is drawn, so that no line wraps (§ 7.2). Frames are drawn as text too,
// as orchestra's Lip Gloss tables are: a rounded frame of columns with their borders shared.
import type { Style, Theme } from "./theme.ts"

/** What a segment is drawn in: a style's colours and attributes. */
export type Look = Pick<Style, "fg" | "bg" | "attributes">

/** The look of frames: the theme's `frame` role. */
export const frameLook = (theme: Theme): Look => ({
  fg: theme.rgba("frame"),
  bg: undefined,
  attributes: 0,
})

/** Text in a look; null for the terminal's own. */
export interface Segment {
  readonly text: string
  readonly look: Look | null
}

export type Segments = ReadonlyArray<Segment>

/** `text` in `look`. */
export const seg = (text: string, look: Look | null = null): Segment => ({ text, look })

/** The props that draw a <text> or <span> in `look`. */
export const styled = (look: Look) => ({
  ...(look.fg === undefined ? {} : { fg: look.fg }),
  ...(look.bg === undefined ? {} : { bg: look.bg }),
  attributes: look.attributes,
})

/** How many columns `segments` take. */
export const widthOf = (segments: Segments): number =>
  segments.reduce((sum, each) => sum + Bun.stringWidth(each.text), 0)

/** `segments` cut to `width` columns, the last one kept ending in `…` when they are wider. */
export const cut = (segments: Segments, width: number): Segments => {
  if (widthOf(segments) <= width) return segments
  const kept: Array<Segment> = []
  let room = Math.max(width - 1, 0)
  for (const each of segments) {
    const w = Bun.stringWidth(each.text)
    if (w <= room) {
      kept.push(each)
      room -= w
      continue
    }
    let text = ""
    for (const char of each.text) {
      if (Bun.stringWidth(text + char) > room) break
      text += char
    }
    kept.push(seg(`${text}…`, each.look))
    break
  }
  return width > 0 ? kept : []
}

/** `segments` padded with spaces to `width` columns. */
export const padded = (segments: Segments, width: number): Segments => {
  const short = width - widthOf(segments)
  return short > 0 ? [...segments, seg(" ".repeat(short))] : segments
}

/** One line, never wrapped: what doesn't fit the box is clipped. */
export const Line = ({ segments }: { readonly segments: Segments }) => (
  <text wrapMode="none" height={1}>
    {segments.map((each, i) =>
      each.look === null ? (
        // biome-ignore lint/suspicious/noArrayIndexKey: a line's segments are drawn anew in order
        <span key={i}>{each.text}</span>
      ) : (
        // biome-ignore lint/suspicious/noArrayIndexKey: a line's segments are drawn anew in order
        <span key={i} {...styled(each.look)}>
          {each.text}
        </span>
      ),
    )}
  </text>
)

/** Lines one under the other, as tall as they are. */
export const Lines = ({ lines }: { readonly lines: ReadonlyArray<Segments> }) => (
  <box flexDirection="column" height={lines.length} flexShrink={0}>
    {lines.map((segments, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: the lines are drawn anew in order
      <Line key={i} segments={segments} />
    ))}
  </box>
)

/**
 * A rounded frame around `rows`, each of cells in columns `widths` wide (a space each side besides),
 * its borders in `frame`: one line a row, and the top and bottom borders.
 */
export const framed = (
  rows: ReadonlyArray<ReadonlyArray<Segments>>,
  widths: ReadonlyArray<number>,
  frame: Look,
): ReadonlyArray<Segments> => {
  const edge = (left: string, join: string, right: string): Segments => [
    seg(left + widths.map((w) => "─".repeat(w + 2)).join(join) + right, frame),
  ]
  const bar = seg("│", frame)
  return [
    edge("╭", "┬", "╮"),
    ...rows.map((cells) => [
      bar,
      ...widths.flatMap((w, i) => [seg(" "), ...padded(cut(cells[i] ?? [], w), w), seg(" "), bar]),
    ]),
    edge("╰", "┴", "╯"),
  ]
}
