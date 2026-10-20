import { expect, test } from "bun:test"
import { Deferred, Effect, Layer, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"
import type { EventStream } from "../src/run/eventstream.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import { repoFiles } from "../src/run/footprint.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { Log } from "../src/run/log.ts"
import type { TicketPhase } from "../src/run/phase.ts"
import { make } from "../src/run/schedule.ts"
import type { Beads, Issue } from "../src/services/Beads.ts"
import { type Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import type { Captured } from "../src/testing/EventStream.ts"
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

const phaseOf = (id: string) =>
  Effect.map(
    Effect.flatMap(Ledger, (ledger) => ledger.current),
    (state): TicketPhase | undefined => state.tickets.get(id)?.phase,
  )

test("a ticket that ends while the fill reads its footprint no longer holds the others back", async () => {
  const seeds: ReadonlyArray<Seed> = [
    { id: "t-1", priority: 0, metadata: { files: ["src/a.ts"] } },
    { id: "t-2", priority: 1, metadata: { files: ["src/a.ts"] } },
  ]
  const [started, phase] = await run(
    seeds,
    Effect.gen(function* () {
      const started = yield* Ref.make<ReadonlyArray<string>>([])
      const t1Done = yield* Deferred.make<void>()
      const schedule = yield* make({
        concurrent: 2,
        limit: 40,
        scope: null,
        excludeTypes: ["epic"],
        footprints: {
          repo: Effect.succeed(repoFiles(["src/a.ts"])),
          changed: () => Effect.succeed([]),
          // t-1 ends while the fill reads the files' contents, as git and the disk take a while.
          mentions: () =>
            Effect.andThen(
              Effect.andThen(Deferred.succeed(t1Done, undefined), flush),
              Effect.succeed(() => false),
            ),
        },
        start: {
          start: (issue: Issue) =>
            Effect.gen(function* () {
              yield* Ref.update(started, (all) => [...all, issue.id])
              if (issue.id === "t-1") yield* Deferred.await(t1Done)
              else yield* Effect.never
            }),
        },
      })
      yield* schedule.fill
      return [yield* Ref.get(started), (yield* phaseOf("t-2"))?._tag] as const
    }),
  )
  expect(started).toEqual(["t-1", "t-2"])
  expect(phase).toBe("Working")
})
