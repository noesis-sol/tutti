import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Exit, Fiber, Layer, Option, Ref, Semaphore } from "effect"
import fc from "fast-check"
import {
  Git,
  GitFailed,
  GitTimedOut,
  GitWriter,
  parseLog,
  parseStatus,
  parseWorktrees,
  RebaseConflict,
  splitNul,
} from "../src/services/Git.ts"
import { slow } from "./gates.ts"
import { hooksDir, makeRepo, type Repo } from "./git.ts"

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (error === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  return error.error
}

const gitLayer = (timeLimits?: { read: Duration.Input; write: Duration.Input }) =>
  Git.layer(timeLimits === undefined ? {} : { timeLimits }).pipe(
    Layer.provideMerge(GitWriter.layer),
    Layer.provideMerge(BunServices.layer),
  )

const run = <A, E>(
  effect: Effect.Effect<A, E, Git | GitWriter | BunServices.BunServices>,
  timeLimits?: { read: Duration.Input; write: Duration.Input },
): Promise<A> => Effect.runPromise(Effect.provide(effect, gitLayer(timeLimits)))

const runExit = <A, E>(effect: Effect.Effect<A, E, Git | GitWriter | BunServices.BunServices>) =>
  Effect.runPromise(Effect.exit(Effect.provide(effect, gitLayer())))

const withGit = <A, E>(use: (git: Git["Service"]) => Effect.Effect<A, E>) =>
  Effect.flatMap(Effect.service(Git), use)

/** Waits up to `ms` for the condition, and says whether it came true. */
const eventually = async (condition: () => boolean, ms = 10_000): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) return false
    await Bun.sleep(20)
  }
  return true
}

/**
 * A ticket branch in a worktree, one commit on top of main, while main has moved on: `shared.txt`
 * changed on both sides when `conflict` is set, on neither otherwise.
 */
