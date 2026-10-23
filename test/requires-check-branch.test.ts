// requires_check runs only the main checkout's entries, in the main checkout (§ 4.11,
// src/agent/requiresTools.ts's checkIn): an entry the worker's branch adds or changes is the
// worker's to write, so its commands are given back to run with Bash, where the permission mode
// sees them, rather than run by tutti behind a permission request that shows only their names.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import fc from "fast-check"
import { checkIn, makeRequiresTools, yoursToRun } from "../src/agent/requiresTools.ts"
import type { Requirement } from "../src/project/settings.ts"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

/** A checkout at a temp folder with `requires` in its settings (`settings` as written, if given). */
const checkout = (requires: ReadonlyArray<Requirement>, settings?: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-requires-branch-")))
  mkdirSync(join(dir, ".tutti"))
  writeFileSync(join(dir, ".tutti", "settings.json"), settings ?? JSON.stringify({ requires }))
  return dir
}

const said = (answer: { content: ReadonlyArray<unknown>; isError?: boolean | undefined }) =>
  answer.content.map((c) => (c as { text: string }).text).join("\n")

const handBack =
  "tutti runs only the entries the main checkout's list has; run those your branch adds or changes with Bash, so that the permission mode sees what runs."

/** An entry whose check and install each leave a file behind in the folder they run in. */
const tell = (name: string, install = `touch ${name}-installed`): Requirement => ({
  name,
  check: `touch ${name}-checked; false`,
  install,
})

describe("requires_check on a branch's entries", () => {
  test("an entry the branch adds isn't run: its commands are given back for Bash", async () => {
    const repo = checkout([])
    const worktree = checkout([tell("x")])
    expect(said(await run(checkIn(repo, worktree, { names: ["x"] })))).toBe(
      "x: new on your branch, so tutti doesn't run it: run its check with Bash, 'touch x-checked; false'; where it fails, its install, 'touch x-installed', then the check again\n" +
        handBack,
    )
    for (const dir of [repo, worktree]) {
      expect(existsSync(join(dir, "x-checked"))).toBe(false)
      expect(existsSync(join(dir, "x-installed"))).toBe(false)
    }
  })

  test("an entry the branch changes isn't run either", async () => {
    const repo = checkout([tell("x")])
    const worktree = checkout([tell("x", "touch x-other")])
    expect(said(await run(checkIn(repo, worktree, {})))).toBe(
      "x: changed on your branch, so tutti doesn't run it: run its check with Bash, 'touch x-checked; false'; where it fails, its install, 'touch x-other', then the check again\n" +
        handBack,
    )
    for (const dir of [repo, worktree]) {
      expect(existsSync(join(dir, "x-checked"))).toBe(false)
      expect(existsSync(join(dir, "x-other"))).toBe(false)
    }
  })

  test("the main checkout's entries run there, beside the branch's given back", async () => {
    const made: Requirement = { name: "made", check: "test -f made", install: "touch made" }
    const repo = checkout([made])
    const worktree = checkout([made, tell("x")])
    expect(said(await run(checkIn(repo, worktree, {})))).toBe(
      "made: installed with 'touch made'\n" +
        "x: new on your branch, so tutti doesn't run it: run its check with Bash, 'touch x-checked; false'; where it fails, its install, 'touch x-installed', then the check again\n" +
        handBack,
    )
    expect(existsSync(join(repo, "made"))).toBe(true)
    expect(existsSync(join(repo, ".tutti", "run", "requires-made.log"))).toBe(true)
    expect(existsSync(join(worktree, "made"))).toBe(false)
  })

  test("a main checkout's entry runs the main checkout's files, not the branch's", async () => {
    const entry: Requirement = { name: "tool", check: "sh check.sh", install: "true" }
    const repo = checkout([entry])
    const worktree = checkout([entry])
    writeFileSync(join(repo, "check.sh"), "exit 0\n")
    writeFileSync(join(worktree, "check.sh"), "touch ran-the-branch; exit 0\n")
    expect(said(await run(checkIn(repo, worktree, {})))).toBe("tool: met")
    expect(existsSync(join(repo, "ran-the-branch"))).toBe(false)
    expect(existsSync(join(worktree, "ran-the-branch"))).toBe(false)
  })

  test("no_install gives back only the check, and a manual step is the maintainer's", async () => {
    const repo = checkout([])
    const manual: Requirement = { name: "m", check: "false", manual: "turn on Screen Recording" }
    const worktree = checkout([tell("x"), manual])
    expect(said(await run(checkIn(repo, worktree, { no_install: true })))).toBe(
      "x: new on your branch, so tutti doesn't run it: run its check with Bash, 'touch x-checked; false'\n" +
        "m: new on your branch, so tutti doesn't run it: run its check with Bash, 'false'\n" +
        handBack,
    )
    expect(said(await run(checkIn(repo, worktree, { names: ["m"] })))).toBe(
      "m: new on your branch, so tutti doesn't run it: run its check with Bash, 'false'; where it fails, ask the maintainer for its manual step: turn on Screen Recording\n" +
        handBack,
    )
  })

  test("a branch's entry for another system is only not checked", async () => {
    const other = process.platform === "darwin" ? "linux" : "darwin"
    const repo = checkout([])
    const worktree = checkout([{ ...tell("x"), platforms: [other] }])
    expect(said(await run(checkIn(repo, worktree, {})))).toBe(`x: not checked: only on ${other}`)
  })

  test("with the main checkout's settings unreadable, tutti runs nothing", async () => {
    const repo = checkout([], "{ not json")
    const worktree = checkout([tell("x")])
    expect(said(await run(checkIn(repo, worktree, {})))).toContain("x: new on your branch")
    expect(existsSync(join(worktree, "x-checked"))).toBe(false)
  })

  test("the worker's server answers so too", async () => {
    const repo = checkout([])
    const worktree = checkout([tell("x")])
    const tools = await run(makeRequiresTools(repo, worktree))
    const check = tools.tools[0]
    if (check === undefined) throw new Error("no requires_check")
    expect(said(await check.handler({}, {}))).toContain("x: new on your branch")
    expect(existsSync(join(worktree, "x-checked"))).toBe(false)
  })

  test("what is given back holds the entry's commands as written", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string({ minLength: 1 }),
        fc.boolean(),
        (check, install, noInstall) => {
          const text = yoursToRun({ name: "x", check, install }, "new", noInstall)
          expect(text).toContain(`'${check}'`)
          expect(text.includes(`'${install}', then the check again`)).toBe(!noInstall)
        },
      ),
    )
  })
})
