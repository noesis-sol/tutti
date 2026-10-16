import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { escapeMarkdown, sanitize, sanitizeLine } from "../src/ui/sanitize.ts"

// unsafe is whether text holds what no sanitised text may: a C0 control but newline and tab, DEL, a
// C1 control, a bidi override or isolate, or a lone surrogate.
const unsafe = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    const low = (at: number) => text.charCodeAt(at) >= 0xdc00 && text.charCodeAt(at) <= 0xdfff
    if (c >= 0xd800 && c <= 0xdbff) {
      if (!low(i + 1)) return true
      i++
    } else if (
      (c < 0x20 && c !== 0x0a && c !== 0x09) ||
      (c >= 0x7f && c <= 0x9f) ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069) ||
      low(i)
    ) {
      return true
    }
  }
  return false
}

const char = (low: number, high: number) =>
  fc.integer({ min: low, max: high }).map((c) => String.fromCodePoint(c))

// Printable text: ASCII, accented and Greek letters, CJK, emoji (with ZWJ sequences and skin
// tones), combining marks, newlines and tabs.
const printable = fc.string({
  unit: fc.oneof(
    char(0x20, 0x7e),
    char(0xc0, 0x24f),
    char(0x391, 0x3c9),
    char(0x4e00, 0x9fff),
    char(0xac00, 0xd7a3),
    char(0x1f300, 0x1faff),
    char(0x300, 0x36f),
    fc.constantFrom("\n", "\t", "👩‍👩‍👧", "👍🏽", "🇬🇷", "e\u0301", "\u200d"),
  ),
})

// Text that is mostly the pieces of control sequences, to find the ones a sanitiser gets wrong.
const hostile = fc.string({
  unit: fc.oneof(
    fc.constantFrom(
      ...["\x1b", "[", "]", "P", "X", "^", "_", "\\", "(", "B", "7", "?", ";", "0", "52", "m", "J"],
      ...["\x07", "\x9b", "\x9c", "\x9d", "\x90", "\r", "\n", "\t", "\x00", "\x7f", "\u202e"],
      ...["\u2067", "\ud83d", "\ude00", "a", " ", "é"],
    ),
    char(0, 0xa0),
  ),
})

// Any string of UTF-16 code units, lone surrogates included.
const anything = fc.oneof(
  fc.string({ unit: "binary" }),
  fc.string({ unit: fc.integer({ min: 0, max: 0xffff }).map((c) => String.fromCharCode(c)) }),
  hostile,
)

// Escape-free text to put around and inside an escape sequence.
const plain = fc.string({ unit: fc.oneof(char(0x20, 0x7e), char(0x4e00, 0x9fff)) })

// Carried over from orchestra v0.7.7's control_sequences_test.go: text a prompt-injected worker
// could put in a title, a clipboard write (OSC 52), a cleared screen (CSI 2J) and a window title
// (OSC 0), with other control characters.
const attacks: Record<string, string> = {
  "OSC 52": "Fix \x1b]52;c;cm0gLXJmIH4K\x07it",
  "CSI 2J": "Fix \x1b[2J\x1b[Hit\b\x00",
  "OSC 0": "Fix \x1b]0;pwned\x1b\\it\x9b\u009b",
}

describe("sanitize", () => {
  for (const [name, text] of Object.entries(attacks)) {
    test(`drops ${name}, keeping the title's words`, () => {
      expect(sanitize(text)).toBe("Fix it")
      expect(sanitizeLine(text)).toBe("Fix it")
    })
  }

  // orchestra's TestPrintableKeepsLayout, with a lone surrogate for its byte that isn't UTF-8.
  test.each([
    ["a\nb\tc", "a\nb\tc"],
    ["a\r\nb\rc", "a\nb\nc"],
    ["a\ud800b", "ab"],
    ["\x1b[31mred\x1b[0m", "red"],
    ["naïve ☃", "naïve ☃"],
  ])("keeps the layout of %j", (text, want) => {
    expect(sanitize(text)).toBe(want)
  })

  test.each([
    ["a CSI with parameters and intermediates", "a\x1b[?25;1 qb", "ab"],
    ["a CSI cut short by the end", "a\x1b[12;3", "a"],
    ["a CSI cut short by a character", "a\x1b[12\nb", "a\nb"],
    ["an OSC ended by ST", "a\x1b]8;;https://x\x1b\\b", "ab"],
    ["an OSC ended by a C1 ST", "a\x1b]2;t\x9cb", "ab"],
    ["an OSC cancelled by CAN or SUB", "a\x1b]0;t\x18b\x1b]2;u\x1ac", "abc"],
    ["an OSC cut short", "a\x1b]52;c;cm0g", "a"],
    ["an OSC cut short by another escape", "a\x1b]0;t\x1b[2Jb", "ab"],
    ["a DCS", "a\x1bPq#0;2;0;0;0\x1b\\b", "ab"],
    ["an SOS, PM and APC", "a\x1bXs\x1b\\\x1b^p\x07\x1b_a\x1b\\b", "ab"],
    ["two-character escapes", "a\x1b7\x1bc\x1b(Bb", "ab"],
    ["an ESC at the end", "ab\x1b", "ab"],
    ["an ESC before a character no escape takes", "a\x1b\u00e9b", "aéb"],
    ["C1 controls", "a\x85\x9b31mb", "a31mb"],
    ["bidi overrides and isolates", "a\u202ecba\u202c\u2066b\u2069", "acbab"],
    ["DEL and C0 controls", "a\x7f\x01\x0b\x0cb", "ab"],
  ])("removes %s", (_, text, want) => {
    expect(sanitize(text)).toBe(want)
  })

  test("leaves no C0 or C1 control, ESC, bidi control or lone surrogate in any text", () => {
    fc.assert(fc.property(anything, (text) => !unsafe(sanitize(text))))
  })

  test("removes an ESC sequence whole", () => {
    const csi = fc
      .tuple(
        fc.string({ unit: char(0x30, 0x3f) }),
        fc.string({ unit: char(0x20, 0x2f) }),
        char(0x40, 0x7e),
      )
      .map(([params, intermediates, final]) => `\x1b[${params}${intermediates}${final}`)
    const stringEscape = fc
      .tuple(
        fc.constantFrom("]", "P", "X", "^", "_"),
        plain,
        fc.constantFrom("\x07", "\x1b\\", "\x9c"),
      )
      .map(([intro, body, end]) => `\x1b${intro}${body}${end}`)
    const twoCharacter = fc
      .tuple(fc.string({ unit: char(0x20, 0x2f) }), char(0x30, 0x7e))
      .filter(([, final]) => final !== "[" && !"]PX^_".includes(final))
      .map(([intermediates, final]) => `\x1b${intermediates}${final}`)
    fc.assert(
      fc.property(plain, fc.oneof(csi, stringEscape, twoCharacter), plain, (a, sequence, b) => {
        expect(sanitize(a + sequence + b)).toBe(a + b)
      }),
    )
  })

  test("keeps printable text unchanged", () => {
    fc.assert(fc.property(printable, (text) => sanitize(text) === text))
  })

  test("is idempotent", () => {
    fc.assert(fc.property(anything, (text) => sanitize(sanitize(text)) === sanitize(text)))
  })
})

