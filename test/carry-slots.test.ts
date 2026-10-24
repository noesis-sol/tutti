// A resumed or carried-over worker takes a slot only when one is free (§ 5's Scheduling, § 4.8's
// The next run): the scheduler's carry checks the slots, the run's holds and the machine's cap
// (its `taking`), the wind-down and a solo ticket as a dispatch does, but no --limit. One with no
// slot for it waits: a carried-over worker in state.json, an answered ticket Asked, each taken up
// at a later look once a slot frees.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber, Layer, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"
import { askedWhy, questionKey } from "../src/run/carry.ts"
import type { EventRecord } from "../src/run/events.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import { type Gate, openGate } from "../src/run/holds.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { Log } from "../src/run/log.ts"
import type { Room } from "../src/run/machineGate.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { make, readyPoll, type Scheduler } from "../src/run/schedule.ts"
import { Beads, type Issue } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import type { TicketRecord } from "../src/services/Store.ts"
import { bash, type SessionScript, sleep, turn } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { type Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"
import {
  advance,
  backlog,
  expectExitCode,
  expectLog,
  expectPhases,
  type Ran,
  scenario,
  type World,
} from "./harness.ts"

type Env = Beads | Backlog | Ledger | Log | EventStream | RunFibers | Scope.Scope

/** Runs `effect` in a scope over the in-memory backlog with `seeds`, under TestClock. */
const inMemory = <A, E>(seeds: ReadonlyArray<Seed>, effect: Effect.Effect<A, E, Env>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(beadsLayer(seeds), ledgerLayer(), runFibersLayer).pipe(
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

/** Lets forked fibers run, without moving the clock. */
const flush = Effect.gen(function* () {
  for (let i = 0; i < 50; i++) yield* Effect.yieldNow
})

/**
 * A scheduler whose dispatched tickets run until the test ends, and a carry whose worker runs
 * until `done` is completed: `carry(id)` says whether it took a slot, `started` the workers it
 * readied.
 */
const scheduler = (options: {
  readonly concurrent: number
  readonly limit?: number
  readonly gate?: Effect.Effect<Gate>
  readonly room?: (own: number) => Effect.Effect<Room>
  readonly carrying?: Effect.Effect<ReadonlySet<string>>
}) =>
  Effect.gen(function* () {
    const started: Array<string> = []
    const schedule: Scheduler = yield* make({
      concurrent: options.concurrent,
      limit: options.limit ?? 40,
      scope: null,
      excludeTypes: ["epic"],
      ...(options.gate === undefined ? {} : { gate: options.gate }),
      ...(options.room === undefined ? {} : { room: options.room }),
      ...(options.carrying === undefined ? {} : { carrying: options.carrying }),
      start: {
        start: (issue: Issue) => Effect.sync(() => void started.push(`dispatched ${issue.id}`)),
      },
    })
    const done = yield* Deferred.make<void>()
    const carry = (id: string, issue?: Issue) =>
      schedule.carry(
        id,
        Effect.sync(() => {
          started.push(`carried ${id}`)
          return Deferred.await(done)
        }),
        issue,
      )
    return { schedule, carry, started, done }
  })

describe("the scheduler's carry", () => {
  test("takes a free slot, counting toward no limit, and none when every slot is taken", async () => {
    const seen = await inMemory(
      [],
      Effect.gen(function* () {
        const { schedule, carry, started } = yield* scheduler({ concurrent: 2, limit: 1 })
        const took = [yield* carry("c-1"), yield* carry("c-2"), yield* carry("c-3")]
        return { took, started, count: yield* schedule.started, slots: yield* schedule.slots }
      }),
    )
    expect(seen.took).toEqual([true, true, false])
    // The third's worker isn't readied: its session would start beside the two.
    expect(seen.started).toEqual(["carried c-1", "carried c-2"])
    expect(seen.count).toBe(0)
    expect(seen.slots).toBe(2)
  })

  test("takes the slot one frees as its worker ends", async () => {
    const seen = await inMemory(
      [],
      Effect.gen(function* () {
        const { carry, started, done } = yield* scheduler({ concurrent: 1 })
        const first = yield* carry("c-1")
        const waiting = yield* carry("c-2")
        yield* Deferred.succeed(done, undefined)
        yield* flush
        return { first, waiting, after: yield* carry("c-2"), started }
      }),
    )
    expect(seen).toEqual({
      first: true,
      waiting: false,
      after: true,
      started: ["carried c-1", "carried c-2"],
    })
  })

  test("takes none while the run doesn't take tickets: a hold, or the machine's cap", async () => {
    const seen = await inMemory(
      [],
      Effect.gen(function* () {
        const gate = yield* Ref.make<Gate>({ ...openGate, usageHeld: true })
        const room = yield* Ref.make(false)
        const { carry, started } = yield* scheduler({
          concurrent: 3,
          gate: Ref.get(gate),
          room: () => Effect.map(Ref.get(room), (has): Room => (has ? "room" : "held")),
        })
        const held = yield* carry("c-1")
        yield* Ref.set(gate, openGate)
        const full = yield* carry("c-1")
        yield* Ref.set(room, true)
        return { held, full, after: yield* carry("c-1"), started }
      }),
    )
    expect(seen).toEqual({ held: false, full: false, after: true, started: ["carried c-1"] })
  })

  test("takes none while the run winds down", async () => {
    const seen = await inMemory(
      [],
      Effect.gen(function* () {
        const { carry, started } = yield* scheduler({ concurrent: 3 })
        const ledger = yield* Ledger
        yield* ledger.windDown
        const wound = yield* carry("c-1")
        yield* ledger.windUp
        return { wound, after: yield* carry("c-1"), started }
      }),
    )
    expect(seen).toEqual({ wound: false, after: true, started: ["carried c-1"] })
  })

  test("takes none beside a solo ticket, and a solo one only with nothing else running", async () => {
    const seen = await inMemory(
      [
        { id: "s-1", labels: ["solo"], status: "in_progress" },
        { id: "s-2", labels: ["solo"], status: "in_progress" },
      ],
      Effect.gen(function* () {
        const beads = yield* Beads
        const solo1 = yield* beads.show("s-1")
        const solo2 = yield* beads.show("s-2")
        const { carry, started } = yield* scheduler({ concurrent: 3 })
        const soloFirst = yield* carry("s-1", solo1)
        const beside = yield* carry("c-1")
        const { carry: carryElsewhere } = yield* scheduler({ concurrent: 3 })
        const plain = yield* carryElsewhere("c-2")
        const soloBeside = yield* carryElsewhere("s-2", solo2)
        return { soloFirst, beside, plain, soloBeside, started }
      }),
    )
    expect(seen.soloFirst).toBe(true)
    expect(seen.beside).toBe(false)
    expect(seen.plain).toBe(true)
    expect(seen.soloBeside).toBe(false)
    expect(seen.started).toEqual(["carried s-1"])
  })

  test("a fill dispatches none of the tickets whose carried-over workers wait for a slot", async () => {
    const started = await inMemory(
      [{ id: "t-1" }, { id: "t-2" }],
      Effect.gen(function* () {
        const { schedule, started } = yield* scheduler({
          concurrent: 3,
          carrying: Effect.succeed(new Set(["t-1"])),
        })
        yield* schedule.fill
        yield* flush
        return started
      }),
    )
    expect(started).toEqual(["dispatched t-2"])
  })
})

const defaults = appConfig().settings

/** A new folder, its real path: the main checkout's, or the worktrees'. */
const folder = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `tutti-slots-${name}-`)))

