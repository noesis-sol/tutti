// Fitting a line by priority (tutti-rvzn.27): firstFit tries a line's forms until one fits, building
// none past it; fitParts steps its parts down by rank until they fit, and cuts the line where none
// can step down any further.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { type FitPart, firstFit, firstFitting, fitParts } from "../src/ui/fit.ts"
import { type Segments, seg, widthOf } from "../src/ui/line.tsx"

/** The text of `segments`. */
const text = (segments: Segments): string => segments.map((each) => each.text).join("")

describe("firstFitting", () => {
  test("gives the first form that fits, the last when none does, undefined with none", () => {
    const short = (word: string) => word.length <= 3
    expect(firstFitting(["three", "two", "one"], short)).toBe("two")
    expect(firstFitting(["three", "seven"], short)).toBe("seven")
    expect(firstFitting([], short)).toBeUndefined()
  })

  test("builds no form past the one that fits", () => {
    const built: Array<string> = []
    const forms = function* () {
      for (const form of ["wide form", "fits", "never built"]) {
        built.push(form)
        yield form
      }
    }
    expect(firstFitting(forms(), (form) => form.length <= 4)).toBe("fits")
    expect(built).toEqual(["wide form", "fits"])
  })
})

describe("firstFit", () => {
  test("gives the first form no wider than the width", () => {
    const forms = [[seg("a long line")], [seg("a line")], [seg("line")]]
    expect(text(firstFit(8, forms))).toBe("a line")
    expect(text(firstFit(20, forms))).toBe("a long line")
  })

  test("cuts the last form where none fits", () => {
    expect(text(firstFit(3, [[seg("a long line")], [seg("line")]]))).toBe("li…")
    expect(firstFit(3, [])).toEqual([])
  })

  test("is never wider than the width", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 20 }), { maxLength: 5 }),
        fc.integer({ min: 0, max: 30 }),
        (forms, width) => {
          expect(
            widthOf(
              firstFit(
                width,
                forms.map((form) => [seg(form)]),
              ),
            ),
          ).toBeLessThanOrEqual(width)
        },
      ),
    )
  })
})

describe("fitParts", () => {
  const gap = [seg(" · ")]
  /** A part in `forms`, each a word, at `rank`. */
  const part = (rank: FitPart["rank"], ...forms: ReadonlyArray<string>): FitPart => ({
    forms: forms.map((form) => (form === "" ? [] : [seg(form)])),
    rank,
  })

  test("keeps every part whole where the line fits", () => {
    const parts = [part(0, "one", ""), part(1, "two", "")]
    expect(text(fitParts(parts, 9, gap))).toBe("one · two")
  })

  test("steps down the part of the lowest rank first", () => {
    const parts = [part(0, "first", "1st", ""), part(1, "second", ""), part(2, "third", "")]
    expect(text(fitParts(parts, 20, gap))).toBe("1st · second · third")
    expect(text(fitParts(parts, 19, gap))).toBe("second · third")
    expect(text(fitParts(parts, 15, gap))).toBe("second · third")
    expect(text(fitParts(parts, 6, gap))).toBe("third")
  })

  test("steps down the last on the line first of those ranked alike", () => {
    const parts = [part(0, "one", ""), part(0, "two", ""), part(0, "three", "")]
    expect(text(fitParts(parts, 9, gap))).toBe("one · two")
    expect(text(fitParts(parts, 3, gap))).toBe("one")
    expect(text(fitParts(parts, 2, gap))).toBe("")
  })

  test("takes a rank a step where a part gives one for each", () => {
    const parts = [part(5, "keep"), part(2, "extra", ""), part([0, 9], "reset 14:05", "reset", "")]
    expect(text(fitParts(parts, 20, gap))).toBe("keep · extra · reset")
    expect(text(fitParts(parts, 12, gap))).toBe("keep · reset")
    expect(text(fitParts(parts, 4, gap))).toBe("keep")
  })

  test("cuts the line where no part can step down", () => {
    const parts = [part(0, "always"), part(0, "there")]
    expect(text(fitParts(parts, 10, gap))).toBe("always · …")
  })

  test("is never wider than the width, and keeps a part that never steps down", () => {
    const partArb = fc.record({
      forms: fc.array(fc.string({ minLength: 1, maxLength: 12 }), { minLength: 1, maxLength: 3 }),
      rank: fc.integer({ min: 0, max: 3 }),
      droppable: fc.boolean(),
    })
    fc.assert(
      fc.property(
        fc.array(partArb, { maxLength: 6 }),
        fc.integer({ min: 0, max: 60 }),
        (arbs, width) => {
          const parts = arbs.map(
            (each): FitPart => ({
              forms: [...each.forms.map((form) => [seg(form)]), ...(each.droppable ? [[]] : [])],
              rank: each.rank,
            }),
          )
          const line = fitParts(parts, width, gap)
          expect(widthOf(line)).toBeLessThanOrEqual(width)
          const whole = fitParts(parts, Number.POSITIVE_INFINITY, gap)
          expect(text(whole)).toBe(arbs.map((each) => each.forms[0]).join(" · "))
        },
      ),
    )
  })
})
