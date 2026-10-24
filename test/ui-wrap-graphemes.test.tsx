// The one wrap and cut every view takes (src/ui/line.tsx): they split text between graphemes, so a
// flag or an emoji joined by ZWJ is never broken, and a tab is spaces before anything is measured,
// so that a tab in a panel's text keeps the frame's right border where it is.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import { renderMarkdown } from "../src/print/markdown.ts"
import { boxed, cut, fit, type Segments, seg, tabWidth, widthOf, wrap } from "../src/ui/line.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { PanelBox, panelParts } from "../src/ui/worker/Panel.tsx"
import { renderFrame } from "./render.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

/** Graphemes a split would break: a flag, a family joined by ZWJ, an accent that combines. */
const joined = ["🇺🇸", "👨‍👩‍👧", "🏳️‍🌈", "é"]

/** Random text of words, spaces, tabs, wide characters and the graphemes above. */
const text = fc.string({
  unit: fc.constantFrom("a", "bc", " ", "\t", "界", "-", ...joined),
  maxLength: 40,
})

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** The graphemes of `line`'s text. */
const graphemesOf = (line: Segments): ReadonlyArray<string> =>
  [...graphemes.segment(line.map((each) => each.text).join(""))].map((each) => each.segment)

/** Whether every grapheme of `line` is whole: one the text was made of, a space or `…`. */
const whole = (line: Segments): boolean =>
  graphemesOf(line).every((each) => ["a", "b", "c", " ", "界", "-", "…", ...joined].includes(each))

const textOf = (line: Segments): string => line.map((each) => each.text).join("")

describe("wrap", () => {
  test("never splits a grapheme, fits the width, and draws a tab as spaces", () => {
    fc.assert(
      fc.property(
        fc.array(text, { maxLength: 4 }),
        fc.integer({ min: 2, max: 30 }),
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 0, max: 10 }),
        fc.constantFrom("edge" as const, "line" as const),
        (texts, width, indent, start, long) => {
          const lines = wrap(
            texts.map((each) => seg(each)),
            width,
            { indent, start: Math.min(start, width), long },
          )
          lines.forEach((line, i) => {
            expect(whole(line)).toBe(true)
            expect(textOf(line)).not.toContain("\t")
            expect(widthOf(line) + (i === 0 ? Math.min(start, width) : 0)).toBeLessThanOrEqual(
              width,
            )
          })
        },
      ),
    )
  })

  test("keeps every grapheme but the spaces, in order", () => {
    fc.assert(
      fc.property(text, fc.integer({ min: 2, max: 30 }), (each, width) => {
        const lines = wrap([seg(each)], width, { indent: 1 })
        const kept = lines.flatMap(graphemesOf).filter((g) => g !== " ")
        const given = [...graphemes.segment(each)]
          .map((g) => g.segment)
          .filter((g) => g !== " " && g !== "\t")
        expect(kept).toEqual(given)
      }),
    )
  })

  test("a tab is tabWidth columns, and wraps as spaces do", () => {
    expect(wrap([seg("a\tb")], 20).map(textOf)).toEqual([`a${" ".repeat(tabWidth)}b`])
    expect(wrap([seg("aaaa\tbbbb")], 6).map(textOf)).toEqual(["aaaa", "bbbb"])
  })

  test("a flag that doesn't fit the line goes onto the next whole", () => {
    expect(wrap([seg("🇺🇸🇺🇸🇺🇸")], 5).map(textOf)).toEqual(["🇺🇸🇺🇸", "🇺🇸"])
    expect(wrap([seg("x👨‍👩‍👧👨‍👩‍👧")], 4).map(textOf)).toEqual(["x👨‍👩‍👧", "👨‍👩‍👧"])
  })
})

describe("a word longer than a line", () => {
  test("as prose, a word that fits a line is never broken, the spaces before it giving way", () => {
    expect(wrap([seg("  abcdefgh")], 9, { indent: 4, long: "line" }).map(textOf)).toEqual([
      "abcdefgh",
    ])
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z界]{1,8}$/), { maxLength: 12 }),
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 20, max: 40 }),
        (words, lead, width) => {
          const lines = wrap([seg(" ".repeat(lead) + words.join(" "))], width, {
            indent: 4,
            long: "line",
          })
          expect(lines.flatMap((line) => textOf(line).split(" ")).filter(Boolean)).toEqual(words)
        },
      ),
    )
  })

  test("is broken at the line's edge, or starts a line of its own", () => {
    expect(wrap([seg("ab abcdefghij")], 6).map(textOf)).toEqual(["ab abc", "defghi", "j"])
    expect(wrap([seg("ab abcdefghij")], 6, { long: "line" }).map(textOf)).toEqual([
      "ab",
      "abcdef",
      "ghij",
    ])
  })
})

