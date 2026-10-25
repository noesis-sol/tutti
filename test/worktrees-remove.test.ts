// Worktrees.remove's git calls, the live layer over the in-memory repository: given `at`, the
// ticket's worktree is removed there without the worktrees listed first, and looked for only when
// git can't remove it there; git forgets worktrees whose folder was deleted only when no worktree
// has the branch.

import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { layer as gitLayer, Repository } from "../src/testing/Git.ts"

const root = "/worktrees"
const at = join(root, "demo-1")

const layer = Worktrees.layer({ repo: "/repo", root, base: "main" }).pipe(
  Layer.provideMerge(gitLayer()),
  Layer.provideMerge(BunServices.layer),
)

/**
 * Makes demo-1's worktree and merges its branch, runs `before` on the repository, then `remove`:
 * the operations of the git calls the removal made, and whether the branch is left.
 */
const removing = (
  remove: (worktrees: Worktrees["Service"]) => Effect.Effect<void, unknown>,
  before: (repository: Repository["Service"]) => Effect.Effect<void> = () => Effect.void,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const repository = yield* Repository
      const git = yield* Git
      yield* git.addWorktree("/repo", at, { branch: "tutti/demo-1", base: "main" })
      yield* repository.commit(at, "demo-1: Work", { "work.txt": "work\n" })
      yield* git.fastForward("/repo", "tutti/demo-1")
      yield* before(repository)
      const from = (yield* repository.calls).length
      yield* remove(yield* Worktrees)
      const ops = (yield* repository.calls).slice(from).map((call) => call.op)
      const left = yield* git.branchExists("/repo", "tutti/demo-1")
      const listed = (yield* git.worktrees("/repo")).map((worktree) => worktree.path)
      return { ops, left, listed }
    }).pipe(Effect.provide(layer)),
  )

describe("removing a ticket's worktree and branch", () => {
  test("at its worktree: removed there, nothing listed or pruned", async () => {
    const removed = await removing((w) => w.remove("demo-1" as TicketId, { at }))
    expect(removed.ops).toEqual(["worktree remove", "show-ref", "branch -d"])
    expect(removed.left).toBe(false)
    expect(removed.listed).toEqual(["/repo"])
  })

  test("without at: looked for, removed, nothing pruned", async () => {
    const removed = await removing((w) => w.remove("demo-1" as TicketId))
    expect(removed.ops).toEqual(["worktree list", "worktree remove", "show-ref", "branch -d"])
    expect(removed.left).toBe(false)
  })

  test("its folder deleted: no worktree has the branch, so git forgets it, then the branch goes", async () => {
    const removed = await removing(
      (w) => w.remove("demo-1" as TicketId),
      (repository) => repository.removeFolder(at),
    )
    expect(removed.ops).toEqual(["worktree list", "worktree prune", "show-ref", "branch -d"])
    expect(removed.left).toBe(false)
    expect(removed.listed).toEqual(["/repo"])
  })

  test("at a folder that isn't its worktree: looked for, and removed where it is", async () => {
    const removed = await removing((w) =>
      w.remove("demo-1" as TicketId, { at: join(root, "elsewhere") }),
    )
    expect(removed.ops).toEqual([
      "worktree remove",
      "worktree list",
      "worktree remove",
      "show-ref",
      "branch -d",
    ])
    expect(removed.left).toBe(false)
    expect(removed.listed).toEqual(["/repo"])
  })

  test("at its worktree with changes: git's refusal is the failure, the branch kept", async () => {
    const exit = await removing(
      (w) => Effect.flip(w.remove("demo-1" as TicketId, { at })),
      (repository) => repository.write(at, { "work.txt": "changed\n" }),
    )
    expect(exit.ops).toEqual(["worktree remove", "worktree list", "worktree remove"])
    expect(exit.left).toBe(true)
  })
})
