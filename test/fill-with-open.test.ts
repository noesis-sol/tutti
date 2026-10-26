// The scheduler's fillWith (tutti-gr4z.6): a fill given bd's open list, as the look read it at its
// start for its Asked tickets, takes it rather than read it again; fillTrying reads it itself.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"
import type { EventStream } from "../src/run/eventstream.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import type { Ledger } from "../src/run/ledger.ts"
import type { Log } from "../src/run/log.ts"
import { make } from "../src/run/schedule.ts"
import { Beads, type Issue, type ListOptions } from "../src/services/Beads.ts"
import { type Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"

type Env = Beads | Backlog | Ledger | Log | EventStream | RunFibers | Scope.Scope

const run = <A, E>(seeds: ReadonlyArray<Seed>, effect: Effect.Effect<A, E, Env>): Promise<A> =>
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

/** A scheduler over the backlog's Beads, the plain bd lists it makes counted, its tickets never ending. */
const scheduler = Effect.gen(function* () {
  const beads = yield* Beads
  const lists = yield* Ref.make(0)
  const counted = Beads.of({
    ...beads,
    list: (listed: ListOptions = {}) =>
      Effect.andThen(
        Object.keys(listed).length === 0 ? Ref.update(lists, (n) => n + 1) : Effect.void,
        beads.list(listed),
      ),
  })
  const schedule = yield* make({
    concurrent: 1,
    limit: 40,
    scope: null,
    excludeTypes: ["epic"],
    start: { start: (_: Issue) => Effect.never },
  }).pipe(Effect.provideService(Beads, counted))
  return { schedule, lists: Ref.get(lists), beads }
})

const seeds: ReadonlyArray<Seed> = [{ id: "t-1" }, { id: "t-2" }]

describe("a fill given the look's open list", () => {
  test("takes it, reading no bd list of its own", async () => {
    const [lists, started] = await run(
      seeds,
      Effect.gen(function* () {
        const { schedule, lists, beads } = yield* scheduler
        const open = yield* beads.list()
        const filled = yield* schedule.fillWith(open)
        return [yield* lists, filled.dispatched.map(String)] as const
      }),
    )
    expect(lists).toBe(0)
    expect(started).toEqual(["t-1"])
  })

  test("fillTrying reads it itself", async () => {
    const lists = await run(
      seeds,
      Effect.gen(function* () {
        const { schedule, lists } = yield* scheduler
        yield* schedule.fillTrying
        return yield* lists
      }),
    )
    expect(lists).toBe(1)
  })
})
