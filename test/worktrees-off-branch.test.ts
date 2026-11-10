// A ticket's worktree left off its branch (tutti-34k9.3): git lists one stopped mid-rebase, left
// detached (git checkout --detach, git bisect) or on another branch with no branch line, or
// another's, so Worktrees found none by the branch, git worktree add failed on the branch the
// worktree holds, and the ticket was deferred with its work intact. prepare finds it at
// <root>/<id>, aborts a rebase left in progress and checks the branch out again, saying what it did
// (`putBack`); remove finds it the same way.

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Option } from "effect"
import type { TicketId } from "../src/services/Beads.ts"
import { Git, GitWriter } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { layer as gitLayer, Repository } from "../src/testing/Git.ts"
import { slow } from "./gates.ts"
import { makeRepo, type Repo } from "./git.ts"

const id = "demo-1" as TicketId
const branch = "tutti/demo-1"

describe("a worktree left off its branch, over the in-memory repository", () => {
  // The repository is in memory; its folder is real only for the info/exclude prepare writes.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-off-branch-")))
  const root = "/worktrees"
  const at = join(root, id)
  const layer = Worktrees.layer({ repo, root, base: "main" }).pipe(
    Layer.provideMerge(gitLayer({ dir: repo })),
    Layer.provideMerge(BunServices.layer),
  )

  /** demo-1's worktree with a commit of its own, left as `leave` leaves it. */
  const left = <A>(
    leave: (repository: Repository["Service"], git: Git["Service"]) => Effect.Effect<void, unknown>,
    then: (worktrees: Worktrees["Service"], git: Git["Service"]) => Effect.Effect<A, unknown>,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* Repository
        const git = yield* Git
        yield* git.addWorktree(repo, at, { branch, base: "main" })
        yield* repository.commit(at, "demo-1: Work", { "work.txt": "work\n" })
        yield* leave(repository, git)
        const listed = yield* git.worktrees(repo)
        expect(listed.find((worktree) => worktree.path === at)?.branch).not.toBe(branch)
        const result = yield* then(yield* Worktrees, git)
        const after = yield* git.worktrees(repo)
        return { result, after: after.find((worktree) => worktree.path === at) }
      }).pipe(Effect.provide(layer)),
    )

  const detach = (repository: Repository["Service"]) =>
    Effect.flatMap(repository.head("HEAD", at), (head) => repository.checkout(at, head))

  const stopRebasing = (repository: Repository["Service"], git: Git["Service"]) =>
    Effect.andThen(repository.conflict(branch, ["work.txt"]), Effect.flip(git.rebase(at, "main")))

  test("left detached, it is found at <root>/<id>, and its branch checked out again", async () => {
    const { result, after } = await left(detach, (worktrees) => worktrees.prepare(id))
    expect(result).toMatchObject({
      path: at,
      reused: true,
      fresh: false,
      putBack: `left detached: ${branch} checked out again`,
    })
    expect(result.earlier.commits.map((commit) => commit.subject)).toEqual(["demo-1: Work"])
    expect(after?.branch).toBe(branch)
  })

  test("left mid-rebase, its rebase is aborted, the branch back as its worker left it", async () => {
    const { result, after } = await left(stopRebasing, (worktrees, git) =>
      Effect.all({ prepared: worktrees.prepare(id), rebasing: git.rebaseInProgress(at) }),
    )
    expect(result.prepared).toMatchObject({
      path: at,
      reused: true,
      fresh: false,
      putBack: `left mid-rebase: the rebase is aborted, ${branch} back as its worker left it`,
    })
    expect(result.rebasing).toBe(false)
    expect(after?.branch).toBe(branch)
  })

  test("left on another branch, its own is checked out again, the other kept", async () => {
    const { result, after } = await left(
      (_, git) => git.checkout(at, "side", { create: true }),
      (worktrees, git) =>
        Effect.all({ prepared: worktrees.prepare(id), side: git.branchExists(repo, "side") }),
    )
    expect(result.prepared).toMatchObject({
      path: at,
      putBack: `left on side: ${branch} checked out again`,
    })
    expect(result.side).toBe(true)
    expect(after?.branch).toBe(branch)
  })

  test("a worktree on its branch is reused as before, with nothing put back", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const worktrees = yield* Worktrees
        yield* worktrees.prepare(id)
        return yield* worktrees.prepare(id)
      }).pipe(Effect.provide(layer)),
    )
    expect(result).toMatchObject({ path: at, reused: true, fresh: false })
    expect(result.putBack).toBeUndefined()
  })

  test("remove without `at` finds a detached worktree at <root>/<id>, and its branch goes", async () => {
    const { result, after } = await left(detach, (worktrees, git) =>
      Effect.andThen(worktrees.remove(id, { force: true }), git.branchExists(repo, branch)),
    )
    expect(result).toBe(false)
    expect(after).toBeUndefined()
  })
})

