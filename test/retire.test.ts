// A done ticket's retirement (merge.ts's retire), the one step a merge, a close with no change and a
// ticket merged by hand share: its worktree and branch removed, its label, its record in state.json,
// the epics above it. A ticket merged by hand is retired with what bd showed of it as the run asked
// whether it merged, so bd is asked of it once, and its worktree, looked for once, is removed where
// git has it.
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Stream } from "effect"
import { Ledger } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Cause } from "../src/run/phase.ts"
import { Beads } from "../src/services/Beads.ts"
import { CheckFailed } from "../src/services/Checks.ts"
import { Git } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { Repository } from "../src/testing/Git.ts"
import { backlog, expectLog, type Ran, scenario } from "./harness.ts"

const options = { repo: "/repo", base: "main" }

/** A check that fails in a file the ticket doesn't change. */
const elsewhere = new CheckFailed({
  check: "fast",
  command: "scripts/check-fast.sh",
  exitCode: 1,
  outputFile: "/dev/fd/9",
  failingLines: ["shared/b.go:12: expected 1"],
  lastLines: ["shared/b.go:12: expected 1", "1 fail"],
  suites: [],
  suite: null,
  flaky: [],
  flakyCount: 0,
})

/** A ticket its worker finished: its worktree on tutti/<id> with a commit naming it, Working. */
const finished = (id: string) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    const worktree = yield* (yield* Worktrees).prepare(id)
    yield* (yield* Git).addWorktree(repository.dir, worktree.path, {
      branch: worktree.branch,
      base: "main",
    })
    yield* repository.commit(worktree.path, `Do ${id} (${id})`, { [`${id}/${id}.go`]: `${id}\n` })
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

interface Retired {
  readonly phase: string | undefined
  /** The bd shows of the ticket from its squash-merge to its retirement. */
  readonly shows: number
  /** The git calls of each operation over the same span. */
  readonly git: Readonly<Record<string, number>>
}

/**
 * `a`, under the epic E, is set aside as its check fails after main moved; then squash-merged onto
 * main by hand, and the queue asks which tickets were: what it asked of bd and git meanwhile.
 */
const mergedByHand = () =>
  scenario(
    {
      backlog: backlog().ticket("E", { type: "epic" }).ticket("a", { parent: "E" }).seeds,
      checks: { fast: [elsewhere] },
    },
    Effect.gen(function* () {
      const repository = yield* Repository
      const beads = yield* Beads
      const ledger = yield* Ledger
      let shows = 0
      const queue = yield* makeQueue(options).pipe(
        Effect.provideService(Beads, {
          ...beads,
          show: (id) =>
            Effect.suspend(() => {
              if (id === "a") shows += 1
              return beads.show(id)
            }),
        }),
      )
      const a = yield* finished("a")
      yield* repository.commit(repository.dir, "Land something else", { "main.txt": "moved\n" })
      yield* queue.offer(a)
      yield* ledger.changes.pipe(
        Stream.filter((state) => state.tickets.get("a")?.phase._tag === "Review"),
        Stream.runHead,
      )
      yield* repository.commit(repository.dir, "Squash-merge a (a)", { "a/a.go": "a\n" })
      const from = (yield* repository.calls).length
      shows = 0
      expect(yield* queue.mergedByHand).toEqual(["a"])
      const calls = (yield* repository.calls).slice(from)
      const git: Record<string, number> = {}
      for (const call of calls) git[call.op] = (git[call.op] ?? 0) + 1
      yield* queue.settled
      return {
        phase: (yield* ledger.current).tickets.get("a")?.phase._tag,
        shows,
        git,
      } satisfies Retired
    }).pipe(Effect.provide(Ledger.layer)),
  )

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

describe("a ticket merged by hand, retired", () => {
  test("is shown by bd once, the epic above it closed all the same", async () => {
    const ran = await mergedByHand()
    const retired = resultOf(ran)
    expect(retired.phase).toBe("Done")
    expect(retired.shows).toBe(1)
    expect(ran.issues.find((issue) => issue.id === "E")?.status).toBe("closed")
    expectLog(ran, [
      /^ {2}a, set aside in this run, is on main now \([0-9a-f]{7} Squash-merge a \(a\)\): merged by hand, so no longer set aside; worktree and branch removed$/,
      "  closed epic E: its 1 subticket is merged",
    ])
  })

  test("has its worktree looked for once and removed where git has it", async () => {
    const ran = await mergedByHand()
    expect(resultOf(ran).git["worktree list"]).toBe(1)
    expect(ran.worktreeCalls).toContainEqual(
      expect.objectContaining({ op: "remove", id: "a", force: false }),
    )
  })
})
