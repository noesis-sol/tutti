// A blocker past its work by the ledger holds its dependant though bd's open list the look read
// earlier still says in_progress (tutti-34k9.7). With a ticket Asked, the look reads bd list once,
// before the answers are taken, and hands it to the fill (fillWith), which reads bd ready after: a
// blocker whose worker closed it meanwhile, ToMerge by the ledger, is in that list as its worker
// left it, and its dependant, which bd ready lists now, must still wait for it to merge.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, type Scope } from "effect"
import { TestClock } from "effect/testing"
import type { EventStream } from "../src/run/eventstream.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { Log } from "../src/run/log.ts"
import { Move } from "../src/run/phase.ts"
import { make } from "../src/run/schedule.ts"
import { ledgerView } from "../src/run/scope.ts"
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

/** A scheduler with two slots whose tickets never end. */
const scheduler = make({
  concurrent: 2,
  limit: 40,
  scope: null,
  excludeTypes: ["epic"],
  start: { start: (_: Issue) => Effect.never },
})

const b = "b" as TicketId
const t = "t" as TicketId
const seeds: ReadonlyArray<Seed> = [
  { id: b, priority: 0 },
  { id: t, priority: 1, blockedBy: [b] },
]

/** b's worker claims it, as the worker does once dispatched. */
const bClaimed = Effect.flatMap(Beads, (beads) => beads.update(b, { claim: true }))

/** b's worker closes it and its work is verified: closed in bd, ToMerge by the ledger. */
const bCloses = Effect.gen(function* () {
  yield* (yield* Beads).close(b)
  yield* (yield* Ledger).transition(b, Move.Verified({ place: 1 }))
})

describe("a blocker closed between the look's list and the fill's ready poll", () => {
  test("holds its dependant, waiting to merge, though the list says in_progress", async () => {
    const [open, dispatched, lines] = await run(
      seeds,
      Effect.gen(function* () {
        const schedule = yield* scheduler
        yield* schedule.fillTrying
        yield* bClaimed
        const open = yield* (yield* Beads).list()
        yield* bCloses
        const filled = yield* schedule.fillWith(open)
        return [open, filled.dispatched.map(String), yield* texts] as const
      }),
    )
    expect(open.map((issue) => [issue.id, issue.status])).toEqual([
      [b, "in_progress"],
      [t, "open"],
    ])
    expect(dispatched).toEqual([])
    expect(lines).toContain("  t waits: after b merges: closed but not merged (waiting to merge)")
  })

  test("the fill's dependant starts once the blocker has merged", async () => {
    const dispatched = await run(
      seeds,
      Effect.gen(function* () {
        const schedule = yield* scheduler
        yield* schedule.fillTrying
        yield* bClaimed
        const open = yield* (yield* Beads).list()
        yield* bCloses
        const ledger = yield* Ledger
        yield* ledger.transition(b, Move.ItsTurn())
        yield* ledger.transition(b, Move.FastForwarded({ commit: "abc1234" }))
        const filled = yield* schedule.fillWith(open)
        return filled.dispatched.map(String)
      }),
    )
    expect(dispatched).toEqual([t])
  })
})

describe("the ledger's view of a ticket past its work", () => {
  test("says it isn't merged whatever status the issue gives", async () => {
    const [toMerge, working] = await run(
      seeds,
      Effect.gen(function* () {
        const schedule = yield* scheduler
        yield* schedule.fillTrying
        const ledger = yield* Ledger
        const stale = { id: b, status: "in_progress", labels: [] }
        const working = ledgerView(yield* ledger.current).unmerged(stale)
        yield* bCloses
        const toMerge = ledgerView(yield* ledger.current).unmerged(stale)
        return [toMerge, working] as const
      }),
    )
    expect(working).toBeUndefined()
    expect(toMerge).toBe("waiting to merge")
  })
})
