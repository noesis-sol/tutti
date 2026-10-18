import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer } from "effect"
import fc from "fast-check"
import { Git, GitWriter } from "../src/services/Git.ts"
import {
  BadTicketId,
  branchOf,
  ensureExcluded,
  leftWork,
  RunFilesOutside,
  runExcludeEntry,
  runFolder,
  ticketIdProblem,
  Worktrees,
  writeRunFile,
} from "../src/services/Worktrees.ts"
import { layer as tempLayer, type WorktreeCall } from "../src/testing/Worktrees.ts"
import { slow } from "./gates.ts"
import { makeRepo, type Repo } from "./git.ts"

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (error === undefined) throw new Error(`expected a typed failure, got ${exit.cause}`)
  return error.error
}

const tempDir = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)))

const withWorktrees = <A, E>(use: (worktrees: Worktrees["Service"]) => Effect.Effect<A, E>) =>
  Effect.flatMap(Effect.service(Worktrees), use)

describe("ticket IDs", () => {
  test("plain Beads IDs are taken", () => {
    for (const id of ["tutti-nrg", "tutti-nrg.2.12", "bd-a1b2", "x_y-Z9", "tut-9a1"]) {
      expect(ticketIdProblem(id)).toBeUndefined()
    }
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z0-9]{0,8}-[a-z0-9]{1,6}(\.[0-9]{1,3}){0,3}$/),
        (id) => {
          expect(ticketIdProblem(id)).toBeUndefined()
        },
      ),
    )
  })

  test("IDs that could escape a path, or that git can't take, are refused with a reason", () => {
    const refused: ReadonlyArray<[string, string]> = [
      ["", "path"],
      [".", "path"],
      ["..", "path"],
      ["x-../../y", "path"],
      ["x-a/b", "path"],
      ["x-a\\b", "path"],
      [".hidden", "branch"],
      ["x-1.", "branch"],
      ["x-1.lock", "branch"],
      ["x-@{1}", "branch"],
      ["x 1", "branch"],
      ["x~1", "branch"],
      ["x^1", "branch"],
      ["x:1", "branch"],
      ["x?1", "branch"],
      ["x*1", "branch"],
      ["x[1", "branch"],
      ["x\t1", "branch"],
      ["x\u007f1", "branch"],
      ["x-\u009b1", "control"],
      ["x-‮1", "control"],
      ["x- 1", "control"],
      ["x- 1", "control"],
      ["x-\ud8001", "control"],
    ]
    for (const [id, kind] of refused) expect(ticketIdProblem(id)).toContain(kind)
  })

  test("an ID taken names a folder directly under the worktree root, and no other", () => {
    const root = "/work/project-tutti"
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 24 }), (id) => {
        if (ticketIdProblem(id) !== undefined) return
        const path = join(root, id)
        expect(dirname(path)).toBe(root)
        expect(basename(path)).toBe(id)
        expect(branchOf(id)).toBe(`tutti/${id}`)
      }),
      { numRuns: 2000 },
    )
  })

  test("an ID holding a path character, `..`, a control or invisible character is refused", () => {
    const bad = fc.constantFrom("/", "\\", "..", "\u0000", "\n", "\u009b", "​", "‮")
    fc.assert(
      fc.property(fc.string(), bad, fc.string(), (before, inserted, after) => {
        expect(ticketIdProblem(`${before}${inserted}${after}`)).toBeDefined()
      }),
    )
  })

  test("prepare and remove refuse a bad ID with BadTicketId", async () => {
    const calls: Array<WorktreeCall> = []
    const root = tempDir("tutti-ids-")
    const run = <A, E>(effect: Effect.Effect<A, E, Worktrees>) =>
      Effect.runPromise(Effect.exit(Effect.provide(effect, tempLayer({ root }, calls))))
    for (const id of ["x-../../y", "x-a/b"]) {
      const prepared = failure(await run(withWorktrees((w) => w.prepare(id))))
      expect(prepared).toBeInstanceOf(BadTicketId)
      expect(prepared).toMatchObject({ id, why: "IDs with path characters can't be run" })
      expect(failure(await run(withWorktrees((w) => w.remove(id))))).toBeInstanceOf(BadTicketId)
    }
    expect(calls).toEqual([])
    expect(readdirSync(root)).toEqual([])
  })
})

