// The scheduler's operations tested alone, over its state record (src/run/schedule/state.ts):
// placing a waiting ticket (placeWaiting), whether a dispatch may start (mayStart), and taking
// and freeing a slot (occupy).
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer, Queue, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"
import type { EventRecord } from "../src/run/events.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import { openGate } from "../src/run/holds.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { Log } from "../src/run/log.ts"
import type { Room } from "../src/run/machineGate.ts"
import { Move, type TicketPhase } from "../src/run/phase.ts"
import { mayStart } from "../src/run/schedule/dispatch.ts"
import { placeWaiting } from "../src/run/schedule/place.ts"
import { current, occupy, slotsNow } from "../src/run/schedule/slots.ts"
import { scheduling } from "../src/run/schedule/state.ts"
import type { Options } from "../src/run/schedule.ts"
import { Beads, type Issue, type TicketId } from "../src/services/Beads.ts"
import { type Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"

type Env = Beads | Backlog | Ledger | Log | EventStream | Captured | RunFibers | Scope.Scope

const layers = (seeds: ReadonlyArray<Seed>) =>
  Layer.mergeAll(beadsLayer(seeds), ledgerLayer(), runFibersLayer).pipe(
    Layer.provideMerge(TestClock.layer()),
  )

const run = <A, E>(seeds: ReadonlyArray<Seed>, effect: Effect.Effect<A, E, Env>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(layers(seeds))))

/** Lets forked fibers run, without moving the clock. */
const flush = Effect.gen(function* () {
  for (let i = 0; i < 50; i++) yield* Effect.yieldNow
})

const t1 = "t-1" as TicketId
const t2 = "t-2" as TicketId

/** The scheduler's state with `concurrent` slots, its tickets' fibers never ending on their own. */
const state = (options: Partial<Options> = {}) =>
  scheduling({
    concurrent: 1,
    limit: 40,
    scope: null,
    excludeTypes: ["epic"],
    start: { start: () => Effect.never },
    ...options,
  })

/** Queues the ticket in the ledger, as a fill does, with its issue as bd has it. */
const queued = (id: TicketId) =>
  Effect.gen(function* () {
    const issue = yield* (yield* Beads).show(id)
    yield* (yield* Ledger).transition(id, Move.Ready(), { title: issue.title, issue })
    return issue
  })

const phaseOf = (id: TicketId) =>
  Effect.map(
    Effect.flatMap(Ledger, (ledger) => ledger.current),
    (state): TicketPhase | undefined => state.tickets.get(id)?.phase,
  )

const records = Effect.flatMap(Captured, (captured) => captured.records)

/** Each record as `<ticket>:<phase>` for a phase record, `queue <n> held <m>` for a queue record. */
const shape = (all: ReadonlyArray<EventRecord>) =>
  all.map((record) =>
    record.kind === "phase"
      ? `${record.ticket}:${record.to}`
      : record.kind === "queue"
        ? `queue ${record.queued} held ${record.held ?? 0}`
        : record.kind,
  )

describe("placeWaiting", () => {
  test("holds a Queued ticket back for its reason, with a queue record, and leaves it so again", async () => {
    const [phase, before, after] = await run(
      [{ id: "t-1" }, { id: "t-2" }],
      Effect.gen(function* () {
        const sched = yield* state()
        yield* queued(t1)
        yield* queued(t2)
        const was = (yield* records).length
        yield* placeWaiting(sched, t1, "solo", [t1, t2])
        const before = (yield* records).slice(was)
        yield* placeWaiting(sched, t1, "solo", [t1, t2])
        const after = (yield* records).slice(was)
        return [yield* phaseOf(t1), before, after] as const
      }),
    )
    expect(phase).toEqual({ _tag: "HeldBack", why: "solo" })
    expect(shape(before)).toEqual(["t-1:HeldBack", "queue 1 held 1"])
    expect(after).toEqual(before)
    expect(before[1]).toMatchObject({ kind: "queue", queued: 1, held: 1, held_by: { solo: 1 } })
  })

  test("releases a ticket held for another reason before holding it for the new one", async () => {
    const [phase, all] = await run(
      [{ id: "t-1" }],
      Effect.gen(function* () {
        const sched = yield* state()
        yield* queued(t1)
        yield* placeWaiting(sched, t1, "merge", [t1])
        const was = (yield* records).length
        yield* placeWaiting(sched, t1, "overlap", [t1])
        return [yield* phaseOf(t1), (yield* records).slice(was)] as const
      }),
    )
    expect(phase).toEqual({ _tag: "HeldBack", why: "overlap" })
    expect(shape(all)).toEqual(["t-1:Queued", "queue 1 held 0", "t-1:HeldBack", "queue 0 held 1"])
  })

  test("releases a held ticket to Queued for no reason, and leaves a Queued one as it is", async () => {
    const [phase, all] = await run(
      [{ id: "t-1" }],
      Effect.gen(function* () {
        const sched = yield* state()
        yield* queued(t1)
        yield* placeWaiting(sched, t1, "parent", [t1])
        const was = (yield* records).length
        yield* placeWaiting(sched, t1, undefined, [t1])
        yield* placeWaiting(sched, t1, undefined, [t1])
        return [yield* phaseOf(t1), (yield* records).slice(was)] as const
      }),
    )
    expect(phase).toEqual({ _tag: "Queued" })
    expect(shape(all)).toEqual(["t-1:Queued", "queue 1 held 0"])
  })

  test("leaves a ticket not in the ledger alone, writing nothing", async () => {
    const [phase, all] = await run(
      [{ id: "t-1" }],
      Effect.gen(function* () {
        const sched = yield* state()
        yield* placeWaiting(sched, t1, "solo", [t1])
        return [yield* phaseOf(t1), yield* records] as const
      }),
    )
    expect(phase).toBeUndefined()
    expect(all).toEqual([])
  })
})

