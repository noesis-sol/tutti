// A scoped run's SCOPE_OPEN line for a follow-up (§ 5 item 14): a ticket of the scope filed by
// another ticket's worker (a discovered-from link) waits while that ticket is closed but not
// merged, and the line names it so: `filed by <source>'s worker; <source> is closed but not merged`.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, type Scope } from "effect"
import { TestClock } from "effect/testing"
import type { EventStream } from "../src/run/eventstream.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { Log } from "../src/run/log.ts"
import { Cause } from "../src/run/phase.ts"
import { end, ledgerView, line, unmergedLabel } from "../src/run/scope.ts"
import { Beads } from "../src/services/Beads.ts"
import { type Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import type { Captured } from "../src/testing/EventStream.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"

type Env = Beads | Backlog | Ledger | Log | EventStream | Captured | Scope.Scope

/** Runs `effect` in a scope with the in-memory backlog of `seeds` and the ledger, under TestClock. */
const run = <A, E>(seeds: ReadonlyArray<Seed>, effect: Effect.Effect<A, E, Env>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(beadsLayer(seeds), ledgerLayer()).pipe(
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

/** The scope line for `root`, from the backlog and the ledger as they are. */
const endOf = (root: string) =>
  Effect.gen(function* () {
    const state = yield* (yield* Ledger).current
    return line(yield* end(yield* Beads, root, ledgerView(state), { excludeTypes: [] }))
  })

/** A link saying the ticket was filed by `source`'s worker. */
const filedBy = (source: string) => [{ id: source, type: "discovered-from" as const }]

describe("SCOPE_OPEN for a follow-up", () => {
  test("names a follow-up filed by a subticket the run closed but has not merged", async () => {
    const result = await run(
      [
        { id: "r", type: "epic" },
        { id: "r.1", parent: "r", status: "closed" },
        { id: "r.2", parent: "r", dependencies: filedBy("r.1") },
      ],
      Effect.gen(function* () {
        // r.1's worker filed r.2 and closed r.1, which now waits to merge.
        const ledger = yield* Ledger
        for (const cause of [Cause.Ready(), Cause.Dispatched(), Cause.Verified({ place: 1 })]) {
          yield* ledger.transition("r.1", cause)
        }
        return yield* endOf("r")
      }),
    )
    expect(result).toBe(
      "SCOPE_OPEN: r: 2 of its 2 subtickets not done: " +
        "r.2 (filed by r.1's worker; r.1 is closed but not merged), " +
        "r.1 (closed but not merged: waiting to merge)",
    )
  })

  test("names a follow-up filed by a ticket outside the scope that an earlier run left unmerged", async () => {
    const result = await run(
      [
        { id: "x", status: "closed", labels: [unmergedLabel] },
        { id: "t" },
        { id: "t.1", parent: "t", dependencies: filedBy("x") },
      ],
      endOf("t"),
    )
    expect(result).toBe(
      "SCOPE_OPEN: t: 1 of its 1 subticket not done: " +
        "t.1 (filed by x's worker; x is closed but not merged)",
    )
  })

  test("names the scope's own ticket when it is the follow-up left", async () => {
    const result = await run(
      [
        { id: "x", status: "closed", labels: [unmergedLabel] },
        { id: "t", dependencies: filedBy("x") },
        { id: "t.1", parent: "t", status: "closed" },
      ],
      endOf("t"),
    )
    expect(result).toBe(
      "SCOPE_OPEN: t: its 1 subticket is merged, " +
        "but t itself is not done (filed by x's worker; x is closed but not merged)",
    )
  })

  test("says not started once the ticket that filed it is merged", async () => {
    const result = await run(
      [
        { id: "x", status: "closed" },
        { id: "t" },
        { id: "t.1", parent: "t", dependencies: filedBy("x") },
      ],
      endOf("t"),
    )
    expect(result).toBe("SCOPE_OPEN: t: 1 of its 1 subticket not done: t.1 (not started)")
  })
})
