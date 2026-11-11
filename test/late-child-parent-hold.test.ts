// A child filed after the look read bd's open list holds its parent in the fill that list is given
// to (tutti-k8wx). With a ticket Asked, the look reads bd list once, before the answers are taken,
// and hands it to the fill (fillWith), which reads bd ready after: a child a worker filed meanwhile
// is in bd ready and not in that list, so its parent, in bd ready too, must wait for it whether the
// child is dispatched in that fill or only queued.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, type Scope } from "effect"
import { TestClock } from "effect/testing"
import type { Log } from "../src/core/log.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import { Ledger } from "../src/run/ledger.ts"
import { Move } from "../src/run/phase.ts"
import { make } from "../src/run/schedule.ts"
import { Beads, type Issue, type TicketId } from "../src/services/Beads.ts"
import { type Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"

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

/** A scheduler whose tickets never end, with slots enough for a parent to start beside its child. */
const scheduler = (concurrent: number) =>
  make({
    concurrent,
    limit: 40,
    scope: null,
    excludeTypes: ["epic"],
    start: { start: (_: Issue) => Effect.never },
  })

const p = "p" as TicketId
const seeds: ReadonlyArray<Seed> = [{ id: p, priority: 1 }]

/** A worker files a child of p, as the look's list is already read. */
const childFiled = Effect.flatMap(Beads, (beads) =>
  beads.create({ title: "a child of p", parent: p, priority: 1 }),
)

describe("a child filed between the look's list and the fill's ready poll", () => {
  test("holds its parent in that fill, and is dispatched in it", async () => {
    const [open, child, dispatched, lines] = await run(
      seeds,
      Effect.gen(function* () {
        const schedule = yield* scheduler(2)
        const open = yield* (yield* Beads).list()
        const child = yield* childFiled
        const filled = yield* schedule.fillWith(open)
        return [open, String(child.id), filled.dispatched.map(String), yield* texts] as const
      }),
    )
    expect(open.map((issue) => issue.id)).toEqual([p])
    expect(child).toBe("p.1")
    expect(dispatched).toEqual([child])
    expect(lines).toContain("  p waits: after its subtickets: p.1")
  })

  test("holds its parent in that fill with no slot for the child", async () => {
    const [dispatched, lines] = await run(
      seeds,
      Effect.gen(function* () {
        const schedule = yield* scheduler(0)
        const open = yield* (yield* Beads).list()
        yield* childFiled
        const filled = yield* schedule.fillWith(open)
        return [filled.dispatched.map(String), yield* texts] as const
      }),
    )
    expect(dispatched).toEqual([])
    expect(lines).toContain("  p waits: after its subtickets: p.1")
  })

  test("the parent starts in a later fill once its child is closed and merged, its fiber still holding a slot", async () => {
    const dispatched = await run(
      seeds,
      Effect.gen(function* () {
        const schedule = yield* scheduler(2)
        const beads = yield* Beads
        const open = yield* beads.list()
        const child = yield* childFiled
        yield* schedule.fillWith(open)
        yield* beads.close(child.id)
        const ledger = yield* Ledger
        yield* ledger.transition(child.id, Move.Verified({ place: 1 }))
        yield* ledger.transition(child.id, Move.ItsTurn())
        yield* ledger.transition(child.id, Move.FastForwarded({ commit: "abc1234" }))
        const filled = yield* schedule.fillTrying
        return filled.dispatched.map(String)
      }),
    )
    expect(dispatched).toEqual([p])
  })
})