const diverged = (repo: Repo, conflict: boolean) => {
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

/**
 * A reference-transaction hook that, once the marker it returns is created, sleeps the first time
 * git updates a ref with a rebase under way: a rebase to interrupt or time out halfway.
 */
const slowRebaseHook = (repo: Repo): string => {
  const hooks = hooksDir(repo)
  const marker = join(hooks, "slow")
  const hook = join(hooks, "reference-transaction")
  writeFileSync(
    hook,
    [
      "#!/bin/sh",
      "cat >/dev/null",
      `marker='${marker}'`,
      'if [ -f "$marker" ] && [ -d "$(git rev-parse --path-format=absolute --git-path rebase-merge)" ]; then',
      '  rm -f "$marker"',
      "  sleep 30",
      "fi",
      "",
    ].join("\n"),
  )
  chmodSync(hook, 0o755)
  return marker
}

describe("reading git's -z output", () => {
  const field = fc.string({ minLength: 1 }).filter((text) => !text.includes("\0"))

  test("splitNul gives back each name, spaces, quotes and newlines and all", () => {
    fc.assert(
      fc.property(fc.array(field), (names) => {
        expect(splitNul(names.map((name) => `${name}\0`).join(""))).toEqual(names)
      }),
    )
  })

  test("parseLog gives back each commit's hash, subject and message", () => {
    const hash = fc.stringMatching(/^[0-9a-f]{40}$/)
    const text = fc.string().filter((value) => !value.includes("\0"))
    fc.assert(
      fc.property(fc.array(fc.record({ hash, subject: text, message: text })), (commits) => {
        // git -z ends each commit with a NUL; %B's message ends with a newline of its own.
        const output = commits
          .map((commit) => `${commit.hash}\0${commit.subject}\0${commit.message}\0`)
          .join("")
        expect(parseLog(output)).toEqual(commits)
      }),
    )
  })

  test("parseStatus reads codes, paths and a rename's former path", () => {
    expect(parseStatus(" M a b.ts\0?? new\nline.txt\0R  to.ts\0from.ts\0UU c.ts\0")).toEqual([
      { code: " M", path: "a b.ts" },
      { code: "??", path: "new\nline.txt" },
      { code: "R ", path: "to.ts", from: "from.ts" },
      { code: "UU", path: "c.ts" },
    ])
    const code = fc.constantFrom(" M", "M ", "A ", "D ", "??", "UU", "AM")
    const renameCode = fc.constantFrom("R ", " R", "RM", "C ", " C", "CM")
    const entry = fc.oneof(
      fc.record({ code, path: field }),
      fc.record({ code: renameCode, path: field, from: field }),
    )
    fc.assert(
      fc.property(fc.array(entry), (entries) => {
        const output = entries
          .map((each) => `${each.code} ${each.path}\0${"from" in each ? `${each.from}\0` : ""}`)
          .join("")
        expect(parseStatus(output)).toEqual(entries)
      }),
    )
  })

  test("parseWorktrees reads branches, detached HEADs and prunable worktrees", () => {
    const output = [
      "worktree /repo",
      "HEAD 111",
      "branch refs/heads/main",
      "",
      "worktree /wt/a b",
      "HEAD 222",
      "detached",
      "",
      "worktree /wt/gone",
      "HEAD 333",
      "branch refs/heads/wt/demo-1",
      "prunable gitdir file points to non-existent location",
      "",
      "",
    ].join("\0")
    expect(parseWorktrees(output)).toEqual([
      { path: "/repo", head: "111", branch: "main", prunable: false },
      { path: "/wt/a b", head: "222", prunable: false },
      { path: "/wt/gone", head: "333", branch: "wt/demo-1", prunable: true },
    ])
    fc.assert(
      fc.property(fc.array(field.filter((path) => !path.startsWith("\n"))), (paths) => {
        const listed = paths.map((path) => `worktree ${path}\0HEAD 1\0detached\0\0`).join("")
        expect(parseWorktrees(listed).map((worktree) => worktree.path)).toEqual(paths)
      }),
    )
  })
})

describe("GitWriter", () => {
  test("lets one writer in at a time", async () => {
    const most = await Effect.runPromise(
      Effect.gen(function* () {
        const writer = GitWriter.make(yield* Semaphore.make(1))
        const inside = yield* Ref.make(0)
        const most = yield* Ref.make(0)
        const write = writer.withLock(
          Effect.gen(function* () {
            const now = yield* Ref.updateAndGet(inside, (count) => count + 1)
            yield* Ref.update(most, (max) => Math.max(max, now))
            yield* Effect.sleep("5 millis")
            yield* Ref.update(inside, (count) => count - 1)
          }),
        )
        yield* Effect.all(
          Array.from({ length: 8 }, () => write),
          { concurrency: "unbounded" },
        )
        return yield* Ref.get(most)
      }),
    )
    expect(most).toBe(1)
  })

  test("a writer holding it, and the fibers it forks, don't wait on themselves", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const writer = GitWriter.make(yield* Semaphore.make(1))
        return yield* writer.withLock(
          Effect.gen(function* () {
            const nested = yield* writer.withLock(Effect.succeed("nested"))
            const forked = yield* Effect.forkChild(writer.withLock(Effect.succeed("forked")))
            return [nested, yield* Fiber.join(forked)]
          }),
        )
      }).pipe(Effect.timeout("2 seconds")),
    )
    expect(result).toEqual(["nested", "forked"])
  })
})

