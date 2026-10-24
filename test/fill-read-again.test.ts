// A fill whose bd ready fails is read again (schedule.ts's fillTrying, readAgain): each failed read
// that is made again is said so, with its number; the one that gives up isn't, and the fill fails
// with bd's error. Run under TestClock, moved on readAgainAfter at a time.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import { layer as runFibersLayer } from "../src/run/fibers.ts"
import { make, readAgainAfter, readTries } from "../src/run/schedule.ts"
import type { Issue } from "../src/services/Beads.ts"
import { Backlog, layer as beadsLayer } from "../src/testing/Beads.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"

interface Filled {
  readonly exit: Exit.Exit<unknown, unknown>
  readonly started: ReadonlyArray<string>
  /** The lines that say the queue is read again. */
  readonly again: ReadonlyArray<string>
}

/** Fills once, a ticket t-1 ready, bd ready failing `times` times first. */
const fills = (times: number): Promise<Filled> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Ref.make<ReadonlyArray<string>>([])
      const never = yield* Deferred.make<void>()
      const schedule = yield* make({
        concurrent: 1,
        limit: 40,
        scope: null,
        excludeTypes: ["epic"],
        start: {
          start: (issue: Issue) =>
            Effect.andThen(
              Ref.update(started, (all) => [...all, issue.id]),
              Deferred.await(never),
            ),
        },
      })
      yield* (yield* Backlog).fail("ready", { times, stderr: "database is locked" })
      const fiber = yield* Effect.forkChild(Effect.exit(schedule.fillTrying))
      for (let i = 0; i < 20 && fiber.pollUnsafe() === undefined; i++) {
        yield* TestClock.adjust(readAgainAfter)
      }
      const exit = yield* Fiber.join(fiber)
      const again = (yield* texts).filter((text) => text.includes("could not read the queue"))
      return { exit, started: yield* Ref.get(started), again } satisfies Filled
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(beadsLayer([{ id: "t-1" }]), ledgerLayer(), runFibersLayer).pipe(
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

describe("a fill whose bd ready fails", () => {
  test("once: says so, reads it again, and fills", async () => {
    const filled = await fills(1)
    expect(Exit.isSuccess(filled.exit)).toBe(true)
    expect(filled.started).toEqual(["t-1"])
    expect(filled.again).toEqual([
      `could not read the queue (try 1 of ${readTries}), reading it again: database is locked`,
    ])
  })

  test(`every time: read ${readTries} times, the last not said to be read again`, async () => {
    const filled = await fills(Infinity)
    expect(Exit.isFailure(filled.exit)).toBe(true)
    expect(filled.started).toEqual([])
    expect(filled.again).toEqual(
      Array.from(
        { length: readTries - 1 },
        (_, i) =>
          `could not read the queue (try ${i + 1} of ${readTries}), reading it again: database is locked`,
      ),
    )
  })
})
