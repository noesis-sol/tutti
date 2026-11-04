// What takenBack.ts asks real git (test/taken-back.test.ts has the test layer's): the files a branch
// conflicts in, found by git merge-tree without touching anything, and whether a rebase, merge or
// cherry-pick is under way in a worktree.
import { expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Git, GitWriter } from "../src/services/Git.ts"
import { slow } from "./gates.ts"
import { makeRepo, type Repo } from "./git.ts"

const withGit = <A, E>(effect: (git: Git["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.flatMap(Effect.service(Git), effect).pipe(
      Effect.provide(
        Git.layer({}).pipe(Layer.provide(GitWriter.layer), Layer.provide(BunServices.layer)),
      ),
    ),
  )

/** A branch and main that both changed a.txt and `other file`, and each a file of its own. */
const diverged = (): { readonly repo: Repo; readonly worktree: string } => {
  const repo = makeRepo()
  repo.commit("Start", { "a.txt": "start\n", "other file": "start\n", "keep.txt": "start\n" })
  const worktree = repo.worktree("t")
  repo.commit("Theirs", { "a.txt": "t\n", "other file": "t\n", "t.txt": "t\n" }, worktree)
  repo.commit("Ours", { "a.txt": "m\n", "other file": "m\n", "m.txt": "m\n" })
  return { repo, worktree }
}

/** Runs a command that stops on conflicts: it fails, leaving what it was doing under way. */
const stops = (repo: Repo, args: ReadonlyArray<string>, dir: string) => {
  expect(() => repo.git(args, dir)).toThrow()
}

slow.describe("git merge-tree, for the files a branch conflicts in", () => {
  test("names them, each as it is, and touches nothing", async () => {
    const { repo, worktree } = diverged()
    const head = repo.head()
    const files = await withGit((git) => git.conflicts(repo.dir, "main", "t"))
    expect(files).toEqual(["a.txt", "other file"])
    expect(repo.head()).toBe(head)
    expect(repo.git(["status", "--porcelain"], worktree)).toBe("")
    expect(repo.git(["status", "--porcelain"])).toBe("")
  })

  test("names none for a branch that merges cleanly", async () => {
    const { repo, worktree } = diverged()
    repo.commit("Same", { "a.txt": "m\n", "other file": "m\n" }, worktree)
    expect(await withGit((git) => git.conflicts(repo.dir, "main", "t"))).toEqual([])
  })

  test("fails for what isn't there", async () => {
    const { repo } = diverged()
    const failed = await withGit((git) => Effect.exit(git.conflicts(repo.dir, "main", "nowhere")))
    expect(failed._tag).toBe("Failure")
  })
})

slow.describe("whether a rebase, merge or cherry-pick is under way in a worktree", () => {
  const inProgress = (worktree: string) => withGit((git) => git.operationInProgress(worktree))

  test("none, in a worktree left clean", async () => {
    const { worktree } = diverged()
    expect(await inProgress(worktree)).toBe(false)
  })

  test("a rebase stopped on conflicts", async () => {
    const { repo, worktree } = diverged()
    stops(repo, ["rebase", "main"], worktree)
    expect(await inProgress(worktree)).toBe(true)
    repo.git(["rebase", "--abort"], worktree)
    expect(await inProgress(worktree)).toBe(false)
  })

  test("a merge stopped on conflicts", async () => {
    const { repo, worktree } = diverged()
    stops(repo, ["merge", "main"], worktree)
    expect(await inProgress(worktree)).toBe(true)
  })

  test("a cherry-pick stopped on conflicts", async () => {
    const { repo, worktree } = diverged()
    stops(repo, ["cherry-pick", "main"], worktree)
    expect(await inProgress(worktree)).toBe(true)
  })
})
