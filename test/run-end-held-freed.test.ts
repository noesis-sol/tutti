// A ticket held back for another, whose fiber ends while the fill reads the holds (look.ts,
// runEnd.ts): the real scheduler, wakes and loop, over the test layers of Beads and the Ledger. The
// fill picks with the slots as it read them before its reads, so the held ticket is placed HeldBack
// again with nothing running; the run looks again at the freed wake rather than end, and starts it.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"
import type { Log } from "../src/core/log.ts"
import { Probed } from "../src/run/environment.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import { noHolds, openGate } from "../src/run/holds.ts"
import { Ledger } from "../src/run/ledger.ts"
import { make as makeLoop } from "../src/run/look.ts"
import { emptyQueue } from "../src/run/mergequeue.ts"
import { Move } from "../src/run/phase.ts"
import { make, type Scheduler } from "../src/run/schedule.ts"
import { make as makeWakes } from "../src/run/wakes.ts"
import type { Beads, Issue, TicketId } from "../src/services/Beads.ts"
import type { EventStream } from "../src/services/EventStream.ts"
import { Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import type { Captured } from "../src/testing/EventStream.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"

type Env = Beads | Backlog | Ledger | Log | EventStream | Captured | RunFibers | Scope.Scope

const layers = (seeds: ReadonlyArray<Seed>) =>
  Layer.mergeAll(beadsLayer(seeds), ledgerLayer(), runFibersLayer).pipe(
    Layer.provideMerge(TestClock.layer()),
  )

const run = <A, E>(seeds: ReadonlyArray<Seed>, effect: Effect.Effect<A, E, Env>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(layers(seeds))))

/** Lets forked fibers run, without moving the clock, until `done` or for long enough. */
const until = <R>(done: Effect.Effect<boolean, never, R>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 5000 && !(yield* done); i++) yield* Effect.yieldNow
  })

const phaseOf = (id: string) =>
  Effect.map(
    Effect.flatMap(Ledger, (ledger) => ledger.current),
    (state) => state.tickets.get(id as TicketId)?.phase._tag,
  )

/**
 * Runs the loop over `seeds` at `concurrent` slots: `first` starts and `held` is held back for it.
 * `first`'s fiber ends, its worker closing it with no change, from inside the next fill's reads of
 * the holds; `held`'s once the test has seen it start. Gives what the test saw at each step.
 */
