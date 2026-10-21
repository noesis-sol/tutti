import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Fiber } from "effect"
import { closedBranches, closedUnmergedLine, startBranches } from "../src/run/closedBranches.ts"
import * as free from "../src/run/deferredFree.ts"
import { type Entry, emptyState, Ledger, type State } from "../src/run/ledger.ts"
import { check, heldAtStart, lines, noStyles, type Options } from "../src/run/nothing.ts"
import { Cause, Outcome as Finished, TicketPhase } from "../src/run/phase.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { unmergedBlockers } from "../src/run/settle.ts"
import { requeueWaiting } from "../src/run/work.ts"
import { Beads, type Dependency, type Issue } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { run as runs, type SessionScript, turn } from "../src/testing/AgentHost.ts"
import type { Seed } from "../src/testing/Beads.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import {
  backlog,
  type Env,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  scenario,
  type World,
} from "./harness.ts"

const where = { repo: "/repo", base: "main" }

/** The scenario's value, or a test failure saying why it gave none. */
const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** A branch cut from main with a commit `message` on it, in a worktree of its own. */
const branchWith = (repo: string, branch: string, message: string, files: Files) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const path = join(repo, "..", `${branch.replace("/", "-")}-${Math.random()}`)
    yield* git.addWorktree(repo, path, { branch, base: "main" })
    yield* repository.commit(path, message, files)
    return path
  })

/** tutti/t-1 with a commit main lacks, closed by hand: `<branch> is not on main`. */
const offMain = (repo: string) => branchWith(repo, "tutti/t-1", "Do it (t-1)", { "t-1.txt": "1\n" })

/** Deletes the branch, and the worktree at `path` it is checked out in. */
const deleteBranch = (repo: string, path: string, branch: string) =>
  Effect.gen(function* () {
    const git = yield* Git
    yield* git.removeWorktree(repo, path, { force: true })
    yield* git.deleteBranch(repo, branch, { force: true })
  })

const warned = (ran: Ran<unknown>, id: string): number =>
  ran.log.filter((each) => each === closedUnmergedLine(id, "main")).length

/** A link of `type` to ticket `id`, as bd show gives it, with its status. */
const link = (id: string, type: string, status = "closed"): Dependency => ({
  id,
  type,
  issue: { id, status, labels: [] } as unknown as Issue,
})

describe("unmergedBlockers", () => {
  const state: State = {
    ...emptyState,
    tickets: new Map([
      [
        "done",
        {
          ticket: "done",
          phase: TicketPhase.Done({ outcome: Finished.Merged({ commit: "abc1234" }) }),
        } as Entry,
      ],
    ]),
  }

  test("counts a closed blocker git finds off the base, as the holds do", () => {
    const issue = {
      dependencies: [link("t-1", "blocks"), link("t-2", "blocks"), link("t-3", "discovered-from")],
    } as unknown as Issue
    const branches = new Map([
      ["t-1", "tutti/t-1 is not on main"],
      ["t-3", "tutti/t-3 is not on main"],
    ])
    expect(unmergedBlockers(issue, state, branches)).toEqual(["t-1"])
    expect(unmergedBlockers(issue, state)).toEqual([])
  })
})

