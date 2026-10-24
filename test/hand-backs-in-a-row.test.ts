// A ticket's hand-backs count by their cause (§ 10): a second check hand-back in a row, Fixing to
// Fixing, counts as one more fix, as one from Resolving to Fixing does.
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Ledger } from "../src/run/ledger.ts"
import { Cause } from "../src/run/phase.ts"
import { Captured, layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as spendingLayer } from "../src/testing/Spending.ts"

/** The ledger over Spending and captured records, under TestClock: `causes` moving t-1. */
const moved = (causes: ReadonlyArray<Cause>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const ledger = yield* Ledger
      for (const cause of causes) {
        yield* Effect.andThen(
          TestClock.adjust(1000),
          ledger.transition("t-1", cause, { title: "T" }),
        )
      }
      yield* ledger.transition("t-1", Cause.FastForwarded({ commit: "abc1234" }), {
        beside: [{ kind: "closed", ticket: "t-1", title: "T", text: "  t-1 closed" }],
      })
      return yield* (yield* Captured).records
    }).pipe(
      Effect.provide(
        Ledger.layer.pipe(
          Layer.provideMerge(spendingLayer()),
          Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer(), TestClock.layer())),
        ),
      ),
    ),
  )

const merging = [
  Cause.Ready(),
  Cause.Dispatched(),
  Cause.Verified({ place: 1 }),
  Cause.ItsTurn(),
] as const

describe("hand-backs in a row", () => {
  test("a second check hand-back while Fixing counts as another fix", async () => {
    const records = await moved([
      ...merging,
      Cause.CheckHandedBack({ attempt: 1 }),
      Cause.CheckHandedBack({ attempt: 2 }),
      Cause.Verified({ place: 1 }),
      Cause.ItsTurn(),
    ])
    const hand_backs = { resolve: 0, fix: 2 }
    expect(records.find((r) => r.kind === "closed")).toMatchObject({ hand_backs })
    expect(records.find((r) => r.kind === "ticket_end")).toMatchObject({ hand_backs })
  })

  test("a check hand-back after a resolution counts as a fix, beside the resolve", async () => {
    const records = await moved([
      ...merging,
      Cause.ConflictsHandedBack({ attempt: 1 }),
      Cause.CheckHandedBack({ attempt: 1 }),
      Cause.CheckHandedBack({ attempt: 2 }),
      Cause.Verified({ place: 1 }),
      Cause.ItsTurn(),
    ])
    expect(records.find((r) => r.kind === "ticket_end")).toMatchObject({
      hand_backs: { resolve: 1, fix: 2 },
    })
  })
})
