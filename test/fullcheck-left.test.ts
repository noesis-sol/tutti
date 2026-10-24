// The full check's worktrees a killed run left (§ 5 item 12): a run killed while its full check ran
// never removed its worktree, so the next run removes those it finds as it starts, and a ticket's
// worktree is kept whatever its name.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { PlatformError, SystemError } from "effect/PlatformError"
import { fullCheckFolderPrefix, removeLeftFullChecks } from "../src/run/fullcheck.ts"
import { run } from "../src/run/run.ts"
import { Git, GitFailed, GitWriter } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"
import { expectLog, scenario } from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-fullcheck-left-${name}-`)))

/** A folder under `root` named `name`, with a file in it, as a full check's setup leaves one. */
const leftIn = (root: string, name: string): string => {
  const path = join(root, name)
  mkdirSync(join(path, "node_modules"), { recursive: true })
  writeFileSync(join(path, "node_modules", "installed.txt"), "x\n")
  return path
}

/** Runs removeLeftFullChecks in the scenario harness, the Worktrees service wrapped by `wrap`. */
const sweeps = (
  root: string,
  wrap: (live: Worktrees["Service"]) => Worktrees["Service"] = (live) => live,
) => {
  const repo = folder("repo")
  return scenario(
    { config: { repo }, git: { dir: repo }, worktrees: { root } },
    Effect.flatMap(Effect.service(Worktrees), (worktrees) =>
      removeLeftFullChecks.pipe(Effect.provideService(Worktrees, wrap(worktrees))),
    ),
  )
}

describe("the full check's worktrees a killed run left", () => {
  test("are removed as the next run starts, each said; other folders are kept", async () => {
    const repo = folder("repo")
    const root = folder("worktrees")
    const left = leftIn(root, `${fullCheckFolderPrefix}aB3xYz`)
    const ticket = leftIn(root, "t-1")
    const ran = await scenario(
      { config: { repo }, git: { dir: repo }, worktrees: { root } },
      run({ version: "0.1.0-test", base: "main" }),
    )
    expect(ran.exit._tag).toBe("Success")
    expect(existsSync(left)).toBe(false)
    expect(existsSync(ticket)).toBe(true)
    expect(ran.worktreeCalls).toEqual([{ op: "removeDetached", path: left }])
    expectLog(ran, [`  removed the full check's worktree ${left}, which a killed run left`])
  })

  test("none left: nothing is removed or said", async () => {
    const root = folder("worktrees")
    const ran = await sweeps(root)
    expect(ran.exit._tag).toBe("Success")
    expect(ran.worktreeCalls).toEqual([])
    expect(ran.log).toEqual([])
  })

  test("one that can't be removed is a CLEANUP_FAILED warning, and the others are still removed", async () => {
    const root = folder("worktrees")
    const stuck = leftIn(root, `${fullCheckFolderPrefix}a`)
    const other = leftIn(root, `${fullCheckFolderPrefix}b`)
    const ran = await sweeps(root, (live) => ({
      ...live,
      removeDetached: (path) =>
        path === stuck
          ? Effect.fail(
              new GitFailed({
                op: "worktree prune",
                command: "git worktree prune",
                exitCode: 1,
                stderr: "error: unable to prune",
              }),
            )
          : live.removeDetached(path),
    }))
    expect(ran.exit._tag).toBe("Success")
    expect(existsSync(other)).toBe(false)
    const text = `  CLEANUP_FAILED: the full check's worktree ${stuck} is left (error: unable to prune); git worktree remove --force ${stuck} removes it`
    expectLog(ran, [text, `  removed the full check's worktree ${other}, which a killed run left`])
    expect(ran.events.filter((record) => record.kind === "warn")).toEqual([
      expect.objectContaining({ kind: "warn", text }),
    ])
  })

  test("the worktrees' folder can't be read: a CLEANUP_FAILED warning, and the run goes on", async () => {
    const root = folder("worktrees")
    const ran = await sweeps(root, (live) => ({
      ...live,
      leftDetached: () =>
        Effect.fail(
          new PlatformError(
            new SystemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "readDirectory",
              description: "permission denied",
              pathOrDescriptor: root,
            }),
          ),
        ),
    }))
    expect(ran.exit._tag).toBe("Success")
    expectLog(ran, [
      /^ {2}CLEANUP_FAILED: could not look for the full check's worktrees a killed run left \(.*permission denied.*\)$/,
    ])
  })
})

slow.describe("the full check's worktrees a killed run left, in real git", () => {
  test("are found and removed, git forgetting them; a ticket's worktree of the same name is kept", async () => {
    const repo = makeRepo()
    const root = folder("live")
    const layer = Worktrees.layer({ repo: repo.dir, root, base: "main" }).pipe(
      Layer.provideMerge(Git.layer()),
      Layer.provideMerge(GitWriter.layer),
      Layer.provideMerge(BunServices.layer),
    )
    const within = <A, E>(use: (worktrees: Worktrees["Service"]) => Effect.Effect<A, E>) =>
      Effect.runPromise(Effect.provide(Effect.flatMap(Effect.service(Worktrees), use), layer))
    const left = await within((worktrees) => worktrees.addDetached(fullCheckFolderPrefix, "main"))
    repo.write({ "installed.txt": "x\n" }, left)
    const ticket = await within((worktrees) => worktrees.prepare(`${fullCheckFolderPrefix}t`))
    expect(await within((worktrees) => worktrees.leftDetached(fullCheckFolderPrefix))).toEqual([
      left,
    ])
    await within((worktrees) => worktrees.removeDetached(left))
    expect(existsSync(left)).toBe(false)
    expect(existsSync(ticket.path)).toBe(true)
    const listed = repo.git(["worktree", "list", "--porcelain"])
    expect(listed).not.toContain(left)
    expect(listed).toContain(ticket.path)
    expect(await within((worktrees) => worktrees.leftDetached(fullCheckFolderPrefix))).toEqual([])
  })
})
