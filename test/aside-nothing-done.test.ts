// A ticket set aside as its worker settled with nothing done (no commits beyond the base, a clean
// worktree) has its worktree and branch removed once triage has its evidence; one with commits or
// changes keeps both, for review (aside.ts, as orchestra 0.8.1's dropNothingDone).
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Fiber, Layer, type Scope, Stream } from "effect"
import { dropNothingDone } from "../src/run/aside.ts"
import { makeHandBacks } from "../src/run/handback.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { FinishedTicket } from "../src/run/merge.ts"
import { emptyQueue, type MergeQueue } from "../src/run/mergequeue.ts"
import { Cause } from "../src/run/phase.ts"
import { makeRechecks } from "../src/run/recheck.ts"
import type { StartTicket } from "../src/run/start.ts"
import type { Deferral, Triage } from "../src/run/triage.ts"
import { type Worked, work } from "../src/run/work.ts"
import { Git, GitFailed } from "../src/services/Git.ts"
import { Worktrees } from "../src/services/Worktrees.ts"
import { run, type SessionScript, turn } from "../src/testing/AgentHost.ts"
import { Repository } from "../src/testing/Git.ts"
import {
  backlog,
  type Env,
  expectLog,
  type Ran,
  type Scripts,
  type Setup,
  scenario,
  type World,
} from "./harness.ts"

const id = "t-1"
const ticket: StartTicket = { id, title: "One ticket", metadata: {} }
const tiny = backlog().ticket(id, { title: "One ticket" })

const worktreesRoot = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-aside-nothing-")))

/** A merge queue that only puts the ticket in line. */
const lineOnly: Effect.Effect<MergeQueue, never, Ledger> = Effect.gen(function* () {
  const ledger = yield* Ledger
  return {
    offer: (finished: FinishedTicket, cause = (place: number) => Cause.Verified({ place })) =>
      ledger.transition(finished.id, cause(1)),
    state: Effect.succeed(emptyQueue),
    changes: undefined as never,
    settled: Effect.succeed(emptyQueue),
    rechecks: yield* makeRechecks,
    handBacks: yield* makeHandBacks,
    recheck: Effect.succeed([]),
    mergedByHand: Effect.succeed([]),
    hold: Effect.void,
    stopMerges: Effect.void,
  } satisfies MergeQueue
})

/** What triage was handed, and whether the ticket's worktree was still there as it was. */
interface Handed {
  readonly deferral: Deferral
  readonly worktreeThere: boolean
}

/** A triage that notes each ticket handed to it, and whether its worktree was there then. */
const noting = (handed: Array<Handed>): Triage => ({
  deferred: (deferral) =>
    Effect.sync(() => {
      handed.push({ deferral, worktreeThere: existsSync(deferral.worktree) })
    }),
  pending: Effect.succeed(0),
  verdicts: Stream.succeed(new Map()),
  interrupt: Effect.void,
})

/** Dispatches the ticket and runs its fiber on main, its worktree in `root`, triage `triage`. */
const working = (setup: Setup & { readonly root: string }, triage?: Triage): Promise<Ran<Worked>> =>
  scenario(
    { ...setup, worktrees: { root: setup.root } },
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const git = yield* Git
      const repository = yield* Repository
      yield* git.addWorktree(repository.dir, join(setup.root, id), {
        branch: `tutti/${id}`,
        base: "main",
      })
      yield* ledger.transition(id, Cause.Ready(), { title: ticket.title })
      yield* ledger.transition(id, Cause.Dispatched())
      const queue = yield* lineOnly
      const fiber = yield* Effect.forkChild(
        work(ticket, { base: "main", queue, ...(triage === undefined ? {} : { triage }) }),
      )
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<Worked, unknown, Env | Scope.Scope>,
  )

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** The worker's session, made from what its commands do to the in-memory Beads and git. */
const session =
  (root: string, steps: (world: World, path: string) => ReadonlyArray<Effect.Effect<void>>) =>
  (world: World): Scripts => ({
    [id]: [
      turn([
        run(orDie(world.beads.update(id, { claim: true }))),
        ...steps(world, join(root, id)).map((step) => run(step)),
      ]) as SessionScript,
    ],
  })

const defer = (world: World) => orDie(world.beads.defer(id))
const reopen = (world: World) => orDie(world.beads.update(id, { status: "open" }))
const commit = (world: World, path: string) =>
  orDie(world.repository.commit(path, "Part of it", { "a.txt": "a\n" }))
