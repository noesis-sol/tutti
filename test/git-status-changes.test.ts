// The one reading of a git status the run's checks share: the tracked changes git won't rebase
// over, the untracked files a check sees but a merge leaves out, every change a worktree's removal
// would lose, and the changes that keep the main checkout from being clean.

import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import type { StatusEntry } from "../src/services/Git.ts"
import {
  allChangeEntries,
  allChanges,
  checkoutChanges,
  trackedChanges,
  untrackedFiles,
} from "../src/services/gitStatus.ts"

const status: ReadonlyArray<StatusEntry> = [
  { code: "??", path: "z.ts" },
  { code: " M", path: "a.txt" },
  { code: "R ", path: "c.ts", from: "old.ts" },
  { code: "!!", path: "node_modules/x" },
  { code: "??", path: ".tutti/run/state.json" },
  { code: " M", path: ".tutti/run" },
  { code: "??", path: ".tutti/runner.txt" },
  { code: "??", path: ".beads/issues.jsonl" },
  { code: " M", path: ".orchestra/run/state.json" },
  { code: "??", path: "b.ts" },
]

describe("a worktree's changes", () => {
  test("trackedChanges: the tracked files changed outside .tutti/run/, sorted", () => {
    expect(trackedChanges(status)).toEqual([".orchestra/run/state.json", "a.txt", "c.ts"])
  })

  test("untrackedFiles: the untracked files outside .tutti/run/, sorted", () => {
    expect(untrackedFiles(status)).toEqual([
      ".beads/issues.jsonl",
      ".tutti/runner.txt",
      "b.ts",
      "z.ts",
    ])
  })

  test("allChanges: both, sorted, with no ignored file", () => {
    expect(allChanges(status)).toEqual([
      ".beads/issues.jsonl",
      ".orchestra/run/state.json",
      ".tutti/runner.txt",
      "a.txt",
      "b.ts",
      "c.ts",
      "z.ts",
    ])
    expect(allChangeEntries(status).find((entry) => entry.path === "c.ts")).toEqual({
      code: "R ",
      path: "c.ts",
      from: "old.ts",
    })
  })

  test("every change is tracked or untracked, never both", () => {
    const entry = fc.record({
      code: fc.constantFrom("??", "!!", " M", "M ", "A ", "R ", "UU", " D"),
      path: fc.constantFrom("a", "b/c", ".tutti/run", ".tutti/run/x", ".tutti/runs", ".beads/x"),
    })
    fc.assert(
      fc.property(fc.array(entry), (entries) => {
        const both = [...trackedChanges(entries), ...untrackedFiles(entries)].sort()
        expect(both).toEqual([...allChanges(entries)])
        expect(allChanges(entries).some((path) => path.startsWith(".tutti/run/"))).toBe(false)
      }),
    )
  })
})

describe("the main checkout's changes", () => {
  test("checkoutChanges: every change outside the tools' folders, untracked ones included", () => {
    expect(checkoutChanges(status)).toEqual([".tutti/runner.txt", "a.txt", "b.ts", "c.ts", "z.ts"])
  })
})
