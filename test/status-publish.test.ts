// The run's status publishes only what changes (showOn), and RunView's projection sanitises each
// ledger entry's texts once: each publish projects the whole view.

import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref, Result, type Scope, Stream, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import type { EventStream } from "../src/run/eventstream.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { Log } from "../src/run/log.ts"
import { Move } from "../src/run/phase.ts"
import { emptyStatus, project, type Status, showOn } from "../src/run/runView.ts"
import { same } from "../src/run/same.ts"
import type { TicketId } from "../src/services/Beads.ts"
import type { Captured } from "../src/testing/EventStream.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { sanitizeLine } from "../src/ui/sanitize.ts"

/** Lets forked fibers run, without moving the clock. */
const flush = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow
})

/** What `status` publishes while `writes` runs, after the value it holds at first. */
const published = (
  status: Status,
  writes: (ref: SubscriptionRef.SubscriptionRef<Status>) => Effect.Effect<void>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const ref = yield* SubscriptionRef.make(status)
        const seen = yield* Ref.make<ReadonlyArray<Status>>([])
        yield* SubscriptionRef.changes(ref).pipe(
          Stream.runForEach((each) => Ref.update(seen, (all) => [...all, each])),
          Effect.forkScoped,
        )
        yield* flush
        yield* writes(ref)
        yield* flush
        return (yield* Ref.get(seen)).slice(1)
      }),
    ),
  )

describe("a status write", () => {
  test("of an equal value publishes nothing", async () => {
    const seen = await published(
      {
        ...emptyStatus,
        shared: 2,
        keepAwake: true,
        windows: [{ name: "5h", utilization: 0.5, resetsAt: null }],
      },
      (status) =>
        Effect.gen(function* () {
          yield* showOn(status, "shared")(2)
          yield* showOn(status, "keepAwake")(true)
          // Another array, the same data.
          yield* showOn(status, "windows")([{ name: "5h", utilization: 0.5, resetsAt: null }])
          yield* showOn(status, "probe")(null)
        }),
    )
    expect(seen).toEqual([])
  })

  test("of a changed value publishes it once, keeping the rest", async () => {
    const seen = await published({ ...emptyStatus, unclosed: 3 }, (status) =>
      Effect.gen(function* () {
        yield* showOn(status, "shared")(1)
        yield* showOn(status, "shared")(1)
      }),
    )
    expect(seen.map((each) => [each.shared, each.unclosed])).toEqual([[1, 3]])
  })

  test("sees a Map change, and not the same Map again", async () => {
    const verdicts = new Map([["a", "environment · high"]])
    const seen = await published(emptyStatus, (status) =>
      Effect.gen(function* () {
        const show = showOn(status, "verdicts", Object.is)
        yield* show(verdicts)
        yield* show(verdicts)
        yield* show(new Map(verdicts).set("b", "flaky · low"))
      }),
    )
    expect(seen.map((each) => [...each.verdicts.keys()])).toEqual([["a"], ["a", "b"]])
  })

  test("of a Map compares its entries by default", async () => {
    const seen = await published(
      { ...emptyStatus, verdicts: new Map([["a", "environment"]]) },
      (status) =>
        Effect.gen(function* () {
          const show = showOn(status, "verdicts")
          yield* show(new Map([["a", "environment"]]))
          yield* show(new Map([["a", "flaky"]]))
        }),
    )
    expect(seen.map((each) => each.verdicts.get("a"))).toEqual(["flaky"])
  })
})

describe("same", () => {
  test("compares Maps by their entries", () => {
    expect(same(new Map([["a", [1]]]), new Map([["a", [1]]]))).toBe(true)
    expect(same(new Map([["a", 1]]), new Map([["a", 2]]))).toBe(false)
    expect(same(new Map([["a", 1]]), new Map([["b", 1]]))).toBe(false)
    expect(same(new Map([["a", 1]]), new Map())).toBe(false)
    expect(same({ m: new Map([["a", 1]]) }, { m: new Map() })).toBe(false)
  })

  test("compares Sets by their members", () => {
    expect(same(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true)
    expect(same(new Set(["a"]), new Set(["b"]))).toBe(false)
    expect(same(new Set(["a"]), new Set())).toBe(false)
  })

  test("tells a Map or a Set from an object", () => {
    expect(same(new Map(), {})).toBe(false)
    expect(same({}, new Set())).toBe(false)
    expect(same(new Map(), new Set())).toBe(false)
  })
})

type Env = Ledger | Log | EventStream | Captured | Scope.Scope

/** Runs `effect` with the ledger over captured logs and events, under TestClock, in a scope. */
const run = <A, E>(effect: Effect.Effect<A, E, Env>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(ledgerLayer().pipe(Layer.provideMerge(TestClock.layer()))),
    ),
  )

describe("a ledger entry's texts", () => {
  test("are sanitised anew when the entry changes", async () => {
    const renamedTitle = "Second\u001b[2J"
    const views = await run(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        // A ticket has a row from its dispatch.
        for (const cause of [Move.Ready(), Move.Dispatched()]) {
          const next = yield* ledger.transition("a" as TicketId, cause, { title: "First" })
          if (Result.isFailure(next)) throw new Error(next.failure.phaseBug("a" as TicketId))
        }
        const state = yield* ledger.current
        const status = { ...emptyStatus, branch: "main", concurrency: 1 }
        const inputs = { workers: new Map(), requests: [], status }
        const first = project({ ...inputs, ledger: state })
        const again = project({ ...inputs, ledger: state }, first)
        const entry = state.tickets.get("a" as TicketId)
        if (entry === undefined) throw new Error("no entry for a")
        const renamed = new Map(state.tickets).set("a" as TicketId, {
          ...entry,
          title: renamedTitle,
        })
        const second = project({ ...inputs, ledger: { ...state, tickets: renamed } }, first)
        return { first, again, second }
      }),
    )
    expect(views.first.rows[0]?.title).toBe("First")
    expect(views.again).toBe(views.first)
    expect(views.second.rows[0]?.title).toBe(sanitizeLine(renamedTitle))
    expect(views.second.rows[0]?.title).not.toBe(renamedTitle)
  })
})
