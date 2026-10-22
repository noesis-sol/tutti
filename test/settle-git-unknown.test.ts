// A worker that stops with its ticket open and a blocker not merged waits for the merge only when it
// left nothing (§ 4.3). When git can't read its worktree, that check reads as work left in it, as the
// check for a ticket set aside does: the ticket is set aside with its worktree kept, and the error
// logged, rather than its fiber failing and the run holding with GIT_FAILED.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Exit, Fiber, type Scope } from "effect"
import { makeHandBacks } from "../src/run/handback.ts"
import { makeHeld } from "../src/run/held.ts"
import { Ledger } from "../src/run/ledger.ts"
import { emptyQueue, type MergeQueue } from "../src/run/mergequeue.ts"
import { Cause } from "../src/run/phase.ts"
import { makeRechecks } from "../src/run/recheck.ts"
import type { StartTicket } from "../src/run/start.ts"
import { type Worked, work } from "../src/run/work.ts"
import { Git } from "../src/services/Git.ts"
import { run, turn } from "../src/testing/AgentHost.ts"
import { type Fault, Repository } from "../src/testing/Git.ts"
import { backlog, type Env, expectLog, type Ran, scenario, type World } from "./harness.ts"

const id = "t-1"
const ticket: StartTicket = { id, title: "One ticket", metadata: {} }

/** A merge queue that only puts the ticket in line, ToMerge. */
const lineOnly: Effect.Effect<MergeQueue, never, Ledger> = Effect.gen(function* () {
  const ledger = yield* Ledger
  return {
    offer: (finished, cause = (place) => Cause.Verified({ place })) =>
      ledger.transition(finished.id, cause(1)),
    state: Effect.succeed(emptyQueue),
    changes: undefined as never,
    settled: Effect.succeed(emptyQueue),
    rechecks: yield* makeRechecks,
    handBacks: yield* makeHandBacks,
    held: yield* makeHeld,
    checksAhead: undefined as never,
    recheck: Effect.succeed([]),
    mergedByHand: Effect.succeed([]),
    hold: Effect.void,
    stopMerges: Effect.void,
  } satisfies MergeQueue
})

/**
 * Dispatches the ticket and runs its fiber on main, its worktree in a new folder. Its worker claims
 * it, links the blocker t-0, which isn't merged, and leaves it open; as its turn ends, git's next
 * log in its worktree fails as `fault` says.
 */
const working = (path: string, fault: Fault): Promise<Ran<Worked>> => {
  const root = dirname(path)
  const step = (effect: (world: World) => Effect.Effect<unknown, unknown>) => (world: World) =>
    run(Effect.asVoid(Effect.orDie(Effect.suspend(() => effect(world)))))
  return scenario(
    {
      backlog: backlog().ticket("t-0").ticket(id, { title: "One ticket" }).seeds,
      worktrees: { root },
      scripts: (world) => ({
        [id]: [
          turn([
            step((w) => w.beads.update(id, { claim: true }))(world),
            step((w) => w.beads.addDependency(id, "t-0"))(world),
            step((w) => w.beads.update(id, { status: "open" }))(world),
            step((w) => w.repository.fail("log", { dir: path, ...fault }))(world),
          ]),
        ],
      }),
    },
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const git = yield* Git
      const repository = yield* Repository
      yield* git.addWorktree(repository.dir, path, { branch: `tutti/${id}`, base: "main" })
      yield* ledger.transition(id, Cause.Ready(), { title: ticket.title })
      yield* ledger.transition(id, Cause.Dispatched())
      const fiber = yield* Effect.forkChild(work(ticket, { base: "main", queue: yield* lineOnly }))
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<Worked, unknown, Env | Scope.Scope>,
  )
}

/** A folder for the worktrees, so a test knows where its ticket's is before it starts. */
const worktreesRoot = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-settle-git-")))

const workedOf = (ran: Ran<Worked>): Worked => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

describe("a git error as settle asks whether a waiting ticket's worker left anything", () => {
  test("git failing: the ticket is set aside, its worktree kept, the error logged", async () => {
    const path = join(worktreesRoot(), id)
    const ran = await working(path, { stderr: "fatal: index file corrupt\nmore" })
    expect(workedOf(ran).phase?._tag).toBe("Deferred")
    expect(ran.issues.find((issue) => issue.id === id)?.status).toBe("deferred")
    expect(ran.worktreeCalls).not.toContainEqual(expect.objectContaining({ op: "remove", id }))
    expectLog(ran, [
      `  t-1: git can't tell whether its worker left anything in ${path}: fatal: index file corrupt; read as work left in it`,
      "  t-1 settled: its worker is idle",
      `  t-1 still open -> noted and deferred; worktree ${path} left open`,
    ])
    expect(ran.log.join("\n")).not.toMatch(/WAITS_FOR_MERGE|GIT_FAILED/)
  })

  test("git timing out: the same", async () => {
    const path = join(worktreesRoot(), id)
    const ran = await working(path, { timedOut: true })
    expect(workedOf(ran).phase?._tag).toBe("Deferred")
    expectLog(ran, [
      /^ {2}t-1: git can't tell whether its worker left anything in .*: git took longer than /,
    ])
    expect(ran.log.join("\n")).not.toMatch(/WAITS_FOR_MERGE|GIT_FAILED/)
  })
})
