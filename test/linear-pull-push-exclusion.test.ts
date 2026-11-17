// A run's pulls from Linear and its pushes never run side by side (§ 5 items 19 and 20,
// tutti-311y): a pull every pull_every is skipped while a pull holds the sync or a push is queued
// or under way, and a push waits for a pull under way, as a pull that listed an issue a push had
// created but not yet linked would add a second ticket for it.
import { describe, expect, test } from "bun:test"
import { Duration, Effect, Fiber, Layer, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"
import type { Log } from "../src/core/log.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import type { Ledger } from "../src/run/ledger.ts"
import { type LinearPulls, make as makePulls } from "../src/run/linearPull.ts"
import { type LinearPushes, make as makePushes } from "../src/run/linearPush.ts"
import { sayer } from "../src/run/say.ts"
import { Beads, type TicketId } from "../src/services/Beads.ts"
import type { EventStream } from "../src/services/EventStream.ts"
import { LinearIssues } from "../src/services/LinearIssues.ts"
import {
  Backlog,
  layer as beadsLayer,
  type LinearSeed,
  linearUrl,
  type Seed,
} from "../src/testing/Beads.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { Listings, layer as linearIssuesLayer } from "../src/testing/LinearIssues.ts"
import { texts } from "../src/testing/Log.ts"

type Env = Beads | Backlog | Listings | Ledger | Log | EventStream | RunFibers | Scope.Scope

const minute = Duration.minutes(1)

/** Before the run began: the backlog's history. */
const before = "1969-12-31T00:00:00.000Z"

/** `body` given a run's pulls, every minute, and its pushes holding the pulls' sync. */
const within = <A>(
  seeds: ReadonlyArray<Seed>,
  issues: ReadonlyArray<LinearSeed>,
  body: (pulls: LinearPulls, pushes: LinearPushes) => Effect.Effect<A, unknown, Env>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const source = yield* LinearIssues
      if (source === null) return yield* Effect.die("no LinearIssues source")
      const pulls = yield* makePulls({
        linear: { team: "NOE", pull_every: minute },
        source,
        beads: yield* Beads,
        held: Effect.succeed(new Set<string>()),
        sayer: yield* sayer,
        wakeUp: Effect.void,
      })
      const pushes = yield* makePushes({ since: 0, sync: pulls.busy })
      return yield* body(pulls, pushes)
    }).pipe(
      Effect.scoped,
      Effect.provide(
        linearIssuesLayer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              beadsLayer(seeds, { linearTeam: { issues } }),
              ledgerLayer(),
              runFibersLayer,
            ),
          ),
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

/** Lets forked fibers run a while, without moving the clock. */
const settle = Effect.promise(() => Bun.sleep(5))

/** Moves the clock on a minute, a pull's time, and lets the pulls run. */
const aMinute = Effect.andThen(TestClock.adjust(minute), settle)

const linearLines = Effect.map(texts, (all) => all.filter((text) => /LINEAR/.test(text)))

const listings = Effect.flatMap(Listings, (listings) => listings.asked)

describe("pulls and pushes to Linear", () => {
  test("a pull is skipped while a push is queued or under way", async () => {
    const seen = await within([], [], (pulls) =>
      Effect.gen(function* () {
        const pushing = yield* Ref.make(true)
        const fiber = yield* Effect.forkChild(pulls.every(Ref.get(pushing)))
        yield* settle
        yield* aMinute
        const whilePushing = (yield* listings).length
        yield* Ref.set(pushing, false)
        yield* aMinute
        yield* Fiber.interrupt(fiber)
        return { whilePushing, after: (yield* listings).length, lines: yield* linearLines }
      }),
    )
    expect(seen.whilePushing).toBe(0)
    expect(seen.after).toBe(1)
    expect(seen.lines).toEqual(["LINEAR: pulled from NOE: nothing new"])
  })

  test("a push waits for a pull under way, then pushes", async () => {
    const seen = await within(
      [{ id: "t-1", status: "closed", externalRef: linearUrl("NOE-1"), createdAt: before }],
      [{ key: "NOE-1", title: "t-1" }],
      (pulls, pushes) =>
        Effect.gen(function* () {
          const stateOf = Effect.map(
            Effect.flatMap(Backlog, (backlog) => backlog.linearIssues),
            (issues) => issues.find((issue) => issue.key === "NOE-1")?.state,
          )
          // A pull holds the sync while the ticket closes.
          const during = yield* pulls.busy.withPermits(1)(
            Effect.gen(function* () {
              yield* pushes.changed("t-1" as TicketId, "closed")
              yield* settle
              return {
                busy: yield* pushes.busy,
                state: yield* stateOf,
                lines: yield* linearLines,
              }
            }),
          )
          yield* settle
          return { during, busy: yield* pushes.busy, state: yield* stateOf }
        }),
    )
    expect(seen.during).toEqual({ busy: true, state: "unstarted", lines: [] })
    expect(seen.busy).toBe(false)
    expect(seen.state).toBe("completed")
  })

  test("a ticket filed in the run is pushed after the pull under way, and no pull adds it again", async () => {
    const seen = await within([{ id: "f", title: "A follow-up" }], [], (pulls, pushes) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(pulls.every(pushes.busy))
        yield* settle
        // A pull holds the sync as the ticket is filed, and over the next pull's time.
        yield* pulls.busy.withPermits(1)(
          Effect.andThen(pushes.changed("f" as TicketId, "filed"), aMinute),
        )
        yield* settle
        // The push has gone through: the next pull finds the issue it created linked.
        yield* aMinute
        yield* Fiber.interrupt(fiber)
        const backlog = yield* Backlog
        return {
          listings: (yield* listings).length,
          lines: yield* linearLines,
          tickets: (yield* backlog.issues).map((issue) => [issue.id, issue.linearKey]),
          issues: (yield* backlog.linearIssues).map((issue) => issue.key),
        }
      }),
    )
    expect(seen.listings).toBe(1)
    expect(seen.lines).toEqual([
      "  LINEAR: f filed, pushed to NOE-1 (created)",
      "LINEAR: pulled from NOE: nothing new",
    ])
    expect(seen.tickets).toEqual([["f", "NOE-1"]])
    expect(seen.issues).toEqual(["NOE-1"])
  })
})
