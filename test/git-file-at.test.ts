import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer, ManagedRuntime } from "effect"
import { Git, GitWriter } from "../src/services/Git.ts"
import { layer as memoryLayer, Repository } from "../src/testing/Git.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

// Git.fileAt, git show <commit>:<path>: a file as a commit has it, as the run reads the setup a
// merge committed to .tutti/settings.json (setup.ts's takeSettings). Real git, and the in-memory
// layer doing as it does.

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
  const root = "/memory-file-at"
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

/** settings.json as main had it before and after it moved on, and a path no commit has. */
const fileAt = async (repo: Fixture) => {
  const settings = ".tutti/settings.json"
  repo.commit("Settings", { [settings]: '{ "checks": {} }\n' })
  const before = repo.head("main")
  repo.commit("Setup", { [settings]: '{ "checks": { "setup": { "command": "npm ci" } } }\n' })
  const after = repo.head("main")
  const was = success(await repo.git((git) => git.fileAt(repo.dir, before, settings)))
  const now = success(await repo.git((git) => git.fileAt(repo.dir, after, settings)))
  const missing = await repo.git((git) => git.fileAt(repo.dir, after, "no-such-file.json"))
  return { was, now, missing: Exit.isFailure(missing) }
}

const expected = {
  was: '{ "checks": {} }\n',
  now: '{ "checks": { "setup": { "command": "npm ci" } } }\n',
  missing: true,
}

describe("Git.fileAt", () => {
  test("the in-memory layer: the file as each commit has it, and none it doesn't", async () => {
    expect(await fileAt(memoryFixture())).toEqual(expected)
  })

  slow.test("real git: the file as each commit has it, and none it doesn't", async () => {
    expect(await fileAt(realFixture())).toEqual(expected)
  })
})
