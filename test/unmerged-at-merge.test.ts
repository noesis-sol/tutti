import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Ledger } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Move } from "../src/run/phase.ts"
import { unmergedLabel } from "../src/run/scope.ts"
import { Beads, BeadsFailed, type Issue } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { type Files, Repository } from "../src/testing/Git.ts"
import { backlog, expectLog, type Ran, scenario } from "./harness.ts"

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

/**
 * A ticket its worker finished: its worktree on tutti/<id> with a commit naming it, closed in Beads,
 * Working in the ledger.
 */
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

/** Merges the tickets, in that order, until the queue settles. */
const mergeAll = (ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const queue = yield* makeQueue(options)
    const tickets = []
    for (const id of ids) tickets.push(yield* finished(id, { [`${id}.txt`]: `${id}\n` }))
    for (const ticket of tickets) yield* queue.offer(ticket)
    yield* queue.settled
  }).pipe(Effect.scoped, Effect.provide(Ledger.layer))

describe("a carried-over ticket labelled unmerged", () => {
  // b was left unmerged by an earlier run, labelled, and is carried over to merge in this one.
  const seeds = backlog()
    .ticket("E", { type: "epic" })
    .ticket("a", { parent: "E" })
    .ticket("b", { parent: "E", labels: [unmergedLabel] }).seeds

  test("loses the label as it merges, and its epic closes when it is the last to", async () => {
    const ran = await scenario({ backlog: seeds }, mergeAll(["a", "b"]))
    resultOf(ran)
    expect(issueOf(ran, "b").labels).toEqual([])
    expect(issueOf(ran, "E").status).toBe("closed")
    expectLog(ran, [/^ {2}b closed/, "  closed epic E: all 2 subtickets are merged"])
  })

  test("bd failing to remove the label is LABEL_FAILED, and the epic stays open", async () => {
    const refused = new BeadsFailed({
      command: "bd label remove b unmerged",
      exitCode: 1,
      stderr: "database is locked",
      noSuchIssue: false,
    })
    const ran = await scenario(
      { backlog: seeds },
      Effect.gen(function* () {
        const beads = yield* Beads
        yield* mergeAll(["a", "b"]).pipe(
          Effect.provideService(Beads, {
            ...beads,
            removeLabel: (id, label) =>
              id === "b" ? Effect.fail(refused) : beads.removeLabel(id, label),
          }),
        )
      }),
    )
    resultOf(ran)
    expect(issueOf(ran, "b").labels).toEqual([unmergedLabel])
    expect(issueOf(ran, "E").status).not.toBe("closed")
    expect(ran.log).toContain(
      "  LABEL_FAILED: bd could not remove b's 'unmerged' label: database is locked; later runs hold the tickets it blocks until it is removed (bd label remove b unmerged)",
    )
    expect(ran.log.some((each) => each.includes("closed epic"))).toBe(false)
  })
})
