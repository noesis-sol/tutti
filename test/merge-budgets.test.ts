// A merge's budgets (merge.ts's budgets) count over the ticket's whole turn: a merge entered again,
// its branch having moved on before its fast-forward, keeps what it spent, so a branch that moves on
// during a check of every entry is blocked once its budget is spent, not checked again in each.
import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Ledger } from "../src/run/ledger.ts"
import { budgets, type FinishedTicket } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Move, type TicketPhase } from "../src/run/phase.ts"
import { Beads } from "../src/services/Beads.ts"
import { Checks } from "../src/services/Checks.ts"
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
  yield* ledger.transition("a", Move.Ready(), { title: "Ticket a" })
  yield* ledger.transition("a", Move.Dispatched())
  return {
    id: "a",
    title: "Ticket a",
    branch: worktree.branch,
    worktree: worktree.path,
  } satisfies FinishedTicket
})

interface Merged {
  readonly phase: TicketPhase | undefined
  readonly main: Tree
  /** How many fast-forwards found its branch moved on. */
  readonly beforeFastForward: number
}

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/**
 * Merges ticket a through a queue of its own, a commit made by hand on its branch during the first
 * check of each entry of its merge, and as each fast-forward starts.
 */
const merge = () =>
  scenario(
    setup,
    Effect.gen(function* () {
      const a = yield* finished
      const git = yield* Git
      const checks = yield* Checks
      const repository = yield* Repository
      let made = 0
      const byHand = Effect.suspend(() => {
        made++
        return Effect.orDie(
          repository.commit(a.worktree, `By hand ${made}`, { [`hand${made}.txt`]: "x\n" }),
        )
      })
      // A check of each entry: the first is overtaken, the second passes.
      let check = 0
      let forwards = 0
      const queue = yield* makeQueue(options).pipe(
        Effect.provideService(Checks, {
          ...checks,
          fast: (run) => Effect.andThen(++check % 2 === 1 ? byHand : Effect.void, checks.fast(run)),
        }),
        // The fast-forward reads the main checkout's branch first, then the branch, then merges.
        Effect.provideService(Git, {
          ...git,
          currentBranch: (dir) =>
            Effect.andThen(
              dir === repository.dir
                ? Effect.andThen(
                    Effect.sync(() => forwards++),
                    byHand,
                  )
                : Effect.void,
              git.currentBranch(dir),
            ),
        }),
      )
      yield* queue.offer(a)
      yield* queue.settled
      return {
        phase: (yield* (yield* Ledger).current).tickets.get("a")?.phase,
        main: yield* repository.tree("main"),
        beforeFastForward: forwards,
      } satisfies Merged
    }).pipe(Effect.provide(Ledger.layer)),
  )

describe("a branch moved on during a check of each entry of its merge", () => {
  test("is blocked once its budget for the whole turn is spent, MERGE_CONFLICT", async () => {
    const ran = await merge()
    const merged = resultOf(ran)
    expect(merged.phase).toEqual(
      expect.objectContaining({ _tag: "Blocked", why: "MERGE_CONFLICT" }),
    )
    // Each entry checks twice, then its fast-forward finds the branch moved on; the entry after
    // the budget is spent is blocked at its first check.
    const entries = budgets.branchDuringCheck + 1
    expect(ran.checkRuns).toHaveLength(2 * entries - 1)
    expect(merged.beforeFastForward).toBe(entries - 1)
    expect(merged.main.get("a.txt")).toBeUndefined()
    const during = ran.log.filter((text) =>
      / while its check ran on [0-9a-f]{7}: checking it again$/.test(text),
    )
    expect(during).toHaveLength(budgets.branchDuringCheck)
    expectLog(ran, [
      /^ {2}tutti\/a moved on to [0-9a-f]{7} after its check passed on [0-9a-f]{7}: checking it again before it merges$/,
      /^ {2}MERGE_CONFLICT: a closed, but tutti\/a kept changing while its checks ran \(commits made by hand\?\)/,
    ])
  })
})
