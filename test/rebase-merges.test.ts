import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer } from "effect"
import fc from "fast-check"
import { Ledger } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Move } from "../src/run/phase.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git, GitWriter, gitCall, gitOps, parseMerges, Sha } from "../src/services/Git.ts"
import { slow } from "./gates.ts"
import { makeRepo, type Repo } from "./git.ts"
import { backlog, expectLog, scenario } from "./harness.ts"

// A branch with merges beyond the base is rebased with --rebase-merges, its merges recreated on the
// new base rather than flattened: a `git subtree add --squash` branch, whose squashed commit holds
// the subtree's own files at its root, would otherwise replay them at the repository's root and
// conflict in every file both have (Fabrica's fab-mgi.3.34). git recreates a merge by merging its
// parents again, which loses what the merge changed itself (the subtree under its prefix), so a
// merge whose other parents share no history with the base is replayed instead: its change on its
// first parent, as a pick, made a merge again after. The rest are git's to recreate.

const layer = Git.layer().pipe(
  Layer.provideMerge(GitWriter.layer),
  Layer.provideMerge(BunServices.layer),
)

const rebase = (worktree: string, onto: string) =>
  Effect.runPromise(
    Effect.exit(
      Effect.provide(
        Effect.flatMap(Effect.service(Git), (git) => git.rebase(worktree, onto)),
        layer,
      ),
    ),
  )

/** A library to vendor: a repository of its own whose files at its root clash with the app's. */
const library = (): Repo => {
  const lib = makeRepo()
  lib.commit("Library", {
    "package.json": '{ "name": "lib" }\n',
    ".gitignore": "dist/\n",
    "src/index.ts": "export const lib = 1\n",
  })
  return lib
}

/** An app on main whose files at its root are the library's names, and a worktree on tutti/a. */
const app = () => {
  const repo = makeRepo()
  repo.commit("App", { "package.json": '{ "name": "app" }\n', ".gitignore": "node_modules/\n" })
  return { repo, worktree: repo.worktree("tutti/a") }
}

/** git subtree add --squash of the library at vendor/lib, in the worktree. */
const vendor = (repo: Repo, worktree: string, lib: Repo) =>
  repo.git(
    ["subtree", "add", "--quiet", "--squash", "--prefix", "vendor/lib", lib.dir, "main"],
    worktree,
  )

/** The parents of rev, its first first. */
const parents = (repo: Repo, rev: string, dir?: string) =>
  repo.git(["rev-list", "--parents", "-n", "1", rev], dir).trim().split(" ").slice(1)

const show = (repo: Repo, rev: string, path: string) => repo.git(["show", `${rev}:${path}`])

describe("parseMerges", () => {
  test("reads a merge's hash, tree and parents a line, and nothing of an empty output", () => {
    const [a, b, c, d] = ["a", "b", "c", "d"].map((x) => x.repeat(40))
    expect(parseMerges(`${a} ${b} ${c} ${d}\n${b} ${c} ${d} ${a} ${a}\n`)).toEqual([
      { hash: Sha.of(a ?? ""), tree: Sha.of(b ?? ""), parents: [c, d].map((x) => Sha.of(x ?? "")) },
      {
        hash: Sha.of(b ?? ""),
        tree: Sha.of(c ?? ""),
        parents: [d, a, a].map((x) => Sha.of(x ?? "")),
      },
    ])
    expect(parseMerges("")).toEqual([])
  })

  test("any output gives merges of two parents or more, read in order", () => {
    fc.assert(
      fc.property(fc.string(), (output) => {
        for (const merge of parseMerges(output)) {
          expect(merge.parents.length).toBeGreaterThanOrEqual(2)
          expect(output).toContain(merge.hash)
        }
      }),
    )
  })
})

describe("the rebase's arguments", () => {
  test("a branch in a line rebases as before; one with merges keeps them", () => {
    expect(gitCall(gitOps.rebase, "abc1234").args).toEqual([
      "rebase",
      "--no-autostash",
      "--no-update-refs",
      "--end-of-options",
      "abc1234",
    ])
    expect(gitCall(gitOps.rebase, "abc1234", "merges").args).toEqual([
      "rebase",
      "--rebase-merges",
      "--no-autostash",
      "--no-update-refs",
      "--end-of-options",
      "abc1234",
    ])
    expect(gitCall(gitOps.rebase, "abc1234", "replaying").args).toEqual([
      "-c",
      "rebase.abbreviateCommands=false",
      "-c",
      "rebase.missingCommitsCheck=ignore",
      "rebase",
      "--rebase-merges",
      "--interactive",
      "--no-autosquash",
      "--empty=drop",
      "--no-autostash",
      "--no-update-refs",
      "--end-of-options",
      "abc1234",
    ])
  })
})

