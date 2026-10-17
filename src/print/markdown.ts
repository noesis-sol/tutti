// The run report's Markdown, rendered for a terminal (§ 7.1, § 7.11 "Markdown"): headings, lists,
// emphasis, code, links, quotes, rules and tables, in the theme's heading, code and link roles with
// tutti's bold, faint and italic. marked's lexer reads the Markdown (it is OpenTUI's too, so the
// report and the worker view read Markdown alike); the tokens are drawn here, with no colours of a
// renderer's own.
//
// The report is a model's words, so it is untrusted text (§ 7.10): it is sanitised before it is
// read, and each piece of text is sanitised again as it is drawn, since a character reference such
// as `&#x1b;` becomes a control character only once it is decoded.
import type { Effect } from "effect"
import { lexer, type Token, type Tokens } from "marked"
import { sanitize, sanitizeLine } from "../ui/sanitize.ts"
import type { Role, Theme } from "../ui/theme.ts"
import type { Printer } from "./organLine.ts"

/** How a piece of text is drawn: tutti's attributes and a role's colour. */
interface Attributes {
  readonly bold: boolean
  readonly faint: boolean
  readonly italic: boolean
  readonly strike: boolean
  readonly colour: Role | null
}

const plain: Attributes = { bold: false, faint: false, italic: false, strike: false, colour: null }

/** A piece of text and the ANSI sequences that start its style; a line break is `\n` alone. */
interface Span {
  readonly text: string
  readonly open: string
}

const lineBreak: Span = { text: "\n", open: "" }

/** The narrowest the report is wrapped to. */
export const minWidth = 20

/** The longest a rule is drawn. */
export const ruleWidth = 40

/** What a quote's lines are drawn behind. */
const quoteBar = "│ "

const named: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
}

/** `text` with its character references decoded: numeric ones, and the common named ones. */
export const decodeReferences = (text: string): string =>
  text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]+);/g, (whole, ref: string) => {
    if (ref.startsWith("#")) {
      const code =
        ref[1] === "x" || ref[1] === "X"
          ? Number.parseInt(ref.slice(2), 16)
          : Number.parseInt(ref.slice(1), 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "�"
    }
    return named[ref] ?? whole
  })

