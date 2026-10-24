// A merge reads each git value once and passes it on (merge.ts): the worktree's status read for a
// change of its own steers the merge too, the check's own read after it says what it left, the
// branch's head read once goes to the setup and check, a pass after the check passed reads only
// the base and the branch again, and the epics are looked for in the bd show made just before.
// Each scenario counts the git and bd calls one merge makes, by operation, to pin what it reads.
import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Ledger } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Cause } from "../src/run/phase.ts"
import { Beads } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { Repository } from "../src/testing/Git.ts"
import { backlog, type Ran, scenario } from "./harness.ts"

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
  backlog: backlog().ticket("a").ticket("b").seeds,
}

/** A ticket its worker finished on top of main, `<id>.txt` committed, closed, Working. */
const finished = (id: string) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    const worktree = yield* (yield* Worktrees).prepare(id)
    yield* (yield* Git).addWorktree(repository.dir, worktree.path, {
      branch: worktree.branch,
      base: "main",
    })
    yield* repository.commit(worktree.path, `Do ${id} (${id})`, { [`${id}.txt`]: `${id}\n` })
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

/** How many calls of each operation, by name. */
type Counts = Readonly<Record<string, number>>

const countOf = (names: ReadonlyArray<string>): Counts => {
  const counts: Record<string, number> = {}
  for (const name of names) counts[name] = (counts[name] ?? 0) + 1
  return counts
}

interface Merged {
  readonly phase: string | undefined
  readonly git: Counts
  readonly shows: number
}

/**
 * Finishes the tickets, merges `ahead` first when given, then merges `ticket` alone through a queue
 * of its own: the git calls and bd shows its merge made, counted.
 */
const counted = (ticket: string, ahead?: string) =>
  scenario(
    setup,
    Effect.gen(function* () {
      const repository = yield* Repository
      const a = yield* finished(ticket)
      const before = ahead === undefined ? undefined : yield* finished(ahead)
      const beads = yield* Beads
      let shows = 0
      const queue = yield* makeQueue(options).pipe(
        Effect.provideService(Beads, {
          ...beads,
          show: (id) =>
            Effect.suspend(() => {
              shows += 1
              return beads.show(id)
            }),
        }),
      )
      if (before !== undefined) {
        yield* queue.offer(before)
        yield* queue.settled
      }
      const from = (yield* repository.calls).length
      shows = 0
      yield* queue.offer(a)
      yield* queue.settled
      const calls = (yield* repository.calls).slice(from)
      const phase = (yield* (yield* Ledger).current).tickets.get(ticket)?.phase._tag
      return { phase, git: countOf(calls.map((call) => call.op)), shows } satisfies Merged
    }).pipe(Effect.provide(Ledger.layer)),
  )

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

// The counts take in the queue's own looks once the base moved on (its settings file, a ticket
// merged by hand): a rev-parse, a diff and a rev-parse after the merge's log.
describe("one merge's reads", () => {
  test("a branch on top of the base, checked and merged: 19 git calls and one bd show", async () => {
    const merged = resultOf(await counted("a"))
    expect(merged.phase).toBe("Done")
    // Before each value was read once: 25, with 3 statuses, a rev-parse, a merge-base and a diff
    // more, and 2 bd shows.
    expect(merged.git).toEqual({
      "symbolic-ref": 2,
      "rev-parse": 7,
      "merge-base": 1,
      status: 5,
      "diff --name-only": 2,
      "merge --ff-only": 1,
      log: 1,
    })
    expect(merged.shows).toBe(1)
  })

  test("a branch rebased onto the base that moved on, checked and merged: 24 and one", async () => {
    const merged = resultOf(await counted("a", "b"))
    expect(merged.phase).toBe("Done")
    // Before: 29, with 3 statuses, a merge-base and a diff more, and 2 bd shows.
    expect(merged.git).toEqual({
      "symbolic-ref": 2,
      "rev-parse": 8,
      "merge-base": 1,
      status: 6,
      "diff --name-only": 3,
      rebase: 1,
      "merge --ff-only": 1,
      log: 2,
    })
    expect(merged.shows).toBe(1)
  })
})
