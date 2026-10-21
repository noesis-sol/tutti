// The worker prompt's Removals rule (§ 4.11): orchestra's rule against removing a target built from
// a variable or a glob stays, with tutti's reason, and with what the worker does instead.
import { describe, expect, test } from "bun:test"
import { builtInWorkerPrompt, forTicket } from "../src/project/prompt.ts"

/** The prompt a worker on `bd-7` is given, its line breaks and indents folded to single spaces. */
const rules = forTicket({ text: builtInWorkerPrompt, file: null }, "bd-7").replace(/\s+/g, " ")

describe("the worker prompt's Removals rule", () => {
  test("never removes a target built from a variable or a glob, with orchestra's examples", () => {
    expect(rules).toContain("Never `rm` a target built from a variable or a glob")
    expect(rules).toContain("(`rm -f $S/*`, `rm -f $f`, `rm -f *`)")
  })

  test("gives tutti's reason: the safety check refuses it unless a person approves it", () => {
    expect(rules).toContain(
      "Claude Code's safety check refuses such a removal unless a person approves it",
    )
    expect(rules).toContain("in auto mode refuses it outright")
  })

  test("overwrites, writes to a new name, or removes a file by its literal absolute path", () => {
    expect(rules).toContain("Overwrite instead (`-y`, `>`) or write to a new name")
    expect(rules).toContain("a file that must go is removed by its literal absolute path")
    expect(rules).toContain("Tell any subagent you start the same.")
  })
})
