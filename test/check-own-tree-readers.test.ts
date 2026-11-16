// scripts/check-own.ts runs the tests that read every tracked file on any change (tutti-wo4i):
// test/no-orchestra.test.ts reads every file git tracks, so the merge check, which runs only the
// tests a change touches, missed a new mention of orchestra in another file until the full check
// at a run's end. A change to any file touches the tests in treeReaders, and so the tests that
// import them.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import fc from "fast-check"
import { testsFor, treeReaders, wholeSuite } from "../scripts/check-own.ts"

const sources = (files: Record<string, string>) => new Map(Object.entries(files))
const existing = (files: Record<string, string>) => (file: string) => file in files

describe("testsFor on the tests that read every tracked file", () => {
  const files = {
    "src/a.ts": "export const a = 1",
    "test/a.test.ts": 'import { a } from "../src/a.ts"',
    "test/no-orchestra.test.ts": 'const listed = Bun.spawnSync(["git", "ls-files", "-z"])',
    "test/other.test.ts": 'import { x } from "./helper.ts"',
    "test/helper.ts": "export const x = 1",
  }
  const tests = (changed: ReadonlyArray<string>) =>
    testsFor(changed, sources(files), existing(files))
  const reader = "test/no-orchestra.test.ts"

  test("test/no-orchestra.test.ts reads every tracked file", () => {
    expect(treeReaders).toContain(reader)
  })

  test("a change anywhere takes them, beside the tests the change touches otherwise", () => {
    expect(tests(["src/a.ts"])).toEqual(["test/a.test.ts", reader])
    expect(tests(["test/helper.ts"])).toEqual([reader, "test/other.test.ts"])
    expect(tests(["docs/setup.md"])).toEqual([reader])
    expect(tests(["README.md", "scripts/check.sh"])).toEqual([reader])
  })

  test("a file added or deleted takes them, as git's list gains or loses it", () => {
    expect(tests(["docs/new.md"])).toEqual([reader])
    expect(tests(["test/fixtures/gone.json"])).toEqual([reader])
  })

  test("no change takes none of them", () => {
    expect(tests([])).toEqual([])
  })

  test("takes them on any change, whatever changed", () => {
    const path = fc.stringMatching(/^[a-z]{1,6}(\/[a-z]{1,6}){0,3}\.(ts|md|json|sh)$/)
    const under = fc.constantFrom("src/", "test/", "scripts/", "docs/", ".github/", "")
    // A path that touches every test (scripts/test.ts) is left out: the readers are then in "all".
    const changed = fc
      .array(
        fc.tuple(under, path).map(([top, rest]) => top + rest),
        { minLength: 1, maxLength: 6 },
      )
      .filter((list) => !list.some((file) => wholeSuite.includes(file)))
    fc.assert(
      fc.property(changed, (list) => {
        const picked = tests(list)
        if (picked === "all") throw new Error("no change here touches every test")
        expect(picked).toContain(reader)
      }),
    )
  })
})

describe("the repository's readers of every tracked file", () => {
  const root = resolve(import.meta.dir, "..")
  const isFile = (file: string) => {
    const path = resolve(root, file)
    return existsSync(path) && statSync(path).isFile()
  }

  test("each is a test file that exists and reads git's list of tracked files", () => {
    for (const reader of treeReaders) {
      expect(reader).toMatch(/^test\/.*\.test\.tsx?$/)
      expect(isFile(reader)).toBe(true)
      expect(readFileSync(resolve(root, reader), "utf8")).toContain('"ls-files"')
    }
  })

  test("a change to a document picks test/no-orchestra.test.ts", () => {
    const repo = sources({
      "test/no-orchestra.test.ts": readFileSync(resolve(root, "test/no-orchestra.test.ts"), "utf8"),
    })
    expect(testsFor(["docs/setup.md"], repo, isFile)).toEqual(["test/no-orchestra.test.ts"])
  })
})
