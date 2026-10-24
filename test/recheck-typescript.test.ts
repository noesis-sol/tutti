import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { ownFailures } from "../src/run/recheck.ts"
import { CheckOutput } from "../src/services/Checks.ts"

/** The lines CheckOutput keeps of `text` as saying what failed. */
const failingLines = (text: string) => {
  const output = new CheckOutput()
  output.write(new TextEncoder().encode(text))
  output.end()
  return output.summary().failingLines
}

// What tsc 5 and Biome 2 printed for src/sub/a.ts, a type error, a lint error and its format, with
// no colours, as a check run by a script prints them.
const tsc = `src/sub/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.
`
const biome = `src/sub/a.ts:3:1 assist/source/organizeImports  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  × This statement must be preceded by a blank line. Add a newline before this statement.

    1 │ export const a: number = "x"
    2 │ let b = 1
  > 3 │ export { b }
      │ ^^^^^^^^^^^^


src/sub/a.ts format ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  × Formatter would have printed the following content:

    1   │ - export·const·c·=·{a:1}
      1 │ + export·const·c·=·{·a:·1·};


Checked 1 file in 25ms. No fixes applied.
Found 2 errors.
check ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  × Some errors were emitted while running checks.

`
// A Biome warning: CheckOutput keeps no line of it.
const biomeWarning = `src/sub/a.ts:2:1 lint/style/useConst  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ! This let declares a variable that is only assigned once.

`

describe("ownFailures in a TypeScript project", () => {
  test("tsc's error names the folder of its file", () => {
    expect(ownFailures(failingLines(tsc), ["src/sub"])).toEqual(["src/sub"])
    expect(ownFailures(failingLines(tsc), ["src", "test"])).toEqual([])
  })

  test("Biome's errors, by position or not, name the folder of their file", () => {
    const said = failingLines(biome)
    expect(said).toContain("src/sub/a.ts:3:1 assist/source/organizeImports  FIXABLE")
    expect(said).toContain("src/sub/a.ts format")
    expect(ownFailures(said, ["src/sub", "test"])).toEqual(["src/sub"])
    expect(ownFailures(["src/sub/a.ts format"], ["src/sub"])).toEqual(["src/sub"])
    expect(ownFailures(said, ["src"])).toEqual([])
  })

  test("a Biome warning names no folder", () => {
    expect(ownFailures(failingLines(biomeWarning), ["src/sub"])).toEqual([])
  })

  test("Biome's closing lines and counts name no folder", () => {
    expect(
      ownFailures(["Found 2 errors.", "× Some errors were emitted while running checks."], ["."]),
    ).toEqual([])
  })

  const part = fc.stringMatching(/^[a-z][a-z0-9_]{0,5}$/)
  const folder = fc.array(part, { minLength: 1, maxLength: 3 }).map((parts) => parts.join("/"))
  const category = fc.constantFrom(
    "format",
    "parse",
    "lint/style/useConst",
    "assist/source/organizeImports",
  )

  test("any file's tsc error or Biome header names its folder", () => {
    fc.assert(
      fc.property(folder, part, fc.nat(), fc.nat(), category, (dir, name, row, column, kind) => {
        const file = `${dir}/${name}.ts`
        const at = `${row + 1}`
        expect(ownFailures([`${file}(${at},${column + 1}): error TS2322: no`], [dir])).toEqual([
          dir,
        ])
        expect(ownFailures([`${file}:${at}:${column + 1} ${kind}  FIXABLE`], [dir])).toEqual([dir])
        expect(ownFailures([`${file} ${kind}`], [dir])).toEqual([dir])
        expect(ownFailures([`other/${dir}x/${name}.ts ${kind}`], [dir])).toEqual([])
      }),
    )
  })
})
