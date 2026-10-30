// What a ticket's worker left running in its worktree is stopped before tutti removes the worktree,
// wherever it does (Trash.stopLeft, src/services/Strays.ts): the merge's removal, whether it sets
// the worktree's folder aside or hands it to git, as with a folder that can't be moved; a ticket
// closed with no change; one set aside with nothing done. The Strays test layer says what was left
// running in each worktree; the log names what was stopped, before the worktree went.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Fiber, Layer, type Scope } from "effect"
import { makeHandBacks } from "../src/run/handback.ts"
import { makeHeld } from "../src/run/held.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { emptyQueue, type MergeQueue, make as makeQueue } from "../src/run/mergequeue.ts"
import { Move } from "../src/run/phase.ts"
import { makeRechecks } from "../src/run/recheck.ts"
import type { StartTicket } from "../src/run/start.ts"
import { Trash, layer as trashLayer } from "../src/run/trash.ts"
import { type Worked, work } from "../src/run/work.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import type { Stray } from "../src/services/Strays.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { run, type SessionScript, turn } from "../src/testing/AgentHost.ts"
import { Repository } from "../src/testing/Git.ts"
import { backlog, type Env, expectLog, type Ran, scenario, type World } from "./harness.ts"

const id = "t-1" as TicketId
const ticket: StartTicket = { id, title: "One ticket", metadata: {} }
const left: ReadonlyArray<Stray> = [
  { pid: 4101, command: "node" },
  { pid: 4102, command: "vitest worker" },
]

const worktreesRoot = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-strays-removal-")))

const succeeded = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

/** The line of `left` stopped in `path`; the Strays test layer finds none once it has gone. */
const stoppedWith = (path: string) =>
  `  ${id}: stopped 2 processes left running in ${path}: node, vitest worker`

describe("the merge", () => {
  /** Merges ticket t-1, finished on its branch, with `remove` in place of the Worktrees' own. */
  const merged = (root: string, aside: boolean) =>
    scenario(
      {
        backlog: backlog().ticket(id).seeds,
        worktrees: { root },
        strays: { [join(root, id)]: left },
      },
      Effect.gen(function* () {
        const git = yield* Git
        const repository = yield* Repository
        const worktrees = yield* Worktrees
        const worktree = yield* worktrees.prepare(id)
        yield* git.addWorktree(repository.dir, worktree.path, {
          branch: worktree.branch,
          base: "main",
        })
        yield* repository.commit(worktree.path, `Do ${id} (${id})`, { "a.txt": "a\n" })
        yield* (yield* Beads).close(id, "done")
        const ledger = yield* Ledger
        yield* ledger.transition(id, Move.Ready(), { title: ticket.title })
        yield* ledger.transition(id, Move.Dispatched())
        return yield* Effect.gen(function* () {
          const queue = yield* makeQueue({ repo: "/repo", base: "main" })
          const finished: FinishedTicket = {
            id,
            title: ticket.title,
            branch: worktree.branch,
            worktree: worktree.path,
          }
          yield* queue.offer(finished)
          yield* queue.settled
          yield* (yield* Trash).settled
        }).pipe(
          Effect.provide(Layer.fresh(trashLayer)),
          Effect.provideService(Worktrees, {
            ...worktrees,
            // A folder that can't be moved, as on another disk, is handed to git.
            remove: (ticketId, removal) =>
              worktrees.remove(ticketId, aside ? removal : { ...removal, aside: false }),
          }),
        )
      }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<void, unknown, Env | Scope.Scope>,
    )

  test("stops what was left in a worktree it sets aside, before it moves it", async () => {
    const root = worktreesRoot()
    const ran = await merged(root, true)
    succeeded(ran)
    expectLog(ran, [stoppedWith(join(root, id))])
    expect(existsSync(join(root, id))).toBe(false)
  })

  test("stops what was left in a worktree it hands to git, as one that can't be moved", async () => {
    const root = worktreesRoot()
    const ran = await merged(root, false)
    succeeded(ran)
    expectLog(ran, [stoppedWith(join(root, id))])
    expect(existsSync(join(root, id))).toBe(false)
  })
})

/** A merge queue that only puts the ticket in line. */
const lineOnly: Effect.Effect<MergeQueue, never, Ledger> = Effect.gen(function* () {
  const ledger = yield* Ledger
  return {
    offer: (finished: FinishedTicket, cause = (place: number) => Move.Verified({ place })) =>
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

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** Runs t-1's worker, which claims it and then does `then`, its worktree in `root`. */
const working = (root: string, then: (world: World) => Effect.Effect<void>) =>
  scenario(
    {
      backlog: backlog().ticket(id, { title: ticket.title }).seeds,
      worktrees: { root },
      strays: { [join(root, id)]: left },
      scripts: (world) => ({
        [id]: [
          turn([
            run(orDie(world.beads.update(id, { claim: true }))),
            run(then(world)),
          ]) as SessionScript,
        ],
      }),
    },
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const git = yield* Git
      const repository = yield* Repository
      yield* git.addWorktree(repository.dir, join(root, id), {
        branch: `tutti/${id}`,
        base: "main",
      })
      yield* ledger.transition(id, Move.Ready(), { title: ticket.title })
      yield* ledger.transition(id, Move.Dispatched())
      const queue = yield* lineOnly
      return yield* Fiber.join(yield* Effect.forkChild(work(ticket, { base: "main", queue })))
    }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<Worked, unknown, Env | Scope.Scope>,
  )

describe("a ticket's worktree removed with nothing to merge", () => {
  test("closed with no change: what was left in it is stopped before it is removed", async () => {
    const root = worktreesRoot()
    const ran = await working(root, (world) => orDie(world.beads.close(id, "nothing to do")))
    expectLog(ran, [stoppedWith(join(root, id)), /^ {2}t-1 closed with no change: .*removed$/])
    expect(ran.worktreeCalls.filter((call) => call.op === "remove")).toHaveLength(1)
  })

  test("set aside with nothing done: what was left in it is stopped before it is removed", async () => {
    const root = worktreesRoot()
    const ran = await working(root, (world) => orDie(world.beads.defer(id)))
    expectLog(ran, [stoppedWith(join(root, id))])
    expect(ran.worktreeCalls.filter((call) => call.op === "remove")).toEqual([
      { op: "remove", id, force: false },
    ])
  })
})
