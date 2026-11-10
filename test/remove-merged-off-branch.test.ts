// A ticket merged by hand whose worktree is left off its branch (detached, on another branch) has
// its branch removed with the worktree (tutti-zvnd): removeMerged (merge.ts) asks restoreBranch to
// move the branch to the base first, which can't reset a branch its worktree doesn't have checked
// out (OffBranch), so the branch kept its commits, git refused to delete it as not merged, and the
// line ended CLEANUP_FAILED for a branch nothing held. Now the branch is moved from the main
// checkout instead (Git.moveBranch, `git branch --force`), which git refuses only for a branch a
// worktree has checked out. Git.moveBranch is tried against the in-memory Git and real git.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer, ManagedRuntime } from "effect"
import { byHand } from "../src/run/handMerged.ts"
import { type Cleanup, removeMerged } from "../src/run/merge.ts"
import { Trash } from "../src/run/trash.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git, GitFailed, GitWriter, type Sha } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { layer as memoryLayer, Repository } from "../src/testing/Git.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

/** A repository on `main` and a Git service over it. */
interface Fixture {
  readonly dir: string
  /** A path beside the repository for a new worktree. */
  path(name: string): string
  /** Commits the files in dir (the main checkout by default); the commit's hash. */
  commit(message: string, files: Readonly<Record<string, string>>, dir?: string): Sha
  /** Detaches the worktree at dir: HEAD at its commit, on no branch. */
  detach(dir: string): void
  head(rev: string): Sha
  git<A, E>(use: (git: Git["Service"]) => Effect.Effect<A, E>): Promise<Exit.Exit<A, E>>
}

const realFixture = (): Fixture => {
  const repo = makeRepo()
  const layer = Git.layer().pipe(
    Layer.provideMerge(GitWriter.layer),
    Layer.provideMerge(BunServices.layer),
  )
  return {
    dir: repo.dir,
    path: (name) => join(dirname(repo.dir), name),
    commit: (message, files, dir) => repo.commit(message, files, dir),
    detach: (dir) => void repo.git(["checkout", "--quiet", "--detach"], dir),
    head: (rev) => repo.head(rev),
    git: (use) =>
      Effect.runPromise(
        Effect.exit(Effect.flatMap(Effect.service(Git), use)).pipe(Effect.provide(layer)),
      ),
  }
}

const memoryFixture = (): Fixture => {
  const root = "/memory-move-branch"
  const runtime = ManagedRuntime.make(memoryLayer({ dir: join(root, "repo") }))
  const repository = runtime.runSync(Effect.service(Repository))
  const sync = <A>(effect: Effect.Effect<A, unknown, Git | GitWriter | Repository>) =>
    runtime.runSync(effect)
  return {
    dir: repository.dir,
    path: (name) => join(root, name),
    commit: (message, files, dir = repository.dir) => sync(repository.commit(dir, message, files)),
    detach: (dir) => sync(repository.checkout(dir, sync(repository.head("HEAD", dir)))),
    head: (rev) => sync(repository.head(rev)),
    git: (use) => runtime.runPromise(Effect.exit(Effect.flatMap(Effect.service(Git), use))),
  }
}

