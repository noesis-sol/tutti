import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer, ManagedRuntime } from "effect"
import { Git, GitWriter } from "../src/services/Git.ts"
import { layer as memoryLayer, Repository } from "../src/testing/Git.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

/** A worktree on `wt/demo` with two commits of its own, an untracked file and a staged change. */
interface Fixture {
  readonly worktree: string
  /** The branch's first commit, which it is reset to. */
  readonly first: string
  read(path: string): string | undefined
  head(rev: string): string
  git<A, E>(use: (git: Git["Service"]) => Effect.Effect<A, E>): Promise<Exit.Exit<A, E>>
}

const realFixture = (): Fixture => {
  const repo = makeRepo()
  const layer = Git.layer().pipe(
    Layer.provideMerge(GitWriter.layer),
    Layer.provideMerge(BunServices.layer),
  )
  const worktree = repo.worktree("wt/demo")
  const first = repo.commit("First", { "a.txt": "one\n" }, worktree)
  repo.commit("Second", { "a.txt": "two\n", "b.txt": "b\n" }, worktree)
  repo.write({ "untracked.txt": "kept\n", "a.txt": "changed\n" }, worktree)
  return {
    worktree,
    first,
    read: (path) => {
      try {
        return readFileSync(join(worktree, path), "utf8")
      } catch {
        return undefined
      }
    },
    head: (rev) => repo.head(rev),
    git: (use) =>
      Effect.runPromise(
        Effect.exit(Effect.provide(Effect.flatMap(Effect.service(Git), use), layer)),
      ),
  }
}

const memoryFixture = (): Fixture => {
  const runtime = ManagedRuntime.make(memoryLayer({ dir: "/memory-reset/repo" }))
  const sync = <A>(effect: Effect.Effect<A, unknown, Git | GitWriter | Repository>) =>
    runtime.runSync(effect)
  const repository = sync(Effect.service(Repository))
  const worktree = "/memory-reset/worktree"
  sync(
    Effect.flatMap(Effect.service(Git), (git) =>
      git.addWorktree(repository.dir, worktree, { branch: "wt/demo", base: "HEAD" }),
    ),
  )
  const first = sync(repository.commit(worktree, "First", { "a.txt": "one\n" }))
  sync(repository.commit(worktree, "Second", { "a.txt": "two\n", "b.txt": "b\n" }))
  sync(repository.write(worktree, { "untracked.txt": "kept\n", "a.txt": "changed\n" }))
  return {
    worktree,
    first,
    read: (path) => sync(repository.read(worktree, path)),
    head: (rev) => sync(repository.head(rev)),
    git: (use) => runtime.runPromise(Effect.exit(Effect.flatMap(Effect.service(Git), use))),
  }
}

const expectations = (fixture: () => Fixture) => {
  test("resetBranch moves the branch, its index and working tree to the commit; untracked files stay", async () => {
    const repo = fixture()
    const reset = await repo.git((git) => git.resetBranch(repo.worktree, repo.first))
    expect(Exit.isSuccess(reset)).toBe(true)
    expect(repo.head("wt/demo")).toBe(repo.first)
    expect(repo.read("a.txt")).toBe("one\n")
    expect(repo.read("b.txt")).toBeUndefined()
    expect(repo.read("untracked.txt")).toBe("kept\n")
    const status = await repo.git((git) => git.status(repo.worktree))
    expect(Exit.isSuccess(status) && status.value.map((entry) => entry.code)).toEqual(["??"])
  })

  test("resetBranch to a commit that isn't there fails GitFailed", async () => {
    const repo = fixture()
    const reset = await repo.git((git) => git.resetBranch(repo.worktree, "0".repeat(40)))
    expect(Exit.isFailure(reset)).toBe(true)
    expect(repo.head("wt/demo")).not.toBe(repo.first)
  })
}

describe("the in-memory Git", () => expectations(memoryFixture))

slow.describe("real git", () => expectations(realFixture))
