import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { CheckOutput } from "../src/services/Checks.ts"

const said = (text: string) => {
  const output = new CheckOutput()
  output.write(new TextEncoder().encode(text))
  output.end()
  return output.summary().failingLines
}

const rule = "━".repeat(60)

describe("CheckOutput in a TypeScript project", () => {
  test("picks bun test's failing tests and its count of them", () => {
    const lines = [
      "bun test v1.4.3 (c6da4a4d3)",
      "",
      "test/a.test.ts:",
      "(pass) group > passes [0.10ms]",
      "error: expect(received).toBe(expected)",
      "",
      "Expected: 2",
      "Received: 1",
      "",
      "(fail) group > fails [5.05ms]",
      "      at <anonymous> (/p/test/a.test.ts:6:46)",
      "(skip) group > skipped",
      "(fail) throws [2.73ms]",
      "",
      " 1 pass",
      " 2 fail",
      " 2 expect() calls",
      "Ran 3 tests across 1 file. [53.00ms]",
    ]
    expect(said(lines.join("\n"))).toEqual([
      "error: expect(received).toBe(expected)",
      "(fail) group > fails [5.05ms]",
      "(fail) throws [2.73ms]",
      "2 fail",
    ])
  })

  test("picks tsc's errors at their file's position", () => {
    const lines = [
      "src/b.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "  Type 'x' is missing the following properties from type 'y': a, b",
      "error TS5083: Cannot read file '/p/tsconfig.json'.",
      "src/b.ts(1,7): a line that is no error",
    ]
    expect(said(lines.join("\n"))).toEqual([
      "src/b.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "error TS5083: Cannot read file '/p/tsconfig.json'.",
    ])
  })

  test("picks Biome's errors, each with its first line, but not its warnings", () => {
    const lines = [
      `src/b.ts:2:1 lint/style/useConst  FIXABLE  ${rule}`,
      "",
      "  ! This let declares a variable that is only assigned once.",
      "",
      "  > 2 │ let y = 1",
      "",
      `src/b.ts:3:1 assist/source/organizeImports  FIXABLE  ${rule}`,
      "",
      "  × The imports and exports are not sorted.",
      "",
      `src/b.ts format ${rule}`,
      "",
      "  × Formatter would have printed the following content:",
      "",
      "    1   │ - const·x·=·1",
      `src/d.ts:1:7 parse ${rule}`,
      "",
      "  × Expected an identifier but instead found '= 1'.",
      "",
      "  i Expected an identifier here.",
      `src/d.ts format ${rule}`,
      "",
      "  × Formatter would have printed the following content:",
      "",
      "Checked 3 files in 9ms. No fixes applied.",
      "Found 4 errors.",
      "Found 1 warning.",
      `check ${rule}`,
      "",
      "  × Some errors were emitted while running checks.",
    ]
    expect(said(lines.join("\n"))).toEqual([
      "src/b.ts:3:1 assist/source/organizeImports  FIXABLE",
      "× The imports and exports are not sorted.",
      "src/b.ts format",
      "× Formatter would have printed the following content:",
      "src/d.ts:1:7 parse",
      "× Expected an identifier but instead found '= 1'.",
      "src/d.ts format",
      "Found 4 errors.",
    ])
  })

  test("a Biome header with no line after it says nothing", () => {
    expect(said(`src/b.ts format ${rule}`)).toEqual([])
    expect(said(`src/b.ts format ${rule}\n\nsrc/a.ts(1,1): error TS1: x`)).toEqual([
      "src/a.ts(1,1): error TS1: x",
    ])
  })

  test("says the same of Biome's errors however the output is cut into chunks", () => {
    const header = fc.constantFrom(`src/a.ts:1:1 lint/x/y ${rule}`, `src/a.ts format ${rule}`)
    const line = fc.oneof(header, fc.constantFrom("", "  × bad", "  ! warned", "(fail) t"))
    fc.assert(
      fc.property(fc.array(line), fc.nat(), (lines, cut) => {
        const bytes = new TextEncoder().encode(lines.join("\n"))
        const at = bytes.length === 0 ? 0 : cut % bytes.length
        const output = new CheckOutput()
        output.write(bytes.subarray(0, at))
        output.write(bytes.subarray(at))
        output.end()
        expect(output.summary().failingLines).toEqual(said(lines.join("\n")))
      }),
    )
  })
})
