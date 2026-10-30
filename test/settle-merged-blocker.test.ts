// A worker that stops with nothing done, having linked a blocker that merged after its worktree was
// cut (§ 5 item 9): its ticket goes back in the queue at once, its worktree and branch removed, to
// start again from the base's head. A blocker not merged yet still gives WAITS_FOR_MERGE; one the
// base held when the worktree was cut is no reason to start again, and the ticket is set aside as
// before.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Exit, Fiber, type Scope } from "effect"
import { Ledger } from "../src/run/ledger.ts"
import { line } from "../src/run/log.ts"
import { emptyQueue, type MergeQueue } from "../src/run/mergequeue.ts"
import { Move, type TicketPhase } from "../src/run/phase.ts"
import { type Outcome, run as runs } from "../src/run/run.ts"
import { readyPoll } from "../src/run/schedule.ts"
import type { StartTicket } from "../src/run/start.ts"
import { type Worked, work } from "../src/run/work.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import { Git, shortHash } from "../src/services/Git.ts"
import { bash, result, run, type SessionScript, sleep, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { Repository } from "../src/testing/Git.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  type Env,
  expectEvents,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  type Setup,
  scenario,
  type World,
} from "./harness.ts"

const id = "t-1" as TicketId
const blocker = "t-0" as TicketId
const ticket: StartTicket = { id, title: "One ticket", metadata: {} }

const folder = (name: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), `tutti-merged-blocker-${name}-`)))

const orDie = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  Effect.asVoid(Effect.orDie(effect))

/** A merge queue that is never offered anything: none of these tickets closes. */
const noQueue: MergeQueue = {
  offer: () => Effect.die("offered"),
  state: Effect.succeed(emptyQueue),
} as unknown as MergeQueue

/** Merges the blocker on main, as the run's merge queue does: its commit, Done{merged} in the ledger. */
const mergeBlocker = Effect.gen(function* () {
  const ledger = yield* Ledger
  const repository = yield* Repository
  const commit = yield* repository.commit(repository.dir, `Change (${blocker})`, {
    "t-0.txt": "t-0\n",
  })
  yield* (yield* Beads).close(blocker, "done")
  yield* ledger.transition(blocker, Move.Ready(), { title: "t-0" })
  yield* ledger.transition(blocker, Move.Dispatched())
  yield* ledger.transition(blocker, Move.Verified({ place: 1 }))
  yield* ledger.transition(blocker, Move.ItsTurn())
  yield* ledger.transition(blocker, Move.FastForwarded({ commit }))
})

/**
 * Runs the ticket's fiber on main in the in-memory git, its worktree cut on tutti/t-1 between
 * `before` and `after`; the commit it was cut from.
 */
const working = (
  setup: Setup & { readonly root: string },
  options: {
    readonly before?: Effect.Effect<void, unknown, Env | Ledger>
    readonly after?: Effect.Effect<void, unknown, Env | Ledger>
  },
): Promise<Ran<{ readonly worked: Worked; readonly cut: string }>> =>
  scenario(
    { ...setup, worktrees: { root: setup.root } },
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const git = yield* Git
      const repository = yield* Repository
      if (options.before !== undefined) yield* options.before
      yield* git.addWorktree(repository.dir, join(setup.root, id), {
        branch: `tutti/${id}`,
        base: "main",
      })
      const cut = yield* repository.head("main")
      if (options.after !== undefined) yield* options.after
      yield* ledger.transition(id, Move.Ready(), { title: ticket.title })
      yield* ledger.transition(id, Move.Dispatched())
      const worked = yield* work(ticket, { base: "main", queue: noQueue })
      return { worked, cut }
    }).pipe(Effect.provide(Ledger.layer)) as Effect.Effect<
      { readonly worked: Worked; readonly cut: string },
      unknown,
      Env | Scope.Scope
    >,
  )

const resultOf = <A>(ran: Ran<A>): A => {
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  return ran.exit.value
}

const phaseOf = (ran: Ran<{ readonly worked: Worked }>): TicketPhase | undefined =>
  resultOf(ran).worked.phase

/** The ticket's phase records' moves, as `from → to (cause)`. */
const movesOf = (ran: Ran<unknown>, ticket: string) =>
  ran.events.flatMap((record) =>
    record.kind === "phase" && record.ticket === ticket
      ? [`${record.from ?? "outside"} → ${record.to ?? "outside"} (${record.cause})`]
      : [],
  )

/** Its worker claims it, links the blocker, and leaves it `status` (in progress, by default). */
const links =
  (status?: string) =>
  (world: World): Readonly<Record<string, ReadonlyArray<SessionScript>>> => ({
    [id]: [
      turn([
        run(orDie(world.beads.update(id, { claim: true }))),
        run(orDie(world.beads.addDependency(id, blocker))),
        ...(status === undefined ? [] : [run(orDie(world.beads.update(id, { status })))]),
      ]),
    ],
  })

