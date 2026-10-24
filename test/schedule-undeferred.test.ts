import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"
import type { EventStream } from "../src/run/eventstream.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import { openGate, stopFor } from "../src/run/holds.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { Log } from "../src/run/log.ts"
import { Move, type PhaseTag } from "../src/run/phase.ts"
import { make } from "../src/run/schedule.ts"
import { Beads, type Issue } from "../src/services/Beads.ts"
import { type Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"
import { filling } from "./filling.ts"

// A ticket set aside (Deferred) whose notes say to bring it back with bd undefer is taken again
// in the same run once it is: gone from bd ready, then back in it, it is Queued again
// (Undeferred) and dispatched. One bd couldn't defer, which bd ready still lists, stays out.

type Env = Beads | Backlog | Ledger | Log | EventStream | Captured | RunFibers | Scope.Scope

const layers = (seeds: ReadonlyArray<Seed>) =>
  Layer.mergeAll(beadsLayer(seeds), ledgerLayer(), runFibersLayer).pipe(
    Layer.provideMerge(TestClock.layer()),
  )

const run = <A, E>(seeds: ReadonlyArray<Seed>, effect: Effect.Effect<A, E, Env>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(layers(seeds))))

/** Lets forked fibers run, without moving the clock. */
const flush = Effect.gen(function* () {
  for (let i = 0; i < 50; i++) yield* Effect.yieldNow
})

/** The next ready poll, and what it set off. */
const poll = Effect.andThen(TestClock.adjust("30 seconds"), flush)

/**
 * A scheduler whose first start of a ticket sets it aside, deferring it in bd unless `deferFails`,
 * and whose later starts run until the test ends. `starts` lists the tickets handed to their fibers;
 * `hold` sets whether the run holds, taking no tickets.
 */
const scheduler = (options: { readonly deferFails?: boolean } = {}) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const beads = yield* Beads
    const starts = yield* Ref.make<ReadonlyArray<string>>([])
    const held = yield* Ref.make(false)
    const forever = yield* Deferred.make<void>()
    const schedule = yield* make({
      concurrent: 2,
      limit: null,
      scope: null,
      excludeTypes: ["epic"],
      gate: Effect.map(Ref.get(held), (yes) => ({
        ...openGate,
        stop: yes ? stopFor("PAUSED", "paused for a test") : null,
      })),
      start: {
        start: (issue: Issue) =>
          Effect.gen(function* () {
            const before = yield* Ref.getAndUpdate(starts, (all) => [...all, issue.id])
            if (before.includes(issue.id)) return yield* Deferred.await(forever)
            if (options.deferFails !== true) {
              yield* Effect.orDie(beads.defer(issue.id, { reason: "set aside" }))
            }
            yield* ledger.transition(issue.id, Move.Defer({ why: "START_FAILED" }))
          }),
      },
    })
    return { schedule, starts: Ref.get(starts), hold: (yes: boolean) => Ref.set(held, yes) }
  })

const phaseOf = (id: string) =>
  Effect.map(
    Effect.flatMap(Ledger, (ledger) => ledger.current),
    (state): PhaseTag | undefined => state.tickets.get(id)?.phase._tag,
  )

const phaseRecords = (id: string) =>
  Effect.map(
    Effect.flatMap(Captured, (captured) => captured.records),
    (all) =>
      all.flatMap((record) =>
        record.kind === "phase" && record.ticket === id
          ? [`${record.from ?? ""}>${record.to ?? ""} ${record.cause}`]
          : [],
      ),
  )

describe("a ticket set aside, then undeferred during the run", () => {
  test("is queued again and started", async () => {
    const seen = await run(
      [{ id: "t-1" }],
      Effect.gen(function* () {
        const { schedule, starts } = yield* scheduler()
        const beads = yield* Beads
        const fiber = yield* Effect.forkChild(filling(schedule))
        yield* flush
        yield* poll
        const aside = { phase: yield* phaseOf("t-1"), starts: yield* starts }
        yield* beads.update("t-1", { status: "open" })
        yield* poll
        const after = {
          phase: yield* phaseOf("t-1"),
          starts: yield* starts,
          started: yield* schedule.started,
        }
        const records = yield* phaseRecords("t-1")
        const lines = yield* texts
        yield* Fiber.interrupt(fiber)
        return { aside, after, records, lines }
      }),
    )
    expect(seen.aside).toEqual({ phase: "Deferred", starts: ["t-1"] })
    expect(seen.after).toEqual({ phase: "Working", starts: ["t-1", "t-1"], started: 2 })
    expect(seen.records).toEqual([
      ">Queued Ready",
      "Queued>Working Dispatched",
      "Working>Deferred Defer",
      "Deferred>Queued Undeferred",
      "Queued>Working Dispatched",
    ])
    expect(seen.lines).toContain("  t-1: undeferred; back in the queue")
  })

  test("is queued again only once it has left bd ready", async () => {
    const seen = await run(
      [{ id: "t-1" }],
      Effect.gen(function* () {
        const { schedule, starts } = yield* scheduler({ deferFails: true })
        const fiber = yield* Effect.forkChild(filling(schedule))
        yield* flush
        yield* poll
        yield* poll
        const after = { phase: yield* phaseOf("t-1"), starts: yield* starts }
        yield* Fiber.interrupt(fiber)
        return after
      }),
    )
    // bd couldn't defer it: still listed by bd ready, it is kept out of this run.
    expect(seen).toEqual({ phase: "Deferred", starts: ["t-1"] })
  })

  test("is left to an environment hold that reopens it, as the run holds", async () => {
    const seen = await run(
      [{ id: "t-1" }],
      Effect.gen(function* () {
        const { schedule, starts, hold } = yield* scheduler()
        const beads = yield* Beads
        const ledger = yield* Ledger
        const fiber = yield* Effect.forkChild(filling(schedule))
        yield* flush
        yield* poll
        // The hold reopens it in bd, and a poll comes before its Reopened.
        yield* hold(true)
        yield* beads.update("t-1", { status: "open" })
        yield* poll
        const mid = yield* phaseOf("t-1")
        yield* ledger.transition("t-1", Move.Reopened())
        const after = { phase: yield* phaseOf("t-1"), starts: yield* starts }
        const bugs = (yield* texts).filter((text) => text.includes("PHASE_BUG"))
        yield* Fiber.interrupt(fiber)
        return { mid, after, bugs }
      }),
    )
    expect(seen).toEqual({
      mid: "Deferred",
      after: { phase: "Waiting", starts: ["t-1"] },
      bugs: [],
    })
  })

  test("waits for the run to take tickets again", async () => {
    const seen = await run(
      [{ id: "t-1" }],
      Effect.gen(function* () {
        const { schedule, starts, hold } = yield* scheduler()
        const beads = yield* Beads
        const fiber = yield* Effect.forkChild(filling(schedule))
        yield* flush
        yield* poll
        yield* hold(true)
        yield* beads.update("t-1", { status: "open" })
        yield* poll
        const holding = yield* phaseOf("t-1")
        yield* hold(false)
        yield* poll
        const after = { phase: yield* phaseOf("t-1"), starts: yield* starts }
        yield* Fiber.interrupt(fiber)
        return { holding, after }
      }),
    )
    expect(seen).toEqual({
      holding: "Deferred",
      after: { phase: "Working", starts: ["t-1", "t-1"] },
    })
  })
})
