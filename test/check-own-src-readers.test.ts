// scripts/check-own.ts runs the tests that read the whole of src/ on any change under src/
// (tutti-113n): test/layers.test.ts imports no src/ module, reading all of src/ through
// test/importGraph.ts, so a worker's own check didn't run it when a src/ file gained an upward
// import. A change to any file under src/ touches the helpers in srcReaders, and so the tests that
// import them, at any depth.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import fc from "fast-check"
import { srcReaders, testsFor, wholeSuite } from "../scripts/check-own.ts"

const sources = (files: Record<string, string>) => new Map(Object.entries(files))
const existing = (files: Record<string, string>) => (file: string) => file in files

describe("testsFor on the tests that read the whole of src/", () => {
  const files = {
    "src/a.ts": "export const a = 1",
    "src/run/b.ts": 'import { a } from "../a.ts"',
    "test/a.test.ts": 'import { a } from "../src/a.ts"',
    "test/importGraph.ts": 'export const readGraph = () => Bun.Glob("**/*.ts")',
    "test/layers.test.ts": 'import { readGraph } from "./importGraph.ts"',
    "test/cycleHelper.ts": 'import { readGraph } from "./importGraph.ts"',
    "test/cycles.test.ts": 'import { cycles } from "./cycleHelper.ts"',
    "test/other.test.ts": 'import { x } from "./helper.ts"',
    "test/helper.ts": "export const x = 1",
  }
  const tests = (changed: ReadonlyArray<string>) =>
    testsFor(changed, sources(files), existing(files))
  const readers = ["test/cycles.test.ts", "test/layers.test.ts"]

  test("test/importGraph.ts is a reader of the whole of src/", () => {
    expect(srcReaders).toContain("test/importGraph.ts")
  })

  test("a change to a module under src/ takes them, with the tests that import the module", () => {
    expect(tests(["src/a.ts"])).toEqual(["test/a.test.ts", ...readers])
    expect(tests(["src/run/b.ts"])).toEqual(readers)
  })

  test("a file added or deleted under src/ takes them, as the graph gains or loses a module", () => {
    expect(tests(["src/run/new.ts"])).toEqual(readers)
    expect(tests(["src/gone.ts"])).toEqual(readers)
  })

  test("a change outside src/ doesn't take them", () => {
    expect(tests(["test/helper.ts"])).toEqual(["test/other.test.ts"])
    expect(tests(["scripts/check.sh", "docs/setup.md", "srcdoc.md"])).toEqual([])
    expect(tests(["test/importGraph.ts"])).toEqual(readers)
  })

  test("takes them when any changed file is under src/, whatever else changed", () => {
    const path = fc.stringMatching(/^[a-z]{1,6}(\/[a-z]{1,6}){0,3}\.ts$/)
    const under = fc.constantFrom("src/", "test/", "scripts/", "docs/", "")
    // A path that touches every test (scripts/test.ts) is left out: the readers are then in "all".
    const changed = fc
      .array(
        fc.tuple(under, path).map(([top, rest]) => top + rest),
        { maxLength: 6 },
      )
      .filter((list) => !list.some((file) => wholeSuite.includes(file)))
    fc.assert(
      fc.property(changed, (list) => {
        const picked = tests(list)
        if (picked === "all") throw new Error("no change here touches every test")
        const anySrc = list.some((file) => file.startsWith("src/"))
        expect(picked).toEqual(expect.arrayContaining(readers.filter(() => anySrc)))
        if (!anySrc && !list.includes("test/importGraph.ts")) {
          expect(picked.filter((test) => readers.includes(test))).toEqual([])
        }
      }),
    )
  })
})

describe("the repository's readers of the whole of src/", () => {
  const root = resolve(import.meta.dir, "..")
  const read = (file: string) => readFileSync(resolve(root, file), "utf8")
  const isFile = (file: string) => {
    const path = resolve(root, file)
    return existsSync(path) && statSync(path).isFile()
  }

  test("each is a test helper that exists", () => {
    for (const reader of srcReaders) {
      expect(reader.startsWith("test/")).toBe(true)
      expect(isFile(reader)).toBe(true)
    }
  })

  test("a change to a src/ module picks test/layers.test.ts through test/importGraph.ts", () => {
    const repo = sources({
      "test/importGraph.ts": read("test/importGraph.ts"),
      "test/layers.test.ts": read("test/layers.test.ts"),
    })
    expect(testsFor(["src/core/log.ts"], repo, isFile)).toEqual(["test/layers.test.ts"])
    expect(testsFor(["docs/setup.md"], repo, isFile)).toEqual([])
  })
})
