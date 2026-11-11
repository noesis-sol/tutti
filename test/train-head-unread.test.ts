// A branch its train rebased cleanly onto the branch ahead, git then failing to say what its commit
// is (mergetrain.ts's rebaseAhead): it is put back as its worker left it there and then, or, where
// git can't put it back either, keeps its mark, for its merge (merge.ts's Enter step) to set it
// aside. Either way the branch ahead, set aside as its check fails, doesn't merge with it.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Stream } from "effect"
import { Ledger, type State } from "../src/run/ledger.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import type { FinishedTicket } from "../src/run/mergeShared.ts"
import { aheadKey } from "../src/run/mergetrain.ts"
import { Move, type PhaseTag } from "../src/run/phase.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git, GitFailed } from "../src/services/Git.ts"
import { Store } from "../src/services/Store.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type CheckRun, passed, type Scripted } from "../src/testing/Checks.ts"
import { Repository } from "../src/testing/Git.ts"
import { backlog, expectLog, type Ran, scenario } from "./harness.ts"

const check = "scripts/check-fast.sh"
const defaults = appConfig().settings

/** A check command, failed checks set aside at once, one ticket checked ahead. */
const settings = {
  ...defaults,
  checks: { ...defaults.checks, fast: { ...defaults.checks.fast, command: check } },
  merge: { ...defaults.merge, check_hand_backs: 0, train: 1 },
}

const failing = new CheckFailed({
  check: "fast",
  command: check,
  exitCode: 1,
  outputFile: "/dev/fd/9",
  failingLines: ["error: a.test.ts: expected 1"],
  lastLines: ["1 fail"],
  suites: [],
  suite: null,
  flaky: [],
  flakyCount: 0,
})

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** A ticket its worker finished: a commit naming it on tutti/<id>, closed, Working. */
const finished = (id: TicketId) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    const worktree = yield* (yield* Worktrees).prepare(id)
    yield* (yield* Git).addWorktree(repository.dir, worktree.path, {
      branch: worktree.branch,
      base: "main",
    })
    yield* repository.commit(worktree.path, `Do ${id} (${id})`, { [`${id}.txt`]: `${id}\n` })
    yield* (yield* Beads).close(id, "done")
    const ledger = yield* Ledger
    yield* ledger.transition(id, Move.Ready(), { title: `Ticket ${id}` })
    yield* ledger.transition(id, Move.Dispatched())
    return {
      id,
      title: `Ticket ${id}`,
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

const tagsOf = (state: State): Record<string, PhaseTag> =>
  Object.fromEntries([...state.tickets.values()].map((entry) => [entry.ticket, entry.phase._tag]))

/** Which ticket a check ran for: its worktree's name. */
const whose = (run: CheckRun): string => run.cwd.split("/").at(-1) ?? ""

/**
 * a and b finished, main moved on, offered in order. b's train rebases it onto tutti/a as a's check
 * runs, and git fails to read tutti/b once, right after; `stuck`: git reset fails in b's worktree
 * from then on. a's check fails once b's train is over.
 */
const unread = (stuck: boolean) => {
  const trainOver = Deferred.makeUnsafe<void>()
  const one: Scripted = (run) =>
    whose(run) === "a"
      ? Effect.andThen(Deferred.await(trainOver), Effect.fail(failing))
      : Effect.succeed({ ...passed("fast"), command: check })
  return scenario(
    {
      config: { settings },
      backlog: backlog().ticket("a").ticket("b").seeds,
      checks: { fast: Array.from({ length: 4 }, () => one) },
    },
    Effect.gen(function* () {
      const repository = yield* Repository
      const git = yield* Git
      const a = yield* finished("a" as TicketId)
      const b = yield* finished("b" as TicketId)
      // Armed by b's first rebase, its train's, and spent on the next read of tutti/b.
      let rebased = false
      let armed = false
      const failingGit: Git["Service"] = {
        ...git,
        rebase: (worktree, onto) =>
          Effect.tap(git.rebase(worktree, onto), () =>
            Effect.gen(function* () {
              if (worktree !== b.worktree || rebased) return
              rebased = true
              armed = true
              if (stuck) yield* repository.fail("reset --hard", { dir: worktree, times: 10 })
            }),
          ),
        revParse: (dir, rev) => {
          if (!armed || rev !== b.branch) return git.revParse(dir, rev)
          armed = false
          return Effect.fail(
            new GitFailed({
              op: "rev-parse",
              command: `git rev-parse --verify --quiet ${rev}`,
              exitCode: 128,
              stderr: "fatal: oops",
            }),
          )
        },
      }
      const queue = yield* makeQueue({ repo: "/repo", base: "main" }).pipe(
        Effect.provideService(Git, failingGit),
      )
      yield* repository.commit(repository.dir, "Land something else", { "main.txt": "moved\n" })
      const before = yield* repository.head(b.branch)
      yield* queue.offer(a)
      yield* queue.offer(b)
      // b shows as rebasing ahead of its turn, then not at all.
      yield* queue.checksAhead.pipe(
        Stream.map((shown) => shown.has("b")),
        Stream.changes,
        Stream.take(3),
        Stream.runDrain,
      )
      const during = yield* repository.head(b.branch)
      const markDuring = (yield* (yield* Store).metadata("b" as TicketId))[aheadKey]
      yield* Deferred.succeed(trainOver, undefined)
      yield* queue.settled
      return {
        before,
        during,
        markDuring,
        mark: (yield* (yield* Store).metadata("b" as TicketId))[aheadKey],
        phases: tagsOf(yield* (yield* Ledger).current),
        main: yield* repository.tree("main"),
      }
    }).pipe(Effect.scoped, Effect.provide(Ledger.layer)),
  )
}

describe("a branch its train rebased, git then unable to say what its commit is", () => {
  test("is put back as its worker left it, and merges without the branch ahead's commits", async () => {
    const ran = await unread(false)
    const merged = resultOf(ran)
    expect(merged.during).toBe(merged.before)
    expect(merged.markDuring).toBeUndefined()
    expect(merged.mark).toBeUndefined()
    // b checked once, in its turn, on main; a checked again as main moves, failing again.
    expect(ran.checkRuns.map(whose)).toEqual(["a", "b", "a"])
    expect(merged.phases).toEqual({ a: "Review", b: "Done" })
    expect(merged.main.get("b.txt")).toBe("b\n")
    expect(merged.main.has("a.txt")).toBe(false)
  })

  test("keeps its mark where git can't put it back, and its merge sets it aside", async () => {
    const ran = await unread(true)
    const merged = resultOf(ran)
    expect(merged.during).not.toBe(merged.before)
    expect(merged.markDuring).toEqual(expect.objectContaining({ orig: merged.before }))
    expect(ran.checkRuns.map(whose)).toEqual(["a"])
    expect(merged.phases).toEqual({ a: "Review", b: "Review" })
    expect(merged.main.has("a.txt")).toBe(false)
    expect(merged.main.has("b.txt")).toBe(false)
    expectLog(ran, [
      new RegExp(
        `^ {2}REBASE_FAILED: .*tutti/b was rebased onto tutti/a to be checked ahead of its turn and could not be put back as its worker left it, at ${merged.before.slice(0, 7)}, so it may have the commits of tutti/a; worktree .*/b left for review$`,
      ),
    ])
  })
})
