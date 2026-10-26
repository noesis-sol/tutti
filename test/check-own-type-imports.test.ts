// scripts/check-own.ts leaves type-only imports and re-exports out of the import graph: Bun erases
// them, so a test that reads a module only for its types runs the same whatever the module holds.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { specifiers, testsFor } from "../scripts/check-own.ts"

const sources = (files: Record<string, string>) => new Map(Object.entries(files))
const existing = (files: Record<string, string>) => (file: string) => file in files

describe("specifiers and type-only statements", () => {
  test("leaves out import type and export type … from, in each of their forms", () => {
    const source = [
      'import type { A } from "./a.ts"',
      'import type B from "./b.ts"',
      'import type * as C from "./c.ts"',
      'export type { D } from "./d.ts"',
      'export type * from "./e.ts"',
      'export type * as F from "./f.ts"',
      'import type {\n  G,\n  H,\n} from "./g.ts"',
      "import type { I } from './i.ts'",
    ].join("\n")
    expect(specifiers(source)).toEqual([])
  })

  test("keeps import { type X }, a mixed import, a value import and a default named type", () => {
    const source = [
      'import { type A } from "./a.ts"',
      'import { type B, b } from "./b.ts"',
      'import { c } from "./c.ts"',
      'import type from "./d.ts"',
      'export { type E } from "./e.ts"',
    ].join("\n")
    expect(specifiers(source)).toEqual(["./a.ts", "./b.ts", "./c.ts", "./d.ts", "./e.ts"])
  })

  test("reads past a local export type with no specifier, keeping the next statement", () => {
    const source = ["export type { A }", 'import { b } from "./b.ts"'].join("\n")
    expect(specifiers(source)).toEqual(["./b.ts"])
  })

  test("gives specifiers for any text without throwing", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 300 }), (text) => {
        expect(Array.isArray(specifiers(text))).toBe(true)
      }),
    )
  })

  test("keeps every value import and drops every type-only one, in any order", () => {
    const specifier = fc.stringMatching(/^\.{1,2}\/[a-zA-Z0-9_./-]{1,30}$/)
    const typeOnly = fc.constantFrom(
      (s: string) => `import type { T } from "${s}"`,
      (s: string) => `import type T from "${s}"`,
      (s: string) => `import type * as T from "${s}"`,
      (s: string) => `export type { T } from "${s}"`,
      (s: string) => `export type * from "${s}"`,
    )
    const value = fc.constantFrom(
      (s: string) => `import { x } from "${s}"`,
      (s: string) => `import { type T } from "${s}"`,
      (s: string) => `import { type T, x } from "${s}"`,
      (s: string) => `export * from "${s}"`,
      (s: string) => `import "${s}"`,
    )
    const statement = fc.oneof(
      fc.record({ kept: fc.constant(false), form: typeOnly, specifier }),
      fc.record({ kept: fc.constant(true), form: value, specifier }),
    )
    fc.assert(
      fc.property(fc.array(statement, { maxLength: 8 }), (list) => {
        const source = list.map(({ form, specifier }) => form(specifier)).join("\n")
        const kept = list.filter(({ kept }) => kept).map(({ specifier }) => specifier)
        expect(specifiers(source)).toEqual(kept)
      }),
    )
  })
})

describe("testsFor and type-only statements", () => {
  const files = {
    "src/a.ts": "export type A = number\nexport const a = 1",
    "test/types.test.ts": 'import type { A } from "../src/a.ts"',
    "test/reexport.test.ts": 'export type { A } from "../src/a.ts"',
    "test/helper.ts": 'import type { A } from "../src/a.ts"\nexport const h = 1',
    "test/helped.test.ts": 'import { h } from "./helper.ts"',
    "test/inline.test.ts": 'import { type A } from "../src/a.ts"',
    "test/mixed.test.ts": 'import { type A, a } from "../src/a.ts"',
    "test/value.test.ts": 'import { a } from "../src/a.ts"',
  }
  const tests = (changed: ReadonlyArray<string>) =>
    testsFor(changed, sources(files), existing(files))

  test("doesn't take a test that reads a changed module only for its types, itself or through a helper", () => {
    const picked = tests(["src/a.ts"])
    expect(picked).not.toContain("test/types.test.ts")
    expect(picked).not.toContain("test/reexport.test.ts")
    expect(picked).not.toContain("test/helped.test.ts")
  })

  test("takes a test that imports with import { type X }, a mixed import or a value import", () => {
    expect(tests(["src/a.ts"])).toEqual([
      "test/inline.test.ts",
      "test/mixed.test.ts",
      "test/value.test.ts",
    ])
  })

  test("still takes a test whose helper changed, though it reads the module only for types", () => {
    expect(tests(["test/helper.ts"])).toEqual(["test/helped.test.ts"])
  })
})
