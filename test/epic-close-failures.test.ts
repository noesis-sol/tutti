// bd failing as an epic's last subticket merges (§ 5 item 12): bd refusing to close the epic, or
// unable to list its subtickets, leaves it open with a log line saying so (and, for the first, the
// command to close it by hand), and the merge queue goes on to the next ticket.
import { describe, expect, test } from "bun:test"
import { Effect, Exit, type Scope } from "effect"
import { Ledger, type State } from "../src/run/ledger.ts"
import type { FinishedTicket, MergeStop } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Cause, type PhaseTag } from "../src/run/phase.ts"
import { Beads, BeadsFailed } from "../src/services/Beads.ts"
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

/** A ticket its worker finished: its worktree on tutti/<id> with a commit naming it, closed in Beads. */
const finished = (id: string, files: Files) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    const worktree = yield* (yield* Worktrees).prepare(id)
    yield* git.addWorktree(repository.dir, worktree.path, { branch: worktree.branch, base: "main" })
    yield* repository.commit(worktree.path, `Do ${id} (${id})`, files)
    yield* (yield* Beads).close(id, "done")
    const ledger = yield* Ledger
    yield* ledger.transition(id, Cause.Ready(), { title: `Ticket ${id}` })
    yield* ledger.transition(id, Cause.Dispatched())
    return {
      id,
      title: `Ticket ${id}`,
      branch: worktree.branch,
      worktree: worktree.path,
    } satisfies FinishedTicket
  })

/** What the queue left: each ticket's phase and its stop. */
interface Merged {
  readonly phases: Readonly<Record<string, PhaseTag>>
  readonly stop: MergeStop | null
}

const tagsOf = (state: State): Record<string, PhaseTag> =>
  Object.fromEntries([...state.tickets.values()].map((entry) => [entry.ticket, entry.phase._tag]))

/** bd failing as a locked database makes it. */
const locked = (command: string) =>
  new BeadsFailed({ command, exitCode: 1, stderr: "database is locked", noSuchIssue: false })

/**
 * Finishes a, the only subticket of the epic E, and b, outside it, and merges them in that order,
 * with `beads` changing what bd does.
 */
const mergeWith = (beads: (live: Beads["Service"]) => Beads["Service"]) =>
  Effect.gen(function* () {
    const live = yield* Beads
    return yield* Effect.gen(function* () {
      const a = yield* finished("a", { "a.txt": "a\n" })
      const b = yield* finished("b", { "b.txt": "b\n" })
      const queue = yield* makeQueue(options)
      yield* queue.offer(a)
      yield* queue.offer(b)
      yield* queue.settled
      return {
        phases: tagsOf(yield* (yield* Ledger).current),
        stop: (yield* queue.state).stop,
      } satisfies Merged
    }).pipe(Effect.provide(Ledger.layer), Effect.provideService(Beads, beads(live)))
  }) satisfies Effect.Effect<Merged, unknown, Env | Scope.Scope>

const seeds = backlog().epic("E", ["a"]).ticket("b").seeds

const statusOf = (ran: Ran<unknown>, id: string) =>
  ran.issues.find((issue) => issue.id === id)?.status

describe("an epic whose last subticket merged", () => {
  test("bd failing to close it leaves it open, says how to close it, and the queue goes on", async () => {
    const ran = await scenario(
      { backlog: seeds },
      mergeWith((live) => ({
        ...live,
        close: (id, reason) =>
          id === "E" ? Effect.fail(locked("bd close E")) : live.close(id, reason),
      })),
    )
    const merged = resultOf(ran)
    expect(merged.phases).toEqual({ a: "Done", b: "Done" })
    expect(merged.stop).toBeNull()
    expect(statusOf(ran, "E")).not.toBe("closed")
    expectLog(ran, [
      /^ {2}a closed /,
      "  its 1 subticket is merged, but bd could not close E: database is locked; close it with: bd close E",
      /^ {2}b closed /,
    ])
    expect(ran.log.some((each) => each.includes("closed epic"))).toBe(false)
    const info = ran.events.find((record) => record.kind === "info")
    expect(info).toMatchObject({ ticket: "E" })
  })

  test("bd failing to list its subtickets leaves it open, saying so, and the queue goes on", async () => {
    const ran = await scenario(
      { backlog: seeds },
      mergeWith((live) => ({
        ...live,
        list: (listing = {}) =>
          listing.parent === "E" ? Effect.fail(locked("bd list --parent E")) : live.list(listing),
      })),
    )
    const merged = resultOf(ran)
    expect(merged.phases).toEqual({ a: "Done", b: "Done" })
    expect(merged.stop).toBeNull()
    expect(statusOf(ran, "E")).not.toBe("closed")
    expectLog(ran, [
      /^ {2}a closed /,
      "  bd could not say whether the subtickets of E are all merged: database is locked; it is left open",
      /^ {2}b closed /,
    ])
    expect(ran.log.some((each) => each.includes("closed epic"))).toBe(false)
    const info = ran.events.find((record) => record.kind === "info")
    expect(info).toMatchObject({ ticket: "E" })
  })
})
