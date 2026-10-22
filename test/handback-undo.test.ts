// handback.ts's undoResolution: a hand-back's resolution refused, the ticket's branch put back as
// the ticket closed it (restoreBranch), and what came of it said in the words its lines and notes
// carry: left mid-rebase, the rebase aborted, left as its worker left it, left at its commit with
// the reason, or reset, or not. Run against the in-memory Git, under TestClock for git's retries.
import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { type RebaseStop, undoResolution } from "../src/run/handback.ts"
import { gitAgainAfter } from "../src/run/merge.ts"
import { Git } from "../src/services/Git.ts"
import { layer as memoryGit, Repository } from "../src/testing/Git.ts"

const worktree = "/worktrees/a"
const branch = "tutti/a"

const short = (hash: string) => hash.slice(0, 10)

interface Ended {
  /** What undoResolution said it did. */
  readonly said: string
  /** Where the branch was before the rebase: the ticket's commit, the stop's head. */
  readonly to: string
  /** The worker's attempt at the resolution, on top of it. */
  readonly attempt: string
  /** Where the branch is once undoResolution is done. */
  readonly branch: string
  readonly rebasing: boolean
}

/**
 * A ticket's worktree whose branch has the ticket's commit, `to`, and its worker's attempt on top
 * of it; `arrange` leaves it as a test wants it before undoResolution puts it back at `to`, the
 * clock moved on while git is asked again.
 */
const undo = (
  arrange: (to: string) => Effect.Effect<void, unknown, Git | Repository> = () => Effect.void,
): Promise<Ended> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const git = yield* Git
      const repository = yield* Repository
      yield* git.addWorktree(repository.dir, worktree, { branch, base: "main" })
      const to = yield* repository.commit(worktree, "Do a (a)", { "a.txt": "a\n" })
      const attempt = yield* repository.commit(worktree, "Resolve a (a)", { "a.txt": "tried\n" })
      yield* arrange(to)
      const stop: RebaseStop = {
        ticket: { id: "a", title: "a", branch, worktree },
        onto: "",
        fork: "",
        head: to,
        own: 1,
        files: ["a.txt"],
      }
      // undoResolution asks for the merge's services but uses Git alone.
      const fiber = yield* Effect.forkChild(
        undoResolution(stop) as unknown as Effect.Effect<string, never, Git>,
      )
      for (let i = 0; i < 20 && fiber.pollUnsafe() === undefined; i++) {
        yield* TestClock.adjust(gitAgainAfter)
      }
      const said = yield* Fiber.join(fiber)
      return {
        said,
        to,
        attempt,
        branch: yield* repository.head(branch),
        rebasing: yield* git.rebaseInProgress(worktree),
      }
    }).pipe(Effect.provide(Layer.merge(memoryGit(), TestClock.layer()))),
  )

/** Starts a rebase of the branch onto a commit of main's that stops on conflicts in a.txt. */
const conflicted = Effect.gen(function* () {
  const git = yield* Git
  const repository = yield* Repository
  const onto = yield* repository.commit(repository.dir, "Main's a", { "a.txt": "main\n" })
  yield* repository.conflict(branch, ["a.txt"])
  yield* Effect.flip(git.rebase(worktree, onto))
})

/** The branch put back at `to` by hand, as before the rebase. */
const atTicket = (to: string) => Effect.flatMap(Git, (git) => git.resetBranch(worktree, to))

describe("undoing a refused hand-back resolution", () => {
  test("says the worktree is left mid-rebase when git can't abort the rebase", async () => {
    const ended = await undo(() =>
      Effect.gen(function* () {
        yield* conflicted
        yield* (yield* Repository).fail("rebase --abort", { stderr: "fatal: locked" })
      }),
    )
    expect(ended.said).toBe(`the rebase could not be aborted, so ${worktree} is left mid-rebase`)
    expect(ended.rebasing).toBe(true)
  })

  test("says the rebase was aborted when that leaves the branch where it was", async () => {
    const ended = await undo((to) =>
      Effect.gen(function* () {
        yield* atTicket(to)
        yield* conflicted
      }),
    )
    expect(ended.said).toBe("the rebase was aborted")
    expect(ended.rebasing).toBe(false)
    expect(ended.branch).toBe(ended.to)
  })

  test("says the branch is as the ticket closed it when nothing moved it", async () => {
    const ended = await undo(atTicket)
    expect(ended.said).toBe(`${branch} is as the ticket closed it`)
    expect(ended.branch).toBe(ended.to)
  })

  test("leaves a dirty worktree as its worker left it", async () => {
    const ended = await undo(() =>
      Effect.flatMap(Repository, (it) => it.write(worktree, { "a.txt": "half done\n" })),
    )
    expect(ended.said).toBe(
      `${branch} is left as its worker left it (it was at ${short(ended.to)} before the rebase)`,
    )
    expect(ended.branch).toBe(ended.attempt)
  })

  test("leaves a worktree on something else at its commit, saying what it has", async () => {
    const ended = await undo((to) => Effect.flatMap(Repository, (it) => it.checkout(worktree, to)))
    expect(ended.said).toBe(
      `${branch} is left at ${short(ended.attempt)} (it was at ${short(ended.to)} before the rebase), as ${worktree} has a detached HEAD`,
    )
    expect(ended.branch).toBe(ended.attempt)
  })

  test("leaves a worktree git can't read at its commit, saying git's error", async () => {
    const ended = await undo(() =>
      Effect.flatMap(Repository, (it) =>
        it.fail("symbolic-ref", { dir: worktree, times: 100, stderr: "fatal: locked" }),
      ),
    )
    expect(ended.said).toBe(
      `${branch} is left at ${short(ended.attempt)} (it was at ${short(ended.to)} before the rebase), as git could not tell what ${worktree} has checked out: fatal: locked`,
    )
    expect(ended.branch).toBe(ended.attempt)
  })

  test("says the branch could not be reset when git reset fails", async () => {
    const ended = await undo(() =>
      Effect.flatMap(Repository, (it) => it.fail("reset --hard", { stderr: "fatal: locked" })),
    )
    expect(ended.said).toBe(
      `${branch} could not be reset to ${short(ended.to)}, where it was before the rebase; it is left at ${short(ended.attempt)}`,
    )
    expect(ended.branch).toBe(ended.attempt)
  })

  test("says the branch was reset, naming its worker's attempt", async () => {
    const ended = await undo()
    expect(ended.said).toBe(
      `${branch} was reset to ${short(ended.to)}, where it was before the rebase (its worker's attempt is ${short(ended.attempt)})`,
    )
    expect(ended.branch).toBe(ended.to)
  })
})
