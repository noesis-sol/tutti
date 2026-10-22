import { describe, expect, test } from "bun:test"
import { exitCodes, exitMeanings, stopCodes } from "../src/run/holds.ts"
import { exitMeaning } from "../src/run/report.ts"

describe("exitMeaning", () => {
  test("has a meaning for every exit code", () => {
    expect(Object.keys(exitMeanings).sort()).toEqual(Object.keys(exitCodes).sort())
    for (const code of Object.values(exitCodes)) {
      expect(exitMeaning(code)).not.toBe("unknown")
    }
  })

  test("names each stop word in its code's meaning", () => {
    for (const [word, code] of Object.entries(stopCodes)) {
      expect(exitMeaning(code)).toContain(word)
    }
  })

  test("says what 2 means: a requirement missing partway", () => {
    expect(exitMeaning(2)).toContain("REQUIREMENTS_MISSING")
  })

  test("names all of 4's causes", () => {
    const meaning = exitMeaning(4)
    for (const word of [
      "BEADS_FAILED",
      "GIT_FAILED",
      "AGENT_FAILED",
      "WORKTREE_FAILED",
      "STATE_UNWRITABLE",
      "PANIC",
    ]) {
      expect(meaning).toContain(word)
    }
  })

  test("a code no run ends with is unknown", () => {
    expect(exitMeaning(1)).toBe("unknown")
  })
})