slow.describe("Git against a real repository", () => {
  test("worktree add, list and remove; an existing branch checked out", async () => {
    const repo = makeRepo()
    repo.branch("wt/demo-2")
    const one = join(repo.dir, "..", "one")
    const two = join(repo.dir, "..", "two")
    const listed = await run(
      withGit((git) =>
        Effect.gen(function* () {
          yield* git.addWorktree(repo.dir, one, { branch: "wt/demo-1", base: "main" })
          yield* git.addWorktree(repo.dir, two, { branch: "wt/demo-2" })
          return yield* git.worktrees(repo.dir)
        }),
      ),
    )
    const start = repo.head("main")
    expect(listed).toEqual([
      { path: repo.dir, head: start, branch: "main", prunable: false },
      { path: one, head: start, branch: "wt/demo-1", prunable: false },
      { path: two, head: start, branch: "wt/demo-2", prunable: false },
    ])

    repo.write({ "dirty.txt": "x\n" }, one)
    const refused = failure(await runExit(withGit((git) => git.removeWorktree(repo.dir, one))))
    expect(refused).toBeInstanceOf(GitFailed)
    expect(refused).toMatchObject({ op: "worktree remove" })
    const left = await run(
      withGit((git) =>
        Effect.gen(function* () {
          yield* git.removeWorktree(repo.dir, one, { force: true })
          yield* git.removeWorktree(repo.dir, two)
          return yield* git.worktrees(repo.dir)
        }),
      ),
    )
    expect(left.map((worktree) => worktree.path)).toEqual([repo.dir])
    expect(existsSync(one)).toBe(false)
  })

  test("worktree prune forgets a worktree whose folder is gone", async () => {
    const repo = makeRepo()
    const worktree = repo.worktree("wt/demo-1")
    Bun.spawnSync(["rm", "-r", worktree])
    const [before, after] = await run(
      withGit((git) =>
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

  test("branch create and delete; an unmerged branch only when forced", async () => {
    const repo = makeRepo()
    const start = repo.head()
    await run(withGit((git) => git.createBranch(repo.dir, "wt/demo-1", "main")))
    expect(repo.head("wt/demo-1")).toBe(start)

    const worktree = repo.worktree("wt/demo-2")
    repo.commit("demo-2: Unmerged", { "b.txt": "b\n" }, worktree)
    await run(withGit((git) => git.removeWorktree(repo.dir, worktree)))
    const refused = failure(
      await runExit(withGit((git) => git.deleteBranch(repo.dir, "wt/demo-2"))),
    )
    expect(refused).toMatchObject({ _tag: "GitFailed", op: "branch -d" })

    await run(
      withGit((git) =>
        Effect.gen(function* () {
          yield* git.deleteBranch(repo.dir, "wt/demo-1")
          yield* git.deleteBranch(repo.dir, "wt/demo-2", { force: true })
        }),
      ),
    )
    expect(repo.git(["branch", "--list", "wt/*"]).trim()).toBe("")
  })

  test("rebase onto a moved main, then merge-base, log and a fast-forward", async () => {
    const repo = makeRepo()
    const { worktree } = diverged(repo, false)
    const main = repo.head("main")
    const [base, commits] = await run(
      withGit((git) =>
        Effect.gen(function* () {
          yield* git.rebase(worktree, "main")
          return [
            yield* git.mergeBase(repo.dir, "main", "wt/demo-1"),
            yield* git.log(worktree, "main"),
          ] as const
        }),
      ),
    )
    expect(base).toBe(main)
    expect(commits).toEqual([
      {
        hash: repo.head("wt/demo-1"),
        subject: "demo-1: Change the ticket's side",
        message: "demo-1: Change the ticket's side\n",
      },
    ])

    await run(withGit((git) => git.fastForward(repo.dir, "wt/demo-1")))
    expect(repo.head("main")).toBe(repo.head("wt/demo-1"))
  })

  test("log gives every commit's whole message, newest first", async () => {
    const repo = makeRepo()
    const worktree = repo.worktree("wt/demo-1")
    repo.commit("demo-1: First\n\nWith a body\nof two lines.", {}, worktree)
    repo.commit("demo-1: Second", {}, worktree)
    const commits = await run(withGit((git) => git.log(repo.dir, "main", "wt/demo-1")))
    expect(commits.map((commit) => [commit.subject, commit.message])).toEqual([
      ["demo-1: Second", "demo-1: Second\n"],
      ["demo-1: First", "demo-1: First\n\nWith a body\nof two lines.\n"],
    ])
  })

  test("a fast-forward that isn't one fails and leaves main as it was", async () => {
    const repo = makeRepo()
    diverged(repo, false)
    const main = repo.head("main")
    const refused = failure(await runExit(withGit((git) => git.fastForward(repo.dir, "wt/demo-1"))))
    expect(refused).toMatchObject({ _tag: "GitFailed", op: "merge --ff-only" })
    expect(repo.head("main")).toBe(main)
  })

  test("a conflicting rebase fails with RebaseConflict naming its files, and stays stopped", async () => {
    const repo = makeRepo()
    const { worktree, before } = diverged(repo, true)
    const conflict = failure(await runExit(withGit((git) => git.rebase(worktree, "main"))))
    expect(conflict).toBeInstanceOf(RebaseConflict)
    expect(conflict).toMatchObject({ files: ["shared.txt"] })

    const [stopped, files, aborted] = await run(
      withGit((git) =>
        Effect.gen(function* () {
          const stopped = yield* git.rebaseInProgress(worktree)
          const files = yield* git.status(worktree)
          yield* git.abortRebase(worktree)
          return [stopped, files, yield* git.rebaseInProgress(worktree)] as const
        }),
      ),
    )
    expect(stopped).toBe(true)
    expect(files).toEqual([{ code: "UU", path: "shared.txt" }])
    expect(aborted).toBe(false)
    expect(repo.head("wt/demo-1")).toBe(before)
  })

  test("a rebase git refuses fails with GitFailed and leaves no rebase behind", async () => {
    const repo = makeRepo()
    const { worktree, before } = diverged(repo, false)
    repo.write({ "README.md": "changed but not committed\n" }, worktree)
    const refused = failure(await runExit(withGit((git) => git.rebase(worktree, "main"))))
    expect(refused).toMatchObject({ _tag: "GitFailed", op: "rebase" })
    const inProgress = await run(withGit((git) => git.rebaseInProgress(worktree)))
    expect(inProgress).toBe(false)
    expect(repo.head("wt/demo-1")).toBe(before)
  })

  test("interrupting a rebase aborts it, leaving the branch as it was", async () => {
    const repo = makeRepo()
    const { worktree, before } = diverged(repo, false)
    const marker = slowRebaseHook(repo)
    writeFileSync(marker, "")
    const after = await run(
      withGit((git) =>
        Effect.gen(function* () {
          const rebase = yield* Effect.forkChild(git.rebase(worktree, "main"))
          const halfway = yield* Effect.promise(() => eventually(() => !existsSync(marker)))
          yield* Fiber.interrupt(rebase)
          return {
            halfway,
            inProgress: yield* git.rebaseInProgress(worktree),
            branch: yield* git.currentBranch(worktree),
            status: yield* git.status(worktree),
          }
        }),
      ),
    )
    expect(after).toEqual({
      halfway: true,
      inProgress: false,
      branch: Option.some("wt/demo-1"),
      status: [],
    })
    expect(repo.head("wt/demo-1")).toBe(before)
  })

  test("a rebase past its time limit fails with GitTimedOut and is aborted", async () => {
    const repo = makeRepo()
    const { worktree, before } = diverged(repo, false)
    writeFileSync(slowRebaseHook(repo), "")
    // The abort runs within the write limit too: 1 s cut it off on a loaded machine (2026-10-22),
    // leaving the rebase in progress. 3 s is still far below the hook's 30 s.
    const limits = { read: Duration.seconds(30), write: Duration.seconds(3) }
    const exit = await run(Effect.exit(withGit((git) => git.rebase(worktree, "main"))), limits)
    const timedOut = failure(exit)
    expect(timedOut).toBeInstanceOf(GitTimedOut)
    expect(timedOut).toMatchObject({ op: "rebase" })
    const [inProgress, branch] = await run(
      withGit((git) => Effect.all([git.rebaseInProgress(worktree), git.currentBranch(worktree)])),
    )
    expect(inProgress).toBe(false)
    expect(branch).toEqual(Option.some("wt/demo-1"))
    expect(repo.head("wt/demo-1")).toBe(before)
  })

  test("status --porcelain: changed, staged, renamed and untracked files, under paths", async () => {
    const repo = makeRepo()
    repo.commit("Files", { "a.txt": "a\n", "b.txt": "b\n", "src/c.ts": "c\n" })
    repo.write({ "a.txt": "changed\n", "new dir/d e.txt": "new\n" })
    repo.git(["mv", "b.txt", "renamed.txt"])
    // Moved in the worktree only, the new path marked with intent to add: a rename in the second column.
    repo.git(["mv", "src/c.ts", "src/moved.ts"])
    repo.git(["reset", "--quiet", "--", "src/c.ts", "src/moved.ts"])
    repo.git(["add", "-N", "src/moved.ts"])
    const [all, under] = await run(
      withGit((git) => Effect.all([git.status(repo.dir), git.status(repo.dir, ["new dir"])])),
    )
    expect(all).toEqual([
      { code: " M", path: "a.txt" },
      { code: "R ", path: "renamed.txt", from: "b.txt" },
      { code: " R", path: "src/moved.ts", from: "src/c.ts" },
      { code: "??", path: "new dir/d e.txt" },
    ])
    expect(under).toEqual([{ code: "??", path: "new dir/d e.txt" }])
  })

  test("diff --name-only base...HEAD: the branch's files, not main's since", async () => {
    const repo = makeRepo()
    repo.commit("Old", { "old.txt": "old\n" })
    const worktree = repo.worktree("wt/demo-1")
    repo.commit("demo-1: Work", { "ticket.txt": "t\n", "with space.txt": "s\n" }, worktree)
    repo.git(["mv", "old.txt", "moved.txt"], worktree)
    repo.commit("demo-1: Move", {}, worktree)
    repo.commit("Move main", { "main.txt": "m\n" })
    const files = await run(withGit((git) => git.changedFiles(worktree, "main")))
    expect([...files].sort()).toEqual(["moved.txt", "old.txt", "ticket.txt", "with space.txt"])
  })

  test("ls-files, rev-parse, the common git folder and the current branch", async () => {
    const repo = makeRepo()
    repo.commit("Files", { "src/a.ts": "a\n", "with space.md": "s\n" })
    repo.write({ "untracked.txt": "u\n" })
    const worktree = repo.worktree("wt/demo-1")
    const result = await run(
      withGit((git) =>
        Effect.all({
          tracked: git.trackedFiles(repo.dir),
          head: git.revParse(worktree, "HEAD"),
          main: git.revParse(repo.dir, "main"),
          missing: Effect.exit(git.revParse(repo.dir, "no-such-branch")),
          commonFromMain: git.commonDir(repo.dir),
          commonFromWorktree: git.commonDir(worktree),
          onMain: git.currentBranch(repo.dir),
          onTicket: git.currentBranch(worktree),
        }),
      ),
    )
    expect(result.tracked).toEqual(["README.md", "src/a.ts", "with space.md"])
    expect(result.head).toBe(repo.head("main"))
    expect(result.main).toMatch(/^[0-9a-f]{40}$/)
    expect(failure(result.missing)).toMatchObject({ _tag: "GitFailed", op: "rev-parse" })
    expect(result.commonFromMain).toBe(join(repo.dir, ".git"))
    expect(result.commonFromWorktree).toBe(join(repo.dir, ".git"))
    expect(result.onMain).toEqual(Option.some("main"))
    expect(result.onTicket).toEqual(Option.some("wt/demo-1"))

    repo.git(["checkout", "--quiet", "--detach"], worktree)
    const detached = await run(withGit((git) => git.currentBranch(worktree)))
    expect(detached).toEqual(Option.none())
    const outside = failure(
      await runExit(withGit((git) => git.currentBranch(join(repo.dir, "..")))),
    )
    expect(outside).toMatchObject({ _tag: "GitFailed", op: "symbolic-ref" })
  })

  test("a write waits for the writer holding GitWriter", async () => {
    const repo = makeRepo()
    const branches = () => repo.git(["branch", "--list", "wt/demo-1"]).trim()
    const result = await run(
      Effect.gen(function* () {
        const git = yield* Git
        const writer = yield* GitWriter
        const holding = yield* Effect.forkChild(writer.withLock(Effect.sleep("500 millis")))
        yield* Effect.sleep("50 millis")
        const write = yield* Effect.forkChild(git.createBranch(repo.dir, "wt/demo-1", "main"))
        yield* Effect.sleep("300 millis")
        const whileHeld = branches()
        yield* Fiber.join(holding)
        yield* Fiber.join(write)
        return { whileHeld, after: branches() }
      }),
    )
    expect(result).toEqual({ whileHeld: "", after: "wt/demo-1" })
  })
})