/** Draws Markdown with `theme`'s styles. */
const painter = (theme: Theme) => {
  const open = (a: Attributes): string =>
    (a.bold ? "\x1b[1m" : "") +
    (a.faint ? "\x1b[2m" : "") +
    (a.italic ? "\x1b[3m" : "") +
    (a.strike ? "\x1b[9m" : "") +
    (a.colour === null ? "" : theme.ansi(a.colour, "fg"))

  const paint = (text: string, a: Attributes): string => {
    const start = open(a)
    return start === "" ? text : `${start}${text}\x1b[0m`
  }

  /** Text as one line of a paragraph: soft line breaks are spaces. */
  const words = (text: string, a: Attributes): ReadonlyArray<Span> => {
    const shown = sanitizeLine(text.replace(/\n/g, " "))
    return shown === "" ? [] : [{ text: shown, open: open(a) }]
  }

  const inline = (tokens: ReadonlyArray<Token>, a: Attributes): ReadonlyArray<Span> =>
    tokens.flatMap((token) => inlineToken(token, a))

  const inlineToken = (token: Token, a: Attributes): ReadonlyArray<Span> => {
    switch (token.type) {
      case "text": {
        const t = token as Tokens.Text
        return t.tokens !== undefined ? inline(t.tokens, a) : words(decodeReferences(t.text), a)
      }
      case "escape":
        return words((token as Tokens.Escape).text, a)
      case "strong":
        return inline((token as Tokens.Strong).tokens, { ...a, bold: true })
      case "em":
        return inline((token as Tokens.Em).tokens, { ...a, italic: true })
      case "del":
        return inline((token as Tokens.Del).tokens, { ...a, strike: true })
      case "codespan":
        return words((token as Tokens.Codespan).text, { ...a, colour: "code" })
      case "br":
        return [lineBreak]
      case "link":
      case "image": {
        const link = token as Tokens.Link | Tokens.Image
        const text =
          link.type === "image" ? words(decodeReferences(link.text), { ...a, colour: "link" }) : []
        const label = link.type === "link" ? inline(link.tokens, { ...a, colour: "link" }) : text
        const href = decodeReferences(link.href)
        const shown = label.map((span) => span.text).join("")
        return href === "" || href === shown || href === `mailto:${shown}`
          ? label
          : [...label, ...words(" ", a), ...words(href, { ...plain, faint: true })]
      }
      case "checkbox":
        return words((token as Tokens.Checkbox).checked ? "[x] " : "[ ] ", a)
      case "html":
        return words((token as Tokens.HTML).text, a)
    }
    const other = token as { readonly text?: string; readonly raw: string }
    return words(other.text ?? other.raw, a)
  }

  /** The blocks of `tokens`, each as its lines `width` columns wide, with blank lines between. */
  const blocks = (
    tokens: ReadonlyArray<Token>,
    width: number,
    a: Attributes,
    tight = false,
  ): Array<string> => {
    const out: Array<string> = []
    for (const token of tokens) {
      const lines = block(token, width, a)
      if (lines.length === 0) continue
      if (out.length > 0 && !tight) out.push("")
      out.push(...lines)
    }
    return out
  }

  const block = (token: Token, width: number, a: Attributes): ReadonlyArray<string> => {
    switch (token.type) {
      case "space":
      case "def":
        return []
      case "heading": {
        const h = token as Tokens.Heading
        const colour: Role = h.depth === 1 ? "heading1" : h.depth === 2 ? "heading2" : "heading3"
        return wrap(inline(h.tokens, { ...a, bold: true, colour }), width)
      }
      case "paragraph":
        return wrap(inline((token as Tokens.Paragraph).tokens, a), width)
      case "text": {
        const t = token as Tokens.Text
        return wrap(t.tokens !== undefined ? inline(t.tokens, a) : words(t.text, a), width)
      }
      case "list":
        return list(token as Tokens.List, width, a)
      case "blockquote": {
        const inner = blocks((token as Tokens.Blockquote).tokens, width - quoteBar.length, {
          ...a,
          faint: true,
          italic: true,
        })
        const faint = { ...plain, faint: true }
        const bar = paint(quoteBar, faint)
        const blank = paint(quoteBar.trimEnd(), faint)
        return inner.map((line) => (line === "" ? blank : bar + line))
      }
      case "code":
        return codeLines((token as Tokens.Code).text).map(
          (line) => `  ${paint(line, { ...a, colour: "code" })}`,
        )
      case "hr":
        return [paint("─".repeat(Math.min(width, ruleWidth)), { ...plain, faint: true })]
      case "table":
        return table(token as Tokens.Table, a)
      case "html":
        return codeLines((token as Tokens.HTML).text.replace(/\n+$/, "")).map((line) =>
          paint(line, a),
        )
    }
    const other = token as { readonly text?: string; readonly raw: string }
    return wrap(words(other.text ?? other.raw, a), width)
  }

  /** A list's items, each after its bullet or number, its other lines indented under its text. */
  const list = (l: Tokens.List, width: number, a: Attributes): ReadonlyArray<string> => {
    const start = typeof l.start === "number" ? l.start : 1
    const markers = l.items.map((_, i) => (l.ordered ? `${start + i}.` : "•"))
    const lead = Math.max(...markers.map((m) => Bun.stringWidth(m))) + 1
    const out: Array<string> = []
    l.items.forEach((item, i) => {
      if (i > 0 && l.loose) out.push("")
      const marker = markers[i] as string
      const lines = blocks(item.tokens, width - lead, a, !item.loose)
      const first = `${marker}${" ".repeat(lead - Bun.stringWidth(marker))}`
      lines.forEach((line, n) => {
        out.push(line === "" ? "" : `${n === 0 ? first : " ".repeat(lead)}${line}`)
      })
      if (lines.length === 0) out.push(first.trimEnd())
    })
    return out
  }

  /** A table's rows, its cells in columns as wide as their widest, its header bold. */
  const table = (t: Tokens.Table, a: Attributes): ReadonlyArray<string> => {
    const cell = (c: Tokens.TableCell, header: boolean) =>
      inline(c.tokens, header ? { ...a, bold: true } : a)
    const rows = [
      t.header.map((c) => cell(c, true)),
      ...t.rows.map((r) => r.map((c) => cell(c, false))),
    ]
    const widthOf = (spans: ReadonlyArray<Span>) =>
      Bun.stringWidth(spans.map((span) => span.text).join(""))
    const columns = t.header.map((_, i) => Math.max(...rows.map((r) => widthOf(r[i] ?? []))))
    const separator = paint(" │ ", { ...plain, faint: true })
    const line = (r: ReadonlyArray<ReadonlyArray<Span>>) =>
      columns
        .map((w, i) => {
          const spans = r[i] ?? []
          return draw(spans) + " ".repeat(w - widthOf(spans))
        })
        .join(separator)
        .trimEnd()
    const rule = paint(columns.map((w) => "─".repeat(w)).join("─┼─"), { ...plain, faint: true })
    return [line(rows[0] ?? []), rule, ...rows.slice(1).map(line)]
  }

  return { blocks }
}

