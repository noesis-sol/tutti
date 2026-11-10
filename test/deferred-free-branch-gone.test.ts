// DEFERRED_FREE names a deferred ticket's worktree left detached whose branch is gone too (a
// worker's `git checkout --detach` then `git branch -D`, a case Worktrees.prepare handles by making
// the branch again at the worktree's HEAD): the HEAD's commits alone are counted, as `git log
// <base>..tutti/<id>` fails without the branch, and the cleanup command removes the worktree alone,
// as `git branch -d` of a missing branch fails (tutti-v6w1). Before, that log's failure left the
// worktree unreported: no `safe to remove` nor `holds uncommitted changes` part on the line.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import * as free from "../src/run/deferredFree.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import type { Seed } from "../src/testing/Beads.ts"
import { Repository } from "../src/testing/Git.ts"
import { scenario } from "./harness.ts"

const folder = (name: string) => mkdtempSync(join(tmpdir(), `tutti-branch-gone-${name}-`))

/** Detaches the worktree at `path` and deletes the ticket's branch, as a worker may leave it. */
const detachAndDeleteBranch = (repo: string, path: string, id: string) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    yield* repository.checkout(path, yield* repository.head("HEAD", path))
    yield* (yield* Git).deleteBranch(repo, `tutti/${id}`, { force: true })
  })

describe("DEFERRED_FREE names a detached worktree whose branch is gone", () => {
  test("safe to remove when empty, kept with uncommitted changes or commits at its HEAD", async () => {
    const repo = "/repo"
    const root = realpathSync(folder("root"))
    const seeds: ReadonlyArray<Seed> = [
      { id: "b-1", status: "closed" },
      { id: "empty", status: "deferred", blockedBy: ["b-1"] },
      { id: "dirty", status: "deferred", blockedBy: ["b-1"] },
      { id: "ahead", status: "deferred", blockedBy: ["b-1"] },
    ]
    const freeing: free.Freeing = {
      repo,
      base: "main",
      filter: { excludeTypes: [] },
      inScope: () => true,
      pending: free.startPending(new Set(), new Set()),
    }
    const ran = await scenario(
      { backlog: seeds, git: { dir: repo }, worktrees: { root } },
      Effect.gen(function* () {
        const git = yield* Git
        const repository = yield* Repository
        for (const id of ["empty", "dirty", "ahead"]) {
          const at = join(root, id)
          yield* git.addWorktree(repo, at, { branch: `tutti/${id}`, base: "main" })
          yield* detachAndDeleteBranch(repo, at, id)
        }
        yield* repository.write(join(root, "dirty"), { "a.ts": "a" })
        // A commit at its detached HEAD, the only place it can be with the branch gone.
        yield* repository.commit(join(root, "ahead"), "ahead", { "b.ts": "b" })
        const branches = yield* git.branches(repo, "tutti")
        return { branches, free: yield* free.list(freeing, yield* (yield* Beads).list()) }
      }),
    )
    if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
    const blockers = ["b-1" as TicketId]
    expect(ran.exit.value.branches).toEqual([])
    expect([...ran.exit.value.free].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "ahead" as TicketId, blockers },
      { id: "dirty" as TicketId, blockers, uncommitted: join(root, "dirty"), branchGone: true },
      { id: "empty" as TicketId, blockers, worktree: join(root, "empty"), branchGone: true },
    ])
  })

  test("the cleanup command removes the worktree alone, with no git branch -d", () => {
    const base = { id: "k-4" as TicketId, blockers: ["k-2" as TicketId] }
    const d: free.DeferredFree = { ...base, worktree: "/wt/k 4", branchGone: true }
    expect(free.cleanup(d)).toBe("git worktree remove '/wt/k 4'")
    expect(free.cleanup({ ...base, worktree: "/wt/k 4" })).toBe(
      "git worktree remove '/wt/k 4' && git branch -d tutti/k-4",
    )
    expect(free.startLine(d, "main")).toBe(
      "DEFERRED_FREE: k-4: its blockers have merged (k-2); to run it: bd update k-4 --status open; " +
        "its worktree has no commits beyond main, safe to remove: git worktree remove '/wt/k 4'",
    )
    // With uncommitted changes the branch's absence changes nothing: the status command is the same.
    expect(free.startLine({ ...base, uncommitted: "/wt/k-4", branchGone: true }, "main")).toBe(
      "DEFERRED_FREE: k-4: its blockers have merged (k-2); to run it: bd update k-4 --status open; " +
        "its worktree holds uncommitted changes, not safe to remove: git -C /wt/k-4 status",
    )
  })
})
