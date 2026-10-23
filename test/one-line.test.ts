// oneLine, the one cut of text to a line of a given width: a notice's, the summary's cells', and
// the text the reviewer and the triage organ read.

import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { oneLine } from "../src/ui/oneLine.ts"

describe("oneLine", () => {
  test("puts text on one line, its runs of white space one space", () => {
    expect(oneLine("  a\n\tb   c \r\n", 20)).toBe("a b c")
  })

  test("cuts with … to the width, dropping a space before it", () => {
    expect(oneLine("abcdef", 6)).toBe("abcdef")
    expect(oneLine("abcdefg", 6)).toBe("abcde…")
    expect(oneLine("abcd efgh", 6)).toBe("abcd…")
    expect(oneLine("abc", 0)).toBe("")
  })

  test("counts a wide character as two columns, and never splits a grapheme", () => {
    expect(oneLine("日本語のテキスト", 7)).toBe("日本語…")
    expect(oneLine("ab👩‍👩‍👧cd", 4)).toBe("ab…")
  })

  test("keeps to the width in characters too: marks that take no column don't pass it", () => {
    const marks = `a${"́".repeat(100)}b`
    expect([...oneLine(marks, 10)].length).toBeLessThanOrEqual(10)
  })

  test("any text fits its width in columns and in characters", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), fc.integer({ min: 1, max: 50 }), (s, n) => {
        const one = oneLine(s, n)
        expect(one).not.toMatch(/\s{2}|[\n\r\t]/)
        expect([...one].length).toBeLessThanOrEqual(n)
        expect(Bun.stringWidth(one)).toBeLessThanOrEqual(n)
      }),
    )
  })
})