/** A code block's lines: sanitised, its tabs four spaces. */
const codeLines = (text: string): ReadonlyArray<string> =>
  text.split("\n").map((line) => sanitizeLine(line.replace(/\t/g, "    ")))

/** `spans` drawn, each run of one style opened and reset after it. */
const draw = (spans: ReadonlyArray<Span>): string => {
  let out = ""
  let run = ""
  let style = ""
  const flush = () => {
    if (run !== "") out += style === "" ? run : `${style}${run}\x1b[0m`
    run = ""
  }
  for (const span of spans) {
    if (span.open !== style) {
      flush()
      style = span.open
    }
    run += span.text
  }
  flush()
  return out
}

/** A character and its style. */
interface Cell {
  readonly char: string
  readonly open: string
}

/**
 * `spans` word-wrapped to `width` columns: words break at spaces, a word wider than a line is cut,
 * and every line opens its own styles, so a style carries over a line it wraps onto.
 */
export const wrap = (spans: ReadonlyArray<Span>, width: number): Array<string> => {
  const room = Math.max(width, 1)
  const out: Array<string> = []
  let paragraph: Array<Array<Cell>> = []
  let word: Array<Cell> = []
  const endWord = () => {
    if (word.length > 0) paragraph.push(word)
    word = []
  }
  const endParagraph = () => {
    endWord()
    out.push(...fill(paragraph, room))
    paragraph = []
  }
  for (const span of spans) {
    if (span === lineBreak) {
      endParagraph()
      continue
    }
    for (const char of span.text) {
      if (char === " ") endWord()
      else word.push({ char, open: span.open })
    }
  }
  endParagraph()
  return out
}

const widthOfCells = (cells: ReadonlyArray<Cell>): number =>
  Bun.stringWidth(cells.map((cell) => cell.char).join(""))

/** Lines of at most `room` columns holding `words`, a space between each two on a line. */
const fill = (words: ReadonlyArray<ReadonlyArray<Cell>>, room: number): Array<string> => {
  const lines: Array<Array<Cell>> = []
  let line: Array<Cell> = []
  let used = 0
  // A space between two words of one style takes that style, so their run isn't broken.
  const space = (before: Cell | undefined, after: Cell | undefined): Cell => ({
    char: " ",
    open: before !== undefined && before.open === after?.open ? before.open : "",
  })
  for (const word of words) {
    const w = widthOfCells(word)
    if (used > 0 && used + 1 + w <= room) {
      line.push(space(line.at(-1), word[0]), ...word)
      used += 1 + w
      continue
    }
    if (used > 0) lines.push(line)
    line = []
    used = 0
    for (const cell of word) {
      const c = Bun.stringWidth(cell.char)
      if (used > 0 && used + c > room) {
        lines.push(line)
        line = []
        used = 0
      }
      line.push(cell)
      used += c
    }
  }
  if (line.length > 0 || lines.length === 0) lines.push(line)
  return lines.map((cells) => draw(cells.map((cell) => ({ text: cell.char, open: cell.open }))))
}

/**
 * `markdown` rendered for a terminal `width` columns wide (`minWidth` at the least), in `theme`'s
 * styles: its lines, with a blank line between blocks and none between a tight list's items.
 * The text is sanitised (§ 7.10).
 */
export const renderMarkdown = (markdown: string, theme: Theme, width: number): string => {
  const text = sanitize(markdown)
  let tokens: ReadonlyArray<Token>
  try {
    tokens = lexer(text)
  } catch {
    return text
  }
  return painter(theme).blocks(tokens, Math.max(width, minWidth), plain).join("\n")
}

/** Prints the run report after a blank line, rendered for a terminal `width` columns wide. */
export const printReport = (
  printer: Printer,
  markdown: string,
  theme: Theme,
  width: number,
): Effect.Effect<void> => printer.print(`\n${renderMarkdown(markdown, theme, width)}`)