slow.describe("a worktree left off its branch, in a real repository", () => {
  const liveLayer = (repo: Repo, root: string) =>
    Worktrees.layer({ repo: repo.dir, root, base: "main" }).pipe(
      Layer.provideMerge(Git.layer()),
      Layer.provideMerge(GitWriter.layer),
      Layer.provideMerge(BunServices.layer),
    )

  const setUp = () => {
    const repo = makeRepo()
    const root = join(dirname(repo.dir), "repo-tutti")
    const run = <A, E>(effect: Effect.Effect<A, E, Worktrees>) =>
      Effect.runPromise(Effect.provide(effect, liveLayer(repo, root)))
    return { repo, root, run }
  }

  const prepare = Effect.flatMap(Effect.service(Worktrees), (worktrees) => worktrees.prepare(id))
  const remove = Effect.flatMap(Effect.service(Worktrees), (worktrees) =>
    worktrees.remove(id, { force: true }),
  )

  /** What `git worktree list` says of the worktree at path: its branch line, if any. */
  const branchListed = (repo: Repo, path: string): string | undefined => {
    const entries = repo.git(["worktree", "list", "--porcelain"]).split("\n\n")
    const entry = entries.find((lines) => lines.startsWith(`worktree ${path}\n`))
    return entry?.split("\n").find((line) => line.startsWith("branch "))
  }

  const currentBranch = (repo: Repo, path: string): Option.Option<string> => {
    try {
      return Option.some(repo.git(["symbolic-ref", "--short", "HEAD"], path).trim())
    } catch {
      return Option.none()
    }
  }

  test("left mid-rebase on conflicts: taken up, the rebase aborted, then removed", async () => {
    const { repo, run } = setUp()
    const first = await run(prepare)
    const ours = repo.commit("demo-1: Change README", { "README.md": "# ours\n" }, first.path)
    repo.commit("main: Change README", { "README.md": "# theirs\n" })
    expect(() => repo.git(["rebase", "main"], first.path)).toThrow(/could not apply/)
    expect(branchListed(repo, first.path)).toBeUndefined()
    expect(currentBranch(repo, first.path)).toEqual(Option.none())
    // What prepare did before: git worktree add on the branch the rebase holds.
    expect(() => repo.git(["worktree", "add", join(dirname(first.path), "x"), branch])).toThrow(
      /already used by worktree/,
    )

    const again = await run(prepare)
    expect(again).toMatchObject({
      path: first.path,
      reused: true,
      fresh: false,
      putBack: `left mid-rebase: the rebase is aborted, ${branch} back as its worker left it`,
    })
    expect(again.earlier.commits.map((commit) => commit.subject)).toEqual(["demo-1: Change README"])
    expect(currentBranch(repo, first.path)).toEqual(Option.some(branch))
    expect(repo.head("HEAD", first.path)).toBe(ours)
    expect(repo.head(branch)).toBe(ours)
    expect(
      existsSync(join(repo.git(["rev-parse", "--git-dir"], first.path).trim(), "rebase-merge")),
    ).toBe(false)

    await run(remove)
    expect(existsSync(first.path)).toBe(false)
    expect(repo.git(["branch", "--list", branch]).trim()).toBe("")
  })

  test("left with git checkout --detach: taken up on its branch again, then removed", async () => {
    const { repo, run } = setUp()
    const first = await run(prepare)
    const ours = repo.commit("demo-1: Some work", { "work.txt": "work\n" }, first.path)
    repo.git(["checkout", "--quiet", "--detach"], first.path)
    repo.write({ "work.txt": "more\n" }, first.path)
    expect(branchListed(repo, first.path)).toBeUndefined()

    const again = await run(prepare)
    expect(again).toMatchObject({
      path: first.path,
      reused: true,
      fresh: false,
      putBack: `left detached: ${branch} checked out again`,
    })
    expect(again.earlier.commits.map((commit) => commit.subject)).toEqual(["demo-1: Some work"])
    // The uncommitted change went over with the checkout.
    expect(again.earlier.status).toEqual([{ code: " M", path: "work.txt" }])
    expect(currentBranch(repo, first.path)).toEqual(Option.some(branch))
    expect(repo.head("HEAD", first.path)).toBe(ours)

    await run(remove)
    expect(existsSync(first.path)).toBe(false)
    expect(repo.git(["branch", "--list", branch]).trim()).toBe("")
  })

  test("left detached with its branch deleted: the branch is made again at its HEAD", async () => {
    const { repo, run } = setUp()
    const first = await run(prepare)
    const ours = repo.commit("demo-1: Some work", { "work.txt": "work\n" }, first.path)
    repo.git(["checkout", "--quiet", "--detach"], first.path)
    repo.git(["branch", "-D", branch])

    const again = await run(prepare)
    expect(again).toMatchObject({
      path: first.path,
      putBack: `left detached, ${branch} gone: ${branch} made again at its HEAD`,
    })
    expect(currentBranch(repo, first.path)).toEqual(Option.some(branch))
    expect(repo.head(branch)).toBe(ours)
  })

  test("under a root git lists by another path (through a symbolic link), it is found all the same", async () => {
    // macOS's temp folder is a link (/var/folders → /private/var/folders): makeRepo resolves
    // its own, so this root is named as the link gives it, as a configured root may be.
    const repo = makeRepo()
    const unresolved = mkdtempSync(join(tmpdir(), "tutti-off-branch-link-"))
    const root = join(unresolved, "worktrees")
    const run = <A, E>(effect: Effect.Effect<A, E, Worktrees>) =>
      Effect.runPromise(Effect.provide(effect, liveLayer(repo, root)))
    const first = await run(prepare)
    repo.commit("demo-1: Some work", { "work.txt": "work\n" }, first.path)
    repo.git(["checkout", "--quiet", "--detach"], first.path)
    expect(branchListed(repo, realpathSync(first.path))).toBeUndefined()

    const again = await run(prepare)
    expect(realpathSync(again.path)).toBe(realpathSync(first.path))
    expect(again.putBack).toBe(`left detached: ${branch} checked out again`)
    expect(currentBranch(repo, first.path)).toEqual(Option.some(branch))

    await run(remove)
    expect(existsSync(first.path)).toBe(false)
    expect(repo.git(["branch", "--list", branch]).trim()).toBe("")
  })

  test("left on another branch: its own checked out again, the other kept", async () => {
    const { repo, run } = setUp()
    const first = await run(prepare)
    repo.git(["checkout", "--quiet", "-b", "side"], first.path)
    repo.commit("side: Aside", { "aside.txt": "aside\n" }, first.path)

    const again = await run(prepare)
    expect(again.putBack).toBe(`left on side: ${branch} checked out again`)
    expect(currentBranch(repo, first.path)).toEqual(Option.some(branch))
    expect(repo.git(["branch", "--list", "side"]).trim()).toBe("side")
  })
})
