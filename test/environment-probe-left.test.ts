// The probe's worktrees a killed run left (§ 4.9): a run killed while the environment probe's setup
// ran never removed its probe-setup-* worktree, so the next run removes those it finds as it starts,
// as it does the full check's, and a ticket's worktree is kept.

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { probeFolderPrefix, removeLeftProbes } from "../src/run/environment.ts"
import { fullCheckFolderPrefix } from "../src/run/fullcheck.ts"
import { run } from "../src/run/run.ts"
import { GitFailed } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { expectLog, scenario } from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-probe-left-${name}-`)))

/** A folder under `root` named `name`, with a file in it, as the probe's setup leaves one. */
const leftIn = (root: string, name: string): string => {
  const path = join(root, name)
  mkdirSync(join(path, "node_modules"), { recursive: true })
  writeFileSync(join(path, "node_modules", "installed.txt"), "x\n")
  return path
}

describe("the probe's worktrees a killed run left", () => {
  test("are removed as the next run starts, each said, with the full check's; other folders are kept", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const probe = leftIn(root, `${probeFolderPrefix}aB3xYz`)
    const full = leftIn(root, `${fullCheckFolderPrefix}cD4wVu`)
    const ticket = leftIn(root, "t-1")
    const ran = await scenario(
      { config: { repo }, git: { dir: repo }, worktrees: { root } },
      run({ version: "0.1.0-test", base: "main" }),
    )
    expect(ran.exit._tag).toBe("Success")
    expect(existsSync(probe)).toBe(false)
    expect(existsSync(full)).toBe(false)
    expect(existsSync(ticket)).toBe(true)
    expect(ran.worktreeCalls).toEqual([
      { op: "removeDetached", path: full },
      { op: "removeDetached", path: probe },
    ])
    expectLog(ran, [
      `  removed the full check's worktree ${full}, which a killed run left`,
      `  removed the probe's worktree ${probe}, which a killed run left`,
    ])
  })

  test("one that can't be removed is a CLEANUP_FAILED warning naming the probe's", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const stuck = leftIn(root, `${probeFolderPrefix}a`)
    const ran = await scenario(
      { config: { repo }, git: { dir: repo }, worktrees: { root } },
      Effect.flatMap(Effect.service(Worktrees), (worktrees) =>
        removeLeftProbes.pipe(
          Effect.provideService(Worktrees, {
            ...worktrees,
            removeDetached: () =>
              Effect.fail(
                new GitFailed({
                  op: "worktree prune",
                  command: "git worktree prune",
                  exitCode: 1,
                  stderr: "error: unable to prune",
                }),
              ),
          }),
        ),
      ),
    )
    expect(ran.exit._tag).toBe("Success")
    expect(existsSync(stuck)).toBe(true)
    expectLog(ran, [
      `  CLEANUP_FAILED: the probe's worktree ${stuck} is left (error: unable to prune); git worktree remove --force ${stuck} removes it`,
    ])
  })
})
