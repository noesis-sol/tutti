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

/** A grapheme of a segment's text, in its look, and the columns it takes. */
interface Cell {
  readonly text: string
  readonly look: Look | null
  readonly width: number
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** The graphemes of `segments`, one at a time, so that a long text is read only as far as needed. */
function* cellsOf(segments: Segments): Generator<Cell> {
  for (const each of segments) {
    for (const { segment } of graphemes.segment(each.text)) {
      yield { text: segment, look: each.look, width: Bun.stringWidth(segment) }
    }
  }
}

/** Cells as segments, a segment a run of one look. */
const segmentsOf = (cells: ReadonlyArray<Cell>): Segments => {
  const out: Array<Segment> = []
  for (const cell of cells) {
    const last = out.at(-1)
    if (last !== undefined && last.look === cell.look) {
      out[out.length - 1] = seg(last.text + cell.text, last.look)
    } else out.push(seg(cell.text, cell.look))
  }
  return out
}

const isSpace = (cell: Cell): boolean => cell.text === " "

/** `cells` without the spaces at their end. */
const trimmed = (cells: ReadonlyArray<Cell>): ReadonlyArray<Cell> => {
  let end = cells.length
  while (end > 0 && isSpace(cells[end - 1] as Cell)) end--
  return cells.slice(0, end)
}

/** What a text is wrapped by: a line's end, a space, a word (`long` when it's cut in pieces). */
type Token =
  | { readonly _tag: "End" }
  | { readonly _tag: "Space"; readonly cell: Cell }
  | { readonly _tag: "Word"; readonly cells: ReadonlyArray<Cell>; readonly long: boolean }

/** The tokens of `segments`, a word at most `longest` graphemes before it is passed on in pieces. */
function* tokensOf(segments: Segments, longest: number): Generator<Token> {
  let word: Array<Cell> = []
  let long = false
  const flush = function* (): Generator<Token> {
    if (word.length > 0) yield { _tag: "Word", cells: word, long }
    word = []
    long = false
  }
  for (const cell of cellsOf(segments)) {
    if (cell.text === "\n" || cell.text === "\r\n") {
      yield* flush()
      yield { _tag: "End" }
    } else if (isSpace(cell)) {
      yield* flush()
      yield { _tag: "Space", cell }
    } else {
      word.push(cell)
      if (word.length > longest) {
        yield { _tag: "Word", cells: word, long: true }
        word = []
        long = true
      }
    }
  }
  yield* flush()
}

/**
 * `segments` wrapped to `width` columns: before a word that doesn't fit the line, within a word
 * longer than a line, and at each `\n`. The lines after the first start `indent` columns in, without
 * the spaces a wrap left at their start. At most `limit` lines: the last is cut with `…` when there
 * is more. A long text is read only as far as the lines it fills.
 */
export const wrap = (
  segments: Segments,
  width: number,
  options: { readonly indent?: number; readonly limit?: number } = {},
): ReadonlyArray<Segments> => {
  const indent = Math.min(Math.max(options.indent ?? 0, 0), Math.max(width - 1, 0))
  const limit = Math.max(options.limit ?? Number.POSITIVE_INFINITY, 1)
  const lines: Array<Segments> = []
  const room = () => (lines.length === 0 ? width : width - indent)
  const lineOf = (text: Segments): Segments =>
    lines.length === 0 || indent === 0 ? text : [seg(" ".repeat(indent)), ...text]
  let line: Array<Cell> = []
  let used = 0
  // Whether the line was begun by a wrap, which drops the spaces at its start.
  let afterWrap = false
  /** Ends the line, and begins the next; false when it was the last, cut with `rest` after it. */
  const next = (rest: Segments, wrapping: boolean): boolean => {
    if (lines.length === limit - 1) {
      lines.push(lineOf(cut([...segmentsOf(line), ...rest], room())))
      return false
    }
    lines.push(lineOf(segmentsOf(trimmed(line))))
    line = []
    used = 0
    afterWrap = wrapping
    return true
  }
  const add = (cell: Cell) => {
    line.push(cell)
    used += cell.width
  }
  for (const token of tokensOf(segments, Math.max(width, 1))) {
    switch (token._tag) {
      case "End":
        // The last line, with lines after it, ends ` …`, or is cut with `…` when that doesn't fit.
        if (!next([seg(used + 2 <= room() ? " …" : "  ")], false)) return lines
        break
      case "Space":
        // A space that doesn't fit the line goes, as the wrap would take it.
        if (!(afterWrap && line.length === 0) && used + 1 <= room()) add(token.cell)
        break
      case "Word": {
        const w = token.cells.reduce((sum, cell) => sum + cell.width, 0)
        if (used + w <= room()) {
          for (const cell of token.cells) add(cell)
        } else if (!token.long && w <= width - indent && !line.every(isSpace)) {
          if (!next(segmentsOf(token.cells), true)) return lines
          for (const cell of token.cells) add(cell)
        } else {
          for (const cell of token.cells) {
            if (used + cell.width > room() && line.length > 0) {
              if (!next(segmentsOf([cell]), true)) return lines
            }
            add(cell)
          }
        }
      }
    }
  }
  lines.push(lineOf(segmentsOf(trimmed(line))))
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
