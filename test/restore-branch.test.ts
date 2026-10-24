// branch.ts's restoreBranch, the one way a ticket's branch is put back (after a rejected hand-back,
// by the merge train, before a branch is removed): a rebase in progress aborted, then the branch
// reset when it is elsewhere and its worktree is clean and on it, each outcome tagged for its
// caller to say in its own words. Run against the in-memory Git.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { type Restored, restoreBranch } from "../src/run/branch.ts"
import { Git } from "../src/services/Git.ts"
import { layer as memoryGit, Repository } from "../src/testing/Git.ts"

const worktree = "/worktrees/a"
const ticket = { branch: "tutti/a", worktree }

interface Ended {
  readonly restored: Restored
  /** Where the branch was put back to: the ticket's commit. */
  readonly to: string
  /** The worker's commit on top of it. */
  readonly attempt: string
  /** Where the branch is once restoreBranch is done. */
  readonly branch: string
  readonly rebasing: boolean
}

/**
 * A ticket's worktree whose branch has the ticket's commit, `to`, and its worker's attempt on top
 * of it; `arrange` leaves it as a test wants it before restoreBranch puts it back at `to`.
 */
const restore = (
  arrange: (to: string) => Effect.Effect<void, unknown, Git | Repository> = () => Effect.void,
): Promise<Ended> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const git = yield* Git
      const repository = yield* Repository
      yield* git.addWorktree(repository.dir, worktree, { branch: "tutti/a", base: "main" })
      const to = yield* repository.commit(worktree, "Do a (a)", { "a.txt": "a\n" })
      const attempt = yield* repository.commit(worktree, "Try a (a)", { "a.txt": "tried\n" })
      yield* arrange(to)
      const restored = yield* restoreBranch(ticket, to, 1)
      return {
        restored,
        to,
        attempt,
        branch: yield* repository.head("tutti/a"),
        rebasing: yield* git.rebaseInProgress(worktree),
      }
    }).pipe(Effect.provide(memoryGit())),
  )

/** Starts a rebase of the branch onto a commit of main's that stops on conflicts in a.txt. */
const conflicted = Effect.gen(function* () {
  const git = yield* Git
  const repository = yield* Repository
  const onto = yield* repository.commit(repository.dir, "Main's a", { "a.txt": "main\n" })
  yield* repository.conflict("tutti/a", ["a.txt"])
  yield* Effect.flip(git.rebase(worktree, onto))
})

/** a.txt changed in the worktree and not committed, as by a worker that stopped halfway. */
const halfDone = Effect.flatMap(Repository, (it) => it.write(worktree, { "a.txt": "half done\n" }))

describe("restoreBranch", () => {
  test("resets a branch elsewhere to where it was, the worker's attempt its from", async () => {
    const ended = await restore()
    expect(ended.restored).toEqual({ _tag: "Reset", from: ended.attempt })
    expect(ended.branch).toBe(ended.to)
  })

  test("leaves a branch at where it was already", async () => {
    const ended = await restore((to) =>
      Effect.gen(function* () {
        yield* (yield* Git).resetBranch(worktree, to)
      }),
    )
    expect(ended.restored).toEqual({ _tag: "AlreadyThere", aborted: false })
    expect(ended.branch).toBe(ended.to)
  })

  test("aborts a rebase in progress, then resets the branch", async () => {
    const ended = await restore(() => conflicted)
    expect(ended.restored).toEqual({ _tag: "Reset", from: ended.attempt })
    expect(ended.rebasing).toBe(false)
    expect(ended.branch).toBe(ended.to)
  })

  test("says so when aborting a rebase leaves the branch where it was", async () => {
    const ended = await restore((to) =>
      Effect.gen(function* () {
        yield* (yield* Git).resetBranch(worktree, to)
        yield* conflicted
      }),
    )
    expect(ended.restored).toEqual({ _tag: "AlreadyThere", aborted: true })
    expect(ended.rebasing).toBe(false)
  })

  test("leaves a worktree mid-rebase when git can't abort the rebase", async () => {
    const ended = await restore(() =>
      Effect.gen(function* () {
        yield* conflicted
        yield* (yield* Repository).fail("rebase --abort", { stderr: "fatal: locked" })
      }),
    )
    expect(ended.restored._tag).toBe("AbortFailed")
    expect(ended.rebasing).toBe(true)
  })

  test("leaves a branch whose worktree has uncommitted changes", async () => {
    const ended = await restore(() => halfDone)
    expect(ended.restored).toEqual({ _tag: "Dirty", at: ended.attempt })
    expect(ended.branch).toBe(ended.attempt)
  })

  test("takes a worktree git can't say is clean for one that isn't", async () => {
    const ended = await restore(() => Effect.flatMap(Repository, (it) => it.fail("status")))
    expect(ended.restored).toEqual({ _tag: "Dirty", at: ended.attempt })
    expect(ended.branch).toBe(ended.attempt)
  })

  test("leaves a branch at where it was whatever its worktree holds", async () => {
    const ended = await restore((to) =>
      Effect.gen(function* () {
        yield* (yield* Git).resetBranch(worktree, to)
        yield* halfDone
      }),
    )
    expect(ended.restored).toEqual({ _tag: "AlreadyThere", aborted: false })
  })

  test("leaves a branch its worktree doesn't have checked out", async () => {
    const ended = await restore((to) =>
      Effect.flatMap(Repository, (it) => it.checkout(worktree, to)),
    )
    expect(ended.restored).toEqual({ _tag: "OffBranch", at: ended.attempt, on: "a detached HEAD" })
    expect(ended.branch).toBe(ended.attempt)
  })

  test("leaves a branch when git can't tell what its worktree has checked out", async () => {
    const ended = await restore(() =>
      Effect.flatMap(Repository, (it) => it.fail("symbolic-ref", { stderr: "fatal: locked" })),
    )
    expect(ended.restored._tag).toBe("Unknown")
    expect(ended.restored).toMatchObject({ at: ended.attempt })
    expect(ended.branch).toBe(ended.attempt)
  })

  test("says where the branch is left when git reset fails", async () => {
    const ended = await restore(() =>
      Effect.flatMap(Repository, (it) => it.fail("reset --hard", { stderr: "fatal: locked" })),
    )
    expect(ended.restored._tag).toBe("ResetFailed")
    expect(ended.restored).toMatchObject({ at: ended.attempt })
    expect(ended.branch).toBe(ended.attempt)
  })
})
