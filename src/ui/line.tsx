// A line of the dashboard as segments of text, each in a style of the theme's, measured and cut to
// the pane's width before it is drawn, so that no line wraps (§ 7.2). Frames are drawn as text too,
// as orchestra's Lip Gloss tables are: a rounded frame of columns with their borders shared.
import { RGBA, TextAttributes } from "@opentui/core"
import { createContext, useContext } from "react"
import { orchestra, type Role, rgbaOf, type Style, type Theme } from "./theme.ts"

/** What a segment is drawn in: a style's colours and attributes. */
export type Look = Pick<Style, "fg" | "bg" | "attributes">

/** The look of frames: the theme's `frame` role. */
export const frameLook = (theme: Theme): Look => ({
  fg: theme.rgba("frame"),
  bg: undefined,
  attributes: 0,
})

/** A role's colour, bold or not, for what no style of orchestra's draws: a frame, a mark. */
export const roleLook = (theme: Theme, role: Role, bold = false): Look => ({
  fg: theme.rgba(role),
  bg: undefined,
  attributes: bold ? TextAttributes.BOLD : 0,
})

/** Text in a look; null for the terminal's own. */
export interface Segment {
  readonly text: string
  readonly look: Look | null
}

export type Segments = ReadonlyArray<Segment>

/** `text` in `look`. */
export const seg = (text: string, look: Look | null = null): Segment => ({ text, look })

/**
 * The terminal's own text colour, for text no role colours (§ 7.11's "default text colour"). Left
 * to itself, OpenTUI draws such text exact white, which a light terminal can't show.
 */
export const plainFg = RGBA.defaultForeground()

/** The props that draw a <text> or <span> in `look`, in the terminal's text colour without a role. */
export const styled = (look: Look) => ({
  fg: look.fg ?? plainFg,
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

/**
 * `segments` wrapped onto lines `width` wide, broken between words: the spaces at a break go, each
 * line after the first starts with `indent`, and a word wider than a line is broken where it
 * reaches the edge. `start` columns of the first line are taken already, by what is drawn before it.
 */
export const wrapped = (
  segments: Segments,
  width: number,
  options: { readonly indent?: string; readonly start?: number } = {},
): ReadonlyArray<Segments> => {
  const indent = Bun.stringWidth(options.indent ?? "") < width ? (options.indent ?? "") : ""
  const lines: Array<Array<Segment>> = [[]]
  let col = options.start ?? 0
  let fresh = false
  let spaces: Array<Segment> = []
  const room = () => width - col
  const put = (each: Segment) => {
    lines[lines.length - 1]?.push(each)
    col += Bun.stringWidth(each.text)
    fresh = false
  }
  const breakLine = () => {
    lines.push(indent === "" ? [] : [seg(indent)])
    col = Bun.stringWidth(indent)
    fresh = true
    spaces = []
  }
  for (const each of segments) {
    for (const word of each.text.match(/\s+|\S+/g) ?? []) {
      if (/^\s/.test(word)) {
        spaces.push(seg(word, each.look))
        continue
      }
      const before = widthOf(spaces)
      const w = Bun.stringWidth(word)
      if (before + w <= room()) {
        for (const space of spaces) put(space)
        spaces = []
        put(seg(word, each.look))
        continue
      }
      if (!fresh && col > 0) breakLine()
      spaces = []
      let rest = word
      while (Bun.stringWidth(rest) > room()) {
        let piece = ""
        for (const char of rest) {
          if (Bun.stringWidth(piece + char) > room()) break
          piece += char
        }
        if (piece === "") {
          // Not even one character fits on a line this narrow: it goes on a line of its own.
          piece = [...rest][0] ?? ""
          if (!fresh && col > 0) breakLine()
        }
        put(seg(piece, each.look))
        rest = rest.slice(piece.length)
        if (rest !== "") breakLine()
      }
      if (rest !== "") put(seg(rest, each.look))
    }
  }
  return lines
}

/** `segments` padded with spaces to `width` columns. */
export const padded = (segments: Segments, width: number): Segments => {
  const short = width - widthOf(segments)
  return short > 0 ? [...segments, seg(" ".repeat(short))] : segments
}

/** What selected text is drawn in: the props a <text> takes for it. */
export interface SelectionColours {
  readonly selectionBg?: RGBA
  readonly selectionFg?: RGBA
}

/**
 * Selected text in the theme's `selection` and `selectionText` roles (§ 7.11). A role left to the
 * terminal's default colour, as every role is under NO_COLOR, would draw selected text as the text
 * around it (OpenTUI's own selection swaps a cell's colours, and both are the terminal's): it is
 * the default scheme's, orchestra's, instead, so that what is selected still shows.
 */
export const selectionLookOf = (theme: Theme): SelectionColours => {
  const colourOf = (role: "selection" | "selectionText", layer: "fg" | "bg") => {
    const given = theme.scheme.colours[role][theme.appearance]
    return !theme.noColor && given._tag !== "Default"
      ? theme.rgba(role)
      : rgbaOf(orchestra.colours[role][theme.appearance], layer)
  }
  return {
    selectionBg: colourOf("selection", "bg"),
    selectionFg: colourOf("selectionText", "fg"),
  }
}

/** The selection colours of the lines drawn under it; OpenTUI's own outside it. */
export const SelectionLook = createContext<SelectionColours>({})

/** One line, never wrapped: what doesn't fit the box is clipped. */
export const Line = ({ segments }: { readonly segments: Segments }) => (
  <text wrapMode="none" height={1} fg={plainFg} {...useContext(SelectionLook)}>
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

/** The corners and sides of a box's frame: rounded, or heavy for the highlighted card. */
const corners = {
  rounded: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  heavy: { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" },
} as const

export type Border = keyof typeof corners

/**
 * `lines` in a frame `width` wide, a space each side of them, the frame in `frame`: rounded, or
 * heavy and bold (§ 7.11's highlight, which keeps the frame's colour).
 */
export const boxed = (
  lines: ReadonlyArray<Segments>,
  width: number,
  frame: Look,
  border: Border = "rounded",
): ReadonlyArray<Segments> => {
  const c = corners[border]
  const look =
    border === "heavy" ? { ...frame, attributes: frame.attributes | TextAttributes.BOLD } : frame
  const inner = Math.max(width - 4, 0)
  const rule = c.h.repeat(Math.max(width - 2, 0))
  return [
    [seg(c.tl + rule + c.tr, look)],
    ...lines.map((line) => [
      seg(c.v, look),
      seg(" "),
      ...padded(cut(line, inner), inner),
      seg(" "),
      seg(c.v, look),
    ]),
    [seg(c.bl + rule + c.br, look)],
  ]
}
