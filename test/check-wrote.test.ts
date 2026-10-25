// The untracked files tutti's own setups and merge checks write in a ticket's worktree
// (checkWrote.ts): kept in its .tutti/run/check-wrote, so the merge removes the worktree with them
// (git worktree remove --force) rather than leave it, CLEANUP_FAILED; an untracked file that was
// there before keeps it. And a branch on top of the base with no check command has its worktree's
// status read before it merges: uncommitted changes there set it aside, DIRTY_WORKTREE. The scenarios
// are whole runs under TestClock; the removal itself is shown in a real repository.

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Fiber, Layer } from "effect"
import { checkWroteName, noteWritten, writtenOnly } from "../src/run/checkWrote.ts"
import { type Outcome, run } from "../src/run/run.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git, GitWriter } from "../src/services/Git.ts"
import type { RunStamp, TicketRecord } from "../src/services/Store.ts"
import { runFolder, Worktrees } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { passed, type Scripted } from "../src/testing/Checks.ts"
import { type Files, layer as gitLayer, Repository } from "../src/testing/Git.ts"
import { slow } from "./gates.ts"
import { makeRepo } from "./git.ts"
import { backlog, expectExitCode, expectLog, expectPhases, type Ran, scenario } from "./harness.ts"

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-check-wrote-${name}-`)))

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings

/** What a killed run left of a, closed, merging: no suspension, no phase. */
const carried = (root: string): TicketRecord => ({
  session: "session-a",
  worktree: join(root, "a"),
  branch: "tutti/a",
  resumes: 0,
  metadata: {},
})

/** A process that has ended, for the run that wrote state.json last: it was killed. */
const killedRun = (): RunStamp => ({
  pid: Bun.spawnSync(["true"]).pid,
  started: "2026-10-24T08:00:00Z",
  version: "0.1.0-test",
})

type Write = (dir: string, files: Files) => Effect.Effect<void>

interface Plan {
  /** The fast check's runs, in order, given how to write files; none: there is no check command. */
  readonly fast?: (write: () => Write) => ReadonlyArray<Scripted>
  /** What is left uncommitted in a's worktree as the run starts. */
  readonly left: Files
}

/**
 * A whole run that takes up a, closed by its worker in a run that was killed before it merged: its
 * worktree has its commit, and `left` uncommitted. Where it ran, and main's files after it.
 */
const runs = (
  plan: Plan,
): Promise<Ran<Outcome> & { root: string; main: ReadonlyMap<string, string> }> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  let main: ReadonlyMap<string, string> = new Map()
  let write: Write | undefined
  const theWrite = (): Write => {
    if (write === undefined) throw new Error("the check ran before the repository was made")
    return write
  }
  const fast = plan.fast
  return scenario(
    {
      config: {
        repo,
        settings: {
          ...defaults,
          checks: {
            ...defaults.checks,
            fast: { ...defaults.checks.fast, command: fast === undefined ? null : check },
          },
        },
      },
      backlog: backlog().ticket("a", { status: "closed" }).seeds,
      git: { dir: repo },
      worktrees: { root },
      state: { version: 1, run: killedRun(), tickets: { a: carried(root) } },
      checks: { fast: fast === undefined ? [] : fast(theWrite) },
    },
    Effect.gen(function* () {
      const repository = yield* Repository
      write = repository.write
      const worktree = join(root, "a")
      mkdirSync(worktree, { recursive: true })
      yield* (yield* Git).addWorktree(repo, worktree, { branch: "tutti/a", base: "main" })
      yield* repository.commit(worktree, "Change (a)", { "a.txt": "a\n" })
      yield* repository.write(worktree, plan.left)
      const fiber = yield* Effect.forkChild(
        Effect.scoped(run({ version: "0.1.0-test", base: "main" })),
      )
      const outcome = yield* Fiber.join(fiber)
      main = yield* repository.tree("main")
      return outcome
    }),
  ).then((ran) => ({ ...ran, root, main }))
}

/** A check that passes, having written `files` into the worktree it ran in. */
const passesWriting =
  (write: () => Write, files: Files): Scripted =>
  (each) =>
    Effect.as(
      Effect.suspend(() => write()(each.cwd, files)),
      passed("fast"),
    )

const removals = (ran: Ran<Outcome>) => ran.worktreeCalls.filter((call) => call.op === "remove")

describe("untracked files the merge check wrote", () => {
  test("are removed with the worktree after the merge, a line naming them", async () => {
    const ran = await runs({
      fast: (write) => [passesWriting(write, { "coverage.txt": "92%\n" })],
      left: {},
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Done" })
    expectLog(ran, [
      `  a: its setup or check left coverage.txt untracked in ${join(ran.root, "a")}, removed with it`,
      /^ {2}a closed \(.*\); merged into main, worktree and branch removed$/,
    ])
    expect(removals(ran)).toEqual([
      { op: "remove", id: "a" as TicketId, force: false, untracked: true, aside: true },
    ])
    expect(ran.main.get("a.txt")).toBe("a\n")
    expect(ran.main.has("coverage.txt")).toBe(false)
  })

  test("one its worker left keeps the worktree as git has it", async () => {
    const ran = await runs({
      fast: (write) => [passesWriting(write, { "coverage.txt": "92%\n" })],
      left: { "notes.txt": "mine\n" },
    })
    expectPhases(ran, { a: "Done" })
    expect(removals(ran)).toEqual([{ op: "remove", id: "a" as TicketId, force: false }])
    expect(ran.log.some((text) => text.includes("removed with it"))).toBe(false)
  })

  test("one its worker left that the check wrote again isn't taken for the check's", async () => {
    const ran = await runs({
      fast: (write) => [passesWriting(write, { "coverage.txt": "92%\n" })],
      left: { "coverage.txt": "90%\n" },
    })
    expectPhases(ran, { a: "Done" })
    expect(removals(ran)).toEqual([{ op: "remove", id: "a" as TicketId, force: false }])
  })
})

describe("a branch on top of the base with no check command", () => {
  test("with uncommitted changes in its worktree is set aside, DIRTY_WORKTREE", async () => {
    const ran = await runs({ left: { "a.txt": "changed\n" } })
    expectExitCode(ran, 0)
    expectPhases(ran, { a: "Review" })
    expectLog(ran, [
      `  DIRTY_WORKTREE: a closed, but ${join(ran.root, "a")} has uncommitted changes to a.txt, which would not merge with tutti/a; worktree left for review (commit or undo them, merge)`,
    ])
    expect(removals(ran)).toEqual([])
    expect(ran.main.has("a.txt")).toBe(false)
  })

  test("with only an untracked file left merges", async () => {
    const ran = await runs({ left: { "notes.txt": "mine\n" } })
    expectPhases(ran, { a: "Done" })
    expect(ran.main.get("a.txt")).toBe("a\n")
    expect(ran.log.some((text) => text.includes("DIRTY_WORKTREE"))).toBe(false)
  })
})

describe("noteWritten and writtenOnly", () => {
  const worktree = () => {
    const repo = folder("unit-repo")
    const path = join(folder("unit-worktrees"), "a")
    mkdirSync(path)
    return { repo, path }
  }
  const inGit = <A>(repo: string, effect: Effect.Effect<A, never, Git | Repository>) =>
    Effect.runPromise(Effect.provide(effect, gitLayer({ dir: repo })))

  test("keep the files each run added, across runs, and only those", async () => {
    const { repo, path } = worktree()
    const listed = await inGit(
      repo,
      Effect.gen(function* () {
        const repository = yield* Repository
        yield* Effect.orDie(
          (yield* Git).addWorktree(repo, path, { branch: "tutti/a", base: "main" }),
        )
        yield* repository.write(path, { "mine.txt": "x\n" })
        yield* noteWritten(path, repository.write(path, { "mine.txt": "y\n", "out/1.txt": "1\n" }))
        yield* noteWritten(path, repository.write(path, { "out/2.txt": "2\n" }))
        return yield* writtenOnly(path)
      }),
    )
    expect(readFileSync(join(path, runFolder, checkWroteName), "utf8")).toBe(
      "out/1.txt\0out/2.txt\0",
    )
    // mine.txt was there before either run: the worktree can't be forced.
    expect(listed).toBeUndefined()
  })

  test("name the untracked files when tutti wrote them all; none for a clean worktree", async () => {
    const { repo, path } = worktree()
    const [clean, written] = await inGit(
      repo,
      Effect.gen(function* () {
        const repository = yield* Repository
        yield* Effect.orDie(
          (yield* Git).addWorktree(repo, path, { branch: "tutti/a", base: "main" }),
        )
        const clean = yield* writtenOnly(path)
        yield* noteWritten(path, repository.write(path, { "out/1.txt": "1\n", "out/2.txt": "2\n" }))
        return [clean, yield* writtenOnly(path)] as const
      }),
    )
    expect(clean).toBeUndefined()
    expect(written).toEqual(["out/1.txt", "out/2.txt"])
  })

  test("a run that fails notes nothing", async () => {
    const { repo, path } = worktree()
    await inGit(
      repo,
      Effect.gen(function* () {
        const repository = yield* Repository
        yield* Effect.orDie(
          (yield* Git).addWorktree(repo, path, { branch: "tutti/a", base: "main" }),
        )
        yield* Effect.ignore(
          noteWritten(
            path,
            Effect.andThen(repository.write(path, { "out.txt": "1\n" }), Effect.fail("no")),
          ),
        )
      }),
    )
    expect(existsSync(join(path, runFolder, checkWroteName))).toBe(false)
  })
})

slow.describe("removing a worktree in a real repository", () => {
  const setUp = () => {
    const repo = makeRepo()
    const root = join(dirname(repo.dir), "repo-tutti")
    const layer = Worktrees.layer({ repo: repo.dir, root, base: "main" }).pipe(
      Layer.provideMerge(Git.layer()),
      Layer.provideMerge(GitWriter.layer),
      Layer.provideMerge(BunServices.layer),
    )
    const runIn = <A, E>(effect: Effect.Effect<A, E, Worktrees | Git>) =>
      Effect.runPromise(Effect.provide(effect, layer))
    return { repo, root, runIn }
  }

  test("goes with --force on the worktree when tutti wrote its only changes", async () => {
    const { repo, runIn } = setUp()
    const path = await runIn(
      Effect.map(
        Effect.flatMap(Effect.service(Worktrees), (w) => w.prepare("t-1" as TicketId)),
        (made) => made.path,
      ),
    )
    repo.git(["merge", "--quiet", "--ff-only", "tutti/t-1"])
    await runIn(
      noteWritten(
        path,
        Effect.sync(() => repo.write({ "coverage/index.html": "x" }, path)),
      ),
    )
    const written = await runIn(writtenOnly(path))
    expect(written).toEqual(["coverage/index.html"])
    await runIn(
      Effect.flatMap(Effect.service(Worktrees), (w) =>
        w.remove("t-1" as TicketId, { untracked: true }),
      ),
    )
    expect(existsSync(path)).toBe(false)
    expect(repo.git(["branch", "--list", "tutti/t-1"])).toBe("")
  })

  test("is refused as before when its worker left an untracked file", async () => {
    const { repo, runIn } = setUp()
    const path = await runIn(
      Effect.map(
        Effect.flatMap(Effect.service(Worktrees), (w) => w.prepare("t-1" as TicketId)),
        (made) => made.path,
      ),
    )
    repo.write({ "notes.txt": "mine" }, path)
    await runIn(
      noteWritten(
        path,
        Effect.sync(() => repo.write({ "coverage/index.html": "x" }, path)),
      ),
    )
    expect(await runIn(writtenOnly(path))).toBeUndefined()
    const removed = await runIn(
      Effect.result(Effect.flatMap(Effect.service(Worktrees), (w) => w.remove("t-1" as TicketId))),
    )
    expect(removed._tag).toBe("Failure")
    expect(existsSync(join(path, "notes.txt"))).toBe(true)
  })

  test("keeps an unmerged branch when only the worktree is forced", async () => {
    const { repo, runIn } = setUp()
    const path = await runIn(
      Effect.map(
        Effect.flatMap(Effect.service(Worktrees), (w) => w.prepare("t-1" as TicketId)),
        (made) => made.path,
      ),
    )
    repo.commit("Own (t-1)", { "own.txt": "own" }, path)
    const removed = await runIn(
      Effect.result(
        Effect.flatMap(Effect.service(Worktrees), (w) =>
          w.remove("t-1" as TicketId, { untracked: true }),
        ),
      ),
    )
    expect(removed._tag).toBe("Failure")
    expect(existsSync(path)).toBe(false)
    expect(repo.git(["branch", "--list", "tutti/t-1"]).trim()).toBe("tutti/t-1")
  })
})
