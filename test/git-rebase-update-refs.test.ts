import { expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer } from "effect"
import { Git, GitWriter } from "../src/services/Git.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

// A rebase moves only the branch it rebases, whatever the user's rebase.updateRefs says: a backup
// branch, or orchestra's wt/<id>, pointing into the branch's commits stays where it was, as
// putting the branch back resets only the branch. The in-memory layer has no config to follow.

const layer = Git.layer().pipe(
  Layer.provideMerge(GitWriter.layer),
  Layer.provideMerge(BunServices.layer),
)

slow.describe("real git", () => {
  test("a rebase with rebase.updateRefs set moves no other branch, and a put-back restores all", async () => {
    const repo = makeRepo()
    repo.git(["config", "rebase.updateRefs", "true"])
    const worktree = repo.worktree("tutti/b")
    const first = repo.commit("b: First", { "b1.txt": "one\n" }, worktree)
    const second = repo.commit("b: Second", { "b2.txt": "two\n" }, worktree)
    repo.branch("backup", first)
    repo.branch("wt/b", first)
    repo.commit("Main moves on", { "main.txt": "main\n" })

    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.provide(
          Effect.flatMap(Effect.service(Git), (git) =>
            Effect.andThen(git.rebase(worktree, "main"), git.resetBranch(worktree, second)),
          ),
          layer,
        ),
      ),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(repo.head("tutti/b")).toBe(second)
    expect(repo.head("backup")).toBe(first)
    expect(repo.head("wt/b")).toBe(first)
  })
})