describe("sanitizeLine", () => {
  test("turns tabs and newlines into spaces", () => {
    expect(sanitizeLine("a\tb\nc\r\nd\re")).toBe("a b c d e")
  })

  test("leaves one line with no control in any text", () => {
    fc.assert(fc.property(anything, (text) => !/[\t\n]/.test(sanitizeLine(text))))
    fc.assert(fc.property(anything, (text) => !unsafe(sanitizeLine(text))))
  })

  test("is sanitize with spaces for tabs and newlines", () => {
    fc.assert(
      fc.property(
        anything,
        (text) => sanitizeLine(text) === sanitize(text).replace(/[\t\n]/g, " "),
      ),
    )
  })

  test("keeps printable text on one line unchanged", () => {
    const line = printable.map((text) => text.replace(/[\t\n]/g, ""))
    fc.assert(fc.property(line, (text) => sanitizeLine(text) === text))
  })

  test("is idempotent", () => {
    fc.assert(
      fc.property(anything, (text) => sanitizeLine(sanitizeLine(text)) === sanitizeLine(text)),
    )
  })
})

// unescapeMarkdown undoes Markdown's backslash escapes, as a Markdown renderer does.
const unescapeMarkdown = (markdown: string): string =>
  markdown.replace(/\\([!-/:-@[-`{-~])/g, (_, c: string) => c)

// literal is whether markdown has no character Markdown would act on: none of \ ` * _ ~ [ ] < > & |
// anywhere, and none of # > + = - or a number with . or ) at a line's start, unless escaped.
const literal = (markdown: string): boolean => {
  for (const line of markdown.split(/\r\n|\r|\n/)) {
    if (/^[ \t]*([#>+=-]|\d+[.)])/.test(line)) return false
    for (let i = 0; i < line.length; i++) {
      if (line[i] === "\\") i++
      else if ("\\`*_~[]<>&|".includes(line[i] ?? "")) return false
    }
  }
  return true
}

describe("escapeMarkdown", () => {
  test.each([
    ["# Heading", "\\# Heading"],
    ["  > quote", "  \\> quote"],
    ["- item\n+ item\n12. item\n3) item", "\\- item\n\\+ item\n12\\. item\n3\\) item"],
    ["title\n===", "title\n\\==="],
    ["*bold* _it_ ~~gone~~ `code`", "\\*bold\\* \\_it\\_ \\~\\~gone\\~\\~ \\`code\\`"],
    ["[link](https://x) ![img](y)", "\\[link\\](https://x) !\\[img\\](y)"],
    ["<b>html</b> &amp; a|b", "\\<b\\>html\\</b\\> \\&amp; a\\|b"],
    ["C:\\path", "C:\\\\path"],
    ["tutti-nrg.2.2 is 1.5 - 2", "tutti-nrg.2.2 is 1.5 - 2"],
  ])("escapes %j", (text, want) => {
    expect(escapeMarkdown(text)).toBe(want)
  })

  test("makes every Markdown control character literal", () => {
    fc.assert(fc.property(anything, (text) => literal(escapeMarkdown(text))))
  })

  test("keeps the text, read as Markdown", () => {
    fc.assert(fc.property(anything, (text) => unescapeMarkdown(escapeMarkdown(text)) === text))
  })
})
