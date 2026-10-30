// A ticket an earlier run left Blocked or set aside, closed and labelled `unmerged`, and merged by
// hand since: its record in state.json is forgotten as the run starts, as a merged ticket's is
// (unmerged.ts's loadUnmerged), or as the run finds it merged while it goes on (handMerged.ts),
// unless carry-over takes the record up (tutti-7f8c).

import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Fiber } from "effect"
import { Ledger } from "../src/run/ledger.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { run } from "../src/run/run.ts"
import { unmergedLabel } from "../src/run/scope.ts"
import { forkKey, loadUnmerged } from "../src/run/unmerged.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { type State, Store, type TicketRecord } from "../src/services/Store.ts"
import type { Seed } from "../src/testing/Beads.ts"
import { Repository } from "../src/testing/Git.ts"
import { type Ran, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main" }

const closed = (id: string): Seed => ({ id, status: "closed" })

/** What a run that ended with the ticket in `phase` saved of it: not suspended, its phase kept. */
const left = (id: string, fields: Partial<TicketRecord> = {}): TicketRecord => ({
  session: `session-${id}`,
  worktree: `/repo-tutti/tutti-${id}`,
  branch: `tutti/${id}`,
  phase: "Blocked",
  resumes: 0,
  metadata: { rebased_unchecked: { head: "0".repeat(40), handed_back: true } },
  ...fields,
})

const stateOf = (tickets: Readonly<Record<string, TicketRecord>>): State => ({
  version: 1,
  tickets,
})

/**
 * The ticket's branch, cut from main with a commit naming it, labelled `unmerged` with its fork
 * noted, as a run that ends with it closed and not merged leaves it; the worktree's folder.
 */
const leftUnmerged = (id: TicketId) =>
  Effect.gen(function* () {
    const git = yield* Git
    const beads = yield* Beads
    const repository = yield* Repository
    const path = `/repo-tutti/tutti-${id}`
    yield* git.addWorktree(repository.dir, path, { branch: `tutti/${id}`, base: "main" })
    yield* repository.commit(path, `${id}: Do it`, { [`${id}.txt`]: `${id}\n` })
    const fork = yield* git.mergeBase(repository.dir, "main", `tutti/${id}`)
    yield* beads.setMetadata(id, forkKey, fork)
    yield* beads.addLabel(id, unmergedLabel)
    return path
  })

/** Merges the ticket's branch into main by hand, a fast-forward, its worktree and branch removed. */
const mergedByHand = (id: TicketId, path: string) =>
  Effect.gen(function* () {
    const git = yield* Git
    const repository = yield* Repository
    yield* git.fastForward(repository.dir, `tutti/${id}`)
    yield* git.removeWorktree(repository.dir, path, { force: true })
    yield* git.deleteBranch(repository.dir, `tutti/${id}`, { force: true })
  })

/** The scenario's value, or a test failure saying why it gave none. */
const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** loadUnmerged as the run starts, after `before`: the tickets in state.json then. */
const loaded = (
  saved: Readonly<Record<string, TicketRecord>>,
  before: Effect.Effect<void, unknown, Git | Beads | Repository>,
) =>
  scenario(
    { backlog: [closed("a")], state: stateOf(saved) },
    Effect.gen(function* () {
      yield* before
      const handed = yield* loadUnmerged(options)
      return { handed, tickets: (yield* (yield* Store).state).tickets }
    }),
  )

describe("a ticket left Blocked, merged by hand since", () => {
  test("its branch gone, a commit on main naming it: its record is forgotten", async () => {
    const ran = await loaded(
      { a: left("a") },
      Effect.gen(function* () {
        yield* mergedByHand("a" as TicketId, yield* leftUnmerged("a" as TicketId))
      }),
    )
    const { handed, tickets } = resultOf(ran)
    expect(handed).toEqual([])
    expect(tickets).toEqual({})
  })

  test("its branch on main: its record is forgotten, as one set aside for review is", async () => {
    const ran = await loaded(
      { a: left("a", { phase: "Review" }) },
      Effect.gen(function* () {
        yield* leftUnmerged("a" as TicketId)
        yield* (yield* Git).fastForward((yield* Repository).dir, "tutti/a")
      }),
    )
    expect(resultOf(ran).tickets).toEqual({})
  })

  test("not merged: its record is kept, and it is handed back", async () => {
    const ran = await loaded({ a: left("a") }, Effect.asVoid(leftUnmerged("a" as TicketId)))
    const { handed, tickets } = resultOf(ran)
    expect(handed.map((each) => each.issue.id)).toEqual(["a" as TicketId])
    expect(tickets).toEqual({ a: left("a") })
  })

  test("a record carry-over takes up, suspended or left by a crash, is left to it", async () => {
    const { phase: _, ...crashed } = left("a")
    for (const saved of [left("a", { suspended: "quit", phase: "Stopped" }), crashed]) {
      const ran = await loaded(
        { a: saved },
        Effect.gen(function* () {
          yield* mergedByHand("a" as TicketId, yield* leftUnmerged("a" as TicketId))
        }),
      )
      expect(resultOf(ran).tickets).toEqual({ a: saved })
    }
  })

  test("a whole run started with it: no phase of it in the run, and its record gone", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-left-record-")))
    let tickets: State["tickets"] | undefined
    const ran = await scenario(
      {
        backlog: [closed("a")],
        config: { repo },
        git: { dir: repo },
        state: stateOf({ a: left("a") }),
      },
      Effect.gen(function* () {
        yield* mergedByHand("a" as TicketId, yield* leftUnmerged("a" as TicketId))
        const running = Effect.scoped(run({ version: "0.1.0-test", base: "main" }))
        const outcome = yield* Fiber.join(yield* Effect.forkChild(running))
        tickets = (yield* (yield* Store).state).tickets
        return outcome
      }),
    )
    expect(Exit.isSuccess(ran.exit)).toBe(true)
    expect(tickets).toEqual({})
    expect(ran.events.filter((record) => record.kind === "phase" && record.ticket === "a")).toEqual(
      [],
    )
    expect(
      ran.log.some((text) => /^ {2}a, left unmerged by an earlier run, is on main now/.test(text)),
    ).toBe(true)
  })

  test("merged by hand while a run goes on: its record is forgotten as its label is removed", async () => {
    const ran = await scenario(
      { backlog: [closed("a")], state: stateOf({ a: left("a") }) },
      Effect.gen(function* () {
        const queue = yield* makeQueue(options)
        const path = yield* leftUnmerged("a" as TicketId)
        yield* queue.mergedByHand
        yield* mergedByHand("a" as TicketId, path)
        const found = yield* queue.mergedByHand
        return { found, tickets: (yield* (yield* Store).state).tickets }
      }).pipe(Effect.provide(Ledger.layer)),
    )
    const { found, tickets } = resultOf(ran)
    expect(found).toEqual(["a"])
    expect(tickets).toEqual({})
    expect(ran.issues.find((issue) => issue.id === "a")?.labels).toEqual([])
  })
})