describe("run files", () => {
  const write = (worktree: string, name = "check.log", text = "output\n") =>
    Effect.runPromise(Effect.exit(writeRunFile(worktree, name, text)))

  test("are written under .tutti/run, which is made when missing", async () => {
    const worktree = tempDir("tutti-run-")
    expect(Exit.isSuccess(await write(worktree))).toBe(true)
    expect(readFileSync(join(worktree, runFolder, "check.log"), "utf8")).toBe("output\n")
    expect(Exit.isSuccess(await write(worktree, "check.log", "new\n"))).toBe(true)
    expect(readFileSync(join(worktree, runFolder, "check.log"), "utf8")).toBe("new\n")
  })

  test("a symbolic link in place of .tutti, .tutti/run or a run file is refused", async () => {
    for (const linked of [".tutti", runFolder, `${runFolder}/check.log`]) {
      const worktree = tempDir("tutti-run-")
      const outside = tempDir("tutti-outside-")
      mkdirSync(join(worktree, dirname(linked)), { recursive: true })
      if (linked === ".tutti") mkdirSync(join(outside, "run"))
      symlinkSync(
        linked.endsWith(".log") ? join(outside, "check.log") : outside,
        join(worktree, linked),
      )

      const refused = failure(await write(worktree))
      expect(refused).toBeInstanceOf(RunFilesOutside)
      expect(refused).toMatchObject({ worktree, path: linked })
      expect(readdirSync(outside).filter((name) => name !== "run")).toEqual([])
      if (linked === ".tutti") expect(readdirSync(join(outside, "run"))).toEqual([])
    }
  })
})

describe("info/exclude", () => {
  const exclude = (commonDir: string) =>
    Effect.runPromise(Effect.provide(ensureExcluded(commonDir), BunServices.layer))

  test("gains the run folder's entry once, keeping the lines it had", async () => {
    const commonDir = tempDir("tutti-git-dir-")
    mkdirSync(join(commonDir, "info"))
    writeFileSync(join(commonDir, "info", "exclude"), "# mine\n*.swp")
    await exclude(commonDir)
    await exclude(commonDir)
    expect(readFileSync(join(commonDir, "info", "exclude"), "utf8")).toBe(
      `# mine\n*.swp\n# per-ticket files written by tutti\n${runExcludeEntry}\n`,
    )
    expect(readdirSync(join(commonDir, "info"))).toEqual(["exclude"])
  })

  test("is made when missing, and written through a link to it", async () => {
    const commonDir = tempDir("tutti-git-dir-")
    await exclude(commonDir)
    expect(readFileSync(join(commonDir, "info", "exclude"), "utf8")).toContain(runExcludeEntry)

    const linkedDir = tempDir("tutti-git-dir-")
    const kept = join(tempDir("tutti-kept-"), "exclude")
    writeFileSync(kept, "*.swp\n")
    mkdirSync(join(linkedDir, "info"))
    symlinkSync(kept, join(linkedDir, "info", "exclude"))
    await exclude(linkedDir)
    expect(readFileSync(kept, "utf8")).toBe(
      `*.swp\n# per-ticket files written by tutti\n${runExcludeEntry}\n`,
    )
  })
})

describe("the temp-folder layer", () => {
  test("makes a folder per ticket, reuses it with what the script left, and removes it", async () => {
    const root = tempDir("tutti-layer-")
    const calls: Array<WorktreeCall> = []
    const earlier = { commits: [{ hash: "abc", subject: "Start", message: "Start\n" }], status: [] }
    const layer = tempLayer({ root, earlier: { "t-1": earlier } }, calls)
    const [first, second] = await Effect.runPromise(
      Effect.provide(
        withWorktrees((w) =>
          Effect.gen(function* () {
            const first = yield* w.prepare("t-1")
            const second = yield* w.prepare("t-1")
            yield* w.remove("t-1")
            return [first, second]
          }),
        ),
        layer,
      ),
    )
    expect(first).toEqual({
      id: "t-1",
      branch: "tutti/t-1",
      path: join(root, "t-1"),
      reused: false,
      earlier: { commits: [], status: [] },
    })
    expect(second).toMatchObject({ reused: true, earlier })
    expect(existsSync(join(root, "t-1"))).toBe(false)
    expect(calls).toEqual([
      { op: "prepare", id: "t-1" },
      { op: "prepare", id: "t-1" },
      { op: "remove", id: "t-1", force: false },
    ])
  })
})

