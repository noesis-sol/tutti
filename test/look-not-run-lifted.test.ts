// A look whose fill lifts the merge queue's hold for a check that could not be run (CHECK_NOT_RUN,
// mergequeue.ts' checkableAgain): the turns it lets go on may merge before the look reads the queue
// settled again, freeing what they held back after the fill read it, so the look counts as one a
// merge ended in and the run looks again rather than end (look.ts, verify-scheduler's
// break-no-lifted-look). A look in which the queue holds for the same check still ends the run.
import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Ref } from "effect"
import { TestClock } from "effect/testing"
import { line } from "../src/core/log.ts"
import { Probed } from "../src/run/environment.ts"
import { noHolds, openGate } from "../src/run/holds.ts"
import { make as makeLoop } from "../src/run/look.ts"
import { emptyQueue, type QueueState } from "../src/run/mergequeue.ts"
import { make as makeWakes } from "../src/run/wakes.ts"
import type { TicketId } from "../src/services/Beads.ts"
import type { Sha } from "../src/services/Git.ts"

const held: QueueState = {
  ...emptyQueue,
  waiting: ["a" as TicketId],
  notRun: {
    ticket: "a" as TicketId,
    onto: "0123456789abcdef0123456789abcdef01234567" as Sha,
    why: line`'scripts/check-fast.sh' could not be run (sh: not found) on tutti/a on top of main`,
  },
}

/** Lets forked fibers run, without moving the clock, until `done` or for long enough. */
const until = (done: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 5000 && !(yield* done); i++) yield* Effect.yieldNow
  })

/**
 * Runs the loop over a merge queue holding for a check not run, nothing else running, the first
 * fill doing `first` to the queue: whether the run ended after the first look, and after a second.
 */
const looks = (first: (state: QueueState) => QueueState) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* Ref.make(held)
        const fills = yield* Ref.make(0)
        const wakes = yield* makeWakes
        const loop = yield* makeLoop({
          fill: () =>
            Effect.gen(function* () {
              if ((yield* Ref.getAndUpdate(fills, (n) => n + 1)) === 0) {
                yield* Ref.update(queue, first)
              }
            }),
          wakes,
          gate: Effect.succeed(openGate),
          holds: {
            now: Effect.succeed(noHolds),
            currentStops: Effect.succeed([]),
            changeHolds: () => Effect.succeed(noHolds),
            stopped: () => Effect.void,
          },
          ledger: { current: Effect.succeed({ tickets: new Map(), windDown: null } as never) },
          attention: { current: Effect.succeed([]) },
          scheduler: {
            running: Effect.succeed(new Set()),
            freed: Effect.never,
            ends: Effect.succeed(0),
            interrupt: Effect.void,
          },
          queue: { state: Ref.get(queue), hold: Effect.void },
          triage: { pending: Effect.succeed(0) },
          usage: {
            limited: Effect.succeed(new Set()),
            handBacks: Effect.succeed(new Set()),
            look: () => Effect.succeed(null),
          },
          commands: {
            acted: Effect.succeed(0),
            endAsked: Effect.succeed(false),
            endAfter: () => Effect.succeed(true),
            askEnd: Effect.void,
          },
          environment: { probe: () => Effect.succeed(Probed.Ends()) },
          resuming: Effect.succeed(false),
          answering: Effect.succeed(false),
          showEndOfRun: () => Effect.void,
          dashboard: false,
        })
        const ended = yield* Ref.make(false)
        const fiber = yield* Effect.forkChild(Effect.andThen(loop.untilEnd, Ref.set(ended, true)))
        yield* until(Effect.map(Ref.get(fills), (n) => n > 0))
        yield* until(Ref.get(ended))
        const afterFirst = yield* Ref.get(ended)
        yield* wakes.wakeUp("poll")
        yield* until(Ref.get(ended))
        const afterSecond = yield* Ref.get(ended)
        yield* Fiber.interrupt(fiber)
        return { afterFirst, afterSecond, fills: yield* Ref.get(fills) }
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  )

describe("a look whose fill lifts the hold for a check not run", () => {
  test("its ticket merged before the queue is read again: the run looks again", async () => {
    // The hold lifted, the ticket's turn taken and its merge over, all within the look.
    const ran = await looks(() => emptyQueue)
    expect(ran).toEqual({ afterFirst: false, afterSecond: true, fills: 2 })
  })

  test("the queue holding for the same check still: the run ends at that look", async () => {
    const ran = await looks((state) => state)
    expect(ran).toEqual({ afterFirst: true, afterSecond: true, fills: 1 })
  })
})
