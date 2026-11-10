// A Go raw string (`…`) runs over its lines (tutti-34k9.10): read as ending at its first newline,
// its body was taken for code, and a /* in it opened a block comment to the end of the file, which
// lost every declaration after it to overlap.ts.
import { describe, expect, test } from "bun:test"
import { codeIn } from "../src/run/codeText.ts"
import { mentionsIn } from "../src/run/overlap.ts"

const words = (text: string): Array<string> => text.match(/[A-Za-z_]\w*/g) ?? []

const file = [
  "package a",
  "",
  "const q = `",
  "SELECT /* all */ x",
  "FROM t WHERE p LIKE 'dir/*'",
  "`",
  "",
  "func mergeQueue() { refreshBranch() }",
  "",
].join("\n")

describe("a Go raw string over several lines", () => {
  test("the functions after it are kept and its words are not code", () => {
    const code = codeIn("a.go", file)
    const kept = words(code)
    expect(kept).toContain("mergeQueue")
    expect(kept).toContain("refreshBranch")
    for (const w of ["SELECT", "all", "x", "FROM", "t", "WHERE", "p", "LIKE", "dir"]) {
      expect(kept).not.toContain(w)
    }
  })

  test("a raw string with a backslash before its close still ends there", () => {
    expect(words(codeIn("a.go", "a(`x \\` + `\ny\n`)\nb()"))).toEqual(["a", "b"])
  })

  test("the mentions of a Go file see a function after a multi-line raw string", () => {
    const mentions = mentionsIn(new Map([["a.go", file]]))
    expect(mentions("a.go", "mergeQueue")).toBe(true)
    expect(mentions("a.go", "refreshBranch")).toBe(true)
    expect(mentions("a.go", "SELECT")).toBe(false)
  })
})