describe("mayStart", () => {
  test("lets a dispatch start with a slot free and the gate open, after beforeStart", async () => {
    const [may, ran] = await run(
      [],
      Effect.gen(function* () {
        const ran = yield* Ref.make(0)
        const sched = yield* state({ beforeStart: Ref.update(ran, (n) => n + 1) })
        return [yield* mayStart(sched), yield* Ref.get(ran)] as const
      }),
    )
    expect(may).toBe(true)
    expect(ran).toBe(1)
  })

  test("refuses with every slot taken, before beforeStart or the gate are read", async () => {
    const [may, ran, read] = await run(
      [{ id: "t-1" }],
      Effect.gen(function* () {
        const ran = yield* Ref.make(0)
        const read = yield* Ref.make(0)
        const sched = yield* state({
          beforeStart: Ref.update(ran, (n) => n + 1),
          gate: Effect.as(
            Ref.update(read, (n) => n + 1),
            openGate,
          ),
        })
        yield* occupy(sched, t1, Effect.never)
        return [yield* mayStart(sched), yield* Ref.get(ran), yield* Ref.get(read)] as const
      }),
    )
    expect(may).toBe(false)
    expect(ran).toBe(0)
    expect(read).toBe(0)
  })

  test("refuses while the gate holds, the run winding down", async () => {
    const may = await run(
      [],
      Effect.gen(function* () {
        const sched = yield* state()
        yield* (yield* Ledger).windDown
        return yield* mayStart(sched)
      }),
    )
    expect(may).toBe(false)
  })

  test("refuses when the machine has no room, with a queue record as the hold begins", async () => {
    const [may, asked, all] = await run(
      [],
      Effect.gen(function* () {
        const asked = yield* Ref.make<ReadonlyArray<number>>([])
        const rooms: Array<Room> = ["began", "held", "lifted"]
        const sched = yield* state({
          room: (own) =>
            Effect.as(
              Ref.update(asked, (all) => [...all, own]),
              rooms.shift() ?? "room",
            ),
        })
        const first = yield* mayStart(sched)
        const second = yield* mayStart(sched)
        const third = yield* mayStart(sched)
        return [[first, second, third], yield* Ref.get(asked), yield* records] as const
      }),
    )
    expect(may).toEqual([false, false, true])
    expect(asked).toEqual([0, 0, 0])
    expect(shape(all)).toEqual(["queue 0 held 0", "queue 0 held 0"])
  })
})

describe("occupy", () => {
  test("takes a slot while the work runs, keeps the issue, and frees it as the work ends", async () => {
    const [taken, issues, after, woken] = await run(
      [{ id: "t-1", labels: ["solo"] }],
      Effect.gen(function* () {
        const sched = yield* state({ concurrent: 2 })
        const issue: Issue = yield* (yield* Beads).show(t1)
        const done = yield* Deferred.make<void>()
        yield* occupy(sched, t1, Deferred.await(done), issue)
        const taken = yield* slotsNow(sched)
        const { s } = yield* current(sched)
        yield* Deferred.succeed(done, undefined)
        yield* flush
        const after = yield* current(sched)
        const woken = yield* Queue.poll(sched.freed)
        return [taken, s, after.s, woken] as const
      }),
    )
    expect(taken).toBe(1)
    expect([...issues.running]).toEqual([t1])
    expect(issues.solo).toBe(t1)
    expect(issues.issues.get(t1)?.id).toBe(t1)
    expect([...after.running]).toEqual([])
    expect(after.solo).toBeNull()
    expect(after.issues.size).toBe(0)
    expect(woken._tag).toBe("Some")
  })

  test("gives a counted ticket's start back when its fiber ends with it back in the queue", async () => {
    const started = await run(
      [{ id: "t-1" }],
      Effect.gen(function* () {
        const sched = yield* state()
        yield* queued(t1)
        yield* (yield* Ledger).transition(t1, Move.Dispatched())
        yield* Ref.update(sched.slots, (s) => ({ ...s, started: 1 }))
        const done = yield* Deferred.make<void>()
        yield* occupy(sched, t1, Deferred.await(done), undefined, true)
        // Back in the queue until its blocker merges: its start counts again as it starts again.
        yield* (yield* Ledger).transition(t1, Move.WaitsForMerge({ blockers: [t2] }))
        yield* Deferred.succeed(done, undefined)
        yield* flush
        return (yield* Ref.get(sched.slots)).started
      }),
    )
    expect(started).toBe(0)
  })
})
