import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import {
  type CriticAnswer,
  evidenceCharacters,
  evidenceStart,
  findingsOf,
  locationOf,
} from "../src/organs/critic.ts"

const finding = (evidence: string): CriticAnswer["findings"][number] => ({
  title: "Throw a tagged error",
  severity: "medium",
  criterion: "CLAUDE.md: errors are tagged errors",
  evidence,
  detail: "parse throws a plain Error.",
  confidence: "high",
})

/** The evidence with `text` starting `at` characters in, after spaces. */
const placed = (at: number, text: string): string => `${" ".repeat(at)}${text}`

describe("a finding's evidence cut to its first characters", () => {
  test("drops a path:line the cut ends inside", () => {
    const location = "src/a.ts:123"
    for (let inside = 1; inside < location.length; inside++) {
      const evidence = placed(evidenceCharacters - inside, `${location} and more`)
      expect(locationOf(evidenceStart(evidence))).toBeUndefined()
      expect(findingsOf({ checklist: [], findings: [finding(evidence)] })).toEqual({
        findings: [],
        unplaced: ["Throw a tagged error"],
      })
    }
  })

  test("keeps a path:line that ends at the cut, or before a run the cut ends inside", () => {
    const atCut = placed(evidenceCharacters - "src/a.ts:123".length, "src/a.ts:123 and more")
    expect(evidenceStart(atCut)).toBe(atCut.slice(0, evidenceCharacters))
    expect(locationOf(evidenceStart(atCut))).toEqual({ file: "src/a.ts", line: 123 })
    const before = placed(evidenceCharacters - 20, "src/a.ts:7 then src/b.ts:99")
    expect(evidenceStart(before)).toBe(placed(evidenceCharacters - 20, "src/a.ts:7 then "))
    const read = findingsOf({ checklist: [], findings: [finding(before)] })
    expect(read.findings.map(({ file, line }) => ({ file, line }))).toEqual([
      { file: "src/a.ts", line: 7 },
    ])
  })

  test("is the whole of evidence no longer than the cut", () => {
    const evidence = placed(evidenceCharacters - "src/a.ts:1".length, "src/a.ts:1")
    expect(evidenceStart(evidence)).toBe(evidence)
  })

  test("names no place the whole evidence doesn't name first", () => {
    const piece = fc.constantFrom("a", "/", ".", "b.ts", ":", ":1", ":12", "-3", " ", ",", "src/")
    const around = fc.array(piece, { minLength: 0, maxLength: 12 }).map((pieces) => pieces.join(""))
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 30 }), around, (back, text) => {
        const evidence = placed(evidenceCharacters - back, text)
        const start = evidenceStart(evidence)
        expect(evidence.startsWith(start)).toBe(true)
        expect(start.length).toBeLessThanOrEqual(evidenceCharacters)
        const where = locationOf(start)
        if (where !== undefined) expect(locationOf(evidence)).toEqual(where)
      }),
    )
  })
})
