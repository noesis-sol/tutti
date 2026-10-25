// The run's start makes no bd call whose answer it already has: the deferred tickets free to run
// spare bd show where bd list's links rule a ticket out, the nothing check reads bd list only once
// every ready ticket has turned out held, the holds at the start spare bd show where bd ready's
// links name nothing to wait on, and the start question's count lists no deferred tickets. The
// results are the same as with every call made.

import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { ticketCount } from "../src/run/choose.ts"
import * as free from "../src/run/deferredFree.ts"
import { check, heldAtStart, noHolds, type Options } from "../src/run/nothing.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import type { Git } from "../src/services/Git.ts"
import { layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as gitLayer } from "../src/testing/Git.ts"
import { TicketCount } from "../src/ui/questions.ts"

const repo = "/repo"

/**
 * Runs `effect` against the in-memory backlog with `seeds`, its bd calls logged as `<op> <id>`
 * (`show k-1`, `list`, `ready`), in order: what it gave back, and the calls.
 */
const run = async <A, E>(
  seeds: ReadonlyArray<Seed>,
  effect: Effect.Effect<A, E, Beads | Git>,
): Promise<{ readonly result: A; readonly calls: ReadonlyArray<string> }> => {
  const calls: Array<string> = []
  const logged = Layer.effect(
    Beads,
    Effect.map(Beads, (beads) =>
      Beads.of({
        ...beads,
        show: (id, options) =>
          Effect.andThen(
            Effect.sync(() => calls.push(`show ${id}`)),
            beads.show(id, options),
          ),
        list: (options) =>
          Effect.andThen(
            Effect.sync(() => calls.push("list")),
            beads.list(options),
          ),
        ready: (options) =>
          Effect.andThen(
            Effect.sync(() => calls.push("ready")),
            beads.ready(options),
          ),
      }),
    ),
  )
  const result = await Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(Layer.provide(logged, beadsLayer(seeds)), gitLayer({ dir: repo })).pipe(
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )
  return { result, calls }
}

/** The bd show calls among `calls`. */
const shows = (calls: ReadonlyArray<string>) => calls.filter((call) => call.startsWith("show"))

/** The check's options for a run of all of bd ready, with `fields` over them. */
const options = (fields: Partial<Options> = {}): Options => ({
  scope: null,
  filter: { excludeTypes: [] },
  repo,
  base: "main",
  carried: new Set(),
  unmerged: new Set(),
  held: noHolds,
  ...fields,
})

const freeing = (): free.Freeing => ({
  repo,
  base: "main",
  filter: { excludeTypes: [] },
  inScope: () => true,
  pending: free.startPending(new Set(), new Set()),
})

describe("the deferred tickets free to run", () => {
  test("bd show only for a deferred ticket bd list's links don't rule out", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "b-1", status: "closed" },
      { id: "b-2" },
      { id: "k-1", status: "deferred", blockedBy: ["b-1"] },
      { id: "k-2", status: "deferred", blockedBy: ["b-1", "b-2"] },
      { id: "k-3", status: "deferred" },
      { id: "k-4", status: "deferred", dependencies: [{ id: "b-1", type: "related" }] },
    ]
    const { result, calls } = await run(
      seeds,
      Effect.gen(function* () {
        return yield* free.list(freeing(), yield* (yield* Beads).list())
      }),
    )
    expect(result).toEqual([{ id: "k-1" as TicketId, blockers: ["b-1" as TicketId] }])
    expect(shows(calls)).toEqual(["show k-1"])
  })

  test("a deferred ticket whose blockers merged is still listed free, beside one held", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "b-1", status: "closed" },
      { id: "b-2", status: "closed" },
      { id: "b-3", status: "closed", labels: ["unmerged"] },
      { id: "k-1", status: "deferred", blockedBy: ["b-1", "b-2"] },
      { id: "k-2", status: "deferred", blockedBy: ["b-1", "b-3"] },
    ]
    const left = {
      ...freeing(),
      pending: free.startPending(new Set(), new Set(["b-3" as TicketId])),
    }
    const { result, calls } = await run(
      seeds,
      Effect.gen(function* () {
        return yield* free.list(left, yield* (yield* Beads).list())
      }),
    )
    expect(result).toEqual([{ id: "k-1" as TicketId, blockers: ["b-1", "b-2"] as Array<TicketId> }])
    // Closed blockers aren't in bd list: bd show says whether they merged.
    expect([...shows(calls)].sort()).toEqual(["show k-1", "show k-2"])
  })
})

describe("the holds at the start", () => {
  test("bd show only for a ready ticket linking to a blocker or a source", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "b-1", status: "closed", labels: ["unmerged"] },
      { id: "s-1", status: "closed" },
      { id: "k-1" },
      { id: "k-2", dependencies: [{ id: "s-1", type: "related" }] },
      { id: "k-3", blockedBy: ["b-1"] },
      { id: "k-4", dependencies: [{ id: "s-1", type: "discovered-from" }] },
    ]
    const unmerged = new Set(["b-1" as TicketId])
    const { result, calls } = await run(
      seeds,
      Effect.gen(function* () {
        const beads = yield* Beads
        const held = heldAtStart(beads, unmerged)
        const ready = yield* beads.ready()
        const holds: Array<string | undefined> = []
        for (const id of ["k-1", "k-2", "k-3", "k-4"]) {
          const issue = ready.find((each) => each.id === id)
          holds.push(issue === undefined ? "not ready" : yield* held(issue))
        }
        return holds
      }),
    )
    expect(result).toEqual([undefined, undefined, "blocker", undefined])
    expect(shows(calls)).toEqual(["show k-3", "show k-4"])
  })
})

describe("the nothing check", () => {
  test("a ready ticket the run would start needs no bd list", async () => {
    const { result, calls } = await run([{ id: "k-1" }, { id: "k-2" }], check(options()))
    expect(result).toBeNull()
    expect(calls).toEqual(["ready"])
  })

  test("bd list once every ready ticket has turned out held", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "b-1", status: "closed", labels: ["unmerged"] },
      { id: "k-1", blockedBy: ["b-1"] },
    ]
    const unmerged = new Set(["b-1" as TicketId])
    const { result, calls } = await run(
      seeds,
      Effect.flatMap(Beads, (beads) =>
        check(options({ unmerged, held: heldAtStart(beads, unmerged) })),
      ),
    )
    expect(result).toMatchObject({ heldBlocked: 1, unmerged: 1, deferredFree: [] })
    expect(calls).toEqual(["ready", "list", "show k-1", "list"])
  })
})

describe("the start question's count", () => {
  test("with none ready, no deferred ticket is shown and bd ready is read once", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "b-1", status: "closed" },
      { id: "k-1", status: "deferred", blockedBy: ["b-1"] },
      { id: "k-2", status: "in_progress" },
    ]
    const asked = options()
    const { result, calls } = await run(seeds, ticketCount(asked, Effect.succeed(asked)))
    expect(result).toEqual(TicketCount.NoneReady({ open: 2 }))
    expect(calls).toEqual(["ready", "list"])
    // The nothing check itself still lists it.
    const { result: n } = await run(seeds, check(options()))
    expect(n).toMatchObject({ deferredFree: [{ id: "k-1", blockers: ["b-1"] }] })
  })

  test("with some ready, the options aren't read", async () => {
    const { result, calls } = await run(
      [{ id: "k-1" }],
      ticketCount(options(), Effect.die("read the options")),
    )
    expect(result).toEqual(TicketCount.Ready({ n: 1 }))
    expect(calls).toEqual(["ready"])
  })
})