const success = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected a success, got ${exit.cause}`)
  return exit.value
}

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (error === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  return error.error
}

const moveBranchExpectations = (fixture: () => Fixture) => {
  /** A worktree on tutti/a with a commit of its own, and main moved on since. */
  const arranged = async () => {
    const repo = fixture()
    const worktree = repo.path("a")
    success(
      await repo.git((git) =>
        git.addWorktree(repo.dir, worktree, { branch: "tutti/a", base: "main" }),
      ),
    )
    const own = repo.commit("Do a (a)", { "a.txt": "a\n" }, worktree)
    const base = repo.commit("Squash-merge a (a)", { "a.txt": "a\n" })
    return { repo, worktree, own, base }
  }

  test("moves a branch no worktree has checked out to the rev, the worktree left as it is", async () => {
    const { repo, worktree, base } = await arranged()
    repo.detach(worktree)
    success(await repo.git((git) => git.moveBranch(repo.dir, "tutti/a", "main")))
    expect(repo.head("tutti/a")).toBe(base)
    expect(success(await repo.git((git) => git.currentBranch(worktree)))._tag).toBe("None")
    // Merged now, as git sees it: deleted unforced.
    success(await repo.git((git) => git.deleteBranch(repo.dir, "tutti/a")))
    expect(success(await repo.git((git) => git.branchExists(repo.dir, "tutti/a")))).toBe(false)
  })

  test("refuses a branch a worktree has checked out, the branch left where it was", async () => {
    const { repo, own } = await arranged()
    const error = failure(await repo.git((git) => git.moveBranch(repo.dir, "tutti/a", "main")))
    expect(error).toBeInstanceOf(GitFailed)
    expect(error).toMatchObject({ op: "branch -f" })
    expect((error as GitFailed).stderr).toMatch(/cannot force update/i)
    expect(repo.head("tutti/a")).toBe(own)
  })

  test("refuses a rev that names nothing, the branch left where it was", async () => {
    const { repo, worktree, own } = await arranged()
    repo.detach(worktree)
    const error = failure(await repo.git((git) => git.moveBranch(repo.dir, "tutti/a", "nothing")))
    expect(error).toBeInstanceOf(GitFailed)
    expect(repo.head("tutti/a")).toBe(own)
  })
}

describe("Git.moveBranch over the in-memory Git", () => moveBranchExpectations(memoryFixture))

slow.describe("Git.moveBranch over real git", () => moveBranchExpectations(realFixture))

describe("removeMerged, of a ticket merged by hand whose worktree is off its branch", () => {
  const id = "a" as TicketId
  const branch = "tutti/a"
  const folder = (name: string) => mkdtempSync(join(tmpdir(), `tutti-remove-merged-${name}-`))
  // Nothing was left running in the worktree, and nothing is deleted in the background.
  const trash = Layer.succeed(
    Trash,
    Trash.of({
      delete: () => Effect.void,
      clearLeft: Effect.void,
      stopLeft: () => Effect.void,
      settled: Effect.void,
    }),
  )

  interface Removed {
    readonly cleanup: Cleanup
    /** Whether git still has the branch, and the other one a test checks out in the worktree. */
    readonly branchLeft: boolean
    readonly mineLeft: boolean
    /** The worktrees git lists after, by path. */
    readonly worktrees: ReadonlyArray<string>
    readonly log: ReadonlyArray<string>
  }

  /**
   * a's worktree at <root>/a on tutti/a, with a commit of its own squash-merged onto main by hand;
   * `leave` leaves the worktree as the test wants it, then removeMerged removes it as byHand asks.
   * The worktree has no folder: the in-memory Git sees none moved aside, so git removes it.
   */
  const removed = (
    leave: (worktree: string) => Effect.Effect<void, unknown, Git | Repository>,
  ): Promise<Removed> => {
    const repo = realpathSync(folder("repo"))
    const root = folder("root")
    const real = realpathSync(root)
    const at = join(real, id)
    const layer = Layer.mergeAll(
      Worktrees.layer({ repo, root, base: "main" }),
      trash,
      logLayer(),
    ).pipe(Layer.provideMerge(memoryLayer({ dir: repo })), Layer.provideMerge(BunServices.layer))
    return Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* Git
        const repository = yield* Repository
        yield* git.addWorktree(repo, at, { branch, base: "main" })
        yield* repository.commit(at, "Do a (a)", { "a/a.go": "a\n" })
        yield* repository.commit(repo, "Squash-merge a (a)", { "a/a.go": "a\n" })
        yield* leave(at)
        const cleanup = yield* removeMerged(
          { id, branch, worktree: at },
          { repo, base: "main" },
          byHand,
        )
        return {
          cleanup,
          branchLeft: yield* git.branchExists(repo, branch),
          mineLeft: yield* git.branchExists(repo, "mine"),
          worktrees: (yield* git.worktrees(repo)).map((worktree) => worktree.path),
          log: yield* texts,
        }
      }).pipe(Effect.provide(layer)),
    )
  }

  const detach = (worktree: string) =>
    Effect.gen(function* () {
      const repository = yield* Repository
      yield* repository.checkout(worktree, yield* repository.head("HEAD", worktree))
    })

  test("left detached: the worktree and the branch are removed", async () => {
    const ran = await removed(detach)
    expect(ran.cleanup).toEqual({ _tag: "Removed" })
    expect(ran.branchLeft).toBe(false)
    expect(ran.worktrees).toHaveLength(1)
    expect(ran.log).toEqual([])
  })

  test("left on another branch: the same, the other branch kept", async () => {
    const ran = await removed((worktree) =>
      Effect.gen(function* () {
        const git = yield* Git
        yield* git.checkout(worktree, "mine", { create: true })
      }),
    )
    expect(ran.cleanup).toEqual({ _tag: "Removed" })
    expect(ran.branchLeft).toBe(false)
    expect(ran.worktrees).toHaveLength(1)
    expect(ran.mineLeft).toBe(true)
  })

  test("left detached with uncommitted changes: worktree and branch are left, as byHand asks", async () => {
    const ran = await removed((worktree) =>
      Effect.gen(function* () {
        yield* detach(worktree)
        yield* (yield* Repository).write(worktree, { "notes.txt": "mine\n" })
      }),
    )
    expect(ran.cleanup).toEqual({ _tag: "Changed", files: ["notes.txt"] })
    expect(ran.branchLeft).toBe(true)
    expect(ran.worktrees).toHaveLength(2)
  })

  test("on its branch: the branch is reset in the worktree, as before, and both removed", async () => {
    const ran = await removed(() => Effect.void)
    expect(ran.cleanup).toEqual({ _tag: "Removed" })
    expect(ran.branchLeft).toBe(false)
    expect(ran.worktrees).toHaveLength(1)
  })
})
