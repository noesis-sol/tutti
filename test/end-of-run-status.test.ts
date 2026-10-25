// The end-of-run box on the run's status (D19): shown in one step with the status's other
// changes, so that a change another fiber makes while it is shown isn't lost.

import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, SubscriptionRef } from "effect"
import { showEndOfRun } from "../src/run/run.ts"
import { emptyStatus, type Status } from "../src/run/runView.ts"
import type { TicketId } from "../src/services/Beads.ts"

const run = <A>(effect: Effect.Effect<A>): Promise<A> => Effect.runPromise(effect)

describe("the end-of-run box on the status", () => {
  test("shows the tickets waiting on you, and hides the box again", async () => {
    const shown = await run(
      Effect.gen(function* () {
        const status = yield* SubscriptionRef.make<Status>({ ...emptyStatus, unclosed: 3 })
        yield* showEndOfRun(status, ["a" as TicketId, "b" as TicketId])
        const boxed = yield* SubscriptionRef.get(status)
        yield* showEndOfRun(status, null)
        return { boxed, hidden: yield* SubscriptionRef.get(status) }
      }),
    )
    expect(shown.boxed.endOfRun).toEqual(["a" as TicketId, "b" as TicketId])
    expect(shown.boxed.unclosed).toBe(3)
    expect(shown.hidden.endOfRun).toBeNull()
  })

  test("leaves the status as it is when the box is the same", async () => {
    const kept = await run(
      Effect.gen(function* () {
        const status = yield* SubscriptionRef.make<Status>({
          ...emptyStatus,
          endOfRun: ["a" as TicketId],
        })
        const before = yield* SubscriptionRef.get(status)
        yield* showEndOfRun(status, ["a" as TicketId])
        return before === (yield* SubscriptionRef.get(status))
      }),
    )
    expect(kept).toBe(true)
  })

  test("keeps a change another fiber makes while the box is shown", async () => {
    const after = await run(
      Effect.gen(function* () {
        const status = yield* SubscriptionRef.make<Status>(emptyStatus)
        const holding = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        // Another fiber's change, under way when the box is shown: the triage's verdicts.
        const verdicts = yield* Effect.forkChild(
          SubscriptionRef.updateEffect(status, (now) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(holding, undefined)
              yield* Deferred.await(release)
              return { ...now, verdicts: new Map([["c", "environment · high"]]) }
            }),
          ),
        )
        yield* Deferred.await(holding)
        const box = yield* Effect.forkChild(showEndOfRun(status, ["a" as TicketId]))
        yield* Effect.yieldNow
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(verdicts)
        yield* Fiber.join(box)
        return yield* SubscriptionRef.get(status)
      }),
    )
    expect(after.endOfRun).toEqual(["a" as TicketId])
    expect([...after.verdicts]).toEqual([["c", "environment · high"]])
  })
})
