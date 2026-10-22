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
export type Segment = Piece<Look | null>

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

/** Text in a look of any kind: a segment's, or the ANSI sequences that open a printed span's style. */
export interface Piece<L> {
  readonly text: string
  readonly look: L
}

/**
 * The spaces a tab is drawn as. Bun.stringWidth counts a tab as no columns and OpenTUI draws it as
 * two, so a tab is spaces before anything is measured, four as a code block's are in the report.
 */
export const tabWidth = 4

const tab = " ".repeat(tabWidth)

/** How many columns `text` takes, a tab `tabWidth`. */
const textWidth = (text: string): number =>
  Bun.stringWidth(text) + (text.includes("\t") ? text.split("\t").length - 1 : 0) * tabWidth

/** `segments` with their tabs spaces; `segments` themselves when they have none. */
const expanded = <S extends Piece<unknown>>(segments: ReadonlyArray<S>): ReadonlyArray<S> =>
  segments.some((each) => each.text.includes("\t"))
    ? segments.map((each) =>
        each.text.includes("\t") ? { ...each, text: each.text.replaceAll("\t", tab) } : each,
      )
    : segments

/** How many columns `segments` take. */
export const widthOf = (segments: ReadonlyArray<Piece<unknown>>): number =>
  segments.reduce((sum, each) => sum + textWidth(each.text), 0)

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/**
 * `segments` cut to `width` columns, the last one kept ending in `…` when they are wider: between
 * graphemes, so that a flag or an emoji joined by ZWJ is never split. Their tabs are spaces.
 */
export const cut = <L,>(
  segments: ReadonlyArray<Piece<L>>,
  width: number,
): ReadonlyArray<Piece<L>> => {
  const flat = expanded(segments)
  if (widthOf(flat) <= width) return flat
  if (width <= 0) return []
  const kept: Array<Piece<L>> = []
  let room = width - 1
  for (const each of flat) {
    const w = Bun.stringWidth(each.text)
    if (w <= room) {
      kept.push(each)
      room -= w
      continue
    }
    let text = ""
    for (const { segment } of graphemes.segment(each.text)) {
      const g = Bun.stringWidth(segment)
      if (g > room) break
      text += segment
      room -= g
    }
    kept.push({ text: `${text}…`, look: each.look })
    break
  }
  return kept
}

/** A grapheme of a segment's text, in its look, and the columns it takes. */
interface Cell<L> {
  readonly text: string
  readonly look: L
  readonly width: number
}

/**
 * The graphemes of `segments`, one at a time, so that a long text is read only as far as needed;
 * a tab is `tabWidth` spaces.
 */
function* cellsOf<L>(segments: ReadonlyArray<Piece<L>>): Generator<Cell<L>> {
  for (const each of segments) {
    for (const { segment } of graphemes.segment(each.text)) {
      if (segment === "\t") {
        for (let i = 0; i < tabWidth; i++) yield { text: " ", look: each.look, width: 1 }
      } else yield { text: segment, look: each.look, width: Bun.stringWidth(segment) }
    }
  }
}

/** Cells as segments, a segment a run of one look. */
const segmentsOf = <L,>(cells: ReadonlyArray<Cell<L>>): ReadonlyArray<Piece<L>> => {
  const out: Array<Piece<L>> = []
  for (const cell of cells) {
    const last = out.at(-1)
    if (last !== undefined && last.look === cell.look) {
      out[out.length - 1] = { text: last.text + cell.text, look: last.look }
    } else out.push({ text: cell.text, look: cell.look })
  }
  return out
}

const isSpace = (cell: Cell<unknown>): boolean => cell.text === " "

/** `cells` without the spaces at their end. */
const trimmed = <L,>(cells: ReadonlyArray<Cell<L>>): ReadonlyArray<Cell<L>> => {
  let end = cells.length
  while (end > 0 && isSpace(cells[end - 1] as Cell<L>)) end--
  return cells.slice(0, end)
}

/** What a text is wrapped by: a line's end, a space, a word (`more` when it goes on a piece before). */
type Token<L> =
  | { readonly _tag: "End" }
  | { readonly _tag: "Space"; readonly cell: Cell<L> }
  | { readonly _tag: "Word"; readonly cells: ReadonlyArray<Cell<L>>; readonly more: boolean }

/** The tokens of `segments`, a word at most `longest` graphemes before it is passed on in pieces. */
function* tokensOf<L>(segments: ReadonlyArray<Piece<L>>, longest: number): Generator<Token<L>> {
  let word: Array<Cell<L>> = []
  let more = false
  const flush = function* (): Generator<Token<L>> {
    if (word.length > 0) yield { _tag: "Word", cells: word, more }
    word = []
    more = false
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
        yield { _tag: "Word", cells: word, more }
        word = []
        more = true
      }
    }
  }
  yield* flush()
}

