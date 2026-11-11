// Untrusted text made safe to show (§ 7.10). Text from tickets, models, tool inputs and outputs,
// check output, MCP server names and `bd` output can hold what a terminal acts on rather than shows:
// an escape sequence that writes the clipboard, clears the screen or sets the window title, or a
// bidi override that shows text in another order than it is read. It is sanitised once, where it
// enters RunView, the transcript view, the log, notifications or plain output.

const BEL = 0x07
const TAB = 0x09
const LF = 0x0a
const CR = 0x0d
const CAN = 0x18
const SUB = 0x1a
const ESC = 0x1b
const ST = 0x9c // the C1 string terminator

const within = (c: number, low: number, high: number): boolean => c >= low && c <= high

// removed: C0 controls but newline and tab, DEL, C1 controls, and the bidi overrides and isolates.
const removed = (c: number): boolean =>
  (c < 0x20 && c !== LF && c !== TAB) ||
  within(c, 0x7f, 0x9f) ||
  within(c, 0x202a, 0x202e) ||
  within(c, 0x2066, 0x2069)

// The introducers of the escapes that carry a string: OSC (]), DCS (P), SOS (X), PM (^), APC (_).
const stringIntroducers = new Set([0x5d, 0x50, 0x58, 0x5e, 0x5f])

// escapeEnd is the index just past the escape sequence that starts with the ESC at start in text.
// A sequence cut short, by the end of the text or by a character that can't be in it, ends there.
const escapeEnd = (text: string, start: number): number => {
  let i = start + 1
  const at = (): number => (i < text.length ? text.charCodeAt(i) : -1)
  if (at() === 0x5b) {
    // CSI: parameter bytes, intermediate bytes, a final byte.
    i++
    while (within(at(), 0x30, 0x3f)) i++
    while (within(at(), 0x20, 0x2f)) i++
    if (within(at(), 0x40, 0x7e)) i++
    return i
  }
  if (stringIntroducers.has(at())) {
    // The string ends at BEL, at ST (ESC \ or U+009C), at CAN or SUB, which cancel it, or at an ESC
    // that starts another sequence.
    for (i++; i < text.length; i++) {
      const c = at()
      if (c === BEL || c === ST || c === CAN || c === SUB) return i + 1
      if (c === ESC) return text.charCodeAt(i + 1) === 0x5c ? i + 2 : i
    }
    return i
  }
  // A two-character escape such as ESC 7 or ESC c, with intermediate bytes as in ESC ( B.
  while (within(at(), 0x20, 0x2f)) i++
  if (within(at(), 0x30, 0x7e)) i++
  return i
}

const highSurrogate = (c: number): boolean => within(c, 0xd800, 0xdbff)
const lowSurrogate = (c: number): boolean => within(c, 0xdc00, 0xdfff)

// sanitize is text without its C0 controls but newline and tab, its C1 controls, its ESC sequences
// (whole, even when cut short), its bidi overrides and isolates, and its lone surrogates. A carriage
// return becomes a newline, as in orchestra, so that it can't take a printed line back to its start.
export const sanitize = (text: string): string => {
  let out = ""
  let i = 0
  while (i < text.length) {
    const c = text.charCodeAt(i)
    if (c === ESC) {
      i = escapeEnd(text, i)
    } else if (c === CR) {
      out += "\n"
      i += text.charCodeAt(i + 1) === LF ? 2 : 1
    } else if (highSurrogate(c)) {
      if (lowSurrogate(text.charCodeAt(i + 1))) out += text.slice(i, i + 2)
      i += lowSurrogate(text.charCodeAt(i + 1)) ? 2 : 1
    } else {
      if (!removed(c) && !lowSurrogate(c)) out += text[i]
      i++
    }
  }
  return out
}

// sanitizeLine is sanitize for single-line contexts: tabs and newlines become spaces.
export const sanitizeLine = (text: string): string => sanitize(text).replace(/[\t\n]/g, " ")

// Characters that mean something in Markdown anywhere on a line: escapes, code, emphasis,
// strikethrough, links and images (whose ! and parentheses mean nothing without the brackets),
// HTML, autolinks, entities, table cells and the @ of an email address, which GFM links bare.
const inlineSpecial = /[\\`*_~[\]<>&|@]/g

// What starts a link GFM finds in bare text: the : of http://, https:// or ftp:// and the . of www.
const bareLink = /(?<=https?|ftp)(?=:\/\/)|(?<=www)(?=\.)/gi

// The start of a line with text on it: its indentation, which would make the line code, where
// escapes are shown rather than read, and what starts a heading, a block quote, a list item or a
// setext underline.
const lineStart = /^([ \t]*)(?=[^ \t\n\r])([#>+=-]|\d+[.)])?/gm

// escapeMarkdown is text that Markdown shows as it is: each character Markdown would act on is
// escaped with a backslash, and a line's indentation is written as character references, which
// Markdown shows as spaces and tabs but doesn't read as indentation. It escapes only; sanitise the
// text as well where it is shown.
export const escapeMarkdown = (text: string): string =>
  text
    .replace(inlineSpecial, "\\$&")
    .replace(bareLink, "\\")
    .replace(lineStart, (_, indent: string, marker: string | undefined) => {
      const references = indent.replace(/ /g, "&#32;").replace(/\t/g, "&#9;")
      return marker ? `${references}${marker.slice(0, -1)}\\${marker.slice(-1)}` : references
    })