describe("cut", () => {
  test("never splits a grapheme, fits the width, and draws a tab as spaces", () => {
    fc.assert(
      fc.property(fc.array(text, { maxLength: 4 }), fc.integer({ min: 0, max: 30 }), (texts, w) => {
        const line = cut(
          texts.map((each) => seg(each)),
          w,
        )
        expect(whole(line)).toBe(true)
        expect(textOf(line)).not.toContain("\t")
        expect(widthOf(line)).toBeLessThanOrEqual(w)
      }),
    )
  })

  test("cuts before a flag rather than through it", () => {
    expect(textOf(cut([seg("ab🇺🇸cd")], 4))).toBe("ab…")
    expect(textOf(cut([seg("ab🇺🇸cd")], 5))).toBe("ab🇺🇸…")
  })

  test("the dashboard's fit cuts before a flag too", () => {
    expect(fit("a🇺🇸🇺🇸🇺🇸cd", 3)).toBe("a…")
    expect(fit("a🇺🇸🇺🇸🇺🇸cd", 5)).toBe("a🇺🇸…")
    expect(fit("a🇺🇸", 3)).toBe("a🇺🇸")
  })

  test("a tab counts as tabWidth columns", () => {
    expect(widthOf([seg("\t")])).toBe(tabWidth)
    expect(textOf(cut([seg("a\tb")], 20))).toBe(`a${" ".repeat(tabWidth)}b`)
  })
})

describe("a frame around text with tabs", () => {
  test("every line of a box is as wide as the box", () => {
    fc.assert(
      fc.property(fc.array(text, { maxLength: 5 }), fc.integer({ min: 6, max: 40 }), (texts, w) => {
        const lines = boxed(
          texts.map((each) => [seg(each)]),
          w,
          theme.look("frame"),
        )
        for (const line of lines) {
          expect(widthOf(line)).toBe(w)
          expect(textOf(line)).not.toContain("\t")
        }
      }),
    )
  })

  const request: AttentionRequest = {
    id: "r1",
    ticket: "t-1",
    kind: {
      _tag: "Question",
      questions: [
        {
          question: "Which\tone?",
          options: [{ label: "a" }, { label: "b" }],
          multiSelect: false,
        },
      ],
      input: {},
    },
    displayName: "AskUserQuestion",
    description: "Pick\t\tone\tof them",
    decisionReason: "col\tcol\tcol",
    defaultToNo: false,
    suppressAlwaysAllowRule: false,
    createdAt: 0,
  }

  test("a tab in a panel's text keeps the frame's right border in place", async () => {
    const width = 40
    const parts = panelParts(request, theme, { width, selected: false, focus: 0 })
    const height = parts.head.length + parts.input.length + parts.foot.length
    const frame = await renderFrame(
      <PanelBox parts={parts} room={parts.input.length} press={() => {}} />,
      { width, height },
    )
    const lines = frame.chars.split("\n").filter((line) => line.trim() !== "")
    expect(lines.length).toBe(height)
    for (const line of lines.slice(1, -1)) {
      expect(line.startsWith("│")).toBe(true)
      expect(line.trimEnd().endsWith("│")).toBe(true)
      expect(Bun.stringWidth(line.trimEnd())).toBe(width)
    }
    expect(frame.chars).toContain("col    col    col")
  })
})

describe("the report's Markdown", () => {
  test("wraps between graphemes, a tab as a space, within the width", () => {
    fc.assert(
      fc.property(
        fc.array(text, { minLength: 1, maxLength: 4 }),
        fc.integer({ min: 20, max: 60 }),
        (texts, w) => {
          const out = renderMarkdown(texts.join(" ").replace(/^[\s-]+/, "a"), theme, w)
          // biome-ignore lint/suspicious/noControlCharactersInRegex: the ANSI styles are taken off
          const plain = out.replace(/\x1b\[[0-9;]*m/g, "")
          for (const line of plain.split("\n")) {
            expect(Bun.stringWidth(line)).toBeLessThanOrEqual(w)
            expect(line).not.toContain("\t")
            expect(whole([seg(line)])).toBe(true)
          }
        },
      ),
    )
  })
})
