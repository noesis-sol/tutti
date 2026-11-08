// tutti's own fast-forward, rebase and commit run without the project's hooks (§ 5, tutti-fnvd.3):
// a hook that outlasts a git write's time limit, as Beads' post-merge waiting on a busy lock, would
// fail the write after git had done it, and one that refuses would fail tutti's merge. Each hook
// here leaves a mark where it runs, then sleeps past the write limit or refuses.
import { describe, expect } from "bun:test"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Exit, Layer } from "effect"
import { Git, GitWriter } from "../src/services/Git.ts"
import { slow } from "./gates.ts"
import { hooksDir, makeRepo, type Repo } from "./git.ts"

// Far above a write here, far below the hooks' 30 s.
const limits = { read: Duration.seconds(30), write: Duration.seconds(5) }

const run = <A, E>(use: (git: Git["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.exit(
      Effect.flatMap(Effect.service(Git), use).pipe(
        Effect.provide(
          Git.layer({ timeLimits: limits }).pipe(
            Layer.provideMerge(GitWriter.layer),
            Layer.provideMerge(BunServices.layer),
          ),
        ),
      ),
    ),
  )

/** The folder the hooks mark, a file named after each hook that ran. */
const marks = (repo: Repo): string => join(dirname(repo.dir), "ran")

/** Hooks that mark that they ran, then sleep past the write limit (`sleep`) or refuse (`refuse`). */
const hooks = (repo: Repo, names: { sleep?: string[]; refuse?: string[] }): void => {
  const folder = marks(repo)
  mkdirSync(folder, { recursive: true })
  const write = (name: string, then: string) =>
    writeFileSync(
      join(hooksDir(repo), name),
      `#!/bin/sh\ntouch '${join(folder, name)}'\n${then}\n`,
      { mode: 0o755 },
    )
  for (const name of names.sleep ?? []) write(name, "sleep 30")
  for (const name of names.refuse ?? []) write(name, "exit 1")
}

const ran = (repo: Repo): string[] => readdirSync(marks(repo)).sort()

describe("tutti's own git writes run without the project's hooks", () => {
  slow.test("a fast-forward runs no post-merge hook, however long it would take", async () => {
    const repo = makeRepo()
    const head = repo.commit("t-1: Change", { "t.txt": "t\n" }, repo.worktree("tutti/t-1"))
    hooks(repo, { sleep: ["post-merge", "reference-transaction"] })
    const exit = await run((git) => git.fastForward(repo.dir, "tutti/t-1"))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(repo.head("main")).toBe(head)
    expect(ran(repo)).toEqual([])
  })

  slow.test("a rebase runs no pre-rebase, post-checkout or post-rewrite hook", async () => {
    const repo = makeRepo()
    const worktree = repo.worktree("tutti/t-1")
    repo.commit("t-1: Change", { "t.txt": "t\n" }, worktree)
    const main = repo.commit("Move main", { "main.txt": "main\n" })
    hooks(repo, { refuse: ["pre-rebase"], sleep: ["post-checkout", "post-rewrite"] })
    const exit = await run((git) => git.rebase(worktree, "main"))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(repo.head("tutti/t-1~1")).toBe(main)
    expect(ran(repo)).toEqual([])
  })

  slow.test("a rebase stopped on conflicts is aborted with no hook run", async () => {
    const repo = makeRepo()
    const worktree = repo.worktree("tutti/t-1")
    const before = repo.commit("t-1: Change", { "README.md": "ticket\n" }, worktree)
    repo.commit("Move main", { "README.md": "main\n" })
    hooks(repo, { sleep: ["post-checkout", "reference-transaction"] })
    const stopped = await run((git) => git.rebase(worktree, "main"))
    expect(Exit.isFailure(stopped)).toBe(true)
    const aborted = await run((git) => git.abortRebase(worktree))
    expect(Exit.isSuccess(aborted)).toBe(true)
    expect(repo.head("tutti/t-1")).toBe(before)
    expect(ran(repo)).toEqual([])
  })

  slow.test("a commit runs no pre-commit, commit-msg or post-commit hook", async () => {
    const repo = makeRepo()
    repo.write({ "notes.txt": "notes\n" })
    repo.git(["add", "notes.txt"])
    hooks(repo, {
      refuse: ["pre-commit", "prepare-commit-msg", "commit-msg"],
      sleep: ["post-commit"],
    })
    const exit = await run((git) => git.commitPaths(repo.dir, "Add notes", ["notes.txt"]))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(repo.git(["log", "-1", "--format=%s"]).trim()).toBe("Add notes")
    expect(existsSync(join(repo.dir, "notes.txt"))).toBe(true)
    expect(ran(repo)).toEqual([])
  })
})