const heldFreed = (seeds: ReadonlyArray<Seed>, first: string, held: string, concurrent: number) =>
  run(
    seeds,
    Effect.gen(function* () {
      const backlog = yield* Backlog
      const ledger = yield* Ledger
      const started = yield* Ref.make<ReadonlyArray<string>>([])
      const done = new Map([
        [first, yield* Deferred.make<void>()],
        [held, yield* Deferred.make<void>()],
      ])
      const armed = yield* Ref.make(false)
      const closeNoChange = (id: string) =>
        Effect.gen(function* () {
          const seed = seeds.find((each) => each.id === id)
          yield* backlog.put({ ...seed, id, status: "closed" })
          yield* ledger.transition(id as TicketId, Move.NoChange())
        })
      const schedule: Scheduler = yield* make({
        concurrent,
        limit: 40,
        scope: null,
        excludeTypes: ["epic"],
        // The base's commit, read as the fill reads the holds: `first` ends there, once armed.
        closedBranches: {
          head: Effect.gen(function* () {
            if (yield* Ref.getAndSet(armed, false)) {
              yield* Deferred.succeed(done.get(first) as Deferred.Deferred<void>, undefined)
              yield* until(Effect.map(schedule.ends, (n) => n > 0))
            }
            return "base"
          }),
          why: () => Effect.succeed(undefined),
        },
        start: {
          start: (issue: Issue) =>
            Effect.gen(function* () {
              yield* Ref.update(started, (all) => [...all, issue.id])
              const end = done.get(issue.id)
              if (end === undefined) return yield* Effect.never
              yield* Deferred.await(end)
              yield* closeNoChange(issue.id)
            }),
        },
      })
      const wakes = yield* makeWakes
      const loop = yield* makeLoop({
        fill: () => Effect.asVoid(Effect.orDie(schedule.fillTrying)),
        wakes,
        gate: Effect.succeed(openGate),
        holds: {
          now: Effect.succeed(noHolds),
          currentStops: Effect.succeed([]),
          changeHolds: () => Effect.succeed(noHolds),
          stopped: () => Effect.void,
        },
        ledger,
        attention: { current: Effect.succeed([]) },
        scheduler: schedule,
        queue: { state: Effect.succeed(emptyQueue), hold: Effect.void },
        triage: { pending: Effect.succeed(0) },
        usage: {
          limited: Effect.succeed(new Set()),
          handBacks: Effect.succeed(new Set()),
          look: () => Effect.succeed(null),
        },
        commands: {
          acted: Effect.succeed(0),
          endAsked: Effect.succeed(false),
          endAfter: () => Effect.succeed(true),
          askEnd: Effect.void,
        },
        environment: { probe: () => Effect.succeed(Probed.Ends()) },
        resuming: Effect.succeed(false),
        answering: Effect.succeed(false),
        showEndOfRun: () => Effect.void,
        dashboard: false,
      })
      const ended = yield* Ref.make(false)
      const fiber = yield* Effect.forkChild(Effect.andThen(loop.untilEnd, Ref.set(ended, true)))
      yield* until(Effect.map(phaseOf(held), (phase) => phase === "HeldBack" || phase === "Queued"))
      const before = {
        started: yield* Ref.get(started),
        held: yield* phaseOf(held),
      }
      // The next look, the ready poll's: its fill reads the holds, and `first` ends meanwhile.
      yield* Ref.set(armed, true)
      yield* wakes.wakeUp("poll")
      const settled = Effect.map(
        Effect.all([phaseOf(held), Ref.get(ended)]),
        ([phase, over]) => phase === "Working" || over,
      )
      yield* until(settled)
      const after = {
        started: yield* Ref.get(started),
        held: yield* phaseOf(held),
        ended: yield* Ref.get(ended),
      }
      // With nothing left, the run ends as ever.
      yield* Deferred.succeed(done.get(held) as Deferred.Deferred<void>, undefined)
      yield* until(Ref.get(ended))
      const last = { ended: yield* Ref.get(ended) }
      yield* Fiber.interrupt(fiber)
      return { before, after, last }
    }),
  )

describe("a ticket held back for one whose fiber ends while the fill reads the holds", () => {
  const solo: ReadonlyArray<Seed> = [
    { id: "w", priority: 0, labels: ["solo"] },
    { id: "t", priority: 1 },
  ]

  for (const concurrent of [2, 1]) {
    test(`held for a solo ticket, at ${concurrent} slots, starts at the freed wake`, async () => {
      const { before, after, last } = await heldFreed(solo, "w", "t", concurrent)
      expect(before.started).toEqual(["w"])
      expect(after).toEqual({ started: ["w", "t"], held: "Working", ended: false })
      expect(last.ended).toBe(true)
    })
  }

  test("held for the merge of the ticket it was filed from starts at the freed wake", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "w", priority: 0 },
      { id: "t", priority: 1, dependencies: [{ id: "w", type: "discovered-from" }] },
    ]
    const { before, after, last } = await heldFreed(seeds, "w", "t", 2)
    expect(before).toEqual({ started: ["w"], held: "HeldBack" })
    expect(after).toEqual({ started: ["w", "t"], held: "Working", ended: false })
    expect(last.ended).toBe(true)
  })

  test("a parent held for its last subticket starts at the freed wake", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "p", priority: 1 },
      { id: "p.1", priority: 0, parent: "p" },
    ]
    const { before, after, last } = await heldFreed(seeds, "p.1", "p", 2)
    expect(before).toEqual({ started: ["p.1"], held: "HeldBack" })
    expect(after).toEqual({ started: ["p.1", "p"], held: "Working", ended: false })
    expect(last.ended).toBe(true)
  })
})
