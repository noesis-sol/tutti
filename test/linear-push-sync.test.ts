// Pushes to Linear hold the sync the run's pulls hold (tutti-mwsd): a push waits for a pull under
// way, and a pull during the run finds the sync held while a push is under way and is skipped
// (linearPull.ts), so that a pull never reads a ticket filed in the run as not yet linked while
// its push links it, and imports its issue again.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer, Option, type Scope, Semaphore } from "effect"
import { TestClock } from "effect/testing"
import type { Log } from "../src/core/log.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import { type LinearPushes, make } from "../src/run/linearPush.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import type { EventStream } from "../src/services/EventStream.ts"
import {
  Backlog,
  layer as beadsLayer,
  type LinearSeed,
  linearUrl,
  type Seed,
} from "../src/testing/Beads.ts"
import { type Captured, layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"

type Env = Beads | Backlog | Log | EventStream | Captured | RunFibers | Scope.Scope

const layers = (seeds: ReadonlyArray<Seed>, issues: ReadonlyArray<LinearSeed>) =>
  Layer.mergeAll(
    beadsLayer(seeds, { linearTeam: { issues } }),
    logLayer(),
    eventsLayer(),
    runFibersLayer,
  ).pipe(Layer.provideMerge(TestClock.layer()))

const within = <A, E>(effect: Effect.Effect<A, E, Env>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(layers([linked], team))))

/** Lets forked fibers run a while, without moving the clock. */
const settle = Effect.gen(function* () {
  for (let i = 0; i < 500; i++) yield* Effect.yieldNow
})

/** Lets forked fibers run, without moving the clock, until `pushes` has nothing queued. */
const idle = (pushes: LinearPushes) =>
  Effect.gen(function* () {
    for (let i = 0; i < 5000 && (yield* pushes.busy); i++) yield* Effect.yieldNow
  })

/** A ticket linked to the Linear issue NOE-1, from before the run, open in both. */
const linked: Seed = {
  id: "t-1",
  externalRef: linearUrl("NOE-1"),
  createdAt: "1969-12-31T00:00:00.000Z",
}
const team: ReadonlyArray<LinearSeed> = [{ key: "NOE-1", title: "t-1" }]

const stateOf = (key: string) =>
  Effect.map(
    Effect.flatMap(Backlog, (backlog) => backlog.linearIssues),
    (issues) => issues.find((issue) => issue.key === key)?.state,
  )

const lines = Effect.map(texts, (all) => all.filter((text) => /LINEAR/.test(text)))

describe("pushes and pulls hold one sync", () => {
  test("a push waits while a pull holds the sync, and goes once it is free", async () => {
    const seen = await within(
      Effect.gen(function* () {
        const sync = yield* Semaphore.make(1)
        const pushes = yield* make({ since: 0, sync })
        const beads = yield* Beads
        yield* beads.close("t-1" as TicketId, "done")
        // A pull under way holds the sync until `pulled`.
        const pulled = yield* Deferred.make<void>()
        const pulling = yield* Deferred.make<void>()
        yield* Effect.forkScoped(
          sync.withPermits(1)(
            Effect.andThen(Deferred.succeed(pulling, undefined), Deferred.await(pulled)),
          ),
        )
        yield* Deferred.await(pulling)
        yield* pushes.changed("t-1" as TicketId, "closed")
        yield* settle
        const during = { state: yield* stateOf("NOE-1"), lines: yield* lines }
        yield* Deferred.succeed(pulled, undefined)
        yield* idle(pushes)
        return { during, after: { state: yield* stateOf("NOE-1"), lines: yield* lines } }
      }),
    )
    expect(seen.during).toEqual({ state: "unstarted", lines: [] })
    expect(seen.after).toEqual({
      state: "completed",
      lines: ["  LINEAR: t-1 closed, pushed to NOE-1 (updated)"],
    })
  })

  test("a push under way holds the sync, so a pull finding it held is skipped", async () => {
    const seen = await within(
      Effect.gen(function* () {
        const sync = yield* Semaphore.make(1)
        const beads = yield* Beads
        // Linear answers the push only once `answered`.
        const answered = yield* Deferred.make<void>()
        const pushes = yield* make({ since: 0, sync }).pipe(
          Effect.provideService(Beads, {
            ...beads,
            linearPush: (ids) => Effect.andThen(Deferred.await(answered), beads.linearPush(ids)),
          }),
        )
        yield* beads.close("t-1" as TicketId, "done")
        yield* pushes.changed("t-1" as TicketId, "closed")
        yield* settle
        // The pulls during the run take the sync only if it is free (linearPull.ts).
        const pull = sync.withPermitsIfAvailable(1)(Effect.void)
        const whilePushing = Option.isSome(yield* pull)
        yield* Deferred.succeed(answered, undefined)
        yield* idle(pushes)
        return { whilePushing, afterwards: Option.isSome(yield* pull), lines: yield* lines }
      }),
    )
    expect(seen).toEqual({
      whilePushing: false,
      afterwards: true,
      lines: ["  LINEAR: t-1 closed, pushed to NOE-1 (updated)"],
    })
  })
})
