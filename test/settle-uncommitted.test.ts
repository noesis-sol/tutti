import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { listChanges, shownChanges } from "../src/run/settle.ts"
import type { StatusEntry } from "../src/services/Git.ts"
import { allChangeEntries } from "../src/services/gitStatus.ts"

describe("the files CLOSED_UNCOMMITTED names", () => {
  test("each with its git status code, a changed and an untracked file alike", () => {
    const status: ReadonlyArray<StatusEntry> = [
      { code: "??", path: "out/build.bin" },
      { code: " M", path: "src/a.ts" },
      { code: "M ", path: "src/b.ts" },
    ]
    expect(listChanges(allChangeEntries(status))).toEqual({
      shown: ["?? out/build.bin", "M src/a.ts", "M src/b.ts"],
      more: 0,
    })
  })

  test("by path, leaving out .tutti/run/ and ignored files", () => {
    const status: ReadonlyArray<StatusEntry> = [
      { code: "??", path: "z.txt" },
      { code: "??", path: ".tutti/run/prompt.md" },
      { code: "!!", path: "node_modules/x.js" },
      { code: "A ", path: "a.txt" },
    ]
    expect(listChanges(allChangeEntries(status)).shown).toEqual(["A a.txt", "?? z.txt"])
  })

  test("the first five, then how many more", () => {
    const status = Array.from({ length: 8 }, (_, i) => ({ code: "??", path: `f${i}.txt` }))
    expect(listChanges(status)).toEqual({
      shown: ["?? f0.txt", "?? f1.txt", "?? f2.txt", "?? f3.txt", "?? f4.txt"],
      more: 3,
    })
  })

  test("names at most five and counts the rest, for any list", () => {
    const entry = fc.record({
      code: fc.constantFrom("??", " M", "M ", "A ", " D", "R ", "UU"),
      path: fc.string({ minLength: 1 }),
    })
    fc.assert(
      fc.property(fc.array(entry, { maxLength: 20 }), (entries) => {
        const { shown, more } = listChanges(entries)
        expect(shown).toHaveLength(Math.min(entries.length, shownChanges))
        expect(shown.length + more).toBe(entries.length)
        shown.forEach((each, i) => {
          expect(each.endsWith(` ${entries[i]?.path}`)).toBe(true)
        })
      }),
    )
  })
})
