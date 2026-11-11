import { expect, test } from "bun:test"
import { Deferred, Effect, Layer, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"
import type { Log } from "../src/core/log.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { TicketPhase } from "../src/run/phase.ts"
import { repoFiles } from "../src/run/repoFiles.ts"
import { make } from "../src/run/schedule.ts"
import { Beads, type Issue, type TicketId } from "../src/services/Beads.ts"
import type { EventStream } from "../src/services/EventStream.ts"
import { type Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import type { Captured } from "../src/testing/EventStream.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"

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

const phaseOf = (id: TicketId) =>
  Effect.map(
    Effect.flatMap(Ledger, (ledger) => ledger.current),
    (state): TicketPhase | undefined => state.tickets.get(id)?.phase,
  )

test("a slot that frees while the fill reads the holds doesn't let a ticket start without the overlap check", async () => {
  // t-1 and t-2 fill the two slots; t-3 shares a function with t-1, so it is skipped while t-1 runs.
  const seeds: ReadonlyArray<Seed> = [
    {
      id: "t-1",
      priority: 0,
      description: "Change Loop.merge.",
      metadata: { files: ["src/a.ts"] },
    },
    { id: "t-2", priority: 1, metadata: { files: ["src/b.ts"] } },
    {
      id: "t-3",
      priority: 2,
      description: "Change Loop.merge.",
      metadata: { files: ["src/a.ts"] },
    },
  ]
  const [started, phase, lines] = await run(
    seeds,
    Effect.gen(function* () {
      const started = yield* Ref.make<ReadonlyArray<string>>([])
      const t2Done = yield* Deferred.make<void>()
      // Whether a bd read of the fill ends t-2: set once t-1 and t-2 run.
      const freeing = yield* Ref.make(false)
      const beads = yield* Beads
      // t-2 ends while the fill reads bd for what holds t-3 back (the closed tickets labelled
      // unmerged, read for the first ticket in line), as bd takes a while.
      const slow: Beads["Service"] = {
        ...beads,
        list: (options) =>
          Effect.gen(function* () {
            if (options?.status === "closed" && (yield* Ref.get(freeing))) {
              yield* Ref.set(freeing, false)
              yield* Deferred.succeed(t2Done, undefined)
              yield* flush
            }
            return yield* beads.list(options)
          }),
      }
      const schedule = yield* make({
        concurrent: 2,
        limit: 40,
        scope: null,
        excludeTypes: ["epic"],
        footprints: {
          repo: Effect.succeed(repoFiles(["src/a.ts", "src/b.ts"])),
          changed: () => Effect.succeed([]),
          mentions: () => Effect.succeed(() => false),
        },
        start: {
          start: (issue: Issue) =>
            Effect.gen(function* () {
              yield* Ref.update(started, (all) => [...all, issue.id])
              if (issue.id === "t-2") yield* Deferred.await(t2Done)
              else yield* Effect.never
            }),
        },
      }).pipe(Effect.provideService(Beads, slow))
      yield* schedule.fillTrying
      const first = [yield* Ref.get(started), (yield* phaseOf("t-3" as TicketId))?._tag] as const
      expect(first).toEqual([["t-1", "t-2"], "Queued"])
      // No slot is free as this fill starts; t-2's slot frees while it reads t-3's holds.
      yield* Ref.set(freeing, true)
      yield* schedule.fillTrying
      return [yield* Ref.get(started), yield* phaseOf("t-3" as TicketId), yield* texts] as const
    }),
  )
  expect(started).toEqual(["t-1", "t-2"])
  expect(phase).toEqual({ _tag: "HeldBack", why: "overlap" })
  expect(lines.filter((text) => text.includes("skipping"))).toEqual([
    "  skipping t-3: after t-1: both touch Loop.merge",
  ])
})
