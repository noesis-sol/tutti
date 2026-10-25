// Closing epics as their last subticket merges, whatever the queue's exclude_types holds: a run never
// takes an epic from bd ready (§ 2 Ticket), so it closes one, and any parent of a type it leaves out.
import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Ledger } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Move } from "../src/run/phase.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { backlog, expectLog, type Ran, type Setup, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main" }
const defaults = appConfig().settings

/** The scenario's value, or a test failure saying why it gave none. */
const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** A ticket its worker finished: its worktree on tutti/<id> with a commit naming it, closed in Beads. */
const finished = (id: TicketId, files: Files) =>
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

/** Merges a, the only subticket of E, of type `type`, with exclude_types `excluded`. */
const mergeUnder = (type: string, excluded: ReadonlyArray<string>) => {
  const setup: Setup = {
    backlog: backlog().ticket("E", { type }).ticket("a", { parent: "E" }).seeds,
    config: { settings: { ...defaults, queue: { ...defaults.queue, exclude_types: excluded } } },
  }
  return scenario(
    setup,
    Effect.gen(function* () {
      const queue = yield* makeQueue(options)
      yield* queue.offer(yield* finished("a" as TicketId, { "a.txt": "a\n" }))
      yield* queue.settled
    }).pipe(Effect.scoped, Effect.provide(Ledger.layer)),
  )
}

const statusOf = (ran: Ran<unknown>, id: string) =>
  ran.issues.find((issue) => issue.id === id)?.status

describe("a parent whose last subticket merges", () => {
  test("an epic closes with exclude_types empty", async () => {
    const ran = await mergeUnder("epic", [])
    resultOf(ran)
    expect(statusOf(ran, "E")).toBe("closed")
    expectLog(ran, [/^ {2}a closed/, "  closed epic E: its 1 subticket is merged"])
  })

  test("an epic closes with exclude_types naming other types only", async () => {
    const ran = await mergeUnder("epic", ["chore"])
    resultOf(ran)
    expect(statusOf(ran, "E")).toBe("closed")
  })

  test("a parent of a type exclude_types names closes", async () => {
    const ran = await mergeUnder("feature", ["feature"])
    resultOf(ran)
    expect(statusOf(ran, "E")).toBe("closed")
  })

  test("a parent of a type the run takes stays open", async () => {
    const ran = await mergeUnder("feature", [])
    resultOf(ran)
    expect(statusOf(ran, "E")).not.toBe("closed")
    expect(ran.log.some((each) => each.includes("closed epic"))).toBe(false)
  })
})
