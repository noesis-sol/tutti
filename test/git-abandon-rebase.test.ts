// Git.abandonRebase, which the merge queue, a train and a hand-back share: a rebase left stopped on
// conflicts is aborted, its branch put back as it was; with none under way, nothing is done.
import { expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Option } from "effect"
import { Git, GitWriter } from "../src/services/Git.ts"
import { slow } from "./gates.ts"
import { makeRepo, type Repo } from "./git.ts"

const run = <A, E>(effect: Effect.Effect<A, E, Git>): Promise<A> =>
  Effect.runPromise(
    Effect.provide(
      effect,
      Git.layer({}).pipe(
        Layer.provideMerge(GitWriter.layer),
        Layer.provideMerge(BunServices.layer),
      ),
    ),
  )

/** A ticket branch in a worktree changing `shared.txt`, while main changed it otherwise. */
const conflicting = (repo: Repo) => {
  repo.commit("Shared", { "shared.txt": "one\n" })
  const worktree = repo.worktree("tutti/a")
  repo.commit("Do a (a)", { "shared.txt": "ticket\n" }, worktree)
  repo.commit("Move main", { "shared.txt": "main\n" })
  return { worktree, before: repo.head("HEAD", worktree) }
}

/** What git says of the worktree once abandonRebase has run there. */
const afterAbandon = (worktree: string) =>
  Effect.gen(function* () {
    const git = yield* Git
    yield* git.abandonRebase(worktree)
    return {
      inProgress: yield* git.rebaseInProgress(worktree),
      branch: yield* git.currentBranch(worktree),
      status: yield* git.status(worktree),
    }
  })

slow.describe("Git.abandonRebase", () => {
  test("aborts a rebase stopped on conflicts, its branch as it was", async () => {
    const repo = makeRepo()
    const { worktree, before } = conflicting(repo)
    const after = await run(
      Effect.gen(function* () {
        const git = yield* Git
        const stopped = yield* Effect.flip(git.rebase(worktree, "main"))
        expect(stopped._tag).toBe("RebaseConflict")
        expect(yield* git.rebaseInProgress(worktree)).toBe(true)
        return yield* afterAbandon(worktree)
      }),
    )
    expect(after).toEqual({ inProgress: false, branch: Option.some("tutti/a"), status: [] })
    expect(repo.head("tutti/a")).toBe(before)
  })

  test("with no rebase under way, leaves the branch as it is", async () => {
    const repo = makeRepo()
    const { worktree, before } = conflicting(repo)
    const after = await run(afterAbandon(worktree))
    expect(after).toEqual({ inProgress: false, branch: Option.some("tutti/a"), status: [] })
    expect(repo.head("tutti/a")).toBe(before)
  })
})
