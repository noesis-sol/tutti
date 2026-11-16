// A ticket put back in the queue at --limit, whose fiber ends between the look's reads (look.ts,
// runEnd.ts): the real scheduler, wakes and loop, over the test layers of Beads and the Ledger. Its
// fiber gives its start back to --limit as it frees its slot; the look reads the slots before the
// gate, so it either sees the slot taken and looks again at the freed wake, or sees the limit given
// back. Either way the run doesn't end with the ticket queued, and it starts again.
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
 * Runs the loop over the one ticket `t` at --limit 1 and `concurrent` slots. Its first fiber puts
 * it back in the queue (MergedSinceCut) and ends from inside the next look's read of the gate,
 * just after the gate has read the limit reached; its second closes it with no change once the
 * test has seen it start. Gives what the test saw at each step.
 */
const requeuedAtLimit = (concurrent: number) => {
  const seeds: ReadonlyArray<Seed> = [{ id: "t", priority: 0 }]
  return run(
    seeds,
    Effect.gen(function* () {
      const backlog = yield* Backlog
      const ledger = yield* Ledger
      const started = yield* Ref.make<ReadonlyArray<string>>([])
      const firstDone = yield* Deferred.make<void>()
      const secondDone = yield* Deferred.make<void>()
      const armed = yield* Ref.make(false)
      const schedule: Scheduler = yield* make({
        concurrent,
        limit: 1,
        scope: null,
        excludeTypes: ["epic"],
        closedBranches: { head: Effect.succeed("base"), why: () => Effect.succeed(undefined) },
        start: {
          start: (issue: Issue) =>
            Effect.gen(function* () {
              const before = yield* Ref.getAndUpdate(started, (all) => [...all, issue.id])
              if (before.length === 0) {
                yield* Deferred.await(firstDone)
                yield* ledger.transition(issue.id, Move.MergedSinceCut({ blockers: [] }))
                return
              }
              yield* Deferred.await(secondDone)
              yield* backlog.put({ ...seeds[0], id: issue.id, status: "closed" })
              yield* ledger.transition(issue.id, Move.NoChange())
            }),
        },
      })
      // The gate reads the scheduler's --limit; once armed, `t`'s first fiber ends just after.
      const gate = Effect.gen(function* () {
        const limitReached = yield* schedule.limitReached
        if (yield* Ref.getAndSet(armed, false)) {
          yield* Deferred.succeed(firstDone, undefined)
          yield* until(Effect.map(schedule.ends, (n) => n > 0))
        }
        return { ...openGate, limitReached }
      })
      const wakes = yield* makeWakes
      const loop = yield* makeLoop({
        fill: () => Effect.asVoid(Effect.orDie(schedule.fillTrying)),
        wakes,
        gate,
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
      yield* until(Effect.map(phaseOf("t"), (phase) => phase === "Working"))
      const before = {
        started: yield* Ref.get(started),
        limitReached: yield* schedule.limitReached,
      }
      // The next look, the ready poll's: `t` goes back in the queue as it reads the gate.
      yield* Ref.set(armed, true)
      yield* wakes.wakeUp("poll")
      const settled = Effect.map(
        Effect.all([Ref.get(started), Ref.get(ended)]),
        ([all, over]) => all.length > 1 || over,
      )
      yield* until(settled)
      const after = {
        started: yield* Ref.get(started),
        phase: yield* phaseOf("t"),
        ended: yield* Ref.get(ended),
      }
      // With nothing left, the run ends as ever.
      yield* Deferred.succeed(secondDone, undefined)
      yield* until(Ref.get(ended))
      const last = { ended: yield* Ref.get(ended) }
      yield* Fiber.interrupt(fiber)
      return { before, after, last }
    }),
  )
}

describe("a ticket put back in the queue at --limit, its fiber ending between the look's reads", () => {
  for (const concurrent of [2, 1]) {
    test(`at ${concurrent} slots, the run doesn't end and the ticket starts again`, async () => {
      const { before, after, last } = await requeuedAtLimit(concurrent)
      expect(before).toEqual({ started: ["t"], limitReached: true })
      expect(after).toEqual({ started: ["t", "t"], phase: "Working", ended: false })
      expect(last.ended).toBe(true)
    })
  }
})
