// The parity matrix's second table (the spec's Appendix A, "Since orchestra v0.7.7"): orchestra's
// changes from 0.8.0 on, each version in its order, and each change done or planned with its
// ticket, or already so or not needed, saying why.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const spec = readFileSync(join(import.meta.dir, "..", ".orchestra/specs/tutti-spec.md"), "utf8")

/** The cells of each row of the first table after `heading` in `text`, header and rule left out. */
const tableRows = (text: string, heading: string): ReadonlyArray<ReadonlyArray<string>> => {
  const start = text.indexOf(heading)
  expect(start).toBeGreaterThanOrEqual(0)
  const lines = text.slice(start).split("\n")
  const first = lines.findIndex((line) => line.startsWith("|"))
  const table = lines.slice(first)
  const end = table.findIndex((line) => !line.startsWith("|"))
  return (end === -1 ? table : table.slice(0, end)).slice(2).map((line) =>
    line
      .slice(1, -1)
      .split(" | ")
      .map((cell) => cell.trim()),
  )
}

const appendixA = spec.slice(spec.indexOf("## Appendix A: Parity matrix"))
const since = tableRows(appendixA, "### Since orchestra v0.7.7")

// orchestra's released versions from 0.8.0 on, 0.8.3 left out as never released, then Unreleased.
const versions = [
  "0.8.0",
  "0.8.1",
  "0.8.2",
  "0.8.4",
  "0.8.5",
  "0.8.6",
  "0.9.0",
  "0.9.1",
  "Unreleased",
]

const ticket = /\(tutti-[a-z0-9]+(?:\.[0-9]+)*\)/

describe("Appendix A since orchestra v0.7.7", () => {
  test("is in Appendix A, after the matrix and before Appendix B", () => {
    const at = spec.indexOf("### Since orchestra v0.7.7")
    expect(at).toBeGreaterThan(spec.indexOf("## Appendix A: Parity matrix"))
    expect(at).toBeLessThan(spec.indexOf("## Appendix B"))
  })

  test("goes through each version from 0.8.0 on, once and in order", () => {
    expect(since.length).toBeGreaterThan(80)
    expect(since[0]?.[0]).toBe(versions[0])
    expect(since.map((row) => row[0]).filter((version) => version !== "")).toEqual(versions)
    for (const row of since) {
      expect(row.length).toBe(3)
      expect((row[1] ?? "").length).toBeGreaterThan(10)
    }
  })

  test("gives each change its ticket, or says why it needs none", () => {
    for (const row of since) {
      const disposition = row[2] ?? ""
      if (disposition.startsWith("Done") || disposition.startsWith("Planned")) {
        expect([disposition, ticket.test(disposition)]).toEqual([disposition, true])
      } else {
        expect([disposition, /^(Already so|Not needed): .{10,}/.test(disposition)]).toEqual([
          disposition,
          true,
        ])
      }
    }
  })

  test("names each change once", () => {
    const changes = since.map((row) => row[1])
    expect(new Set(changes).size).toBe(changes.length)
  })
})