/** A new folder, its real path: the main checkout's (for the attention files), or the worktrees'. */
const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-closed-unmerged-pending-${name}-`)))

interface Plan {
  readonly tickets: ReadonlyArray<string>
  readonly backlog: ReadonlyArray<Seed>
  readonly scripts: (world: World) => Readonly<Record<string, SessionScript[]>>
  /** Readies the repository and Beads before the run starts. */
  readonly before?: (repo: string) => Effect.Effect<void, unknown, Env>
}

/** A whole plain run on main, each ticket's worktree in git where the Worktrees test layer puts it. */
const runOf = (plan: Plan): Promise<Ran<Outcome>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  return scenario(
    {
      backlog: plan.backlog,
      config: { repo },
      git: { dir: repo },
      worktrees: { root },
      scripts: plan.scripts,
    },
    Effect.gen(function* () {
      const git = yield* Git
      if (plan.before !== undefined) yield* plan.before(repo)
      for (const id of plan.tickets) {
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      const fiber = yield* Effect.forkChild(
        Effect.scoped(run({ version: "0.1.0-test", base: "main" })),
      )
      return yield* Fiber.join(fiber)
    }),
  )
}

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

describe("WAITS_FOR_MERGE on a blocker closed by hand, its branch not merged", () => {
  test("a worker stopped with nothing done, having linked it, goes back in the queue", async () => {
    const ran = await runOf({
      tickets: ["t-2"],
      backlog: backlog().ticket("t-1", { status: "closed" }).ticket("t-2").seeds,
      before: (repo) => Effect.asVoid(offMain(repo)),
      scripts: (world) => ({
        "t-2": [
          turn([
            runs(orDie(world.beads.update("t-2", { claim: true }))),
            runs(orDie(world.beads.addDependency("t-2", "t-1"))),
          ]),
        ],
      }),
    })
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-2": "Waiting" })
    expect(warned(ran, "t-1")).toBe(1)
    expectLog(ran, [
      /t-2 dispatching/,
      "  WAITS_FOR_MERGE: t-2 waits for t-1 to merge; its worker stopped with nothing done, so it is back in the queue until it does; worktree and branch removed",
    ])
    expect(ran.issues.find((issue) => issue.id === "t-2")?.status).toBe("open")
  })

  test("a Waiting ticket stays so until its blocker's branch is merged or deleted", async () => {
    const ran = await scenario(
      {
        backlog: backlog()
          .ticket("t-1", { status: "closed" })
          .ticket("t-2", { blockedBy: ["t-1"] }).seeds,
      },
      Effect.gen(function* () {
        const ledger = yield* Ledger
        const path = yield* offMain(where.repo)
        yield* ledger.transition("t-2", Cause.Ready(), { title: "t-2" })
        yield* ledger.transition("t-2", Cause.Dispatched())
        yield* ledger.transition("t-2", Cause.WaitsForMerge({ for: "t-1" }))
        const branches = yield* closedBranches(where)
        const held = yield* requeueWaiting(branches)
        yield* deleteBranch(where.repo, path, "tutti/t-1")
        const freed = yield* requeueWaiting(branches)
        return { held, freed }
      }).pipe(Effect.provide(Ledger.layer)),
    )
    expect(resultOf(ran)).toEqual({ held: [], freed: ["t-2"] })
    expect(warned(ran, "t-1")).toBe(1)
  })
})

describe("DEFERRED_FREE with a blocker closed by hand, its branch not merged", () => {
  const seeds = backlog()
    .ticket("t-1", { status: "closed" })
    .ticket("k-1", { status: "deferred", blockedBy: ["t-1"] }).seeds

  const freeing = (branches: free.Freeing["pending"]): free.Freeing => ({
    ...where,
    filter: { excludeTypes: [] },
    inScope: () => true,
    pending: branches,
  })

  test("frees nothing before the run, until the branch is gone, and warns of nothing", async () => {
    const ran = await scenario(
      { backlog: seeds },
      Effect.gen(function* () {
        const path = yield* offMain(where.repo)
        const listed = () =>
          Effect.gen(function* () {
            const pending = free.startPending(new Set(), new Set(), startBranches(where))
            const open = yield* (yield* Beads).list()
            return (yield* free.list(freeing(pending), open)).map((each) => each.id)
          })
        const held = yield* listed()
        yield* deleteBranch(where.repo, path, "tutti/t-1")
        return { held, freed: yield* listed() }
      }),
    )
    expect(resultOf(ran)).toEqual({ held: [], freed: ["k-1"] })
    expect(ran.log.some((each) => each.includes("CLOSED_UNMERGED"))).toBe(false)
  })

  test("the START block doesn't list a ticket it blocks; it does once the branch is merged", async () => {
    const held = await runOf({
      tickets: [],
      backlog: seeds,
      before: (repo) => Effect.asVoid(offMain(repo)),
      scripts: () => ({}),
    })
    expectExitCode(held, 0)
    expect(held.log.some((each) => each.includes("DEFERRED_FREE"))).toBe(false)
    expect(warned(held, "t-1")).toBe(1)

    const freed = await runOf({
      tickets: [],
      backlog: seeds,
      before: (repo) =>
        Effect.gen(function* () {
          yield* offMain(repo)
          yield* (yield* Git).fastForward(repo, "tutti/t-1")
        }),
      scripts: () => ({}),
    })
    expectExitCode(freed, 0)
    expect(freed.log.some((each) => each.includes("DEFERRED_FREE: k-1"))).toBe(true)
  })
})

describe("Nothing to run with a blocker closed by hand, its branch not merged", () => {
  const seeds = backlog()
    .ticket("t-1", { status: "closed" })
    .ticket("t-2", { blockedBy: ["t-1"] })
    .ticket("t-3", { dependencies: [{ id: "t-1", type: "discovered-from" }] }).seeds

  const options = (beads: Beads["Service"], withBranches: boolean): Options => {
    const branches = withBranches ? startBranches(where) : undefined
    return {
      scope: null,
      filter: { excludeTypes: [] },
      ...where,
      carried: new Set(),
      unmerged: new Set(),
      ...(branches === undefined ? {} : { branches }),
      held: heldAtStart(beads, new Set(), branches),
    }
  }

  test("counts the tickets it blocks, and its follow-ups, among those waiting for it", async () => {
    const ran = await scenario(
      { backlog: seeds },
      Effect.gen(function* () {
        const beads = yield* Beads
        const path = yield* offMain(where.repo)
        const held = yield* check(options(beads, true))
        const unasked = yield* check(options(beads, false))
        yield* deleteBranch(where.repo, path, "tutti/t-1")
        const deleted = yield* check(options(beads, true))
        return { held, unasked, deleted }
      }),
    )
    const { held, unasked, deleted } = resultOf(ran)
    expect(held).toEqual(expect.objectContaining({ heldBlocked: 1, heldFollowUps: 1 }))
    expect(held === null ? [] : lines(held, noStyles).rest).toEqual([
      "1 ticket waits for its blocker to merge",
      "1 follow-up waits for the ticket it was filed from to merge",
    ])
    expect(unasked).toBeNull()
    expect(deleted).toBeNull()
    expect(ran.log.some((each) => each.includes("CLOSED_UNMERGED"))).toBe(false)
  })
})
