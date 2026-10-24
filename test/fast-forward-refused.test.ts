// Why git refused a fast-forward, read alone (merge.ts's diagnose): changes in the main checkout in
// the branch's way, the base moved on, a branch that doesn't fast-forward, a base git can't read,
// or git kept from writing while the branch still fast-forwards. Run against the in-memory Git,
// under TestClock, moved on gitAgainAfter at a time while git's reads are made again.
import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { diagnose, gitAgainAfter, gitTries, type Refused } from "../src/run/merge.ts"
import { Git, GitFailed } from "../src/services/Git.ts"
import { layer as memoryGit, Repository } from "../src/testing/Git.ts"

const options = { repo: "/repo", base: "main" }
const worktree = "/worktrees/a"
const refusal = new GitFailed({
  op: "merge --ff-only",
  command: "git merge --ff-only tutti/a",
  exitCode: 128,
  stderr: "fatal: Unable to create '/repo/.git/index.lock': File exists.",
})

interface Diagnosed {
  readonly refused: Refused
  /** Where main was as the branch was put on top of it. */
  readonly onto: string
  /** The branch's commit, the one the fast-forward was refused. */
  readonly at: string
  /** How many times git was asked for a commit, as diagnose asks where main is. */
  readonly reads: number
}

/**
 * The branch tutti/a with a.txt committed on top of main, as checked; `arrange` leaves the main
 * checkout as a test wants it before the fast-forward to it is refused and diagnosed.
 */
const diagnosed = (
  arrange: (onto: string) => Effect.Effect<void, unknown, Git | Repository> = () => Effect.void,
): Promise<Diagnosed> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const git = yield* Git
      const repository = yield* Repository
      yield* git.addWorktree(repository.dir, worktree, { branch: "tutti/a", base: "main" })
      const at = yield* repository.commit(worktree, "Do a (a)", { "a.txt": "a\n" })
      const onto = yield* repository.head("main")
      yield* arrange(onto)
      const status = yield* git.status(repository.dir)
      const fiber = yield* Effect.forkChild(diagnose(options, onto, at, status, refusal))
      for (let i = 0; i < 20 && fiber.pollUnsafe() === undefined; i++) {
        yield* TestClock.adjust(gitAgainAfter)
      }
      const refused = yield* Fiber.join(fiber)
      const reads = (yield* repository.calls).filter((call) => call.op === "rev-parse").length
      return { refused, onto, at, reads }
    }).pipe(Effect.provide(memoryGit()), Effect.provide(TestClock.layer())),
  )

describe("a branch that still fast-forwards", () => {
  test("is Kept: git was kept from writing, with its refusal", async () => {
    const { refused } = await diagnosed()
    expect(refused).toEqual(expect.objectContaining({ _tag: "Kept", error: refusal }))
  })
})

describe("uncommitted changes in the main checkout", () => {
  test("to a file the branch changes are InTheWay, named", async () => {
    const { refused } = await diagnosed(() =>
      Effect.flatMap(Repository, (repository) =>
        repository.write(repository.dir, { "a.txt": "by hand\n", "other.txt": "x\n" }),
      ),
    )
    expect(refused).toEqual(expect.objectContaining({ _tag: "InTheWay", files: ["a.txt"] }))
  })

  test("to files the branch doesn't change are not in its way", async () => {
    const { refused } = await diagnosed(() =>
      Effect.flatMap(Repository, (repository) =>
        repository.write(repository.dir, { "other.txt": "x\n" }),
      ),
    )
    expect(refused._tag).toBe("Kept")
  })
})

describe("the base", () => {
  test("moved on from where the branch is on top of it: BaseMoved, to its commit", async () => {
    let moved = ""
    const { refused } = await diagnosed(() =>
      Effect.gen(function* () {
        const repository = yield* Repository
        moved = yield* repository.commit(repository.dir, "By hand", { "hand.txt": "x\n" })
      }),
    )
    expect(refused).toEqual(expect.objectContaining({ _tag: "BaseMoved", to: moved }))
  })

  test("not where the branch left it, though at `onto`: NoFastForward", async () => {
    const refused = await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* Git
        const repository = yield* Repository
        yield* git.addWorktree(repository.dir, worktree, { branch: "tutti/a", base: "main" })
        const at = yield* repository.commit(worktree, "Do a (a)", { "a.txt": "a\n" })
        // main moved on before the merge read it: the branch, off main's first commit, is behind.
        const onto = yield* repository.commit(repository.dir, "By hand", { "hand.txt": "x\n" })
        return yield* diagnose(options, onto, at, [], refusal)
      }).pipe(Effect.provide(memoryGit())),
    )
    expect(refused).toEqual(expect.objectContaining({ _tag: "NoFastForward", error: refusal }))
  })

  test(`git can't read, asked ${gitTries} times: Unreadable, with both errors`, async () => {
    const { refused, reads } = await diagnosed(() =>
      Effect.flatMap(Repository, (repository) =>
        repository.fail("rev-parse", { times: 100, stderr: "fatal: bad object" }),
      ),
    )
    expect(refused._tag).toBe("Unreadable")
    if (refused._tag !== "Unreadable") return
    expect(refused.error).toBe(refusal)
    expect(refused.read).toEqual(expect.objectContaining({ stderr: "fatal: bad object" }))
    expect(reads).toBe(gitTries)
  })
})
