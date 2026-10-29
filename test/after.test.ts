// Why a held ticket waits, in the words the log and Up next share (src/run/after.ts, tutti-zv69):
// each reason starts `after` and names the tickets it waits for, which afterParts finds again in a
// reason as the log said it, for the panel to draw in the live role.

import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import {
  afterMerging,
  afterOverlap,
  afterParts,
  afterSolo,
  afterSubtickets,
} from "../src/run/after.ts"

/** The tickets `reason` names, as afterParts finds them. */
const named = (reason: string) => afterParts(reason).flatMap((part) => (part.id ? [part.text] : []))

describe("the reasons", () => {
  test("each form starts after and names the tickets waited for", () => {
    expect(afterOverlap("tutti-scod", "test/init.test.ts")).toBe(
      "after tutti-scod: both touch test/init.test.ts",
    )
    expect(afterMerging(["tutti-h2o9"])).toBe("after tutti-h2o9 merges")
    expect(afterMerging(["a", "b"])).toBe("after a, b merge")
    expect(afterSolo("tutti-kkb.28")).toBe("after tutti-kkb.28 (solo)")
    expect(afterSubtickets(["e.1"])).toBe("after its subtickets: e.1")
    expect(afterSubtickets(["e.1", "e.2"])).toBe("after its subtickets: e.1, e.2")
    expect(afterSubtickets(["e.1", "e.2", "e.3", "e.4", "e.5"])).toBe(
      "after its subtickets: e.1, e.2, then +3",
    )
  })

  test("afterParts finds the tickets of each form, and keeps every character", () => {
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
      [afterOverlap("tutti-scod", "test/init.test.ts"), ["tutti-scod"]],
      [afterMerging(["tutti-h2o9"]), ["tutti-h2o9"]],
      [`${afterMerging(["x"])}: closed but not merged (tutti/x is not on main)`, ["x"]],
      [`${afterMerging(["x"])}: filed by its worker`, ["x"]],
      [afterMerging(["a", "b"]), ["a", "b"]],
      [afterSolo("tutti-kkb.28"), ["tutti-kkb.28"]],
      [afterSubtickets(["e.1", "e.2", "e.3"]), ["e.1", "e.2"]],
      ["waits for the environment probe to pass", []],
      ["its setup failed: waits for a ticket to merge, or the probe", []],
    ]
    for (const [reason, ids] of cases) {
      expect([reason, named(reason)]).toEqual([reason, [...ids]])
      expect(
        afterParts(reason)
          .map((part) => part.text)
          .join(""),
      ).toBe(reason)
    }
  })

  // A bd ID: letters, digits, `-` and `.`, as `tutti-kkb.28`.
  const id = fc.stringMatching(/^[a-z0-9][a-z0-9.-]{0,15}$/)
  const ids = fc.array(id, { minLength: 1, maxLength: 6 })
  // What a footprint shares: a file, a folder, a glob, a function or an area label.
  const what = fc.string({ minLength: 1, maxLength: 40 })

  test("finds the IDs of every form again, for any IDs and any shared file", () => {
    fc.assert(
      fc.property(id, what, (one, shared) => {
        expect(named(afterOverlap(one, shared))).toEqual([one])
        expect(named(afterSolo(one))).toEqual([one])
      }),
    )
    fc.assert(
      fc.property(ids, (many) => {
        expect(named(afterMerging(many))).toEqual(many)
        expect(named(afterSubtickets(many))).toEqual(many.slice(0, 2))
      }),
    )
  })

  test("any text comes back whole from its parts", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(
          afterParts(text)
            .map((part) => part.text)
            .join(""),
        ).toBe(text)
      }),
    )
  })
})
