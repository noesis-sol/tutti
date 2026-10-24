// tutti init's import from orchestra (§ 8.3): orchestra reads its ticket_limit with Go's
// time.ParseDuration, so any zero time there ("0", "0s", "0m", "0h0m", "-0s") is no limit, which
// imports as tutti's null rather than being left out as a time not longer than 0.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { importSettings } from "../src/init/import.ts"

const units = ["ns", "us", "µs", "μs", "ms", "s", "m", "h"]

/** A zero time as Go writes or reads it: "0", or zeros with units, signed or not. */
const goZero = fc.oneof(
  fc.constant("0"),
  fc
    .tuple(
      fc.constantFrom("", "+", "-"),
      fc.array(
        fc.tuple(fc.constantFrom("0", "00", "0.", "0.0", ".0", "0.000"), fc.constantFrom(...units)),
        { minLength: 1, maxLength: 3 },
      ),
    )
    .map(([sign, parts]) => sign + parts.map(([amount, unit]) => amount + unit).join("")),
)

describe("orchestra's ticket_limit of zero", () => {
  test("a zero Go duration imports as no limit", () => {
    for (const limit of ["0", "0s", "0m", "0h", "0h0m0s", "-0s", "0.0m"]) {
      const imported = importSettings({ ticket_limit: limit })
      expect(imported.json).toEqual({ workers: { ticket_limit: null } })
      expect(imported.imported).toEqual([{ key: "ticket_limit", to: "workers.ticket_limit" }])
      expect(imported.leftOut).toEqual([])
    }
  })

  test("any zero time Go reads imports as no limit", () => {
    fc.assert(
      fc.property(goZero, (limit) => {
        const imported = importSettings({ ticket_limit: limit })
        expect(imported.json).toEqual({ workers: { ticket_limit: null } })
        expect(imported.leftOut).toEqual([])
      }),
    )
  })

  test("a limit that isn't zero is imported as it is, and one that isn't a time is left out", () => {
    expect(importSettings({ ticket_limit: "90m" }).json).toEqual({
      workers: { ticket_limit: "90m" },
    })
    for (const limit of ["0x", "s", ".s", "00", "zero"]) {
      const imported = importSettings({ ticket_limit: limit })
      expect(imported.json).toEqual({})
      expect(imported.leftOut.map((each) => each.key)).toEqual([
        `ticket_limit (${JSON.stringify(limit)})`,
      ])
    }
  })
})
