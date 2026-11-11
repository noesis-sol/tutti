// A child filed after the look read bd's open list that bd ready omits holds its parent in the fill
// that list is given to (tutti-7tun). With a ticket Asked, the look reads bd list once, before the
// answers are taken, and hands it to the fill (fillWith), which reads bd ready after: a child filed
// meanwhile with an open blocker outside its parent's subtickets, or in progress, is in neither
// list. A ticket bd ready lists that the look's list lacks says the backlog changed since: the fill
// then reads the open list afresh, and the parent waits for every child.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, type Scope } from "effect"
import { TestClock } from "effect/testing"
import type { Log } from "../src/core/log.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import type { Ledger } from "../src/run/ledger.ts"
import { make } from "../src/run/schedule.ts"
import { Beads, type Issue, type TicketId } from "../src/services/Beads.ts"
import type { EventStream } from "../src/services/EventStream.ts"
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

/** A scheduler whose tickets never end, with slots enough for a parent to start beside a child. */
const scheduler = (concurrent: number) =>
  make({
    concurrent,
    limit: 40,
    scope: null,
    excludeTypes: ["epic"],
    start: { start: (_: Issue) => Effect.never },
  })

const p = "p" as TicketId
/** q, in progress, is in bd's open list and not in bd ready, and blocks a child of p. */
const q = "q" as TicketId
const seeds: ReadonlyArray<Seed> = [
  { id: p, priority: 1 },
  { id: q, priority: 1, status: "in_progress" },
]

/** A worker files a child of p that bd ready lists, as the look's list is already read. */
const readyChild = Effect.flatMap(Beads, (beads) =>
  beads.create({ title: "a child of p", parent: p, priority: 1 }),
)

describe("a child filed between the look's list and the fill's ready poll that bd ready omits", () => {
  test("blocked by a ticket outside its parent's subtickets, it holds its parent with its ready sibling", async () => {
    const [ids, dispatched, lines] = await run(
      seeds,
      Effect.gen(function* () {
        const schedule = yield* scheduler(3)
        const beads = yield* Beads
        const open = yield* beads.list()
        const ready = yield* readyChild
        const blocked = yield* beads.create({
          title: "a child of p waiting on q",
          parent: p,
          priority: 1,
          blockedBy: [q],
        })
        const filled = yield* schedule.fillWith(open)
        return [
          [ready.id, blocked.id].map(String),
          filled.dispatched.map(String),
          yield* texts,
        ] as const
      }),
    )
    expect(ids).toEqual(["p.1", "p.2"])
    expect(dispatched).toEqual(["p.1"])
    expect(lines).toContain("  p waits: after its subtickets: p.1, p.2")
  })

  test("in progress, it holds its parent with its ready sibling", async () => {
    const [dispatched, lines] = await run(
      seeds,
      Effect.gen(function* () {
        const schedule = yield* scheduler(3)
        const beads = yield* Beads
        const open = yield* beads.list()
        yield* readyChild
        const claimed = yield* beads.create({ title: "a child of p", parent: p, priority: 1 })
        yield* beads.update(claimed.id, { claim: true })
        const filled = yield* schedule.fillWith(open)
        return [filled.dispatched.map(String), yield* texts] as const
      }),
    )
    expect(dispatched).toEqual(["p.1"])
    expect(lines).toContain("  p waits: after its subtickets: p.1, p.2")
  })

  test("with no slot for the sibling, it holds its parent still", async () => {
    const [dispatched, lines] = await run(
      seeds,
      Effect.gen(function* () {
        const schedule = yield* scheduler(0)
        const beads = yield* Beads
        const open = yield* beads.list()
        yield* readyChild
        yield* beads.create({ title: "a child of p", parent: p, priority: 1, blockedBy: [q] })
        const filled = yield* schedule.fillWith(open)
        return [filled.dispatched.map(String), yield* texts] as const
      }),
    )
    expect(dispatched).toEqual([])
    expect(lines).toContain("  p waits: after its subtickets: p.1, p.2")
  })
})
