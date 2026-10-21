// docs/parity.md, the parity audit against the spec's Appendix A (§ 14 row 1.0), checked against the
// spec and the code: it has one row per row of the parity matrix, in the matrix's order, each with a
// disposition; a gap names its follow-up ticket; and every module, test file and test name it gives
// as evidence is there.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const read = (file: string): string => readFileSync(join(root, file), "utf8")

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

const matrix = tableRows(read(".orchestra/specs/tutti-spec.md"), "## Appendix A: Parity matrix")
const audit = tableRows(read("docs/parity.md"), "## The matrix")

const statuses = ["Kept", "Changed as specified", "Dropped as specified", "Missing", "Differs"]

describe("docs/parity.md", () => {
  test("has one row per row of Appendix A, in its order", () => {
    expect(matrix.length).toBeGreaterThan(80)
    expect(audit.map((row) => [row[0], row[1]])).toEqual(matrix.map((row) => [row[0], row[1]]))
  })

  test("gives each row a disposition, and each gap its ticket", () => {
    for (const row of audit) {
      const status = row[2] ?? ""
      expect(statuses.some((name) => status.startsWith(name))).toBe(true)
      if (status.startsWith("Missing") || status.startsWith("Differs")) {
        expect(status).toMatch(/tutti-[a-z0-9.]+/)
      }
    }
  })

  test("names modules and test files that are there", () => {
    const paths = audit.flatMap((row) =>
      [...`${row[3]} ${row[4]}`.matchAll(/`((?:src|test|scripts|skills|docs)\/[^`]+?)`/g)].map(
        (found) => found[1] ?? "",
      ),
    )
    expect(paths.length).toBeGreaterThan(80)
    for (const path of paths) expect([path, existsSync(join(root, path))]).toEqual([path, true])
  })

  test("names tests that are in the files it gives", () => {
    let named = 0
    for (const row of audit) {
      for (const cite of (row[4] ?? "").split(";")) {
        const file = cite.match(/`(test\/[^`]+)`/)?.[1]
        if (file === undefined) continue
        for (const [, name] of cite.matchAll(/"([^"]+)"/g)) {
          named++
          expect([file, name, read(file).includes(name ?? "")]).toEqual([file, name, true])
        }
      }
    }
    expect(named).toBeGreaterThan(80)
  })
})
