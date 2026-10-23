// tenths, the one way a record's elapsed seconds are written: a wall clock that steps back between
// two readings gives 0, never -0 or a negative, which the event schema refuses (tutti-5mlh).

import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { encodeLine, tenths } from "../src/run/events.ts"
import { stamp } from "../src/run/eventstream.ts"

describe("tenths", () => {
  test("rounds milliseconds to a tenth of a second", () => {
    expect(tenths(0)).toBe(0)
    expect(tenths(1_234)).toBe(1.2)
    expect(tenths(1_250)).toBe(1.3)
  })

  test("a clock stepping back gives 0, not -0 or less", () => {
    expect(Object.is(tenths(-30), 0)).toBe(true)
    expect(Object.is(tenths(-5_000), 0)).toBe(true)
  })

  test("a check record with any elapsed time is written", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e9, max: 1e9 }), (ms) => {
        const event = {
          kind: "check" as const,
          suite: "merge" as const,
          seconds: tenths(ms),
          command: "scripts/check.sh",
          result: "passed" as const,
        }
        expect(encodeLine(stamp(event, "2026-10-23T10:00:00+02:00", 0))._tag).toBe("Success")
      }),
    )
  })
})
