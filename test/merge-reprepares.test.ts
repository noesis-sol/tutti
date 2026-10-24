// A ticket whose branch, or base, moves on between its check and every fast-forward, as by commits
// made by hand each time, is prepared and checked again up to budgets.beforeFastForward times, then
// blocked, MERGE_CONFLICT, its branch or the base having kept changing.
import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Ledger } from "../src/run/ledger.ts"
import { budgets, type FinishedTicket } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Cause, type TicketPhase } from "../src/run/phase.ts"
import { Beads } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { Repository, type Tree } from "../src/testing/Git.ts"
import { backlog, expectLog, type Ran, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main" }
const defaults = appConfig().settings
const setup = {
  config: {
    repo: "/repo",
    settings: {
      ...defaults,
      checks: {
        ...defaults.checks,
        fast: { ...defaults.checks.fast, command: "scripts/check-fast.sh" },
      },
    },
  },
  backlog: backlog().ticket("a").seeds,
}

/** At most this many commits by hand, so that a merge loop without a limit still ends. */
const most = 3 * budgets.beforeFastForward

/** Ticket a, finished on top of main: a.txt committed on tutti/a, closed, Working. */
const finished = Effect.gen(function* () {
  const repository = yield* Repository
  const worktree = yield* (yield* Worktrees).prepare("a")
  yield* (yield* Git).addWorktree(repository.dir, worktree.path, {
    branch: worktree.branch,
    base: "main",
  })
  yield* repository.commit(worktree.path, "Do a (a)", { "a.txt": "a\n" })
  yield* (yield* Beads).close("a", "done")
  const ledger = yield* Ledger
  yield* ledger.transition("a", Cause.Ready(), { title: "Ticket a" })
  yield* ledger.transition("a", Cause.Dispatched())
  return {
    id: "a",
    title: "Ticket a",
    branch: worktree.branch,
    worktree: worktree.path,
  } satisfies FinishedTicket
})

interface Merged {
  readonly phase: TicketPhase | undefined
  readonly stop: string | undefined
  readonly main: Tree
  /** How many commits were made by hand. */
  readonly commits: number
}

/**
 * Merges ticket a through a queue of its own, `byHand` committing as each fast-forward starts, on
 * a's branch or on main.
 */
const merge = (byHand: "branch" | "base") =>
  scenario(
    setup,
    Effect.gen(function* () {
      const a = yield* finished
      const git = yield* Git
      const repository = yield* Repository
      let commits = 0
      // The fast-forward reads the main checkout's branch first, then the branch, then merges.
      const commit = Effect.gen(function* () {
        if (commits >= most) return
        commits++
        const dir = byHand === "branch" ? a.worktree : repository.dir
        yield* Effect.orDie(
          repository.commit(dir, `By hand ${commits}`, { [`hand${commits}.txt`]: "x\n" }),
        )
      })
      const queue = yield* makeQueue(options).pipe(
        Effect.provideService(Git, {
          ...git,
          currentBranch: (dir) =>
            Effect.andThen(dir === repository.dir ? commit : Effect.void, git.currentBranch(dir)),
        }),
      )
      yield* queue.offer(a)
      yield* queue.settled
      return {
        phase: (yield* (yield* Ledger).current).tickets.get("a")?.phase,
        stop: (yield* queue.state).stop?.why,
        main: yield* repository.tree("main"),
        commits,
      } satisfies Merged
    }).pipe(Effect.provide(Ledger.layer)),
  )

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

describe("a branch moved on after every check passed, before its fast-forward", () => {
  test(`is checked again ${budgets.beforeFastForward} times, then blocked, MERGE_CONFLICT, unmerged`, async () => {
    const ran = await merge("branch")
    const merged = resultOf(ran)
    expect(merged.phase).toEqual(
      expect.objectContaining({ _tag: "Blocked", why: "MERGE_CONFLICT" }),
    )
    expect(merged.stop).toBeUndefined()
    expect(merged.commits).toBe(budgets.beforeFastForward + 1)
    expect(ran.checkRuns).toHaveLength(budgets.beforeFastForward + 1)
    expect(merged.main.get("a.txt")).toBeUndefined()
    expectLog(ran, [
      /^ {2}MERGE_CONFLICT: a closed, but tutti\/a kept changing while its checks ran \(commits made by hand\?\)/,
    ])
  })
})

describe("a base moved on before every fast-forward", () => {
  test(`is rebased and checked again ${budgets.beforeFastForward} times, then blocked, MERGE_CONFLICT`, async () => {
    const ran = await merge("base")
    const merged = resultOf(ran)
    expect(merged.phase).toEqual(
      expect.objectContaining({ _tag: "Blocked", why: "MERGE_CONFLICT" }),
    )
    expect(merged.stop).toBeUndefined()
    expect(merged.commits).toBe(budgets.beforeFastForward + 1)
    expect(ran.checkRuns).toHaveLength(budgets.beforeFastForward + 1)
    expect(merged.main.get("a.txt")).toBeUndefined()
    expectLog(ran, [
      /^ {2}MERGE_CONFLICT: a closed, but main kept changing while its checks ran \(commits made by hand\?\)/,
    ])
    expect(ran.log.some((text) => /MERGE_FAILED|GIT_FAILED/.test(text))).toBe(false)
  })
})