const write = (world: World, path: string) =>
  orDie(world.repository.write(path, { "a.txt": "a\n" }))

const removals = (ran: Ran<unknown>) => ran.worktreeCalls.filter((call) => call.op === "remove")
const notesOf = (ran: Ran<unknown>) => ran.issues.find((issue) => issue.id === id)?.notes ?? ""

describe("a ticket set aside with nothing done", () => {
  test("deferred by its worker: its worktree and branch removed, after triage's evidence", async () => {
    const root = worktreesRoot()
    const handed: Array<Handed> = []
    const ran = await working(
      { root, backlog: tiny.seeds, scripts: session(root, (world) => [defer(world)]) },
      noting(handed),
    )
    expectLog(ran, [
      `  ${id} deferred by its worker; nothing done, so its worktree and branch are removed`,
    ])
    expect(removals(ran)).toEqual([{ op: "remove", id, force: false }])
    expect(existsSync(join(root, id))).toBe(false)
    expect(handed).toEqual([
      { deferral: expect.objectContaining({ ticket: id }), worktreeThere: true },
    ])
  })

  test("left open: deferred by tutti, its note and line saying nothing was done, then removed", async () => {
    const root = worktreesRoot()
    const ran = await working({
      root,
      backlog: tiny.seeds,
      scripts: session(root, (world) => [reopen(world)]),
    })
    expectLog(ran, [
      `  ${id} still open -> noted and deferred; nothing done, so its worktree and branch are removed`,
    ])
    expect(notesOf(ran)).toContain(
      "tutti: its worker settled with the ticket still 'open' and nothing done (no commits, no changes); deferred for review, its worktree and branch removed.",
    )
    expect(ran.issues.find((issue) => issue.id === id)?.status).toBe("deferred")
    expect(removals(ran)).toEqual([{ op: "remove", id, force: false }])
  })

  test("removed without triage too", async () => {
    const root = worktreesRoot()
    const ran = await working({
      root,
      backlog: tiny.seeds,
      scripts: session(root, (world) => [defer(world)]),
    })
    expect(removals(ran)).toEqual([{ op: "remove", id, force: false }])
  })
})

describe("a ticket set aside with work of its own", () => {
  test("deferred by its worker after a commit: worktree and branch kept", async () => {
    const root = worktreesRoot()
    const handed: Array<Handed> = []
    const ran = await working(
      {
        root,
        backlog: tiny.seeds,
        scripts: session(root, (world, path) => [commit(world, path), defer(world)]),
      },
      noting(handed),
    )
    expectLog(ran, [`  ${id} deferred by its worker; worktree ${join(root, id)} left open`])
    expect(removals(ran)).toEqual([])
    expect(existsSync(join(root, id))).toBe(true)
    expect(handed).toHaveLength(1)
  })

  test("left open with uncommitted changes: worktree and branch kept for review", async () => {
    const root = worktreesRoot()
    const ran = await working({
      root,
      backlog: tiny.seeds,
      scripts: session(root, (world, path) => [write(world, path), reopen(world)]),
    })
    expectLog(ran, [
      `  ${id} still open -> noted and deferred; worktree ${join(root, id)} left open`,
    ])
    expect(notesOf(ran)).toContain(`deferred for review (worktree ${join(root, id)}).`)
    expect(removals(ran)).toEqual([])
  })
})

describe("dropNothingDone", () => {
  test("a removal git refuses is CLEANUP_FAILED, in the log and a warn record", async () => {
    const refusing = Layer.succeed(
      Worktrees,
      Worktrees.of({
        remove: () =>
          Effect.fail(
            new GitFailed({
              op: "worktree remove",
              command: "git worktree remove",
              exitCode: 128,
              stderr: "fatal: cannot remove a locked working tree\n",
            }),
          ),
      } as unknown as Worktrees["Service"]),
    )
    const ran = await scenario(
      {},
      dropNothingDone({ id, path: "/w/t-1", branch: "tutti/t-1" }).pipe(Effect.provide(refusing)),
    )
    expect(Exit.isSuccess(ran.exit)).toBe(true)
    const text =
      "  CLEANUP_FAILED for /w/t-1 / tutti/t-1: fatal: cannot remove a locked working tree"
    expectLog(ran, [text])
    expect(ran.events).toContainEqual(expect.objectContaining({ kind: "warn", ticket: id, text }))
  })
})