const both = backlog().ticket("t-0").ticket(id, { title: "One ticket" }).seeds

describe("a worker that stops for a blocker merged after its worktree was cut", () => {
  test("left open: back in the queue at once, its worktree and branch removed", async () => {
    const root = folder("worktrees")
    const ran = await working(
      { root, backlog: both, scripts: links("open") },
      { after: mergeBlocker },
    )
    const { cut } = resultOf(ran)
    expect(phaseOf(ran)?._tag).toBe("Queued")
    expect(movesOf(ran, id).slice(2)).toEqual(["Working → Queued (MergedSinceCut)"])
    expect(ran.worktreeCalls).toContainEqual({ op: "remove", id, force: false })
    expect(ran.issues.find((issue) => issue.id === id)?.status).toBe("open")
    expect(ran.issues.find((issue) => issue.id === id)?.notes).toContain(
      `its worktree was cut from ${shortHash(cut)}, before t-0 merged; back in the queue`,
    )
    expectLog(ran, [
      "  t-1 settled: its worker is idle",
      `  t-1 back in the queue: t-0 merged after its worktree was cut from ${shortHash(cut)}; worktree and branch removed`,
    ])
    expect(ran.log.some((text) => text.includes("WAITS_FOR_MERGE"))).toBe(false)
    expect(ran.events.filter((record) => record.kind === "waits")).toEqual([])
    expect(ran.events.filter((record) => record.kind === "queue")).not.toEqual([])
    // Not set aside: it isn't deferred, nor handed to triage.
    expect(ran.events.filter((record) => record.kind === "deferred")).toEqual([])
    expect(resultOf(ran).worked.settling).toBe("uncounted")
  })

  test("left in progress: reopened, and back in the queue", async () => {
    const root = folder("worktrees")
    const ran = await working({ root, backlog: both, scripts: links() }, { after: mergeBlocker })
    expect(phaseOf(ran)?._tag).toBe("Queued")
    expect(ran.issues.find((issue) => issue.id === id)?.status).toBe("open")
    expect(ran.worktreeCalls).toContainEqual({ op: "remove", id, force: false })
  })

  test("a blocker not merged yet: WAITS_FOR_MERGE, as before", async () => {
    const root = folder("worktrees")
    const ran = await working({ root, backlog: both, scripts: links("open") }, {})
    expect(phaseOf(ran)?._tag).toBe("Waiting")
    expect(movesOf(ran, id).slice(2)).toEqual(["Working → Waiting (WaitsForMerge)"])
    expectLog(ran, [
      "  t-1 settled: its worker is idle",
      "  WAITS_FOR_MERGE: t-1 waits for t-0 to merge; its worker stopped with nothing done, so it is back in the queue until it does; worktree and branch removed",
    ])
  })

  test("a blocker merged before the cut: no reason to start again, set aside as before", async () => {
    const root = folder("worktrees")
    const ran = await working(
      { root, backlog: both, scripts: links("open") },
      { before: mergeBlocker },
    )
    expect(phaseOf(ran)).toEqual(
      expect.objectContaining({ _tag: "Deferred", why: "still open, noted for review" }),
    )
    expect(ran.log.some((text) => text.includes("back in the queue"))).toBe(false)
  })

  test("with work of its own, a blocker merged after the cut doesn't put it back", async () => {
    const root = folder("worktrees")
    const ran = await working(
      {
        root,
        backlog: both,
        scripts: (world) => ({
          [id]: [
            turn([
              run(orDie(world.beads.update(id, { claim: true }))),
              run(orDie(world.repository.write(join(root, id), { "half.txt": "half\n" }))),
              run(orDie(world.beads.addDependency(id, blocker))),
              run(orDie(world.beads.update(id, { status: "open" }))),
            ]),
          ],
        }),
      },
      { after: mergeBlocker },
    )
    expect(phaseOf(ran)?._tag).toBe("Deferred")
  })
})

// The whole run: the ticket starts again and merges, and counts toward --limit once.

/** Waits, in real time, until the run has written no log line or record for 30 ms. */
const caughtUp = Effect.gen(function* () {
  const captured = yield* Captured
  let said = -1
  for (let i = 0, still = 0; i < 1000 && still < 6; i++) {
    const now = (yield* texts).length + (yield* captured.records).length
    still = now === said ? still + 1 : 0
    said = now
    yield* Effect.promise(() => Bun.sleep(5))
  }
})

/** Moves TestClock on by `total`, a ready poll at a time, once the run has caught up each time. */
const passes = (total: Duration.Input) =>
  Effect.gen(function* () {
    const polls = Duration.toMillis(Duration.fromInputUnsafe(total)) / Duration.toMillis(readyPoll)
    for (let i = 0; i < polls; i++) {
      yield* caughtUp
      yield* advance(readyPoll)
    }
  })

