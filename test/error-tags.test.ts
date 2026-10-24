// Every tagged error in src/ has a tag of its own: a catchTag for one error mustn't also catch
// another that happens to share its name, as main's catchTag("CommandFailed") once could exec's.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { CommandFailed } from "../src/cli/commands.ts"
import { CommandExitedNonZero } from "../src/services/exec.ts"

const src = resolve(import.meta.dir, "../src")

/** The tags of the tagged errors defined in src/, with the file each is defined in. */
const tags = (): ReadonlyArray<{ readonly tag: string; readonly file: string }> =>
  Array.from(new Bun.Glob("**/*.{ts,tsx}").scanSync(src)).flatMap((file) =>
    Array.from(
      readFileSync(join(src, file), "utf8").matchAll(/TaggedError<\w+>\(\)\(\s*"(\w+)"/g),
      (match) => ({ tag: match[1] ?? "", file }),
    ),
  )

describe("tagged errors", () => {
  test("no two in src/ share a tag", () => {
    const found = tags()
    expect(found.length).toBeGreaterThan(0)
    const shared = found.filter(({ tag }) => found.filter((other) => other.tag === tag).length > 1)
    expect(shared).toEqual([])
  })

  test("a subcommand's failure and a command's non-zero exit are told apart", () => {
    expect(new CommandFailed({ command: "login" })._tag).toBe("CommandFailed")
    expect(new CommandExitedNonZero({ command: "git status", exitCode: 1, stderr: "" })._tag).toBe(
      "CommandExitedNonZero",
    )
  })
})
