import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import {
  type CriticAnswer,
  evidenceCharacters,
  findingsOf,
  locationOf,
} from "../src/organs/critic.ts"
import { unplacedLine } from "../src/run/critic.ts"
import type { TicketId } from "../src/services/Beads.ts"

/** How long locationOf may take on any evidence, however long. */
const fast = 50

const timed = <A>(read: () => A): { readonly value: A; readonly ms: number } => {
  const started = performance.now()
  const value = read()
  return { value, ms: performance.now() - started }
}

const finding = (title: string, evidence: string): CriticAnswer["findings"][number] => ({
  title,
  severity: "medium",
  criterion: "CLAUDE.md: errors are tagged errors",
  evidence,
  detail: "parse throws a plain Error.",
  confidence: "high",
})

describe("a finding's location", () => {
  test("is the first path:line past a URL or an absolute path", () => {
    expect(
      locationOf("the handler at http://localhost:3000/x breaks; see src/server.ts:42"),
    ).toEqual({ file: "src/server.ts", line: 42 })
    expect(locationOf("/abs/src/a.ts:12 and src/b.ts:3")).toEqual({ file: "src/b.ts", line: 3 })
    expect(locationOf("../x/a.ts:1, then ./c/d.md:7")).toEqual({ file: "c/d.md", line: 7 })
    expect(locationOf("src/a.ts:0 or src/a.ts:5")).toEqual({ file: "src/a.ts", line: 5 })
    expect(locationOf("at line Makefile:3 of README.md:9")).toEqual({ file: "README.md", line: 9 })
  })

  test(`is read within ${fast} ms of 100 000 characters`, () => {
    const bytes = new Uint8Array(75_000)
    for (let i = 0; i < bytes.length; i += 65_536) {
      crypto.getRandomValues(bytes.subarray(i, i + 65_536))
    }
    const base64 = Buffer.from(bytes).toString("base64")
    for (const evidence of [
      "a/".repeat(50_000),
      base64,
      "a.".repeat(50_000),
      ":1".repeat(50_000),
    ]) {
      expect(evidence.length).toBe(100_000)
      const { ms } = timed(() => locationOf(evidence))
      expect(ms).toBeLessThan(fast)
    }
    const { value, ms } = timed(() => locationOf(`${"a/".repeat(50_000)} src/a.ts:4`))
    expect(value).toEqual({ file: "src/a.ts", line: 4 })
    expect(ms).toBeLessThan(fast)
  })

  test("of long tokens of dots and slashes is read at once, and safe", () => {
    const piece = fc.constantFrom("a", "/", ".", "b.", "/c", ":", ":1", " ", "//", "x:")
    const token = fc
      .tuple(fc.array(piece, { minLength: 1, maxLength: 8 }), fc.integer({ min: 500, max: 5_000 }))
      .map(([pieces, times]) => pieces.join("").repeat(times))
    fc.assert(
      fc.property(token, fc.string(), (long, after) => {
        const { value, ms } = timed(() => locationOf(`${long}${after}`))
        expect(ms).toBeLessThan(fast)
        if (value === undefined) return
        expect(value.line).toBeGreaterThanOrEqual(1)
        expect(value.file).toMatch(/[./]/)
        expect(value.file.startsWith("/")).toBe(false)
        expect(value.file.split("/")).not.toContain("..")
      }),
      { numRuns: 50 },
    )
  })
})

describe("a finding naming no location", () => {
  test("is dropped, its title kept to be logged", () => {
    const read = findingsOf({
      checklist: [],
      findings: [
        finding("Throw a tagged error", "src/parse.ts:2"),
        finding("Handle the empty input", "in the parser"),
        finding("  ", "nowhere"),
      ],
    })
    expect(read.findings.map((f) => f.title)).toEqual(["Throw a tagged error"])
    expect(read.unplaced).toEqual(["Handle the empty input"])
    expect<string>(unplacedLine("t-1" as TicketId, "Handle\nthe input")).toBe(
      "  review t-1: dropped a finding naming no path:line: Handle the input",
    )
  })

  test(`is one whose path:line is past its first ${evidenceCharacters} characters`, () => {
    const late = `${"x".repeat(evidenceCharacters)} src/parse.ts:2`
    const read = findingsOf({ checklist: [], findings: [finding("Too far", late)] })
    expect(read).toEqual({ findings: [], unplaced: ["Too far"] })
  })
})
