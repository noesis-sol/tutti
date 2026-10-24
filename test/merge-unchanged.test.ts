import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import type { EventRecord } from "../src/run/events.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Move, type TicketPhase } from "../src/run/phase.ts"
import { unmergedLabel } from "../src/run/scope.ts"
import { Beads, type Issue } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { backlog, type Env, expectLog, type Ran, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main" }

/** The scenario's value, or a test failure saying why it gave none. */
const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

const issueOf = (ran: Ran<unknown>, id: string): Issue => {
  const issue = ran.issues.find((each) => each.id === id)
  if (issue === undefined) throw new Error(`no issue ${id}`)
  return issue
}

const records = (ran: Ran<unknown>, kind: EventRecord["kind"]) =>
  ran.events.filter((record) => record.kind === kind)

/**
 * A ticket its worker finished: its worktree on tutti/<id> with a commit of each of `commits`, the
 * last naming it, closed in Beads, Working in the ledger.
 */
const finished = (id: string, ...commits: ReadonlyArray<Files>) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const worktree = yield* (yield* Worktrees).prepare(id)
    yield* git.addWorktree(repository.dir, worktree.path, { branch: worktree.branch, base: "main" })
    for (const [n, files] of commits.entries()) {
      const last = n === commits.length - 1
      yield* repository.commit(worktree.path, last ? `Do ${id} (${id})` : `Start ${id}`, files)
    }
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

/** Another ticket's merge, landing on main while the ticket ran. */
const moveMain = (files: Files) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    yield* repository.commit(repository.dir, "Land something else", files)
  })

interface Merged {
  readonly phase: TicketPhase | undefined
  /** main's head before the merge, and after it. */
  readonly before: string
  readonly after: string
  /** Where tutti/a is as it is removed: the test layer's Worktrees only records the removal. */
  readonly branch: string
}

/** Merges `make`'s ticket a, after `before`, until the queue settles. */
const mergeA = (
  make: Effect.Effect<FinishedTicket, unknown, Env | Ledger>,
  before: Effect.Effect<void, unknown, Env | Ledger> = Effect.void,
) =>
  Effect.gen(function* () {
    const queue = yield* makeQueue(options)
    const ticket = yield* make
    yield* before
    const repository = yield* Repository
    const head = yield* repository.head("main")
    yield* queue.offer(ticket)
    yield* queue.settled
    return {
      phase: (yield* (yield* Ledger).current).tickets.get("a")?.phase,
      before: head,
      after: yield* repository.head("main"),
      branch: yield* repository.head(ticket.branch),
    } satisfies Merged
  }).pipe(Effect.scoped, Effect.provide(Ledger.layer))

describe("a ticket left with no change of its own as it merges", () => {
  test("a rebase that drops every commit, the base having them, closes it as unchanged", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds },
      mergeA(finished("a", { "a.txt": "a\n" }), moveMain({ "a.txt": "a\n" })),
    )
    const merged = resultOf(ran)
    expect(merged.phase?._tag === "Done" && merged.phase.outcome._tag).toBe("NoChange")
    expect(merged.after).toBe(merged.before)
    expect(merged.branch).toBe(merged.before)
    // Nothing is left to check, or to merge.
    expect(ran.checkRuns).toEqual([])
    expect(ran.worktreeCalls.filter((call) => call.op === "remove")).toEqual([
      { op: "remove", id: "a", force: false },
    ])
    expectLog(ran, [
      "  a closed with no change: rebased onto main, which has its changes already, tutti/a changes nothing, so there is nothing to merge; worktree and branch removed",
    ])
    expect(ran.log.some((each) => each.includes("merged into main"))).toBe(false)
    expect(
      records(ran, "phase").map((record) => record.kind === "phase" && `${record.to}`),
    ).toEqual(["Queued", "Working", "ToMerge", "Merging", "Done"])
    expect(records(ran, "closed")).toEqual([
      expect.objectContaining({ ticket: "a", title: "Ticket a", detail: "no change to merge" }),
    ])
  })

  test("commits that together change nothing are closed as unchanged, their branch moved to main", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds },
      mergeA(finished("a", { "a.txt": "a\n" }, { "a.txt": null })),
    )
    const merged = resultOf(ran)
    expect(merged.phase?._tag === "Done" && merged.phase.outcome._tag).toBe("NoChange")
    expect(merged.after).toBe(merged.before)
    // Moved to main, so git deletes it as merged: its reflog keeps the commits.
    expect(merged.branch).toBe(merged.before)
    expect(ran.checkRuns).toEqual([])
    expect(ran.worktreeCalls.filter((call) => call.op === "remove")).toEqual([
      { op: "remove", id: "a", force: false },
    ])
    expectLog(ran, [
      "  a closed with no change: the commits on tutti/a, taken together, change nothing, so there is nothing to merge; worktree and branch removed",
    ])
  })

  test("a carried-over ticket loses its unmerged label, and its epic closes", async () => {
    const ran = await scenario(
      {
        backlog: backlog()
          .ticket("E", { type: "epic" })
          .ticket("a", { parent: "E", labels: [unmergedLabel] }).seeds,
      },
      mergeA(finished("a", { "a.txt": "a\n" }), moveMain({ "a.txt": "a\n" })),
    )
    resultOf(ran)
    expect(issueOf(ran, "a").labels).toEqual([])
    expect(issueOf(ran, "E").status).toBe("closed")
    expectLog(ran, [/^ {2}a closed with no change/, "  closed epic E: its 1 subticket is merged"])
  })

  test("a rebase that keeps a change goes on to the check, and the log says it passed", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds },
      mergeA(finished("a", { "a.txt": "a\n" }), moveMain({ "main.txt": "moved\n" })),
    )
    const merged = resultOf(ran)
    expect(merged.phase?._tag === "Done" && merged.phase.outcome._tag).toBe("Merged")
    expect(ran.checkRuns).toHaveLength(1)
    expectLog(ran, [
      "  rebased tutti/a onto main, which moved on while it ran",
      "  'scripted fast' passes on the rebased tutti/a",
      /^ {2}a closed \(.*\); merged into main, worktree and branch removed$/,
    ])
  })
})