/** What the last run saved of a ticket, its worktree under `root`: suspended by a quit. */
const savedRecord = (
  root: string,
  id: string,
  fields: Partial<TicketRecord> = {},
): TicketRecord => ({
  session: `session-${id}`,
  worktree: join(root, id),
  branch: `tutti/${id}`,
  suspended: "quit",
  phase: "Stopped",
  resumes: 0,
  metadata: {},
  ...fields,
})

/**
 * Claims the ticket, works for a ready poll's time, then commits a change naming it and closes it,
 * in its worktree under `root`.
 */
const finishes = (world: World, root: string, id: string): SessionScript => {
  const orDie = <A, E>(effect: Effect.Effect<A, E>) => Effect.asVoid(Effect.orDie(effect))
  return turn([
    ...bash(`bd update ${id} --claim`, orDie(world.beads.update(id, { claim: true }))),
    sleep(readyPoll),
    ...bash(
      `git commit -am "Change (${id})"`,
      orDie(world.repository.commit(join(root, id), `Change (${id})`, { [`${id}.txt`]: "x\n" })),
    ),
    ...bash(`bd close ${id}`, orDie(world.beads.close(id, "done"))),
  ])
}

/**
 * A whole plain run with one slot, after an earlier run that left `saved` in state.json, each
 * of `ids` with its worktree and a worker that finishes its ticket. The clock stands still until
 * `holder`'s worker is resumed and carry-over is over, its worker holding the slot meanwhile;
 * then it moves on a ready poll at a time until the run ends.
 */