/** Claims its ticket, waits `takes`, commits a file and closes it. */
const works = (world: World, root: string, ticket: TicketId, takes: Duration.Input = 0) =>
  turn(
    [
      ...bash(`bd update ${ticket} --claim`, orDie(world.beads.update(ticket, { claim: true }))),
      sleep(takes),
      ...bash(
        `git commit -am "Change (${ticket})"`,
        orDie(
          world.repository.commit(join(root, ticket), `Change (${ticket})`, {
            [`${ticket}.txt`]: `${ticket}\n`,
          }),
        ),
      ),
      ...bash(`bd close ${ticket}`, orDie(world.beads.close(ticket, "done"))),
    ],
    result(`Closed ${ticket}.`),
  )

/** Claims its ticket, waits `takes`, links `on` as its blocker and stops with it open. */
const needs = (world: World, ticket: TicketId, on: TicketId, takes: Duration.Input) =>
  turn(
    [
      ...bash(`bd update ${ticket} --claim`, orDie(world.beads.update(ticket, { claim: true }))),
      sleep(takes),
      ...bash(`bd dep add ${ticket} ${on}`, orDie(world.beads.addDependency(ticket, on))),
      ...bash(
        `bd update ${ticket} --status open`,
        orDie(world.beads.update(ticket, { status: "open" })),
      ),
    ],
    result(`${ticket} needs ${on}'s work first.`),
  )

describe("in a whole run", () => {
  test("the ticket starts again once its blocker merged, and counts toward --limit once", async () => {
    // b's worktree is cut as the run starts; a merges at 1m; at 2m b's worker finds it needs a's
    // work, links a and stops with nothing done.
    const repo = folder("repo")
    const root = folder("worktrees")
    const defaults = appConfig().settings
    const ran = await scenario(
      {
        config: {
          repo,
          worktrees: root,
          limit: 2,
          settings: {
            ...defaults,
            concurrent: 2,
            checks: {
              ...defaults.checks,
              fast: { ...defaults.checks.fast, command: "scripts/check-fast.sh" },
            },
          },
        },
        backlog: backlog().ticket("a", { priority: 0 }).ticket("b", { priority: 1 }).seeds,
        git: { dir: repo, files: { "README.md": "tutti\n" } },
        worktrees: { root },
        scripts: (world: World) => ({
          a: [works(world, root, "a" as TicketId, "1 minute")],
          b: [
            needs(world, "b" as TicketId, "a" as TicketId, "2 minutes"),
            works(world, root, "b" as TicketId),
          ],
        }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        for (const each of ["a", "b"]) {
          yield* git.addWorktree(repo, join(root, each), { branch: `tutti/${each}`, base: "main" })
        }
        const cut = yield* (yield* Repository).head("main")
        const fiber = yield* Effect.forkChild(
          runs({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
        )
        yield* passes("3 minutes")
        const outcome: Outcome = yield* Fiber.join(fiber)
        return { outcome, cut }
      }),
    )
    const { cut } = resultOf(ran)
    expectExitCode({ ...ran, exit: Exit.map(ran.exit, (value) => value.outcome) }, 0)
    expect(ran.log.filter((text) => text.includes("PHASE_BUG"))).toEqual([])
    expectPhases(
      { ...ran, exit: Exit.map(ran.exit, (value) => value.outcome) },
      {
        a: "Done",
        b: "Done",
      },
    )
    expect(movesOf(ran, "b")).toEqual([
      "outside → Queued (Ready)",
      "Queued → Working (Dispatched)",
      "Working → Queued (MergedSinceCut)",
      "Queued → Working (Dispatched)",
      "Working → ToMerge (Verified)",
      "ToMerge → Merging (ItsTurn)",
      "Merging → Done (FastForwarded)",
    ])
    const closed = (ticket: string) =>
      new RegExp(
        `^ {2}${ticket} closed \\([0-9a-f]{7} .*\\); merged into main, worktree and branch removed$`,
      )
    expectLog(ran, [
      "[1/2] a dispatching: a",
      "[2/2] b dispatching: b",
      closed("a"),
      "  b settled: its worker is idle",
      `  b back in the queue: a merged after its worktree was cut from ${shortHash(cut)}; worktree and branch removed`,
      // It counts toward --limit once, as it starts again.
      "[2/2] b dispatching: b",
      closed("b"),
      "LIMIT_REACHED at 2 tickets",
    ])
    expectEvents(ran, ["dispatch", "dispatch", "closed", "queue", "dispatch", "closed", "end"])
    // Its worktree held nothing: removed, and made again from the base's head as it started again.
    expect(ran.worktreeCalls.filter((call) => "id" in call && call.id === "b")).toEqual([
      { op: "prepare", id: "b" as TicketId },
      { op: "remove", id: "b" as TicketId, force: false },
      { op: "prepare", id: "b" as TicketId },
      { op: "remove", id: "b" as TicketId, force: false, aside: true },
    ])
  }, 30_000)
})
