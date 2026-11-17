// A push to Linear holds the pulls' sync for bd's push alone (tutti-ecg4): not while it reads the
// ticket, nor while a start waits for its worker's claim, nor for a ticket read and never pushed,
// so that a pull during the run is held off no longer than a push takes.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer, Option, type Scope, Semaphore } from "effect"
import { TestClock } from "effect/testing"
import type { Log } from "../src/core/log.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import { LinearPushTimes, type LinearPushes, make } from "../src/run/linearPush.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import type { EventStream } from "../src/services/EventStream.ts"
import { layer as beadsLayer, type LinearSeed, linearUrl, type Seed } from "../src/testing/Beads.ts"
import { type Captured, layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"

type Env = Beads | Log | EventStream | Captured | RunFibers | Scope.Scope

/** A ticket linked to the Linear issue NOE-1, from before the run, open in both. */
const linked: Seed = {
  id: "t-1",
  externalRef: linearUrl("NOE-1"),
  createdAt: "1969-12-31T00:00:00.000Z",
}
/** A ticket from before the run, linked to nothing: never pushed. */
const backlog: Seed = { id: "t-2", createdAt: "1969-12-31T00:00:00.000Z" }
const team: ReadonlyArray<LinearSeed> = [{ key: "NOE-1", title: "t-1" }]

const within = <A, E>(effect: Effect.Effect<A, E, Env>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          beadsLayer([linked, backlog], { linearTeam: { issues: team } }),
          logLayer(),
          eventsLayer(),
          runFibersLayer,
        ).pipe(Layer.provideMerge(TestClock.layer())),
      ),
    ),
  )

/** Lets forked fibers run a while, without moving the clock. */
const settle = Effect.gen(function* () {
  for (let i = 0; i < 500; i++) yield* Effect.yieldNow
})

/** Lets forked fibers run, without moving the clock, until `pushes` has nothing queued. */
const idle = (pushes: LinearPushes) =>
  Effect.gen(function* () {
    for (let i = 0; i < 5000 && (yield* pushes.busy); i++) yield* Effect.yieldNow
  })

const lines = Effect.map(texts, (all) => all.filter((text) => /LINEAR/.test(text)))

/**
 * The pushes, with bd's reads of a ticket answered only once `read` is done, and the number of
 * bd's pushes asked for.
 */
const pushesWith = (sync: Semaphore.Semaphore, read: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    const beads = yield* Beads
    let asked = 0
    const pushes = yield* make({ since: 0, sync }).pipe(
      Effect.provideService(Beads, {
        ...beads,
        show: (id) => Effect.andThen(Deferred.await(read), beads.show(id)),
        linearPush: (ids) =>
          Effect.suspend(() => {
            asked++
            return beads.linearPush(ids)
          }),
      }),
    )
    return { pushes, asked: () => asked }
  })

// The pulls during the run take the sync only if it is free (linearPull.ts).
const pull = (sync: Semaphore.Semaphore) =>
  Effect.map(sync.withPermitsIfAvailable(1)(Effect.void), Option.isSome)

describe("a push holds the sync for bd's push alone", () => {
  test("a pull goes through while a start reads its ticket and waits for its claim", async () => {
    const seen = await within(
      Effect.gen(function* () {
        const sync = yield* Semaphore.make(1)
        const read = yield* Deferred.make<void>()
        const { pushes, asked } = yield* pushesWith(sync, read)
        yield* pushes.changed("t-1" as TicketId, "started")
        yield* settle
        const whileReading = yield* pull(sync)
        yield* Deferred.succeed(read, undefined)
        yield* idle(pushes)
        // Open still: the start waits for the worker's claim, read again every claimPoll.
        const whileWaiting = yield* pull(sync)
        yield* TestClock.adjust(LinearPushTimes.claimPoll)
        yield* idle(pushes)
        const whileStillWaiting = { pull: yield* pull(sync), asked: asked() }
        yield* Effect.orDie((yield* Beads).update("t-1" as TicketId, { claim: true }))
        yield* TestClock.adjust(LinearPushTimes.claimPoll)
        yield* idle(pushes)
        return {
          whileReading,
          whileWaiting,
          whileStillWaiting,
          asked: asked(),
          lines: yield* lines,
        }
      }),
    )
    expect(seen).toEqual({
      whileReading: true,
      whileWaiting: true,
      whileStillWaiting: { pull: true, asked: 0 },
      asked: 1,
      lines: ["  LINEAR: t-1 started, pushed to NOE-1 (updated)"],
    })
  })

  test("a ticket read and never pushed holds no sync", async () => {
    const seen = await within(
      Effect.gen(function* () {
        const sync = yield* Semaphore.make(1)
        const read = yield* Deferred.make<void>()
        const { pushes, asked } = yield* pushesWith(sync, read)
        yield* pushes.changed("t-2" as TicketId, "closed")
        yield* settle
        const whileReading = yield* pull(sync)
        yield* Deferred.succeed(read, undefined)
        yield* idle(pushes)
        return { whileReading, asked: asked(), lines: yield* lines }
      }),
    )
    expect(seen).toEqual({ whileReading: true, asked: 0, lines: [] })
  })
})
