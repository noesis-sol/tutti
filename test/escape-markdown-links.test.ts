import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { lexer, type Token } from "marked"
import { escapeMarkdown } from "../src/ui/sanitize.ts"

// inline is the inline tokens Markdown reads in one line of text, as a paragraph.
const inline = (line: string): ReadonlyArray<Token> => {
  const [paragraph] = lexer(line)
  return (paragraph as { tokens?: ReadonlyArray<Token> } | undefined)?.tokens ?? []
}

const plain = (tokens: ReadonlyArray<Token>): boolean =>
  tokens.every((token) => token.type === "text" || token.type === "escape")

// Text made of the pieces of the links GFM finds in bare text: email addresses, mailto: and xmpp:
// addresses, and http://, https://, ftp:// and www. addresses, in any case.
const bareLinkish = fc.string({
  unit: fc.constantFrom(
    ...["@", ".", ":", "//", "/", "-", "_", "+", " ", "a", "0", "x.y", "a@b.c"],
    ...["www.", "WwW.", "http://", "HTTPS://", "ftp://", "mailto:", "xmpp:"],
  ),
})

describe("escapeMarkdown and the links GFM finds in bare text", () => {
  test.each([
    [".@0.0", ".\\@0.0"],
    ["mail me at a@b.c", "mail me at a\\@b.c"],
    ["see www.example.com", "see www\\.example.com"],
    ["https://x.y and FTP://x.y", "https\\://x.y and FTP\\://x.y"],
    ["mailto:a@b.c", "mailto:a\\@b.c"],
  ])("escapes %j", (text, want) => {
    expect(escapeMarkdown(text)).toBe(want)
    expect(plain(inline(escapeMarkdown(text)))).toBe(true)
  })

  test("leaves no bare link in any text made of their pieces", () => {
    fc.assert(
      fc.property(bareLinkish, (text) => {
        const line = text.trim()
        fc.pre(line !== "")
        expect(plain(inline(escapeMarkdown(line)))).toBe(true)
      }),
    )
  })
})
