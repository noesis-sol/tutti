// A ticket merges only at the commit its merge check passed on: a commit made on its branch while
// the check runs, or after it passed and before the fast-forward, as its worker's when you message
// it in ToMerge or Merging, is checked before it merges.
import { describe, expect, test } from "bun:test"
import { Effect, Exit, type Scope } from "effect"
import { Ledger } from "../src/run/ledger.ts"
import { budgets, type FinishedTicket } from "../src/run/merge.ts"
import { type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import { Move, type TicketPhase } from "../src/run/phase.ts"
import { Beads } from "../src/services/Beads.ts"
import { Checks } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { backlog, type Env, expectLog, type Ran, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main" }

const defaults = appConfig().settings

/** The settings with a merge check, which every merge then runs, a branch on top of main too. */
const settings = {
  ...defaults,
  checks: {
    ...defaults.checks,
    fast: { ...defaults.checks.fast, command: "scripts/check-fast.sh" },
  },
}

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** A ticket its worker finished: closed, its commit on tutti/<id>, Working in the ledger. */
const finished = (id: string, files: Files) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const worktree = yield* (yield* Worktrees).prepare(id)
    yield* git.addWorktree(repository.dir, worktree.path, { branch: worktree.branch, base: "main" })
    yield* repository.commit(worktree.path, `Do ${id} (${id})`, files)
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

/**
 * Merges ticket a, which adds a.txt, with its queue made by `around`: a's phase, main's tree, and
 * the commit of tutti/a each merge check ran on.
 */
const mergeA = (
  around: (
    ticket: () => FinishedTicket,
    queue: Effect.Effect<MergeQueue, never, Env | Ledger | Scope.Scope>,
  ) => Effect.Effect<MergeQueue, never, Env | Ledger | Scope.Scope>,
) => {
  let ticket: FinishedTicket | undefined
  const of = () => {
    if (ticket === undefined) throw new Error("ticket a isn't finished yet")
    return ticket
  }
  return scenario(
    { config: { settings }, backlog: backlog().ticket("a").seeds },
    Effect.gen(function* () {
      ticket = yield* finished("a", { "a.txt": "a\n" })
      const queue = yield* around(of, makeQueue(options))
      yield* queue.offer(ticket)
      yield* queue.settled
      const phase: TicketPhase | undefined = (yield* (yield* Ledger).current).tickets.get(
        "a",
      )?.phase
      const main = yield* (yield* Repository).tree("main")
      return { phase, main }
    }).pipe(Effect.provide(Ledger.layer)),
  )
}

/** The queue with its merge check recording tutti/a's commit as each check starts, then `during`. */
const watched = (
  heads: Array<string>,
  during: (n: number) => Effect.Effect<void, unknown, Env | Ledger>,
) =>
  Effect.fnUntraced(function* (
    _ticket: () => FinishedTicket,
    queue: Effect.Effect<MergeQueue, never, Env | Ledger | Scope.Scope>,
  ) {
    const checks = yield* Checks
    const git = yield* Git
    const context = yield* Effect.context<Env | Ledger>()
    return yield* Effect.provideService(queue, Checks, {
      ...checks,
      fast: (run) =>
        Effect.gen(function* () {
          heads.push(yield* git.revParse("/repo", "tutti/a"))
          yield* Effect.orDie(during(heads.length)).pipe(Effect.provide(context))
          return yield* checks.fast(run)
        }),
    })
  })

describe("a commit made on the branch while its merge check runs", () => {
  test("is checked before it merges, and merges with the branch", async () => {
    const heads: Array<string> = []
    let worktree = ""
    const ran = await mergeA((ticket, queue) =>
      watched(heads, (n) =>
        Effect.gen(function* () {
          worktree = ticket().worktree
          if (n === 1) {
            yield* (yield* Repository).commit(worktree, "More of a (a)", { "b.txt": "b\n" })
          }
        }),
      )(ticket, queue),
    )
    const { phase, main } = resultOf(ran)
    expect(phase).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(heads).toHaveLength(2)
    expect(heads[1]).not.toBe(heads[0])
    expect(main.get("a.txt")).toBe("a\n")
    expect(main.get("b.txt")).toBe("b\n")
    expectLog(ran, [
      /^ {2}tutti\/a moved on to [0-9a-f]{7} while its check ran on [0-9a-f]{7}: checking it again$/,
    ])
  })

  test("on every check blocks the ticket, MERGE_CONFLICT, none of its commits merged", async () => {
    const heads: Array<string> = []
    const ran = await mergeA((ticket, queue) =>
      watched(heads, (n) =>
        Effect.asVoid(
          Effect.flatMap(Repository, (repository) =>
            repository.commit(ticket().worktree, `More of a ${n} (a)`, { [`more${n}.txt`]: "x\n" }),
          ),
        ),
      )(ticket, queue),
    )
    const { phase, main } = resultOf(ran)
    expect(phase).toEqual(expect.objectContaining({ _tag: "Blocked", why: "MERGE_CONFLICT" }))
    expect(heads).toHaveLength(budgets.branchDuringCheck + 1)
    expect(main.get("a.txt")).toBeUndefined()
    expectLog(ran, [
      /^ {2}MERGE_CONFLICT: a closed, but tutti\/a kept changing while its checks ran \(commits made by hand\?\)/,
    ])
  })
})

describe("a commit made on the branch after its check passed", () => {
  test("isn't fast-forwarded unchecked: the branch is checked again at it, then merges", async () => {
    const heads: Array<string> = []
    let committed = false
    const ran = await mergeA((ticket, queue) =>
      Effect.gen(function* () {
        const git = yield* Git
        const repository = yield* Repository
        // The fast-forward reads the main checkout's branch first: the commit lands just then.
        const late = Effect.provideService(queue, Git, {
          ...git,
          currentBranch: (dir) =>
            Effect.gen(function* () {
              if (dir === "/repo" && heads.length === 1 && !committed) {
                committed = true
                yield* Effect.orDie(
                  repository.commit(ticket().worktree, "Late (a)", { "late.txt": "late\n" }),
                )
              }
              return yield* git.currentBranch(dir)
            }),
        })
        return yield* watched(heads, () => Effect.void)(ticket, late)
      }),
    )
    const { phase, main } = resultOf(ran)
    expect(committed).toBe(true)
    expect(phase).toEqual(expect.objectContaining({ _tag: "Done" }))
    expect(heads).toHaveLength(2)
    expect(heads[1]).not.toBe(heads[0])
    expect(main.get("late.txt")).toBe("late\n")
    expectLog(ran, [
      /^ {2}tutti\/a moved on to [0-9a-f]{7} after its check passed on [0-9a-f]{7}: checking it again before it merges$/,
    ])
  })
})