const runs = async (
  seeds: ReadonlyArray<Seed>,
  ids: ReadonlyArray<string>,
  holder: string,
  saved: (root: string) => Readonly<Record<string, TicketRecord>>,
): Promise<Ran<Outcome>> => {
  const repo = folder("repo")
  const root = folder("worktrees")
  return scenario(
    {
      backlog: seeds,
      config: { repo, settings: { ...defaults, concurrent: 1 } },
      git: { dir: repo },
      worktrees: { root },
      state: { version: 1, tickets: saved(root) },
      scripts: (world: World) =>
        Object.fromEntries(ids.map((id) => [id, [finishes(world, root, id)]])),
    },
    Effect.gen(function* () {
      const git = yield* Git
      for (const id of ids) {
        mkdirSync(join(root, id), { recursive: true })
        yield* git.addWorktree(repo, join(root, id), { branch: `tutti/${id}`, base: "main" })
      }
      const fiber = yield* Effect.forkChild(
        Effect.scoped(run({ version: "0.1.0-test", base: "main" })),
      )
      const resumed = `RESUMED: ${holder} `
      for (let i = 0; i < 2000; i++) {
        if ((yield* texts).some((each) => each.includes(resumed))) break
        yield* Effect.promise(() => Bun.sleep(5))
      }
      yield* Effect.promise(() => Bun.sleep(50))
      for (let i = 0; i < 200 && fiber.pollUnsafe() === undefined; i++) {
        yield* advance(readyPoll)
        yield* Effect.promise(() => Bun.sleep(5))
      }
      return yield* Fiber.join(fiber)
    }),
  )
}

/**
 * The run's records, in order, as `<kind> <ticket>` for the resumes and `<to> <ticket>` for each
 * ticket's moves into Working and ToMerge.
 */
const steps = (ran: Ran<unknown>) =>
  ran.events.flatMap((record: EventRecord) =>
    record.kind === "resumed"
      ? [`resumed ${record.ticket}`]
      : record.kind === "phase" && (record.to === "Working" || record.to === "ToMerge")
        ? [`${record.to} ${record.ticket}`]
        : [],
  )

describe("with one slot", () => {
  test("a run resumes its suspended workers one at a time", async () => {
    const ran = await runs(
      backlog().ticket("t-1", { status: "in_progress" }).ticket("t-2", { status: "in_progress" })
        .seeds,
      ["t-1", "t-2"],
      "t-1",
      (root) => ({ "t-1": savedRecord(root, "t-1"), "t-2": savedRecord(root, "t-2") }),
    )
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done" })
    // t-2 waited for t-1's slot: resumed once t-1's worker had left its ticket to merge.
    expect(steps(ran)).toEqual([
      "Working t-1",
      "resumed t-1",
      "ToMerge t-1",
      "Working t-2",
      "resumed t-2",
      "ToMerge t-2",
    ])
    expect(ran.events.filter((record) => record.kind === "dispatch")).toEqual([])
    expectLog(ran, ["  t-2, carried over from the last run, waits for a free slot to be resumed"])
  })

  test("an answered ticket waits Asked for the slot a resumed worker holds", async () => {
    const ran = await runs(
      backlog()
        .ticket("q-1", { labels: ["human"], title: "Which way?", status: "closed" })
        .ticket("t-1", { blockedBy: ["q-1"] })
        .ticket("t-2", { status: "in_progress" }).seeds,
      ["t-1", "t-2"],
      "t-2",
      (root) => ({
        "t-1": savedRecord(root, "t-1", {
          suspended: askedWhy,
          phase: "Asked",
          metadata: { [questionKey]: "q-1" },
        }),
        "t-2": savedRecord(root, "t-2"),
      }),
    )
    expectExitCode(ran, 0)
    expectPhases(ran, { "t-1": "Done", "t-2": "Done" })
    expect(steps(ran)).toEqual([
      "Working t-2",
      "resumed t-2",
      "ToMerge t-2",
      "Working t-1",
      "resumed t-1",
      "ToMerge t-1",
    ])
  })
})