/**
 * `segments` wrapped to `width` columns: before a word that doesn't fit the line, within a word
 * longer than a line, and at each `\n`, always between graphemes. Such a word is broken where it
 * reaches the line's edge, or, `long: "line"`, starts on a line of its own as prose's words do.
 * A tab is `tabWidth` spaces. `start` columns of the first line are taken already, by what is drawn
 * before it. The lines after the first start `indent` columns in, without the spaces a wrap left at
 * their start. At most `limit` lines: the last is cut with `…` when there is more. A long text is
 * read only as far as the lines it fills.
 */
export const wrap = <L,>(
  segments: ReadonlyArray<Piece<L>>,
  width: number,
  options: {
    readonly indent?: number
    readonly start?: number
    readonly limit?: number
    readonly long?: "edge" | "line"
  } = {},
): ReadonlyArray<ReadonlyArray<Piece<L | null>>> => {
  const indent = Math.min(Math.max(options.indent ?? 0, 0), Math.max(width - 1, 0))
  const start = Math.max(options.start ?? 0, 0)
  const limit = Math.max(options.limit ?? Number.POSITIVE_INFINITY, 1)
  type Out = ReadonlyArray<Piece<L | null>>
  const lines: Array<Out> = []
  const room = () => (lines.length === 0 ? width - start : width - indent)
  // The indent gives way to a grapheme wider than the rest of a line, so the line keeps to `width`.
  const lineOf = (text: Out): Out => {
    const pad = lines.length === 0 ? 0 : Math.min(indent, Math.max(width - widthOf(text), 0))
    return pad === 0 ? text : [{ text: " ".repeat(pad), look: null }, ...text]
  }
  let line: Array<Cell<L>> = []
  let used = 0
  // Whether the line was begun by a wrap, which drops the spaces at its start.
  let afterWrap = false
  /** Whether a word that doesn't fit the line goes on the next: the line holds more than spaces. */
  const taken = () => (lines.length === 0 && start > 0) || !line.every(isSpace)
  /** Ends the line, and begins the next; false when it was the last, cut with `rest` after it. */
  const next = (rest: Out, wrapping: boolean): boolean => {
    if (lines.length === limit - 1) {
      lines.push(lineOf(cut([...segmentsOf<L | null>(line), ...rest], room())))
      return false
    }
    lines.push(lineOf(segmentsOf(trimmed(line))))
    line = []
    used = 0
    afterWrap = wrapping
    return true
  }
  const add = (cell: Cell<L>) => {
    line.push(cell)
    used += cell.width
  }
  for (const token of tokensOf(segments, Math.max(width, 1))) {
    switch (token._tag) {
      case "End":
        // The last line, with lines after it, ends ` …`, or is cut with `…` when that doesn't fit.
        if (!next([{ text: used + 2 <= room() ? " …" : "  ", look: null }], false)) return lines
        break
      case "Space":
        // A space that doesn't fit the line goes, as the wrap would take it.
        if (!(afterWrap && line.length === 0) && used + 1 <= room()) add(token.cell)
        break
      case "Word": {
        const w = token.cells.reduce((sum, cell) => sum + cell.width, 0)
        const own = options.long === "line" || w <= width - indent
        if (!token.more && used + w > room()) {
          if (own && taken()) {
            if (!next(segmentsOf(token.cells), true)) return lines
          } else if (options.long === "line") {
            // Only spaces before it, which the word needs the room of: they go, as at a wrap.
            line = []
            used = 0
          }
        }
        for (const [i, cell] of token.cells.entries()) {
          if (used + cell.width > room() && (line.length > 0 || taken())) {
            if (!next(segmentsOf(token.cells.slice(i)), true)) return lines
          }
          add(cell)
        }
      }
    }
  }
  lines.push(lineOf(segmentsOf(trimmed(line))))
  return lines
}

/** `text` wrapped to `width` columns, as `wrap` wraps prose, each line its text. Empty: one line. */
export const wrapText = (text: string, width: number): ReadonlyArray<string> =>
  wrap([{ text, look: null }], width, { long: "line" }).map((line) =>
    line.map((each) => each.text).join(""),
  )

/** `segments` padded with spaces to `width` columns. */
export const padded = (segments: Segments, width: number): Segments => {
  const flat = expanded(segments)
  const short = width - widthOf(flat)
  return short > 0 ? [...flat, seg(" ".repeat(short))] : flat
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