slow.describe("real git", () => {
  test("a git subtree add --squash branch rebases onto a base that moved on, its subtree in place", async () => {
    const lib = library()
    const { repo, worktree } = app()
    vendor(repo, worktree, lib)
    const squash = parents(repo, "HEAD", worktree)[1] ?? ""
    repo.commit("a: Use the library (a)", { "src/app.ts": "import 'lib'\n" }, worktree)
    const main = repo.commit("Main moves on", { "main.txt": "main\n" })

    const exit = await rebase(worktree, main)

    expect(exit).toEqual(Exit.succeed({ merges: true }))
    // On top of main, for the merge queue's fast-forward, and the merge kept, its subtree with it.
    expect(repo.git(["merge-base", "--is-ancestor", main, "tutti/a"])).toBe("")
    const merge = repo.head("tutti/a~1")
    expect(parents(repo, merge)).toEqual([main, squash])
    expect(repo.git(["log", "-1", "--format=%an <%ae> %s", merge])).toBe(
      `tutti test <test@tutti.invalid> Merge commit '${squash}' as 'vendor/lib'\n`,
    )
    expect(show(repo, "tutti/a", "package.json")).toBe('{ "name": "app" }\n')
    expect(show(repo, "tutti/a", ".gitignore")).toBe("node_modules/\n")
    expect(show(repo, "tutti/a", "vendor/lib/package.json")).toBe('{ "name": "lib" }\n')
    expect(show(repo, "tutti/a", "vendor/lib/src/index.ts")).toBe("export const lib = 1\n")
    expect(show(repo, "tutti/a", "main.txt")).toBe("main\n")
    expect(show(repo, "tutti/a", "src/app.ts")).toBe("import 'lib'\n")
    expect(repo.git(["status", "--porcelain"], worktree)).toBe("")
    // git subtree can still find the squash it split from, as its later pulls need.
    expect(repo.git(["log", "--format=%H", "--grep=git-subtree-dir: vendor/lib", "tutti/a"])).toBe(
      `${squash}\n`,
    )
  })

  test("a subtree merge that conflicts with the base stops; git add and rebase --continue keep it a merge", async () => {
    const lib = library()
    const { repo, worktree } = app()
    vendor(repo, worktree, lib)
    const squash = parents(repo, "HEAD", worktree)[1] ?? ""
    const main = repo.commit("Main vendors it too", { "vendor/lib/package.json": "mine\n" })

    const exit = await rebase(worktree, main)

    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("RebaseConflict")
    expect(repo.git(["diff", "--name-only", "--diff-filter=U"], worktree)).toBe(
      "vendor/lib/package.json\n",
    )
    repo.write({ "vendor/lib/package.json": "resolved\n" }, worktree)
    repo.git(["add", "--all"], worktree)
    repo.git(["-c", "core.editor=true", "rebase", "--continue"], worktree)

    expect(parents(repo, "tutti/a")).toEqual([main, squash])
    expect(show(repo, "tutti/a", "vendor/lib/package.json")).toBe("resolved\n")
    expect(show(repo, "tutti/a", "vendor/lib/src/index.ts")).toBe("export const lib = 1\n")
    expect(show(repo, "tutti/a", "package.json")).toBe('{ "name": "app" }\n')
  })

  test("a merge git makes itself is recreated by git, the branch it merged rebased", async () => {
    const repo = makeRepo()
    const side = repo.worktree("side")
    repo.commit("Side", { "side.txt": "side\n" }, side)
    const worktree = repo.worktree("tutti/a", "main")
    repo.commit("a: Own (a)", { "a.txt": "a\n" }, worktree)
    repo.git(["merge", "--quiet", "--no-ff", "-m", "Merge side", "side"], worktree)
    const main = repo.commit("Main moves on", { "main.txt": "main\n" })

    const exit = await rebase(worktree, main)

    expect(exit).toEqual(Exit.succeed({ merges: true }))
    const [first, second] = parents(repo, "tutti/a")
    expect(parents(repo, first ?? "")).toEqual([main])
    expect(parents(repo, second ?? "")).toEqual([main])
    expect(repo.git(["log", "-1", "--format=%s", "tutti/a"])).toBe("Merge side\n")
    expect(show(repo, "tutti/a", "side.txt")).toBe("side\n")
    expect(show(repo, "tutti/a", "a.txt")).toBe("a\n")
  })

  test("a merge of a branch sharing the base's history is git's to recreate: its conflict stops again", async () => {
    const repo = makeRepo()
    repo.commit("Shared", { "f.txt": "one\n" })
    const side = repo.worktree("side")
    repo.commit("Side", { "f.txt": "side\n" }, side)
    const worktree = repo.worktree("tutti/a", "main")
    repo.commit("a: Own (a)", { "f.txt": "a\n" }, worktree)
    expect(() => repo.git(["merge", "--quiet", "side"], worktree)).toThrow()
    repo.commit("Merge side", { "f.txt": "both\n" }, worktree)
    const main = repo.commit("Main moves on", { "main.txt": "main\n" })

    const exit = await rebase(worktree, main)

    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("RebaseConflict")
    repo.write({ "f.txt": "both\n" }, worktree)
    repo.git(["add", "--all"], worktree)
    repo.git(["-c", "core.editor=true", "rebase", "--continue"], worktree)
    expect(parents(repo, "tutti/a")).toHaveLength(2)
    expect(show(repo, "tutti/a", "f.txt")).toBe("both\n")
    expect(show(repo, "tutti/a", "main.txt")).toBe("main\n")
  })

  test("the base merged into the branch, a conflict resolved, then moved on: nothing of the base is lost", async () => {
    const repo = makeRepo()
    repo.commit("Shared", { "f.txt": "one\n" })
    const worktree = repo.worktree("tutti/a", "main")
    repo.commit("a: Own (a)", { "f.txt": "a\n" }, worktree)
    repo.commit("Main 1", { "f.txt": "main\n" })
    expect(() => repo.git(["merge", "--quiet", "main"], worktree)).toThrow()
    repo.commit("Merge main", { "f.txt": "both\n" }, worktree)
    repo.commit("a: More (a)", { "b.txt": "b\n" }, worktree)
    const main = repo.commit("Main 2", { "m2.txt": "m2\n" })

    const exit = await rebase(worktree, main)

    // git merges the branch with the base again, and its conflict goes back to the worker.
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("RebaseConflict")
    repo.write({ "f.txt": "both\n" }, worktree)
    repo.git(["add", "--all"], worktree)
    repo.git(["-c", "core.editor=true", "rebase", "--continue"], worktree)
    expect(repo.git(["merge-base", "--is-ancestor", main, "tutti/a"])).toBe("")
    expect(show(repo, "tutti/a", "m2.txt")).toBe("m2\n")
    expect(show(repo, "tutti/a", "f.txt")).toBe("both\n")
    expect(show(repo, "tutti/a", "b.txt")).toBe("b\n")
  })

  test("a branch without merges rebases in a line, as before", async () => {
    const repo = makeRepo()
    const worktree = repo.worktree("tutti/a")
    repo.commit("a: First (a)", { "a.txt": "a\n" }, worktree)
    repo.commit("a: Second (a)", { "b.txt": "b\n" }, worktree)
    const main = repo.commit("Main moves on", { "main.txt": "main\n" })

    const exit = await rebase(worktree, main)

    expect(exit).toEqual(Exit.succeed({ merges: false }))
    expect(parents(repo, "tutti/a")).toHaveLength(1)
    expect(repo.git(["rev-list", "--count", `${main}..tutti/a`])).toBe("2\n")
    expect(repo.git(["rev-list", "--merges", "--count", "tutti/a"])).toBe("0\n")
  })

  test("the merge queue merges a subtree branch onto a base that moved on, and says with its merges", async () => {
    const lib = library()
    const { repo, worktree } = app()
    vendor(repo, worktree, lib)
    repo.commit("a: Use the library (a)", { "src/app.ts": "import 'lib'\n" }, worktree)
    repo.commit("Main moves on", { "main.txt": "main\n" })
    const id = "a" as TicketId
    const ticket: FinishedTicket = { id, title: "Ticket a", branch: "tutti/a", worktree }

    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds },
      Effect.gen(function* () {
        const queue = yield* makeQueue({ repo: repo.dir, base: "main" })
        yield* (yield* Beads).close(id, "done")
        const ledger = yield* Ledger
        yield* ledger.transition(id, Move.Ready(), { title: "Ticket a" })
        yield* ledger.transition(id, Move.Dispatched())
        yield* queue.offer(ticket)
        yield* queue.settled
        return (yield* ledger.current).tickets.get(id)?.phase
      }).pipe(Effect.scoped, Effect.provide(Ledger.layer), Effect.provide(layer)),
    )

    if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
    const phase = ran.exit.value
    expect(phase?._tag === "Done" && phase.outcome._tag).toBe("Merged")
    expectLog(ran, [
      "  rebased tutti/a, with its merges, onto main, which moved on while it ran",
      /^ {2}a closed \(.*\); merged into main, worktree and branch removed$/,
    ])
    expect(show(repo, "main", "vendor/lib/package.json")).toBe('{ "name": "lib" }\n')
    expect(show(repo, "main", "package.json")).toBe('{ "name": "app" }\n')
    expect(show(repo, "main", "src/app.ts")).toBe("import 'lib'\n")
  })
})
