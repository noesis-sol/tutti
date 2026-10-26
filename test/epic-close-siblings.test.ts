// Closing an epic as a subticket merges while the run still holds another subticket of it, not
// Done: the epic can't close yet, so bd isn't asked about it. A subticket only bd knows of, or one
// the run holds without its issue, is bd's to judge, as before.
import { describe, expect, test } from "bun:test"
import { Effect, Exit, type Scope } from "effect"
import { Ledger } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Move } from "../src/run/phase.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
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

/** `id` taken up by the run, its issue as bd shows it kept on its entry, and its worker at it. */
const working = (id: TicketId, withIssue = true) =>
  Effect.gen(function* () {
    const issue = yield* (yield* Beads).show(id)
    yield* (yield* Ledger).transition(id, Move.Ready(), {
      title: `Ticket ${id}`,
      ...(withIssue ? { issue } : {}),
    })
    yield* (yield* Ledger).transition(id, Move.Dispatched())
  })

/** A ticket its worker finished: its worktree on tutti/<id> with a commit naming it, closed in Beads. */
const finished = (id: TicketId, files: Files) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const worktree = yield* (yield* Worktrees).prepare(id)
    yield* git.addWorktree(repository.dir, worktree.path, { branch: worktree.branch, base: "main" })
    yield* repository.commit(worktree.path, `Do ${id} (${id})`, files)
    yield* working(id)
    yield* (yield* Beads).close(id, "done")
    return {
      id,
      title: `Ticket ${id}`,
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

/** Finishes `merged` and merges them in order, after `before`, with each bd show and bd list about E noted. */
const mergeNoting = (
  merged: ReadonlyArray<string>,
  before: Effect.Effect<void, unknown, Env | Ledger> = Effect.void,
) =>
  Effect.gen(function* () {
    const live = yield* Beads
    const asked: Array<string> = []
    const noting: Beads["Service"] = {
      ...live,
      show: (id) => {
        if (id === "E") asked.push("show E")
        return live.show(id)
      },
      list: (listing = {}) => {
        if (listing.parent === "E") asked.push("list --parent E")
        return live.list(listing)
      },
    }
    return yield* Effect.gen(function* () {
      yield* before
      const tickets = yield* Effect.forEach(merged, (id) =>
        finished(id as TicketId, { [`${id}.txt`]: `${id}\n` }),
      )
      const queue = yield* makeQueue(options)
      for (const ticket of tickets) {
        yield* queue.offer(ticket)
        yield* queue.settled
        asked.push(`merged ${ticket.id}`)
      }
      return asked
    }).pipe(Effect.provide(Ledger.layer), Effect.provideService(Beads, noting))
  }) satisfies Effect.Effect<ReadonlyArray<string>, unknown, Env | Scope.Scope>

const seeds = backlog().epic("E", ["a", "b"]).seeds

const statusOf = (ran: Ran<unknown>, id: string) =>
  ran.issues.find((issue) => issue.id === id)?.status

describe("a subticket merged while the run holds a sibling", () => {
  test("a sibling still working keeps bd from being asked about the epic", async () => {
    const ran = await scenario({ backlog: seeds }, mergeNoting(["a"], working("b" as TicketId)))
    expect(resultOf(ran)).toEqual(["merged a"])
    expect(statusOf(ran, "E")).not.toBe("closed")
    expect(ran.log.some((each) => each.includes("closed epic"))).toBe(false)
  })

  test("the last one merged, its sibling finished meanwhile, asks bd and closes the epic", async () => {
    const ran = await scenario({ backlog: seeds }, mergeNoting(["a", "b"]))
    expect(resultOf(ran)).toEqual(["merged a", "show E", "list --parent E", "merged b"])
    expect(statusOf(ran, "E")).toBe("closed")
    expectLog(ran, [
      /^ {2}a closed/,
      /^ {2}b closed/,
      "  closed epic E: all 2 subtickets are merged",
    ])
  })

  test("a sibling only bd knows of is checked with bd", async () => {
    const ran = await scenario({ backlog: seeds }, mergeNoting(["a"]))
    expect(resultOf(ran)).toEqual(["show E", "list --parent E", "merged a"])
    expect(statusOf(ran, "E")).not.toBe("closed")
  })

  test("a sibling the run holds without its issue is checked with bd", async () => {
    const ran = await scenario(
      { backlog: seeds },
      mergeNoting(["a"], working("b" as TicketId, false)),
    )
    expect(resultOf(ran)).toEqual(["show E", "list --parent E", "merged a"])
    expect(statusOf(ran, "E")).not.toBe("closed")
  })
})
