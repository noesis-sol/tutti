import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"
import type { EventStream } from "../src/run/eventstream.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { Log } from "../src/run/log.ts"
import { Cause, type PhaseTag } from "../src/run/phase.ts"
import { make } from "../src/run/schedule.ts"
import { Beads, type Issue } from "../src/services/Beads.ts"
import { type Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import type { Captured } from "../src/testing/EventStream.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"

// A ticket back in the queue for WAITS_FOR_MERGE enters Waiting a few steps before its fiber ends.
// Its blocker merging inside that window puts it back in the queue while its fiber still holds its
// slot: it counts toward --limit once all the same.

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

/**
 * A scheduler whose first start of `t-1` moves it to Waiting, then holds its fiber open until
 * `end()`: the window. Its later starts run until the test ends. `starts` lists the tickets handed
 * to their fibers.
 */
const scheduler = (options: { readonly concurrent: number; readonly limit: number }) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const starts = yield* Ref.make<ReadonlyArray<string>>([])
    const window = yield* Deferred.make<void>()
    const forever = yield* Deferred.make<void>()
    const schedule = yield* make({
      concurrent: options.concurrent,
      limit: options.limit,
      scope: null,
      excludeTypes: ["epic"],
      start: {
        start: (issue: Issue) =>
          Effect.gen(function* () {
            const before = yield* Ref.getAndUpdate(starts, (all) => [...all, issue.id])
            if (before.length > 0) return yield* Deferred.await(forever)
            yield* ledger.transition(issue.id, Cause.WaitsForMerge({ blockers: ["t-0"] }))
            yield* Deferred.await(window)
          }),
      },
    })
    const end = Effect.andThen(Deferred.succeed(window, undefined), flush)
    return { schedule, starts: Ref.get(starts), end }
  })

const phaseOf = (id: string) =>
  Effect.map(
    Effect.flatMap(Ledger, (ledger) => ledger.current),
    (state): PhaseTag | undefined => state.tickets.get(id)?.phase._tag,
  )

describe("a ticket put back in the queue before its fiber ends", () => {
  test("starts again once its fiber ends, and counts toward --limit once", async () => {
    const seen = await run(
      [{ id: "t-1" }],
      Effect.gen(function* () {
        const { schedule, starts, end } = yield* scheduler({ concurrent: 2, limit: 2 })
        const ledger = yield* Ledger
        const fiber = yield* Effect.forkChild(schedule.run)
        yield* flush
        const waiting = yield* phaseOf("t-1")
        // Its blocker merges inside the window, and the next poll fills the free slot.
        yield* ledger.transition("t-1", Cause.Requeued())
        yield* TestClock.adjust("30 seconds")
        yield* flush
        const inWindow = { starts: yield* starts, started: yield* schedule.started }
        yield* end
        const after = {
          starts: yield* starts,
          started: yield* schedule.started,
          running: [...(yield* schedule.running)],
          limitReached: yield* schedule.limitReached,
          phase: yield* phaseOf("t-1"),
        }
        yield* Fiber.interrupt(fiber)
        return { waiting, inWindow, after }
      }),
    )
    expect(seen.waiting).toBe("Waiting")
    expect(seen.inWindow).toEqual({ starts: ["t-1"], started: 1 })
    expect(seen.after).toEqual({
      starts: ["t-1", "t-1"],
      started: 1,
      running: ["t-1"],
      limitReached: false,
      phase: "Working",
    })
  })

  test("counts for nothing when bd ready no longer lists it as its fiber ends", async () => {
    const seen = await run(
      [{ id: "t-1" }],
      Effect.gen(function* () {
        const { schedule, starts, end } = yield* scheduler({ concurrent: 2, limit: 2 })
        const ledger = yield* Ledger
        const beads = yield* Beads
        const fiber = yield* Effect.forkChild(schedule.run)
        yield* flush
        // Back in the queue, then deferred outside the run: the next poll takes it out of the ledger.
        yield* ledger.transition("t-1", Cause.Requeued())
        yield* beads.defer("t-1", { reason: "not now" })
        yield* TestClock.adjust("30 seconds")
        yield* flush
        const gone = (yield* phaseOf("t-1")) === undefined
        yield* end
        const after = {
          starts: yield* starts,
          started: yield* schedule.started,
          running: [...(yield* schedule.running)],
        }
        yield* Fiber.interrupt(fiber)
        return { gone, after }
      }),
    )
    expect(seen.gone).toBe(true)
    expect(seen.after).toEqual({ starts: ["t-1"], started: 0, running: [] })
  })
})
