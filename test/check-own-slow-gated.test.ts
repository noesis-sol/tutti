// scripts/check-own.ts lets a plain pass stand for a TUTTI_SLOW=1 run in the test files with no
// slow gate (slowGated), which run the same in both modes, beside the slow pass (standOnPasses).
// test/check-own-pass.test.ts runs check-own.sh on it.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { slowGated, standOn, standOnPasses } from "../scripts/check-own.ts"

const sources = (files: Record<string, string>) => new Map(Object.entries(files))
const existing = (files: Record<string, string>) => (file: string) => file in files

const gates = "export const slow = {}\nexport const live = {}\nconst on = 'TUTTI_SLOW'\n"

describe("slowGated", () => {
  test("is the test files that call the gates' slow, and not those that only import gates", () => {
    const files = {
      "test/gates.ts": gates,
      "test/plain.test.ts": 'import { test } from "bun:test"\ntest("x", () => {})\n',
      "test/slow.test.ts": 'import { slow } from "./gates.ts"\nslow.test("x", () => {})\n',
      "test/group.test.ts": 'import { slow } from "./gates.ts"\nslow.describe("x", () => {})\n',
      "test/live.test.ts": 'import { live } from "./gates.ts"\nlive.test("x", () => {})\n',
      "test/unused.test.ts":
        'import { live, slow } from "./gates.ts"\nlive.describe("slow tools", () => {})\n',
      "test/contract/sdk.test.ts": 'import { live } from "../gates.ts"\nlive.test("x", () => {})\n',
    }
    expect(slowGated(sources(files), existing(files))).toEqual([
      "test/group.test.ts",
      "test/slow.test.ts",
    ])
  })

  test("follows the name slow is imported as, a namespace import, and a call with no import", () => {
    const files = {
      "test/gates.ts": gates,
      "test/alias.test.ts": 'import { slow as gated } from "./gates.ts"\ngated.test("x", f)\n',
      "test/alias-unused.test.ts":
        'import { slow as gated } from "./gates.ts"\nlive.test("x", f)\n',
      "test/namespace.test.ts": 'import * as g from "./gates.ts"\ng.slow.test("x", f)\n',
      "test/namespace-live.test.ts": 'import * as g from "./gates.ts"\ng.live.test("x", f)\n',
      "test/written.test.ts": "const text = `import { slow } from x; slow.test('y', f)`\n",
    }
    expect(slowGated(sources(files), existing(files))).toEqual([
      "test/alias.test.ts",
      "test/namespace.test.ts",
      "test/written.test.ts",
    ])
  })

  test("counts a test naming TUTTI_SLOW, or importing a gated helper; no module outside test/", () => {
    const files = {
      "test/gates.ts": gates,
      "test/helper.ts": 'import { slow } from "./gates.ts"\nexport const t = slow.test\n',
      "test/wrapper.ts": 'export * from "./helper.ts"\n',
      "test/deep.test.ts": 'import { t } from "./wrapper.ts"\n',
      "test/typed.test.ts": 'import type { t } from "./helper.ts"\n',
      "test/env.test.ts": 'const env = { TUTTI_SLOW: "" }\n',
      "src/settings.ts": '// slow.test\nexport const full = "TUTTI_SLOW=1 scripts/check.sh"\n',
      "test/settings.test.ts": 'import { full } from "../src/settings.ts"\n',
    }
    expect(slowGated(sources(files), existing(files))).toEqual([
      "test/deep.test.ts",
      "test/env.test.ts",
    ])
  })
})

const all = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts"]

describe("standOnPasses", () => {
  test("stands on each pass with the change since its own tree, counting each pass's share", () => {
    const picked = standOnPasses(
      "all",
      [
        { since: ["test/b.test.ts"], passed: ["test/a.test.ts", "test/b.test.ts"] },
        { since: [], passed: ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"] },
      ],
      all,
    )
    expect(picked).toEqual({
      run: ["test/d.test.ts"],
      leftOut: [1, 2],
      passed: all,
    })
  })

  test("runs the whole selection with no pass", () => {
    expect(standOnPasses("all", [], all)).toEqual({ run: "all", leftOut: [], passed: all })
    const selection = ["test/b.test.ts", "test/c.test.ts"]
    expect(standOnPasses(selection, [], all)).toEqual({
      run: selection,
      leftOut: [],
      passed: selection,
    })
  })

  test("runs every selected test no pass stands for, and is standOn for one pass", () => {
    const tests = fc.subarray(all)
    const pass = fc.record({ since: tests, passed: tests })
    fc.assert(
      fc.property(tests, fc.array(pass, { maxLength: 3 }), (selection, passes) => {
        const picked = standOnPasses(selection, passes, all)
        const run = picked.run === "all" ? all : picked.run
        for (const test of selection) {
          const stands = passes.some(
            ({ since, passed }) => passed.includes(test) && !since.includes(test),
          )
          expect(run.includes(test)).toBe(!stands)
        }
        expect(run.every((test) => selection.includes(test))).toBe(true)
        expect(picked.leftOut.reduce((sum, count) => sum + count, 0)).toBe(
          selection.length - run.length,
        )
        const [first] = passes
        if (passes.length === 1 && first !== undefined) {
          expect(standOn(selection, first.since, first.passed, all)).toEqual({
            run: picked.run,
            leftOut: picked.leftOut[0] ?? 0,
            passed: picked.passed,
          })
        }
      }),
    )
  })
})
