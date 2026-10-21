// CLEANUP_FAILED after a fast-forward (§ 5 item 12): the ticket's branch is merged into the base, but
// removing its worktree and branch fails. The ticket is Done all the same, the log line says it
// merged and what kept the cleanup from finishing, and the queue goes on to the next ticket.
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { Duration, Effect, Exit, type Scope } from "effect"
import { Ledger, type State } from "../src/run/ledger.ts"
import type { FinishedTicket, MergeStop } from "../src/run/merge.ts"
import { make as makeQueue } from "../src/run/mergequeue.ts"
import { Cause, type PhaseTag } from "../src/run/phase.ts"
import { Beads } from "../src/services/Beads.ts"
import { Git, type GitError, GitFailed, GitTimedOut } from "../src/services/Git.ts"
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

/** What the queue left: each ticket's phase, its stop, and the tickets' worktrees. */
interface Merged {
  readonly phases: Readonly<Record<string, PhaseTag>>
  readonly stop: MergeStop | null
  readonly worktrees: Readonly<Record<string, string>>
  /** The failing ticket's file, as main has it at the end. */
  readonly onMain: string | undefined
}

const tagsOf = (state: State): Record<string, PhaseTag> =>
  Object.fromEntries([...state.tickets.values()].map((entry) => [entry.ticket, entry.phase._tag]))

/**
 * Finishes the tickets `ids` (each committing <id>.txt) and merges them in that order, with
 * Worktrees.remove failing with `failure` for the ticket `failing`.
 */
const mergeFailingCleanup = (ids: ReadonlyArray<string>, failing: string, failure: GitError) =>
  Effect.gen(function* () {
    const worktrees = yield* Worktrees
    return yield* Effect.gen(function* () {
      const tickets: Array<FinishedTicket> = []
      for (const id of ids) tickets.push(yield* finished(id, { [`${id}.txt`]: `${id}\n` }))
      const queue = yield* makeQueue(options)
      for (const ticket of tickets) yield* queue.offer(ticket)
      yield* queue.settled
      const main = yield* (yield* Repository).tree("main")
      return {
        phases: tagsOf(yield* (yield* Ledger).current),
        stop: (yield* queue.state).stop,
        worktrees: Object.fromEntries(tickets.map((ticket) => [ticket.id, ticket.worktree])),
        onMain: main.get(`${failing}.txt`),
      } satisfies Merged
    }).pipe(
      Effect.provide(Ledger.layer),
      Effect.provideService(Worktrees, {
        ...worktrees,
        remove: (id, removal) =>
          id === failing ? Effect.fail(failure) : worktrees.remove(id, removal),
      }),
    )
  }) satisfies Effect.Effect<Merged, unknown, Env | Scope.Scope>

const refused = new GitFailed({
  op: "worktree remove",
  command: "git worktree remove /worktrees/a",
  exitCode: 128,
  stderr: "fatal: '/worktrees/a' contains modified or untracked files, use --force to delete it\n",
})

describe("CLEANUP_FAILED after a fast-forward", () => {
  test("the ticket merges and is Done, and the log names the worktree and branch git would not remove", async () => {
    const ran = await scenario(
      { backlog: backlog().ticket("a").seeds },
      mergeFailingCleanup(["a"], "a", refused),
    )
    const merged = resultOf(ran)
    expect(merged.phases).toEqual({ a: "Done" })
    expect(merged.stop).toBeNull()
    expect(merged.onMain).toBe("a\n")
    const worktree = merged.worktrees.a as string
    expect(existsSync(worktree)).toBe(true)
    expect(ran.log).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^ {2}a closed \\([0-9a-f]{7} Do a \\(a\\)\\); merged into main, but CLEANUP_FAILED for ${worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} / tutti/a: fatal: '/worktrees/a' contains modified or untracked files, use --force to delete it$`,
        ),
      ),
    )
    const closed = ran.events.find((record) => record.kind === "closed")
    expect(closed).toMatchObject({ ticket: "a", title: "Ticket a" })
    expect(closed?.kind === "closed" && closed.detail).toMatch(
      /^[0-9a-f]{7} merged; cleanup failed$/,
    )
    expect(ran.issues.find((issue) => issue.id === "a")?.status).toBe("closed")
  })

  test("git timing out on the cleanup says so, and the next ticket in line still merges", async () => {
    const slow = new GitTimedOut({
      op: "worktree remove",
      command: "git worktree remove /worktrees/a",
      timeLimit: Duration.minutes(2),
    })
    const ran = await scenario(
      { backlog: backlog().ticket("a").ticket("b").seeds },
      mergeFailingCleanup(["a", "b"], "a", slow),
    )
    const merged = resultOf(ran)
    expect(merged.phases).toEqual({ a: "Done", b: "Done" })
    expect(merged.stop).toBeNull()
    expectLog(ran, [
      /^ {2}a closed \([0-9a-f]{7} Do a \(a\)\); merged into main, but CLEANUP_FAILED for .*\/a \/ tutti\/a: git took longer than 2m$/,
      /^ {2}b closed \([0-9a-f]{7} Do b \(b\)\); merged into main, worktree and branch removed$/,
    ])
    expect(existsSync(merged.worktrees.a as string)).toBe(true)
    expect(existsSync(merged.worktrees.b as string)).toBe(false)
  })
})
