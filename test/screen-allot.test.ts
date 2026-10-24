// A screen's lines handed out in priority order (tutti-rvzn.27): allot gives each part as many as
// it asks of those left, and stack hands a list of parts theirs, the rest to one of them, so that
// they add up to the pane's height.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { allot, stack } from "../src/ui/allot.ts"

describe("allot", () => {
  test("gives each part what it asks of the lines left", () => {
    const lines = allot(5)
    expect(lines.take(2)).toBe(2)
    expect(lines.rest()).toBe(3)
    expect(lines.take(-1)).toBe(0)
    expect(lines.take(4)).toBe(3)
    expect(lines.take(1)).toBe(0)
    expect(lines.rest()).toBe(0)
  })

  test("has no lines for a pane of none or fewer", () => {
    expect(allot(-3).rest()).toBe(0)
    expect(allot(-3).take(2)).toBe(0)
  })
})

describe("stack", () => {
  test("hands out its parts' lines in order, the rest to the rest's part", () => {
    expect(
      stack(
        10,
        [
          ["hint", 1],
          ["head", 2],
          ["body", 3],
          ["panel", 9],
        ],
        "body",
      ),
    ).toEqual({ hint: 1, head: 2, body: 3, panel: 4 })
    expect(
      stack(
        4,
        [
          ["hint", 1],
          ["body", 0],
        ],
        "body",
      ),
    ).toEqual({ hint: 1, body: 3 })
  })

  test("adds up a part named more than once", () => {
    expect(
      stack(
        6,
        [
          ["rule", 1],
          ["body", 2],
          ["rule", 1],
        ],
        "body",
      ),
    ).toEqual({ rule: 2, body: 4 })
  })

  test("its parts add up to the pane, none more than it asks but the rest's", () => {
    const keys = ["a", "b", "c", "d", "e"] as const
    fc.assert(
      fc.property(
        fc.integer({ min: -5, max: 80 }),
        fc.array(fc.tuple(fc.constantFrom(...keys), fc.integer({ min: -3, max: 30 })), {
          maxLength: 12,
        }),
        fc.constantFrom(...keys),
        (height, wants, rest) => {
          const laid = stack(height, wants, rest)
          const values: ReadonlyArray<number> = Object.values(laid)
          expect(values.every((lines) => lines >= 0)).toBe(true)
          expect(values.reduce((sum, lines) => sum + lines, 0)).toBe(Math.max(height, 0))
          for (const key of keys) {
            if (key === rest) continue
            const asked = wants
              .filter(([each]) => each === key)
              .reduce((sum, [, lines]) => sum + Math.max(lines, 0), 0)
            expect(laid[key] ?? 0).toBeLessThanOrEqual(asked)
          }
        },
      ),
    )
  })
})
