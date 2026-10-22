import { describe, expect, test } from "bun:test"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer, ManagedRuntime, Option } from "effect"
import { Git, GitWriter } from "../src/services/Git.ts"
import { layer as memoryLayer, Repository } from "../src/testing/Git.ts"
import { machineWhich } from "./env.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

// Repositories as people have them, where git's command line can trip: a base branch named like a
// top-level folder or file, which git takes for a path unless told (`ambiguous argument`); commits
// signed while log.showSignature is set, which puts git's verdict before each commit in `log`; and
// names that aren't ASCII, which git quotes outside -z. Real git, and the in-memory layer doing as
// it does.

/** A repository on `main` and a Git service over it. */
interface Fixture {
  readonly dir: string
  /** A path beside the repository for a new worktree. */
  path(name: string): string
  /** Commits the files in dir (the main checkout by default); the commit's hash. */
  commit(message: string, files: Readonly<Record<string, string>>, dir?: string): string
  /** Writes the files in dir without staging them. */
  write(files: Readonly<Record<string, string>>, dir: string): void
  /** Sets the repository's git config; the in-memory layer has none. */
  config(key: string, value: string): void
  /** Signs the commits made from here on, with an ssh key, where the machine has ssh-keygen. */
  sign(): void
  head(rev: string): string
  git<A, E>(use: (git: Git["Service"]) => Effect.Effect<A, E>): Promise<Exit.Exit<A, E>>
}

const realFixture = (): Fixture => {
  const repo = makeRepo()
  const layer = Git.layer().pipe(
    Layer.provideMerge(GitWriter.layer),
    Layer.provideMerge(BunServices.layer),
  )
  const config = (key: string, value: string) => void repo.git(["config", key, value])
  return {
    dir: repo.dir,
    path: (name) => join(dirname(repo.dir), name),
    commit: (message, files, dir) => repo.commit(message, files, dir),
    write: (files, dir) => repo.write(files, dir),
    config,
    sign: () => {
      const keygen = machineWhich("ssh-keygen")
      if (keygen === null) return
      const key = join(dirname(repo.dir), "signing-key")
      const made = Bun.spawnSync([
        keygen,
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "tutti",
        "-f",
        key,
      ])
      if (made.exitCode !== 0) throw new Error(`ssh-keygen: ${made.stderr.toString()}`)
      config("gpg.format", "ssh")
      config("gpg.ssh.program", keygen)
      config("user.signingkey", key)
      config("commit.gpgsign", "true")
    },
    head: (rev) => repo.head(rev),
    git: (use) =>
      Effect.runPromise(
        Effect.exit(Effect.provide(Effect.flatMap(Effect.service(Git), use), layer)),
      ),
  }
}

const memoryFixture = (): Fixture => {
  const root = "/memory-quirks"
  const runtime = ManagedRuntime.make(memoryLayer({ dir: join(root, "repo") }))
  const repository = runtime.runSync(Effect.service(Repository))
  const sync = <A>(effect: Effect.Effect<A, unknown, Git | GitWriter | Repository>) =>
    runtime.runSync(effect)
  return {
    dir: repository.dir,
    path: (name) => join(root, name),
    commit: (message, files, dir = repository.dir) => sync(repository.commit(dir, message, files)),
    write: (files, dir) => sync(repository.write(dir, files)),
    config: () => {},
    sign: () => {},
    head: (rev) => sync(repository.head(rev)),
    git: (use) => runtime.runPromise(Effect.exit(Effect.flatMap(Effect.service(Git), use))),
  }
}

