// A ticket's fiber frees its slot and counts its end in one step (slots.ts occupy's release): no
// read sees the ticket out of running with its end not counted, which a look would take for
// nothing running and no fiber ended since its fill, and end the run on (look.ts, runEnd.ts). A
// reader fiber reads both, as the look does, between every step of the release: each fiber yields
// after every few operations, at each count of them from the fewest up, so that the reader's reads
// land between each two steps in one count or another, and the queue's show yields as it draws.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Ref, References, type Scope } from "effect"
import { TestClock } from "effect/testing"
import type { Log } from "../src/core/log.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import type { Ledger } from "../src/run/ledger.ts"
import { make, type QueueShown } from "../src/run/schedule.ts"
import type { Beads, TicketId } from "../src/services/Beads.ts"
import type { EventStream } from "../src/services/EventStream.ts"
import { type Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import type { Captured } from "../src/testing/EventStream.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"

type Env = Beads | Backlog | Ledger | Log | EventStream | Captured | RunFibers | Scope.Scope

// A solo ticket: its release takes it from the queue shown, so the show runs in the release.
const seeds: ReadonlyArray<Seed> = [{ id: "s", priority: 0, labels: ["solo"] }]

const layers = Layer.mergeAll(beadsLayer(seeds), ledgerLayer(), runFibersLayer).pipe(
  Layer.provideMerge(TestClock.layer()),
)

const run = <A, E>(effect: Effect.Effect<A, E, Env>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(layers)))

interface Seen {
  readonly running: boolean
  readonly ends: number
}

// How many operations a fiber runs before it yields, from the fewest that let it go on (at 1 or 2,
// Effect's run loop yields again as it resumes, before it runs anything).
const budgets = [3, 4, 5, 6, 7, 8]

/**
 * Starts the solo ticket, ends its work and reads, until it is out of running and its end counted,
 * whether it runs and the ends counted: each fiber yielding after `budget` operations, and the show
 * yielding `showYields` times. Gives the reads, and the queues shown.
 */
const release = (showYields: number, budget: number) =>
  run(
    Effect.gen(function* () {
      const done = yield* Deferred.make<void>()
      const shown = yield* Ref.make<ReadonlyArray<QueueShown>>([])
      const schedule = yield* make({
        concurrent: 1,
        limit: 40,
        scope: null,
        excludeTypes: ["epic"],
        start: { start: () => Deferred.await(done) },
        show: (queue) =>
          Effect.gen(function* () {
            for (let i = 0; i < showYields; i++) yield* Effect.yieldNow
            yield* Ref.update(shown, (all) => [...all, queue])
          }),
      })
      yield* schedule.fillTrying
      const seen = yield* Ref.make<ReadonlyArray<Seen>>([])
      // Read as the look reads them: running first, the ends counted after it.
      const read = Effect.gen(function* () {
        const running = (yield* schedule.running).has("s" as TicketId)
        const ends = yield* schedule.ends
        yield* Ref.update(seen, (all) => [...all, { running, ends }])
        return !running && ends > 0
      })
      const reader = yield* Effect.forkChild(
        Effect.gen(function* () {
          while (!(yield* read)) yield* Effect.yieldNow
        }),
      )
      // The work ends once the reader has seen the ticket running.
      while ((yield* Ref.get(seen)).length === 0) yield* Effect.yieldNow
      yield* Deferred.succeed(done, undefined)
      yield* Fiber.join(reader)
      // The release goes on to show the queue, and wakes the fill as it ends.
      yield* schedule.freed
      return { seen: yield* Ref.get(seen), shown: yield* Ref.get(shown) }
    }).pipe(Effect.provideService(References.MaxOpsBeforeYield, budget)),
  )

describe("a ticket's fiber that ends", () => {
  for (const showYields of [0, 3]) {
    test(`frees its slot and counts its end in one step, with a show that yields ${showYields} times`, async () => {
      for (const budget of budgets) {
        const { seen, shown } = await release(showYields, budget)
        // The release ran with the reader beside it: seen running, then ended.
        expect(seen[0]).toEqual({ running: true, ends: 0 })
        expect(seen.at(-1)).toEqual({ running: false, ends: 1 })
        expect(shown.map((queue) => queue.solo)).toEqual([{ ticket: "s", running: true }, null])
        expect({ budget, gap: seen.filter((each) => !each.running && each.ends === 0) }).toEqual({
          budget,
          gap: [],
        })
      }
    })
  }
})
