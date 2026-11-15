// A solo ticket first in line holds back a recheck (recheck.ts) and a take-back of a conflict
// rebased by hand (takenBack.ts), both through the scheduler's recheckSlot, only while the run
// takes new tickets: once --limit is reached no fill picks again, and that ticket won't start in
// this run. A solo ticket running holds them back still.
import { expect, test } from "bun:test"
import { Deferred, Effect, Layer, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"
import type { Log } from "../src/core/log.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import type { Ledger } from "../src/run/ledger.ts"
import { make } from "../src/run/schedule.ts"
import type { Beads, Issue, TicketId } from "../src/services/Beads.ts"
import type { EventStream } from "../src/services/EventStream.ts"
import { layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"

type Env = Beads | Ledger | Log | EventStream | RunFibers | Scope.Scope

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

/** Lets forked fibers run, without moving the clock. */
const flush = Effect.gen(function* () {
  for (let i = 0; i < 50; i++) yield* Effect.yieldNow
})

/**
 * With bd ready listing a, b and then s, solo when `soloNext`, and r and r2 closed, set aside:
 * a fill at two slots starts a and b, which end; then r, and r2 beside it, each ask for a slot to
 * be checked once more, r solo when `soloR`. What started, and whether each took a slot.
 */
const after = (options: {
  readonly limit: number
  readonly soloNext: boolean
  readonly soloR?: boolean
}) =>
  run(
    [
      { id: "a", priority: 1 },
      { id: "b", priority: 1 },
      { id: "s", priority: 2, labels: options.soloNext ? ["solo"] : [] },
      { id: "r", status: "closed", labels: options.soloR === true ? ["solo"] : [] },
      { id: "r2", status: "closed" },
    ],
    Effect.gen(function* () {
      const started = yield* Ref.make<ReadonlyArray<string>>([])
      const done = yield* Deferred.make<void>()
      const schedule = yield* make({
        concurrent: 2,
        limit: options.limit,
        scope: null,
        excludeTypes: ["epic"],
        start: {
          start: (issue: Issue) =>
            Effect.andThen(
              Ref.update(started, (all) => [...all, issue.id]),
              Deferred.await(done),
            ),
        },
      })
      yield* schedule.fillTrying
      yield* Deferred.succeed(done, undefined)
      yield* flush
      const running = [...(yield* schedule.running)]
      const r = yield* schedule.recheckSlot("r" as TicketId, Effect.never)
      const r2 = yield* schedule.recheckSlot("r2" as TicketId, Effect.never)
      return { started: yield* Ref.get(started), running, r, r2 }
    }),
  )

test("with --limit reached and a solo ticket next in line, a recheck takes a free slot", async () => {
  expect(await after({ limit: 2, soloNext: true })).toEqual({
    started: ["a", "b"],
    running: [],
    r: true,
    r2: true,
  })
})

test("with --limit reached and a plain ticket next in line, a recheck takes a free slot", async () => {
  expect(await after({ limit: 2, soloNext: false })).toEqual({
    started: ["a", "b"],
    running: [],
    r: true,
    r2: true,
  })
})

test("with --limit reached, a solo ticket checked once more keeps the next recheck out", async () => {
  expect(await after({ limit: 2, soloNext: true, soloR: true })).toEqual({
    started: ["a", "b"],
    running: [],
    r: true,
    r2: false,
  })
})

test("while the run takes tickets with a solo one first in line, a recheck waits", async () => {
  expect(await after({ limit: 3, soloNext: true })).toEqual({
    started: ["a", "b"],
    running: [],
    r: false,
    r2: false,
  })
})
