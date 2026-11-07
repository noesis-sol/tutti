// The frames' arithmetic (tutti-6bwa.5): frameInner is what boxed's frame leaves inside, boxWidth
// how wide a box over the screen is, and framedWidth how wide framed draws its columns, so that a
// line of a frame is exactly as wide as they say, and neither width goes below its least.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import {
  boxed,
  boxMargin,
  boxWidth,
  columnGap,
  frameChrome,
  framed,
  framedWidth,
  frameEdge,
  frameInner,
  type Segments,
  seg,
  widthOf,
} from "../src/ui/line.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })
const frame = theme.look("frame")

/** The text of `segments`. */
const text = (segments: Segments): string => segments.map((each) => each.text).join("")

const words = fc.stringMatching(/^[ -~]{0,40}$/)

describe("frameInner", () => {
  test("is the box's width less its sides and their padding, never below its least", () => {
    expect(frameChrome).toBe(4)
    expect(frameInner(30)).toBe(26)
    expect(frameInner(3)).toBe(1)
    expect(frameInner(3, 0)).toBe(0)
    fc.assert(
      fc.property(fc.integer({ min: -10, max: 200 }), fc.nat(10), (width, least) => {
        const inner = frameInner(width, least)
        expect(inner).toBeGreaterThanOrEqual(least)
        expect(inner).toBe(Math.max(width - frameChrome, least))
      }),
    )
  })

  test("is the width of what boxed draws inside its frame", () => {
    fc.assert(
      fc.property(words, fc.integer({ min: frameChrome + 1, max: 80 }), (said, width) => {
        const [, line] = boxed([[seg(said)]], width, frame)
        expect(text(line ?? []).slice(2, -2)).toHaveLength(frameInner(width))
      }),
    )
  })
})

describe("boxWidth", () => {
  test("keeps boxMargin from each side of the screen, up to its max, never below its least", () => {
    expect(boxWidth(100, { max: 60, least: 8 })).toBe(60)
    expect(boxWidth(40, { max: 60, least: 8 })).toBe(40 - 2 * boxMargin)
    expect(boxWidth(6, { max: 60, least: 8 })).toBe(8)
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 300 }),
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 0, max: 200 }),
        (width, least, more) => {
          const max = least + more
          const outer = boxWidth(width, { max, least })
          expect(outer).toBeGreaterThanOrEqual(least)
          expect(outer).toBeLessThanOrEqual(max)
          if (outer > least) expect(outer).toBeLessThanOrEqual(width - 2 * boxMargin)
        },
      ),
    )
  })
})

describe("framedWidth", () => {
  test("sums the columns, each with its gap, and the frame's first side", () => {
    expect(columnGap).toBe(3)
    expect(framedWidth([])).toBe(1)
    expect(framedWidth([5, 7])).toBe(1 + 5 + 3 + 7 + 3)
  })

  test("is the width of every line framed draws", () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat(20), { minLength: 1, maxLength: 5 }),
        fc.array(words, { maxLength: 5 }),
        (widths, cells) => {
          for (const line of framed([cells.map((each) => [seg(each)])], widths, frame)) {
            expect(widthOf(line)).toBe(framedWidth(widths))
          }
        },
      ),
    )
  })
})

describe("frameEdge", () => {
  test("is exactly the frame's width, with a label or without", () => {
    fc.assert(
      fc.property(words, fc.integer({ min: 2, max: 80 }), (label, width) => {
        const shown = label === "" ? [] : [seg(label)]
        expect(widthOf(frameEdge("top", width, frame, "rounded", shown))).toBe(width)
      }),
    )
  })
})
