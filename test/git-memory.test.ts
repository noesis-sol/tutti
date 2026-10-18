import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Fiber, Layer, ManagedRuntime, Option } from "effect"
import { Git, GitFailed, GitTimedOut, GitWriter, RebaseConflict } from "../src/services/Git.ts"
import { layer as memoryLayer, Repository } from "../src/testing/Git.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (error === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  return error.error
}

const success = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected a success, got ${exit.cause}`)
  return exit.value
}

/** A repository and a Git service over it: real git in a temp folder, or the in-memory layer. */
interface Fixture {
  /** The main checkout, on `main`, with one commit holding README.md. */
  readonly dir: string
  /** A path beside the repository, for a worktree. */
  readonly beside: (name: string) => string
  commit(message: string, files?: Readonly<Record<string, string>>, dir?: string): string
  write(files: Readonly<Record<string, string>>, dir?: string): void
  /** git add the paths. */
  stage(paths: ReadonlyArray<string>, dir?: string): void
  /** A new worktree beside the repository, on a new branch from base; its path. */
  worktree(branch: string, base?: string): string
  head(rev?: string, dir?: string): string
  detach(dir: string): void
  /** Deletes a worktree's folder behind git's back. */
  removeFolder(path: string): void
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
    beside: (name) => join(repo.dir, "..", name),
    commit: (message, files, dir) => repo.commit(message, files, dir),
    write: (files, dir) => repo.write(files, dir),
    stage: (paths, dir) => void repo.git(["add", "--", ...paths], dir),
    worktree: (branch, base) => repo.worktree(branch, base),
    head: (rev, dir) => repo.head(rev, dir),
    detach: (dir) => void repo.git(["checkout", "--quiet", "--detach"], dir),
    removeFolder: (path) => void Bun.spawnSync(["rm", "-r", path]),
    git: (use) =>
      Effect.runPromise(
        Effect.exit(Effect.provide(Effect.flatMap(Effect.service(Git), use), layer)),
      ),
  }
}

let memories = 0

/** The in-memory layer, its Repository and its runtime, for tests that script it. */
const memory = () => {
  memories += 1
  const root = `/memory-${memories}`
  const runtime = ManagedRuntime.make(memoryLayer({ dir: join(root, "repo") }))
  const repository = runtime.runSync(Effect.service(Repository))
  const run = <A, E>(effect: Effect.Effect<A, E, Git | GitWriter | Repository>) =>
    runtime.runPromise(Effect.exit(effect))
  return { root, runtime, repository, run }
}

const memoryFixture = (): Fixture => {
  const { root, runtime, repository, run } = memory()
  let worktrees = 0
  const sync = <A>(effect: Effect.Effect<A, unknown, Git | GitWriter | Repository>) =>
    runtime.runSync(effect)
  return {
    dir: repository.dir,
    beside: (name) => join(root, name),
    commit: (message, files, dir = repository.dir) => sync(repository.commit(dir, message, files)),
    write: (files, dir = repository.dir) => sync(repository.write(dir, files)),
    stage: (paths, dir = repository.dir) => sync(repository.stage(dir, paths)),
    worktree: (branch, base = "HEAD") => {
      worktrees += 1
      const path = join(root, `worktree-${worktrees}`)
      sync(
        Effect.flatMap(Effect.service(Git), (git) =>
          git.addWorktree(repository.dir, path, { branch, base }),
        ),
      )
      return path
    },
    head: (rev, dir) => sync(repository.head(rev, dir)),
    detach: (dir) => sync(repository.checkout(dir, sync(repository.head("HEAD", dir)))),
    removeFolder: (path) => sync(repository.removeFolder(path)),
    git: (use) => run(Effect.flatMap(Effect.service(Git), use)),
  }
}

/**
 * A ticket branch in a worktree, one commit on top of main, while main has moved on: `shared.txt`
 * changed on both sides when `conflict` is set, on neither otherwise.
 */
const diverged = (repo: Fixture, conflict: boolean) => {
  repo.commit("Shared", { "shared.txt": "one\n" })
  const worktree = repo.worktree("wt/demo-1")
  repo.commit(
    "demo-1: Change the ticket's side",
    conflict ? { "shared.txt": "ticket\n" } : { "ticket.txt": "ticket\n" },
    worktree,
  )
  repo.commit("Move main", conflict ? { "shared.txt": "main\n" } : { "main.txt": "main\n" })
  return { worktree, before: repo.head("HEAD", worktree) }
}

/** The expectations the Git service meets, run against real git and the in-memory layer alike. */
const expectations = (make: () => Fixture) => {
  test("worktree add, list and remove; an existing branch; a dirty one only when forced", async () => {
    const repo = make()
    const start = repo.head("main")
    const one = repo.beside("one")
    const two = repo.beside("two")
    const listed = success(
      await repo.git((git) =>
        Effect.gen(function* () {
          yield* git.createBranch(repo.dir, "wt/demo-2", "main")
          yield* git.addWorktree(repo.dir, one, { branch: "wt/demo-1", base: "main" })
          yield* git.addWorktree(repo.dir, two, { branch: "wt/demo-2" })
          return yield* git.worktrees(repo.dir)
        }),
      ),
    )
    expect(listed).toEqual([
      { path: repo.dir, head: start, branch: "main", prunable: false },
      { path: one, head: start, branch: "wt/demo-1", prunable: false },
      { path: two, head: start, branch: "wt/demo-2", prunable: false },
    ])

    const taken = failure(
      await repo.git((git) =>
        git.addWorktree(repo.dir, repo.beside("three"), { branch: "wt/demo-1" }),
      ),
    )
    expect(taken).toMatchObject({ _tag: "GitFailed", op: "worktree add" })

    repo.write({ "dirty.txt": "x\n" }, one)
    const refused = failure(await repo.git((git) => git.removeWorktree(repo.dir, one)))
    expect(refused).toMatchObject({ _tag: "GitFailed", op: "worktree remove" })
    const left = success(
      await repo.git((git) =>
        Effect.gen(function* () {
          yield* git.removeWorktree(repo.dir, one, { force: true })
          yield* git.removeWorktree(repo.dir, two)
          return yield* git.worktrees(repo.dir)
        }),
      ),
    )
    expect(left.map((worktree) => worktree.path)).toEqual([repo.dir])
  })

  test("worktree add --detach: a commit checked out on no branch; an unknown commit refused", async () => {
    const repo = make()
    const start = repo.head("main")
    const detached = repo.beside("detached")
    const listed = success(
      await repo.git((git) =>
        Effect.gen(function* () {
          yield* git.addDetachedWorktree(repo.dir, detached, "main")
          return yield* git.worktrees(repo.dir)
        }),
      ),
    )
    expect(listed).toEqual([
      { path: repo.dir, head: start, branch: "main", prunable: false },
      { path: detached, head: start, prunable: false },
    ])
    const unknown = failure(
      await repo.git((git) => git.addDetachedWorktree(repo.dir, repo.beside("x"), "no-such")),
    )
    expect(unknown).toMatchObject({ _tag: "GitFailed", op: "worktree add" })
  })

  test("worktree prune forgets a worktree whose folder is gone", async () => {
    const repo = make()
    const worktree = repo.worktree("wt/demo-1")
    repo.removeFolder(worktree)
    const [before, after] = success(
      await repo.git((git) =>
        Effect.gen(function* () {
          const before = yield* git.worktrees(repo.dir)
          yield* git.pruneWorktrees(repo.dir)
          return [before, yield* git.worktrees(repo.dir)] as const
        }),
      ),
    )
    expect(before.map((each) => each.prunable)).toEqual([false, true])
    expect(after.map((each) => each.path)).toEqual([repo.dir])
  })

  test("branch create and delete; one checked out or unmerged is refused", async () => {
    const repo = make()
    const worktree = repo.worktree("wt/demo-2")
    repo.commit("demo-2: Unmerged", { "b.txt": "b\n" }, worktree)
    const result = await repo.git((git) =>
      Effect.gen(function* () {
        yield* git.createBranch(repo.dir, "wt/demo-1", "main")
        const created = yield* git.revParse(repo.dir, "wt/demo-1")
        const twice = yield* Effect.exit(git.createBranch(repo.dir, "wt/demo-1", "main"))
        const checkedOut = yield* Effect.exit(git.deleteBranch(repo.dir, "wt/demo-2"))
        yield* git.removeWorktree(repo.dir, worktree)
        const unmerged = yield* Effect.exit(git.deleteBranch(repo.dir, "wt/demo-2"))
        yield* git.deleteBranch(repo.dir, "wt/demo-1")
        yield* git.deleteBranch(repo.dir, "wt/demo-2", { force: true })
        const gone = yield* Effect.exit(git.revParse(repo.dir, "wt/demo-2"))
        return { created, twice, checkedOut, unmerged, gone }
      }),
    )
    const { created, twice, checkedOut, unmerged, gone } = success(result)
    expect(created).toBe(repo.head("main"))
    expect(failure(twice)).toMatchObject({ _tag: "GitFailed", op: "branch" })
    expect(failure(checkedOut)).toMatchObject({ _tag: "GitFailed", op: "branch -d" })
    expect(failure(unmerged)).toMatchObject({ _tag: "GitFailed", op: "branch -d" })
    expect(failure(gone)).toMatchObject({ _tag: "GitFailed", op: "rev-parse", exitCode: 1 })
  })

  test("commits: log gives each one's whole message, newest first", async () => {
    const repo = make()
    const worktree = repo.worktree("wt/demo-1")
    const first = repo.commit("demo-1: First\n\nWith a body\nof two lines.", {}, worktree)
    const second = repo.commit("demo-1: Second", { "a.txt": "a\n" }, worktree)
    const commits = success(await repo.git((git) => git.log(repo.dir, "main", "wt/demo-1")))
    expect(commits).toEqual([
      { hash: second, subject: "demo-1: Second", message: "demo-1: Second\n" },
      {
        hash: first,
        subject: "demo-1: First",
        message: "demo-1: First\n\nWith a body\nof two lines.\n",
      },
    ])
    expect(repo.head("wt/demo-1")).toBe(second)
  })

  test("rebase onto a moved main, then merge-base, log, the branch's files and a fast-forward", async () => {
    const repo = make()
    const { worktree } = diverged(repo, false)
    const main = repo.head("main")
    const result = success(
      await repo.git((git) =>
        Effect.gen(function* () {
          yield* git.rebase(worktree, "main")
          return {
            base: yield* git.mergeBase(repo.dir, "main", "wt/demo-1"),
            commits: yield* git.log(worktree, "main"),
            files: yield* git.changedFiles(worktree, "main"),
            status: yield* git.status(worktree),
            branch: yield* git.currentBranch(worktree),
          }
        }),
      ),
    )
    expect(result).toEqual({
      base: main,
      commits: [
        {
          hash: repo.head("wt/demo-1"),
          subject: "demo-1: Change the ticket's side",
          message: "demo-1: Change the ticket's side\n",
        },
      ],
      files: ["ticket.txt"],
      status: [],
      branch: Option.some("wt/demo-1"),
    })

    success(await repo.git((git) => git.fastForward(repo.dir, "wt/demo-1")))
    expect(repo.head("main")).toBe(repo.head("wt/demo-1"))
    const tracked = success(await repo.git((git) => git.trackedFiles(repo.dir)))
    expect(tracked).toEqual(["README.md", "main.txt", "shared.txt", "ticket.txt"])
  })

  test("a rebase with nothing to replay leaves the branch where it was", async () => {
    const repo = make()
    const worktree = repo.worktree("wt/demo-1")
    const head = repo.commit("demo-1: Work", { "a.txt": "a\n" }, worktree)
    success(await repo.git((git) => git.rebase(worktree, "main")))
    expect(repo.head("wt/demo-1")).toBe(head)
  })

  test("a fast-forward that isn't one fails and leaves main as it was", async () => {
    const repo = make()
    diverged(repo, false)
    const main = repo.head("main")
    const refused = failure(await repo.git((git) => git.fastForward(repo.dir, "wt/demo-1")))
    expect(refused).toMatchObject({ _tag: "GitFailed", op: "merge --ff-only" })
    expect(repo.head("main")).toBe(main)
  })

  test("a conflicting rebase fails with RebaseConflict naming its files, and stays stopped", async () => {
    const repo = make()
    const { worktree, before } = diverged(repo, true)
    const conflict = failure(await repo.git((git) => git.rebase(worktree, "main")))
    expect(conflict).toBeInstanceOf(RebaseConflict)
    expect(conflict).toMatchObject({ files: ["shared.txt"] })

    const result = success(
      await repo.git((git) =>
        Effect.gen(function* () {
          const stopped = yield* git.rebaseInProgress(worktree)
          const branch = yield* git.currentBranch(worktree)
          const files = yield* git.status(worktree)
          yield* git.abortRebase(worktree)
          return {
            stopped,
            branch,
            files,
            aborted: yield* git.rebaseInProgress(worktree),
            after: yield* git.currentBranch(worktree),
            again: yield* Effect.exit(git.abortRebase(worktree)),
          }
        }),
      ),
    )
    expect(result.stopped).toBe(true)
    expect(result.branch).toEqual(Option.none())
    expect(result.files).toEqual([{ code: "UU", path: "shared.txt" }])
    expect(result.aborted).toBe(false)
    expect(result.after).toEqual(Option.some("wt/demo-1"))
    expect(failure(result.again)).toMatchObject({ _tag: "GitFailed", op: "rebase --abort" })
    expect(repo.head("wt/demo-1")).toBe(before)
  })

  test("a rebase of a dirty worktree is refused with GitFailed and leaves no rebase", async () => {
    const repo = make()
    const { worktree, before } = diverged(repo, false)
    repo.write({ "README.md": "changed but not committed\n" }, worktree)
    const unstaged = failure(await repo.git((git) => git.rebase(worktree, "main")))
    expect(unstaged).toBeInstanceOf(GitFailed)
    expect(unstaged).toMatchObject({ op: "rebase", exitCode: 1 })
    expect((unstaged as GitFailed).stderr).toContain("You have unstaged changes")

    repo.stage(["README.md"], worktree)
    const staged = failure(await repo.git((git) => git.rebase(worktree, "main")))
    expect((staged as GitFailed).stderr).toContain("Your index contains uncommitted changes")
    const inProgress = success(await repo.git((git) => git.rebaseInProgress(worktree)))
    expect(inProgress).toBe(false)
    expect(repo.head("wt/demo-1")).toBe(before)
  })

  test("status --porcelain: changed, staged, added, deleted and untracked files, under paths", async () => {
    const repo = make()
    repo.commit("Files", { "a.txt": "a\n", "b.txt": "b\n", "src/c.ts": "c\n", "d.txt": "d\n" })
    repo.write({ "a.txt": "changed\n", "b.txt": "staged\n", "new dir/d e.txt": "new\n" })
    repo.write({ "src/added.ts": "added\n" })
    repo.stage(["b.txt", "src/added.ts"])
    repo.write({ "b.txt": "staged, then changed\n" })
    const [all, under] = success(
      await repo.git((git) => Effect.all([git.status(repo.dir), git.status(repo.dir, ["src"])])),
    )
    expect(all).toEqual([
      { code: " M", path: "a.txt" },
      { code: "MM", path: "b.txt" },
      { code: "A ", path: "src/added.ts" },
      { code: "??", path: "new dir/d e.txt" },
    ])
    expect(under).toEqual([{ code: "A ", path: "src/added.ts" }])
  })

  test("diff --name-only base...HEAD: the branch's files, not main's since", async () => {
    const repo = make()
    repo.commit("Old", { "old.txt": "old\n" })
    const worktree = repo.worktree("wt/demo-1")
    repo.commit("demo-1: Work", { "ticket.txt": "t\n", "with space.txt": "s\n" }, worktree)
    repo.commit("Move main", { "main.txt": "m\n" })
    const files = success(await repo.git((git) => git.changedFiles(worktree, "main")))
    expect(files).toEqual(["ticket.txt", "with space.txt"])
  })

  test("ls-files, rev-parse, the common git folder and the current branch, detached too", async () => {
    const repo = make()
    repo.commit("Files", { "src/a.ts": "a\n", "with space.md": "s\n" })
    repo.write({ "untracked.txt": "u\n" })
    const worktree = repo.worktree("wt/demo-1")
    const result = success(
      await repo.git((git) =>
        Effect.all({
          tracked: git.trackedFiles(repo.dir),
          head: git.revParse(worktree, "HEAD"),
          parent: git.revParse(repo.dir, "main~1"),
          commonFromMain: git.commonDir(repo.dir),
          commonFromWorktree: git.commonDir(worktree),
          onMain: git.currentBranch(repo.dir),
          onTicket: git.currentBranch(worktree),
        }),
      ),
    )
    expect(result).toEqual({
      tracked: ["README.md", "src/a.ts", "with space.md"],
      head: repo.head("main"),
      parent: repo.head("main~1"),
      commonFromMain: join(repo.dir, ".git"),
      commonFromWorktree: join(repo.dir, ".git"),
      onMain: Option.some("main"),
      onTicket: Option.some("wt/demo-1"),
    })

    repo.detach(worktree)
    const detached = success(await repo.git((git) => git.currentBranch(worktree)))
    expect(detached).toEqual(Option.none())
    const outside = failure(await repo.git((git) => git.currentBranch(repo.beside(""))))
    expect(outside).toMatchObject({ _tag: "GitFailed", op: "symbolic-ref" })
  })
}

slow.describe("the expectations, against real git", () => expectations(realFixture))

describe("the expectations, against the in-memory repository", () => expectations(memoryFixture))

describe("the in-memory repository, scripted", () => {
  test("a conflict forced on a branch stops its next rebase once, even with nothing overlapping", async () => {
    const { repository, run } = memory()
    const result = success(
      await run(
        Effect.gen(function* () {
          const git = yield* Git
          const worktree = join(repository.dir, "..", "wt")
          yield* git.addWorktree(repository.dir, worktree, { branch: "tutti/t-1", base: "main" })
          yield* repository.commit(worktree, "t-1: Work", { "a.txt": "a\n" })
          yield* repository.conflict("tutti/t-1", ["a.txt"])
          const first = yield* Effect.exit(git.rebase(worktree, "main"))
          yield* git.abortRebase(worktree)
          const second = yield* Effect.exit(git.rebase(worktree, "main"))
          return { first, second }
        }),
      ),
    )
    expect(failure(result.first)).toEqual(new RebaseConflict({ files: ["a.txt"] }))
    expect(Exit.isSuccess(result.second)).toBe(true)
  })

  test("a stopped rebase is resolved and continued, as a worker handed it back would", async () => {
    const { repository, run } = memory()
    const result = success(
      await run(
        Effect.gen(function* () {
          const git = yield* Git
          const worktree = join(repository.dir, "..", "wt")
          yield* repository.commit(repository.dir, "Shared", { "s.txt": "one\n" })
          yield* git.addWorktree(repository.dir, worktree, { branch: "tutti/t-1", base: "main" })
          yield* repository.commit(worktree, "t-1: First", { "s.txt": "ticket\n", "b.txt": "b\n" })
          yield* repository.commit(worktree, "t-1: Second", { "c.txt": "c\n" })
          yield* repository.commit(repository.dir, "Move main", { "s.txt": "main\n" })
          const conflict = yield* Effect.exit(git.rebase(worktree, "main"))
          const stopped = yield* git.status(worktree)
          const marked = yield* repository.read(worktree, "s.txt")
          const left = yield* repository.continueRebase(worktree, { "s.txt": "both\n" })
          return {
            conflict,
            stopped,
            marked,
            left,
            inProgress: yield* git.rebaseInProgress(worktree),
            branch: yield* git.currentBranch(worktree),
            commits: yield* git.log(worktree, "main"),
            tree: yield* repository.tree("tutti/t-1"),
          }
        }),
      ),
    )
    expect(failure(result.conflict)).toMatchObject({ files: ["s.txt"] })
    expect(result.stopped).toEqual([
      { code: "A ", path: "b.txt" },
      { code: "UU", path: "s.txt" },
    ])
    expect(result.marked).toContain("<<<<<<<")
    expect(result.left).toEqual([])
    expect(result.inProgress).toBe(false)
    expect(result.branch).toEqual(Option.some("tutti/t-1"))
    expect(result.commits.map((commit) => commit.subject)).toEqual(["t-1: Second", "t-1: First"])
    expect(Object.fromEntries(result.tree)).toEqual({
      "README.md": "# demo\n",
      "b.txt": "b\n",
      "c.txt": "c\n",
      "s.txt": "both\n",
    })
  })

  test("a fault fails the next call of its operation, in its worktree only, as often as asked", async () => {
    const { repository, run } = memory()
    const result = success(
      await run(
        Effect.gen(function* () {
          const git = yield* Git
          const worktree = join(repository.dir, "..", "wt")
          yield* git.addWorktree(repository.dir, worktree, { branch: "tutti/t-1", base: "main" })
          yield* repository.fail("status", { dir: worktree, times: 2, stderr: "boom" })
          yield* repository.fail("rebase", { timedOut: true })
          const elsewhere = yield* git.status(repository.dir)
          const first = yield* Effect.exit(git.status(worktree))
          const second = yield* Effect.exit(git.status(worktree))
          const third = yield* git.status(worktree)
          const rebase = yield* Effect.exit(git.rebase(worktree, "main"))
          return { elsewhere, first, second, third, rebase, calls: yield* repository.calls }
        }),
      ),
    )
    expect(result.elsewhere).toEqual([])
    expect(failure(result.first)).toMatchObject({
      _tag: "GitFailed",
      op: "status",
      exitCode: 1,
      stderr: "boom",
    })
    expect(failure(result.second)).toBeInstanceOf(GitFailed)
    expect(result.third).toEqual([])
    expect(failure(result.rebase)).toBeInstanceOf(GitTimedOut)
    expect(result.calls.map((call) => call.op)).toEqual([
      "worktree add",
      "status",
      "status",
      "status",
      "status",
      "rebase",
    ])
  })

  test("writes take the layer's GitWriter", async () => {
    const { repository, run } = memory()
    const result = success(
      await run(
        Effect.gen(function* () {
          const git = yield* Git
          const writer = yield* GitWriter
          const holding = yield* Effect.forkChild(writer.withLock(Effect.sleep("50 millis")))
          yield* Effect.yieldNow
          const write = yield* Effect.forkChild(git.createBranch(repository.dir, "b", "main"))
          yield* Effect.yieldNow
          const whileHeld = yield* Effect.exit(git.revParse(repository.dir, "b"))
          yield* Fiber.join(holding)
          yield* Fiber.join(write)
          return {
            whileHeld,
            after: yield* git.revParse(repository.dir, "b"),
            main: yield* repository.head("main"),
          }
        }),
      ),
    )
    expect(Exit.isFailure(result.whileHeld)).toBe(true)
    expect(result.after).toBe(result.main)
  })
})

/**
 * The merge queue's git steps for a ticket (§ 5, 7), as far as they go: the reason it would be set
 * aside or blocked, or `MERGED`.
 */
const merge = (repo: string, worktree: string, branch: string) =>
  Effect.gen(function* () {
    const git = yield* Git
    const current = yield* git.currentBranch(worktree)
    if (Option.getOrUndefined(current) !== branch) return "OFF_BRANCH"
    if ((yield* git.status(worktree)).length > 0) return "DIRTY_WORKTREE"
    const rebased = yield* Effect.exit(git.rebase(worktree, "main"))
    if (Exit.isFailure(rebased)) {
      return failure(rebased) instanceof RebaseConflict ? "MERGE_CONFLICT" : "REBASE_FAILED"
    }
    const merged = yield* Effect.exit(git.fastForward(repo, branch))
    return Exit.isSuccess(merged) ? "MERGED" : "MERGE_FAILED"
  })

describe("the in-memory repository, scripted into each merge failure", () => {
  /** A ticket's worktree with one commit, main moved on beside it; `script` then sets it up. */
  const scenario = (
    script: (
      repository: Repository["Service"],
      worktree: string,
    ) => Effect.Effect<void, unknown, Git | GitWriter | Repository>,
  ) => {
    const { repository, run } = memory()
    const worktree = join(repository.dir, "..", "tutti-t-1")
    return run(
      Effect.gen(function* () {
        const git = yield* Git
        yield* git.addWorktree(repository.dir, worktree, { branch: "tutti/t-1", base: "main" })
        yield* repository.commit(worktree, "t-1: Work", { "t.txt": "t\n", "s.txt": "ticket\n" })
        yield* repository.commit(repository.dir, "Move main", { "m.txt": "m\n" })
        yield* script(repository, worktree)
        return yield* merge(repository.dir, worktree, "tutti/t-1")
      }),
    ).then(success)
  }

  test("left alone, the ticket merges", async () => {
    expect(await scenario(() => Effect.void)).toBe("MERGED")
  })

  test("OFF_BRANCH: the worktree on a detached HEAD, or another branch", async () => {
    expect(
      await scenario((repository, worktree) =>
        Effect.flatMap(repository.head("HEAD", worktree), (head) =>
          repository.checkout(worktree, head),
        ),
      ),
    ).toBe("OFF_BRANCH")
    expect(
      await scenario((repository, worktree) =>
        Effect.gen(function* () {
          yield* (yield* Git).createBranch(repository.dir, "other", "main")
          yield* repository.checkout(worktree, "other")
        }),
      ),
    ).toBe("OFF_BRANCH")
  })

  test("DIRTY_WORKTREE: a change left uncommitted, or an untracked file", async () => {
    expect(
      await scenario((repository, worktree) => repository.write(worktree, { "t.txt": "more\n" })),
    ).toBe("DIRTY_WORKTREE")
    expect(
      await scenario((repository, worktree) => repository.write(worktree, { "new.txt": "n\n" })),
    ).toBe("DIRTY_WORKTREE")
  })

  test("MERGE_CONFLICT: main changed a file the ticket changed, or a conflict forced", async () => {
    expect(
      await scenario((repository) =>
        Effect.asVoid(repository.commit(repository.dir, "Main's side", { "s.txt": "main\n" })),
      ),
    ).toBe("MERGE_CONFLICT")
    expect(await scenario((repository) => repository.conflict("tutti/t-1", ["t.txt"]))).toBe(
      "MERGE_CONFLICT",
    )
  })

  test("REBASE_FAILED: git fails the rebase", async () => {
    expect(await scenario((repository) => repository.fail("rebase", { exitCode: 128 }))).toBe(
      "REBASE_FAILED",
    )
  })

  test("MERGE_FAILED: main moves between the rebase and the fast-forward, or git fails it", async () => {
    expect(
      await scenario((repository) => repository.fail("merge --ff-only", { exitCode: 128 })),
    ).toBe("MERGE_FAILED")
    // A write main took between the steps leaves the rebased branch no longer a descendant.
    const { repository, run } = memory()
    const worktree = join(repository.dir, "..", "tutti-t-1")
    const result = await run(
      Effect.gen(function* () {
        const git = yield* Git
        yield* git.addWorktree(repository.dir, worktree, { branch: "tutti/t-1", base: "main" })
        yield* repository.commit(worktree, "t-1: Work", { "t.txt": "t\n" })
        yield* git.rebase(worktree, "main")
        yield* repository.commit(repository.dir, "Main moves on", { "m.txt": "m\n" })
        return yield* Effect.exit(git.fastForward(repository.dir, "tutti/t-1"))
      }),
    ).then(success)
    expect(failure(result)).toMatchObject({ _tag: "GitFailed", op: "merge --ff-only" })
  })
})
