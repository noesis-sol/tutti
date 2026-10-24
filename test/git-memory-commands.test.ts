import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer } from "effect"
import { Git, GitFailed, GitWriter } from "../src/services/Git.ts"
import { layer as memoryLayer, Repository } from "../src/testing/Git.ts"

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (error === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  return error.error
}

/** The live layer over a git that isn't there: each call fails at once with the command it ran. */
const missingGit = Git.layer({ command: "/nonexistent/tutti-test/git" }).pipe(
  Layer.provide(GitWriter.layer),
  Layer.provide(BunServices.layer),
)

/** Each operation, the op of the first git command it runs, and a call of it. */
const calls: ReadonlyArray<{
  readonly op: string
  readonly call: (git: Git["Service"], dir: string) => Effect.Effect<unknown, unknown>
}> = [
  {
    op: "worktree add",
    call: (git, dir) => git.addWorktree(dir, "/wt", { branch: "tutti/t-1", base: "main" }),
  },
  { op: "worktree add", call: (git, dir) => git.addWorktree(dir, "/wt", { branch: "main" }) },
  { op: "worktree add", call: (git, dir) => git.addDetachedWorktree(dir, "/wt", "main") },
  { op: "worktree remove", call: (git, dir) => git.removeWorktree(dir, "/wt", { force: true }) },
  { op: "worktree remove", call: (git, dir) => git.removeWorktree(dir, "/wt") },
  { op: "worktree list", call: (git, dir) => git.worktrees(dir) },
  { op: "worktree prune", call: (git, dir) => git.pruneWorktrees(dir) },
  { op: "branch", call: (git, dir) => git.createBranch(dir, "b", "main") },
  { op: "branch -d", call: (git, dir) => git.deleteBranch(dir, "b") },
  { op: "branch -d", call: (git, dir) => git.deleteBranch(dir, "b", { force: true }) },
  { op: "rebase", call: (git, dir) => git.rebase(dir, "main") },
  { op: "rebase --abort", call: (git, dir) => git.abortRebase(dir) },
  { op: "rev-parse --git-path", call: (git, dir) => git.rebaseInProgress(dir) },
  { op: "rev-parse", call: (git, dir) => git.resetBranch(dir, "main") },
  { op: "merge-base", call: (git, dir) => git.mergeBase(dir, "main", "HEAD") },
  { op: "merge-tree", call: (git, dir) => git.holds(dir, "main", "b") },
  { op: "merge --ff-only", call: (git, dir) => git.fastForward(dir, "b") },
  { op: "log", call: (git, dir) => git.log(dir, "main") },
  { op: "status", call: (git, dir) => git.status(dir) },
  { op: "status", call: (git, dir) => git.status(dir, ["src", "-x"]) },
  { op: "diff --name-only", call: (git, dir) => git.changedFiles(dir, "main") },
  { op: "diff --name-only", call: (git, dir) => git.filesBetween(dir, "main", "HEAD") },
  { op: "show", call: (git, dir) => git.fileAt(dir, "main", "README.md") },
  { op: "ls-files", call: (git, dir) => git.trackedFiles(dir) },
  { op: "check-attr", call: (git, dir) => git.mergedByUnion(dir, ["CHANGELOG.md"]) },
  { op: "rev-parse", call: (git, dir) => git.revParse(dir, "main") },
  { op: "show-ref", call: (git, dir) => git.branchExists(dir, "b") },
  { op: "rev-parse --git-common-dir", call: (git, dir) => git.commonDir(dir) },
  { op: "rev-parse --show-toplevel", call: (git, dir) => git.topLevel(dir) },
  { op: "symbolic-ref", call: (git, dir) => git.currentBranch(dir) },
  { op: "--version", call: (git, dir) => git.version(dir) },
]

const shown = (error: unknown) => {
  expect(error).toBeInstanceOf(GitFailed)
  const { op, command } = error as GitFailed
  return { op, command }
}

describe("the Git test layer's commands", () => {
  test("a fault fails each operation with the op and command the live layer's failure has", async () => {
    for (const { op, call } of calls) {
      const live = await Effect.runPromise(
        Effect.exit(Effect.flatMap(Effect.service(Git), (git) => call(git, import.meta.dir))).pipe(
          Effect.provide(missingGit),
        ),
      )
      const memory = await Effect.runPromise(
        Effect.gen(function* () {
          const repository = yield* Repository
          yield* repository.fail(op)
          return yield* Effect.exit(call(yield* Git, repository.dir))
        }).pipe(Effect.provide(memoryLayer())),
      )
      expect(shown(failure(memory))).toEqual(shown(failure(live)))
    }
  })

  test("resetBranch reads the rev's hash first, and resets to the hash", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* Git
        const repository = yield* Repository
        const start = yield* repository.head()
        yield* repository.commit(repository.dir, "Second", { "a.txt": "a\n" })
        const reset = yield* Effect.exit(git.resetBranch(repository.dir, "main~1"))
        const resetCalls = yield* repository.calls
        yield* repository.fail("rev-parse", { stderr: "fatal: oops" })
        const faulted = yield* Effect.exit(git.resetBranch(repository.dir, "main"))
        const unknown = yield* Effect.exit(git.resetBranch(repository.dir, "nowhere"))
        return {
          start,
          reset,
          resetCalls,
          faulted,
          unknown,
          calls: yield* repository.calls,
          head: yield* repository.head(),
        }
      }).pipe(Effect.provide(memoryLayer())),
    )
    expect(Exit.isSuccess(result.reset)).toBe(true)
    expect(result.resetCalls.map((call) => call.op)).toEqual(["rev-parse", "reset --hard"])
    expect(failure(result.faulted)).toMatchObject({
      op: "rev-parse",
      command: "git rev-parse --verify --quiet --end-of-options main",
      stderr: "fatal: oops",
    })
    // git rev-parse --verify --quiet says nothing of a rev that names nothing, and exits 1.
    expect(failure(result.unknown)).toMatchObject({ op: "rev-parse", exitCode: 1, stderr: "" })
    expect(result.calls.slice(2).map((call) => call.op)).toEqual(["rev-parse", "rev-parse"])
    expect(result.head).toBe(result.start)
  })

  test("resetBranch's reset is given the hash, as live", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* Repository
        yield* repository.fail("reset --hard")
        const exit = yield* Effect.exit((yield* Git).resetBranch(repository.dir, "main"))
        return { exit, hash: yield* repository.head("main") }
      }).pipe(Effect.provide(memoryLayer())),
    )
    expect(failure(result.exit)).toMatchObject({
      op: "reset --hard",
      command: `git reset --hard --quiet ${result.hash} --`,
    })
  })

  test("mergedByUnion of no paths runs no git, and a check-attr fault waits for a call that does", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* Git
        const repository = yield* Repository
        yield* repository.fail("check-attr")
        const none = yield* git.mergedByUnion(repository.dir, [])
        const calls = yield* repository.calls
        const some = yield* Effect.exit(git.mergedByUnion(repository.dir, ["CHANGELOG.md"]))
        return { none, calls, some }
      }).pipe(Effect.provide(memoryLayer())),
    )
    expect(result.none).toEqual([])
    expect(result.calls).toEqual([])
    expect(failure(result.some)).toMatchObject({ op: "check-attr" })
  })
})
