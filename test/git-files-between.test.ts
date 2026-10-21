import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer, ManagedRuntime } from "effect"
import { Git, GitWriter } from "../src/services/Git.ts"
import { layer as memoryLayer, Repository } from "../src/testing/Git.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

// Git.filesBetween, git diff --name-only from to: the files whose content differs between two
// commits, whatever their history, as the setup reads a worker's resolution (setup.ts). Real git,
// and the in-memory layer doing as it does.

/** A repository on `main` and a Git service over it. */
interface Fixture {
  readonly dir: string
  /** Commits the files in dir (the main checkout by default); the commit's hash. */
  commit(message: string, files: Readonly<Record<string, string>>, dir?: string): string
  /** A new worktree on a new branch from main; its path. */
  worktree(branch: string): string
  head(rev: string): string
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
    commit: (message, files, dir) => repo.commit(message, files, dir),
    worktree: (branch) => repo.worktree(branch, "main"),
    head: (rev) => repo.head(rev),
    git: (use) =>
      Effect.runPromise(
        Effect.exit(Effect.provide(Effect.flatMap(Effect.service(Git), use), layer)),
      ),
  }
}

const memoryFixture = (): Fixture => {
  const root = "/memory-files-between"
  const runtime = ManagedRuntime.make(memoryLayer({ dir: join(root, "repo") }))
  const repository = runtime.runSync(Effect.service(Repository))
  const sync = <A>(effect: Effect.Effect<A, unknown, Git | GitWriter | Repository>) =>
    runtime.runSync(effect)
  return {
    dir: repository.dir,
    commit: (message, files, dir = repository.dir) => sync(repository.commit(dir, message, files)),
    worktree: (branch) => {
      const path = join(root, branch.replace("/", "-"))
      sync(
        Effect.flatMap(Effect.service(Git), (git) =>
          git.addWorktree(repository.dir, path, { branch, base: "main" }),
        ),
      )
      return path
    },
    head: (rev) => sync(repository.head(rev)),
    git: (use) => runtime.runPromise(Effect.exit(Effect.flatMap(Effect.service(Git), use))),
  }
}

const success = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected a success, got ${exit.cause}`)
  return exit.value
}

/**
 * Two branches with the same ticket.txt, one from main before it moved on (main.txt), one after:
 * they differ in main.txt alone, though each left main with ticket.txt.
 */
const twoBranches = (repo: Fixture) => {
  repo.commit("Shared", { "shared.txt": "one\n" })
  const one = repo.worktree("wt/one")
  repo.commit("One", { "ticket.txt": "t\n" }, one)
  repo.commit("Move main", { "main.txt": "m\n" })
  const two = repo.worktree("wt/two")
  repo.commit("Two", { "ticket.txt": "t\n" }, two)
  return { one: repo.head("wt/one"), two: repo.head("wt/two") }
}

const filesBetween = async (repo: Fixture) => {
  const { one, two } = twoBranches(repo)
  const between = success(await repo.git((git) => git.filesBetween(repo.dir, one, two)))
  const changed = success(await repo.git((git) => git.changedFiles(repo.dir, one, two)))
  const missing = await repo.git((git) => git.filesBetween(repo.dir, "no-such-branch", two))
  return { between, changed: [...changed].sort(), missing: Exit.isFailure(missing) }
}

const expected = { between: ["main.txt"], changed: ["main.txt", "ticket.txt"], missing: true }

describe("Git.filesBetween", () => {
  test("the in-memory layer: the files whose content differs, not those since the merge base", async () => {
    expect(await filesBetween(memoryFixture())).toEqual(expected)
  })

  slow.test(
    "real git: the files whose content differs, not those since the merge base",
    async () => {
      expect(await filesBetween(realFixture())).toEqual(expected)
    },
  )
})