const liveLayer = (repo: Repo, root: string) =>
  Worktrees.layer({ repo: repo.dir, root, base: "main" }).pipe(
    Layer.provideMerge(Git.layer()),
    Layer.provideMerge(GitWriter.layer),
    Layer.provideMerge(BunServices.layer),
  )

const live = (repo: Repo, root: string) => ({
  run: <A, E>(effect: Effect.Effect<A, E, Worktrees>) =>
    Effect.runPromise(Effect.provide(effect, liveLayer(repo, root))),
  runExit: <A, E>(effect: Effect.Effect<A, E, Worktrees>) =>
    Effect.runPromise(Effect.exit(Effect.provide(effect, liveLayer(repo, root)))),
})

const setUp = () => {
  const repo = makeRepo()
  const root = join(dirname(repo.dir), "repo-tutti")
  return { repo, root, ...live(repo, root) }
}

slow.describe("worktrees in a real repository", () => {
  test("a new worktree is made at <root>/<id> on tutti/<id>, from the base", async () => {
    const { repo, root, run } = setUp()
    const worktree = await run(withWorktrees((w) => w.prepare("demo-1")))
    expect(worktree).toEqual({
      id: "demo-1",
      branch: "tutti/demo-1",
      path: join(root, "demo-1"),
      reused: false,
      earlier: { commits: [], status: [] },
    })
    expect(repo.git(["symbolic-ref", "--short", "HEAD"], worktree.path).trim()).toBe("tutti/demo-1")
    expect(repo.head("HEAD", worktree.path)).toBe(repo.head("main"))
  })

  test("a worktree an earlier attempt left is reused, with its commits and changes reported", async () => {
    const { repo, run } = setUp()
    const first = await run(withWorktrees((w) => w.prepare("demo-1")))
    repo.commit("demo-1: Half the work", { "half.txt": "half\n" }, first.path)
    repo.write({ "README.md": "# changed\n", "new.txt": "new\n" }, first.path)

    const again = await run(withWorktrees((w) => w.prepare("demo-1")))
    expect(again.path).toBe(first.path)
    expect(again.reused).toBe(true)
    expect(leftWork(again.earlier)).toBe(true)
    expect(again.earlier.commits.map((commit) => commit.subject)).toEqual(["demo-1: Half the work"])
    expect(again.earlier.status).toEqual([
      { code: " M", path: "README.md" },
      { code: "??", path: "new.txt" },
    ])
  })

  test("a branch left without its worktree is checked out again, with its commits reported", async () => {
    const { repo, root, run } = setUp()
    const first = await run(withWorktrees((w) => w.prepare("demo-1")))
    repo.commit("demo-1: Some work", { "work.txt": "work\n" }, first.path)
    repo.git(["worktree", "remove", "--force", first.path])

    const again = await run(withWorktrees((w) => w.prepare("demo-1")))
    expect(again).toMatchObject({ path: join(root, "demo-1"), reused: true })
    expect(again.earlier.commits.map((commit) => commit.subject)).toEqual(["demo-1: Some work"])
    expect(again.earlier.status).toEqual([])
  })

  test("run files are excluded through info/exclude, and git doesn't see them", async () => {
    const { repo, run } = setUp()
    writeFileSync(join(repo.dir, ".git", "info", "exclude"), "# mine\n*.swp\n")
    const worktree = await run(
      withWorktrees((w) =>
        Effect.gen(function* () {
          const worktree = yield* w.prepare("demo-1")
          yield* w.writeRunFile(worktree.path, "check.log", "checked\n")
          yield* w.writeRunFile(worktree.path, "setup.log", "set up\n")
          return worktree
        }),
      ),
    )
    const exclude = readFileSync(join(repo.dir, ".git", "info", "exclude"), "utf8")
    expect(exclude).toBe(`# mine\n*.swp\n# per-ticket files written by tutti\n${runExcludeEntry}\n`)
    expect(repo.git(["status", "--porcelain", "--untracked-files=all"], worktree.path)).toBe("")
    expect(readFileSync(join(worktree.path, runFolder, "check.log"), "utf8")).toBe("checked\n")
  })

  test("a symlinked .tutti/run is refused with RunFilesOutside, and nothing is written there", async () => {
    const { repo, runExit } = setUp()
    const outside = join(dirname(repo.dir), "outside")
    mkdirSync(outside)
    const exit = await runExit(
      withWorktrees((w) =>
        Effect.gen(function* () {
          const worktree = yield* w.prepare("demo-1")
          mkdirSync(join(worktree.path, ".tutti"))
          symlinkSync(outside, join(worktree.path, runFolder))
          yield* w.writeRunFile(worktree.path, "check.log", "checked\n")
        }),
      ),
    )
    expect(failure(exit)).toMatchObject({ _tag: "RunFilesOutside", path: runFolder })
    expect(readdirSync(outside)).toEqual([])
  })

  test("removing a merged ticket's worktree removes its branch, run files and all", async () => {
    const { repo, root, run } = setUp()
    const worktree = await run(
      withWorktrees((w) =>
        Effect.gen(function* () {
          const worktree = yield* w.prepare("demo-1")
          yield* w.writeRunFile(worktree.path, "check.log", "checked\n")
          return worktree
        }),
      ),
    )
    repo.commit("demo-1: Work", { "work.txt": "work\n" }, worktree.path)
    repo.git(["merge", "--ff-only", "--quiet", "tutti/demo-1"])
    await run(withWorktrees((w) => w.remove("demo-1")))
    expect(existsSync(join(root, "demo-1"))).toBe(false)
    expect(repo.git(["branch", "--list", "tutti/demo-1"])).toBe("")
    // Nothing left to remove is no failure.
    await run(withWorktrees((w) => w.remove("demo-1")))
  })

  test("an unmerged branch is kept unless removal is forced", async () => {
    const { repo, run, runExit } = setUp()
    const worktree = await run(withWorktrees((w) => w.prepare("demo-1")))
    repo.commit("demo-1: Unmerged", { "work.txt": "work\n" }, worktree.path)
    expect(failure(await runExit(withWorktrees((w) => w.remove("demo-1"))))).toMatchObject({
      _tag: "GitFailed",
      op: "branch -d",
    })
    expect(repo.git(["branch", "--list", "tutti/demo-1"])).not.toBe("")
    await run(withWorktrees((w) => w.remove("demo-1", { force: true })))
    expect(repo.git(["branch", "--list", "tutti/demo-1"])).toBe("")
  })

  test("a bad ID makes nothing", async () => {
    const { repo, root, runExit } = setUp()
    const exit = await runExit(withWorktrees((w) => w.prepare("x-../../y")))
    expect(failure(exit)).toBeInstanceOf(BadTicketId)
    expect(existsSync(root)).toBe(false)
    expect(repo.git(["branch", "--list", "tutti/*"])).toBe("")
  })

  // Up to 200 git processes, one after another: past bun's 5 s on a loaded machine.
  test(
    "every ID taken is a branch name git takes",
    () => {
      const repo = makeRepo()
      fc.assert(
        fc.property(fc.string({ unit: "grapheme", minLength: 1, maxLength: 12 }), (id) => {
          if (ticketIdProblem(id) !== undefined) return
          const result = Bun.spawnSync(["git", "check-ref-format", "--branch", branchOf(id)], {
            cwd: repo.dir,
          })
          expect(result.exitCode).toBe(0)
        }),
        { numRuns: 200 },
      )
    },
    { timeout: 60_000 },
  )
})
