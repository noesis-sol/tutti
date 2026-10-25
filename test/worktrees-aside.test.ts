// Worktrees.remove's `aside`: a merged ticket's worktree folder moved into the worktrees' trash
// folder, git's record of it pruned and its branch deleted, the folder given back for deleteAside;
// leftAside lists what is left there. A folder that can't be moved is removed by git, as without it.

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import type { TicketId } from "../src/services/Beads.ts"
import { Git, GitWriter } from "../src/services/Git.ts"
import { trashFolder, Worktrees } from "../src/services/Worktrees.ts"
import { layer as gitLayer, Repository } from "../src/testing/Git.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

const id = "demo-1" as TicketId

describe("setting a worktree aside where it can't be moved", () => {
  test("its folder isn't there: git removes the worktree as without aside, and nothing is given back", async () => {
    const root = "/worktrees"
    const at = join(root, "demo-1")
    const layer = Worktrees.layer({ repo: "/repo", root, base: "main" }).pipe(
      Layer.provideMerge(gitLayer()),
      Layer.provideMerge(BunServices.layer),
    )
    const removed = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* Repository
        const git = yield* Git
        yield* git.addWorktree("/repo", at, { branch: "tutti/demo-1", base: "main" })
        yield* repository.commit(at, "demo-1: Work", { "work.txt": "work\n" })
        yield* git.fastForward("/repo", "tutti/demo-1")
        const from = (yield* repository.calls).length
        const aside = yield* (yield* Worktrees).remove(id, { at, aside: true })
        const ops = (yield* repository.calls).slice(from).map((call) => call.op)
        return { aside, ops, left: yield* git.branchExists("/repo", "tutti/demo-1") }
      }).pipe(Effect.provide(layer)),
    )
    expect(removed.aside).toBeUndefined()
    expect(removed.ops).toEqual(["worktree remove", "show-ref", "branch -d"])
    expect(removed.left).toBe(false)
  })
})

slow.describe("setting a worktree aside in a real repository", () => {
  test("moves its folder into the trash, git forgets it and its branch goes; deleteAside deletes it", async () => {
    const repo = makeRepo()
    const root = join(dirname(repo.dir), "repo-tutti")
    const layer = Worktrees.layer({ repo: repo.dir, root, base: "main" }).pipe(
      Layer.provideMerge(Git.layer()),
      Layer.provideMerge(GitWriter.layer),
      Layer.provideMerge(BunServices.layer),
    )
    const run = <A, E>(effect: (worktrees: Worktrees["Service"]) => Effect.Effect<A, E>) =>
      Effect.runPromise(Effect.provide(Effect.flatMap(Effect.service(Worktrees), effect), layer))

    const worktree = await run((w) => w.prepare(id))
    repo.commit(
      "demo-1: Work",
      { "work.txt": "work\n", ".gitignore": "node_modules/\n" },
      worktree.path,
    )
    repo.git(["merge", "--ff-only", "tutti/demo-1"])
    // What its setup installed, which git ignores.
    mkdirSync(join(worktree.path, "node_modules", "dep"), { recursive: true })
    writeFileSync(join(worktree.path, "node_modules", "dep", "index.js"), "x\n")

    const aside = await run((w) => w.remove(id, { at: worktree.path, aside: true }))
    if (aside === undefined) throw new Error("the worktree was not set aside")
    expect(dirname(aside)).toBe(join(root, trashFolder))
    expect(existsSync(worktree.path)).toBe(false)
    expect(readdirSync(aside)).toEqual(["demo-1"])
    expect(existsSync(join(aside, "demo-1", "node_modules", "dep", "index.js"))).toBe(true)
    expect(repo.git(["worktree", "list", "--porcelain"])).not.toContain("demo-1")
    expect(repo.git(["branch", "--list", "tutti/demo-1"]).trim()).toBe("")
    expect(await run((w) => w.leftAside)).toEqual([aside])

    await run((w) => w.deleteAside(aside))
    expect(existsSync(aside)).toBe(false)
    expect(await run((w) => w.leftAside)).toEqual([])

    // The ticket's worktree can be made again where it was.
    const again = await run((w) => w.prepare(id))
    expect(again).toMatchObject({ path: worktree.path, reused: false, fresh: true })
  })
})
