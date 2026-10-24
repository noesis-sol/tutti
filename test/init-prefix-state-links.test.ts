// tutti init --prefix reads the last run's state.json through the symlink guard (§ 9.1), as the
// Store does: a merged ticket can leave a symbolic link at .tutti/run or state.json, and init
// doesn't read through it to tell whether the last run left workers. A link is a reason of its own
// not to rename the tickets, naming the link and quoting nothing of what it points at.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import type { Machine } from "../src/init/steps.ts"
import { prefixRefusal } from "../src/init/workers.ts"
import { stateFile, statePath } from "../src/services/Store.ts"
import * as TestBeads from "../src/testing/Beads.ts"

/** A main checkout, and a folder outside it with a state of workers a link can point at. */
const places = () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-prefix-links-")))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "tutti-prefix-links-outside-")))
  mkdirSync(join(repo, ".git"))
  const target = join(outside, "state.json")
  writeFileSync(target, JSON.stringify({ version: 1, tickets: { "secret-1": {} } }))
  return { repo, outside, target }
}

/** A machine with no branches, answering every command with nothing. */
const machine: Machine = {
  run: () => Effect.succeed(""),
  which: () => null,
  env: () => undefined,
  platform: "darwin",
  executable: () => false,
}

const refusal = async (repo: string): Promise<string | null> => {
  const exit = await Effect.runPromiseExit(
    prefixRefusal(machine, repo).pipe(Effect.provide(TestBeads.layer([]))),
  )
  if (Exit.isFailure(exit)) throw new Error(`expected a success, got ${exit.cause}`)
  return exit.value
}

describe("init --prefix reading state.json", () => {
  test("a link at state.json is a reason of its own, quoting nothing behind it", async () => {
    const { repo, target } = places()
    mkdirSync(join(repo, ".tutti", "run"), { recursive: true })
    symlinkSync(target, statePath(repo))
    const why = await refusal(repo)
    expect(why).toBe(
      `${statePath(repo)} can't be read: ${stateFile} under ${repo}: ${stateFile} is a symbolic link`,
    )
    expect(why).not.toContain("secret-1")
    expect(why).not.toContain("workers")
  })

  test("a link at .tutti/run is a reason of its own too", async () => {
    const { repo, outside } = places()
    mkdirSync(join(repo, ".tutti"))
    symlinkSync(outside, join(repo, ".tutti", "run"))
    const why = await refusal(repo)
    expect(why).toContain(`${join(".tutti", "run")} is a symbolic link`)
    expect(why).not.toContain("secret-1")
  })

  test("no .tutti, no .tutti/run or no state.json carries nothing", async () => {
    const { repo } = places()
    expect(await refusal(repo)).toBeNull()
    mkdirSync(join(repo, ".tutti"))
    expect(await refusal(repo)).toBeNull()
    mkdirSync(join(repo, ".tutti", "run"))
    expect(await refusal(repo)).toBeNull()
  })

  test("a regular state.json with workers still refuses the rename", async () => {
    const { repo } = places()
    mkdirSync(join(repo, ".tutti", "run"), { recursive: true })
    writeFileSync(statePath(repo), JSON.stringify({ tickets: { "tutti-1": {} } }))
    expect(await refusal(repo)).toBe(
      `the last run left workers in ${stateFile}, which the next run carries on with`,
    )
  })
})