const success = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected a success, got ${exit.cause}`)
  return exit.value
}

const expectations = (fixture: () => Fixture) => {
  test("a ticket's branch is rebased, merged and cleaned up on a base named like a top-level folder", async () => {
    const repo = fixture()
    repo.commit("Notes", { "main/notes.md": "notes\n" })
    const worktree = repo.path("demo-1")
    success(
      await repo.git((git) =>
        git.addWorktree(repo.dir, worktree, { branch: "tutti/demo-1", base: "main" }),
      ),
    )
    const ticket = repo.commit("demo-1: Add the ticket's file", { "ticket.txt": "t\n" }, worktree)
    repo.commit("More notes", { "main/more.md": "more\n" })

    success(await repo.git((git) => git.rebase(worktree, "main")))
    const log = success(await repo.git((git) => git.log(worktree, "main")))
    expect(log.map((commit) => commit.subject)).toEqual(["demo-1: Add the ticket's file"])
    expect(log[0]?.hash).not.toBe(ticket)
    expect(success(await repo.git((git) => git.changedFiles(worktree, "main")))).toEqual([
      "ticket.txt",
    ])
    expect(success(await repo.git((git) => git.mergeBase(repo.dir, "main", "tutti/demo-1")))).toBe(
      repo.head("main"),
    )
    expect(success(await repo.git((git) => git.holds(repo.dir, "main", "tutti/demo-1")))).toBe(
      false,
    )

    success(await repo.git((git) => git.fastForward(repo.dir, "tutti/demo-1")))
    expect(repo.head("main")).toBe(repo.head("tutti/demo-1"))
    expect(success(await repo.git((git) => git.holds(repo.dir, "main", "tutti/demo-1")))).toBe(true)

    // The cleanup after a merge: the worktree's branch reset to its base, then deleted unforced.
    success(await repo.git((git) => git.resetBranch(worktree, "main")))
    success(await repo.git((git) => git.removeWorktree(repo.dir, worktree)))
    success(await repo.git((git) => git.deleteBranch(repo.dir, "tutti/demo-1")))
    expect(Exit.isFailure(await repo.git((git) => git.revParse(repo.dir, "tutti/demo-1")))).toBe(
      true,
    )
  })

  test("branches named like a top-level file and folder are revisions to every command", async () => {
    const repo = fixture()
    repo.commit("Docs", { "docs/guide.md": "guide\n" })
    success(await repo.git((git) => git.createBranch(repo.dir, "README.md", "main")))
    success(await repo.git((git) => git.createBranch(repo.dir, "docs", "README.md")))
    expect(success(await repo.git((git) => git.revParse(repo.dir, "docs")))).toBe(repo.head("main"))

    const worktree = repo.path("docs")
    success(await repo.git((git) => git.addWorktree(repo.dir, worktree, { branch: "docs" })))
    repo.commit("Guide", { "docs/guide.md": "more guide\n" }, worktree)
    expect(
      success(await repo.git((git) => git.filesBetween(repo.dir, "README.md", "docs"))),
    ).toEqual(["docs/guide.md"])
    expect(
      success(await repo.git((git) => git.fileAt(repo.dir, "README.md", "docs/guide.md"))),
    ).toBe("guide\n")

    const detached = repo.path("detached")
    success(await repo.git((git) => git.addDetachedWorktree(repo.dir, detached, "docs")))
    expect(success(await repo.git((git) => git.currentBranch(detached)))).toEqual(Option.none())

    success(await repo.git((git) => git.resetBranch(worktree, "README.md")))
    expect(repo.head("docs")).toBe(repo.head("README.md"))
    success(await repo.git((git) => git.removeWorktree(repo.dir, worktree)))
    success(await repo.git((git) => git.deleteBranch(repo.dir, "docs")))
  })

  test("log reads signed commits with log.showSignature set", async () => {
    const repo = fixture()
    repo.config("log.showSignature", "true")
    repo.sign()
    const base = repo.head("main")
    const first = repo.commit("First signed", { "a.txt": "a\n" })
    const second = repo.commit("Second signed\n\nIts body.", { "b.txt": "b\n" })
    const log = success(await repo.git((git) => git.log(repo.dir, base)))
    expect(log.map((commit) => commit.hash)).toEqual([second, first])
    expect(log.map((commit) => commit.subject)).toEqual(["Second signed", "First signed"])
    expect(log[0]?.message.trim()).toBe("Second signed\n\nIts body.")
  })

  test("names that aren't ASCII come back as they are", async () => {
    const repo = fixture()
    const branch = "tutti/ünïcödé-1"
    const file = "naïve café/résumé ✓.md"
    const worktree = repo.path("unicode")
    success(await repo.git((git) => git.addWorktree(repo.dir, worktree, { branch, base: "main" })))
    const commit = repo.commit("Résumé ✓", { [file]: "écrit\n" }, worktree)

    expect(success(await repo.git((git) => git.currentBranch(worktree)))).toEqual(
      Option.some(branch),
    )
    expect(success(await repo.git((git) => git.revParse(repo.dir, branch)))).toBe(commit)
    const listed = success(await repo.git((git) => git.worktrees(repo.dir)))
    expect(listed.find((each) => each.path === worktree)?.branch).toBe(branch)
    const log = success(await repo.git((git) => git.log(worktree, "main")))
    expect(log.map((each) => each.subject)).toEqual(["Résumé ✓"])
    expect(success(await repo.git((git) => git.changedFiles(worktree, "main")))).toEqual([file])
    expect(success(await repo.git((git) => git.filesBetween(repo.dir, "main", branch)))).toEqual([
      file,
    ])
    expect(success(await repo.git((git) => git.fileAt(repo.dir, branch, file)))).toBe("écrit\n")
    expect(success(await repo.git((git) => git.trackedFiles(worktree)))).toContain(file)

    const draft = "brouillon ü.txt"
    repo.write({ [draft]: "draft\n", [file]: "réécrit\n" }, worktree)
    const status = success(await repo.git((git) => git.status(worktree)))
    expect(status.map((entry) => [entry.code, entry.path])).toEqual([
      [" M", file],
      ["??", draft],
    ])
  })
}

describe("the in-memory Git", () => expectations(memoryFixture))

slow.describe("real git", () => expectations(realFixture))
