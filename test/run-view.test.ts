import { describe, expect, test } from "bun:test"
import { Effect, Layer, Queue, Ref, Result, type Scope, Stream, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import { WorkerState } from "../src/agent/WorkerState.ts"
import { makeCommands, offer, resolve, UiCommand } from "../src/run/commands.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import { emptyState, emptyTallies, Ledger, type State } from "../src/run/ledger.ts"
import type { Log } from "../src/run/log.ts"
import { Cause, Detail, type TicketPhase } from "../src/run/phase.ts"
import {
  emptyStatus,
  type Inputs,
  interval,
  make,
  ordinal,
  project,
  type RunView,
  type Status,
} from "../src/run/runView.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"
import { sanitizeLine } from "../src/ui/sanitize.ts"

type Env = Ledger | Log | EventStream | Captured | Scope.Scope

/** Runs `effect` with the ledger over captured logs and events, under TestClock, in a scope. */
const run = <A, E>(effect: Effect.Effect<A, E, Env>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(ledgerLayer().pipe(Layer.provideMerge(TestClock.layer()))),
    ),
  )

/** Moves `ticket` by each of `causes` in turn, failing the test on an invalid one. */
const go = (ticket: string, ...causes: ReadonlyArray<Cause>) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    for (const [i, cause] of causes.entries()) {
      const options = i === 0 ? { title: `Title of ${ticket}` } : {}
      const next = yield* ledger.transition(ticket, cause, options)
      if (Result.isFailure(next)) throw new Error(next.failure.phaseBug(ticket))
    }
  })

const dispatched = [Cause.Ready(), Cause.Dispatched()] as const
const toMerge = [...dispatched, Cause.Verified({ place: 1 })] as const
const merging = [...toMerge, Cause.ItsTurn()] as const

const permission = (id: string, ticket: string, defaultToNo = false): AttentionRequest => ({
  id,
  ticket,
  kind: {
    _tag: "Permission",
    tool: "Bash",
    input: { command: "rm -rf build" },
    suggestions: [],
    summary: "rm -rf build",
  },
  defaultToNo,
  suppressAlwaysAllowRule: false,
  createdAt: 0,
})

const inputs = (ledger: State, over: Partial<Omit<Inputs, "ledger">> = {}): Inputs => ({
  ledger,
  workers: new Map(),
  requests: [],
  status: { ...emptyStatus, branch: "main", concurrency: 3 },
  ...over,
})

const current = Effect.flatMap(Ledger, (ledger) => ledger.current)

/** Lets forked fibers run, without moving the clock. */
const flush = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow
})

describe("totals", () => {
  test("count each phase as § 5.1 does, and Needs you each ticket once", async () => {
    const view = await run(
      Effect.gen(function* () {
        yield* go("queued", Cause.Ready())
        yield* go("held", Cause.Ready(), Cause.Held({ why: "overlap" }))
        yield* go("working", ...dispatched)
        yield* go("asking", ...dispatched)
        yield* go("needs", ...dispatched)
        yield* go("to-merge", ...toMerge)
        yield* go("merging", ...merging)
        yield* go("merged", ...merging, Cause.FastForwarded({ commit: "abc1234def" }))
        yield* go("no-change", ...dispatched, Cause.NoChange())
        yield* go("asked", ...dispatched, Cause.FiledQuestion({ question: "q-1" }))
        yield* go("blocked", ...merging, Cause.Block({ why: "MERGE_CONFLICT" }))
        yield* go("deferred", ...dispatched, Cause.Defer({ why: "BAD_TICKET_ID" }))
        yield* go("review", ...dispatched, Cause.Aside({ why: "OFF_BRANCH" }))
        yield* go("stopped", ...dispatched, Cause.StopRun({ why: "PAUSED" }))
        yield* go("waiting", ...dispatched, Cause.WaitsForMerge({ for: "x-1" }))
        yield* go("fixing", ...merging, Cause.CheckHandedBack({ attempt: 1 }))
        // asking has two open requests; needs's worker waits on you without one.
        return project(
          inputs(yield* current, {
            requests: [permission("r1", "asking"), permission("r2", "asking")],
            workers: new Map([["needs", WorkerState.NeedsYou({ requests: 1 })]]),
          }),
        )
      }),
    )
    expect(view.totals).toEqual({
      completed: 2,
      deferred: 1,
      review: 1,
      triaged: 0,
      needsYou: 4,
      workers: 4,
      slots: 3,
      queued: 1,
      unclosed: null,
      heldBack: 1,
      setupFailed: 0,
      queueHeld: false,
    })
    const status = (ticket: string) => {
      const row = view.rows.find((each) => each.ticket === ticket)
      return row === undefined ? undefined : `${row.mark} ${row.word}`
    }
    expect(status("queued")).toBeUndefined()
    expect(status("held")).toBeUndefined()
    expect(status("working")).toBe("▶ starting")
    expect(status("asking")).toBe("■ allow?")
    expect(status("needs")).toBe("■ allow?")
    expect(status("to-merge")).toBe("◼ to merge")
    expect(status("merging")).toBe("◆ merging")
    expect(status("merged")).toBe("✓ done")
    expect(status("asked")).toBe("? for you")
    expect(status("blocked")).toBe("■ blocked")
    expect(status("deferred")).toBe("↷ deferred")
    expect(status("review")).toBe("! review")
    expect(status("stopped")).toBe("■ stopped")
    expect(status("waiting")).toBe("◷ waiting")
    expect(status("fixing")).toBe("⟳ fixing")
    expect(view.rows.find((row) => row.ticket === "merged")?.note).toBe("abc1234 merged into main")
    // Cards for the phases with work under way only.
    expect(view.cards.map((card) => card.ticket).sort()).toEqual(
      ["asking", "fixing", "merging", "needs", "to-merge", "working"].sort(),
    )
    const asking = view.cards.find((card) => card.ticket === "asking")
    expect(asking?.status).toBe("permission — waiting for you (2)")
    expect(asking?.motion).toBe("•")
    expect(view.cards.find((card) => card.ticket === "to-merge")?.status).toBe("to merge (1st)")
    expect(view.cards.find((card) => card.ticket === "merging")?.action).toBe("rebasing onto main")
  })

  test("rows keep the order the run picked their tickets up in, but as they leave Current", async () => {
    const view = await run(
      Effect.gen(function* () {
        yield* go("b", Cause.Ready())
        yield* go("a", ...dispatched)
        yield* go("c", ...dispatched)
        const ledger = yield* Ledger
        yield* ledger.transition("b", Cause.Dispatched())
        yield* ledger.transition("a", Cause.WaitsForMerge({ for: "c" }))
        yield* ledger.transition("a", Cause.Requeued())
        return project(inputs(yield* current))
      }),
    )
    // b's row came after c's; a, leaving Current to wait for c, moved to the end, and came back to
    // Queued keeping its row.
    expect(view.rows.map((row) => `${row.ticket} ${row.word}`)).toEqual([
      "c starting",
      "b starting",
      "a queued",
    ])
  })

  test("titles are sanitised where they enter RunView", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (title) => {
        const entry = {
          ticket: "t",
          title,
          phase: { _tag: "Working", activity: "working" } as TicketPhase,
          since: 0,
          worker: 1,
          row: 0,
          rechecking: false,
          steered: false,
          lastMessage: null,
          tallies: emptyTallies,
        }
        const view = project(inputs({ ...emptyState, tickets: new Map([["t", entry]]) }))
        expect(view.rows[0]?.title).toBe(sanitizeLine(title))
        expect(view.cards[0]?.title).toBe(sanitizeLine(title))
      }),
    )
  })
})

describe("worker numbers", () => {
  test("a new worker takes the lowest free number, and numbers never shift", async () => {
    const numbers = await run(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        const workers = (state: State) =>
          Object.fromEntries([...state.tickets.values()].map((e) => [e.ticket, e.worker]))
        yield* go("t1", ...dispatched)
        yield* go("t2", ...dispatched)
        yield* go("t3", ...dispatched)
        const first = workers(yield* current)
        yield* ledger.transition("t2", Cause.NoChange())
        yield* ledger.transition("t1", Cause.Verified({ place: 1 }))
        const second = workers(yield* current)
        yield* go("t4", ...dispatched)
        yield* go("t5", ...dispatched)
        const third = workers(yield* current)
        yield* ledger.transition("t1", Cause.ItsTurn())
        yield* ledger.transition("t1", Cause.CheckHandedBack({ attempt: 1 }))
        yield* ledger.transition("t1", Cause.Aside({ why: "CHECKS_FAILED" }))
        yield* ledger.transition("t3", Cause.Defer({ why: "deferred by its worker" }))
        yield* go("t6", ...dispatched)
        const fourth = workers(yield* current)
        const view = project(inputs(yield* current))
        return { first, second, third, fourth, cards: view.cards.map((c) => c.worker) }
      }),
    )
    expect(numbers.first).toEqual({ t1: 1, t2: 2, t3: 3 })
    expect(numbers.second).toEqual({ t1: 1, t2: null, t3: 3 })
    expect(numbers.third).toEqual({ t1: 1, t2: null, t3: 3, t4: 2, t5: 4 })
    // t1, set aside after a failed check that may be checked again, keeps its session's number.
    expect(numbers.fourth).toEqual({ t1: 1, t2: null, t3: null, t4: 2, t5: 4, t6: 3 })
    expect(numbers.cards).toEqual([2, 3, 4])
  })
})

describe("identity", () => {
  test("unchanged parts keep their identity", async () => {
    const result = await run(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        yield* go("a", ...dispatched)
        yield* go("b", ...dispatched)
        yield* go("c", ...merging, Cause.FastForwarded({ commit: "abc1234" }))
        const first = project(inputs(yield* current))
        const again = project(inputs(yield* current), first)
        yield* ledger.refine("a", Detail.Activity({ activity: "editing" }))
        const second = project(inputs(yield* current), first)
        const working = new Map([["b", WorkerState.Working({ doing: "testing" })]])
        const third = project(inputs(yield* current, { workers: working }), second)
        return { first, again, second, third }
      }),
    )
    const { first, again, second, third } = result
    const row = (view: RunView, ticket: string) => view.rows.find((r) => r.ticket === ticket)
    const card = (view: RunView, ticket: string) => view.cards.find((c) => c.ticket === ticket)
    expect(again).toBe(first)
    expect(second).not.toBe(first)
    expect(row(second, "a")).not.toBe(row(first, "a"))
    expect(row(second, "a")?.word).toBe("editing")
    expect(row(second, "b")).toBe(row(first, "b"))
    expect(row(second, "c")).toBe(row(first, "c"))
    expect(card(second, "b")).toBe(card(first, "b"))
    expect(second.totals).toBe(first.totals)
    expect(second.hint).toBe(first.hint)
    expect(second.requests).toBe(first.requests)
    expect(row(third, "a")).toBe(row(second, "a"))
    expect(card(third, "a")).toBe(card(second, "a"))
    expect(card(third, "b")).not.toBe(card(second, "b"))
    expect(card(third, "b")?.status).toBe("testing")
  })
})

describe("a failed turn's card", () => {
  test("shows stopped for an interrupt and failed for another error", async () => {
    const statuses = await run(
      Effect.gen(function* () {
        yield* go("a", ...dispatched)
        yield* go("b", ...dispatched)
        const workers = new Map([
          ["a", WorkerState.Failed({ at: 0, error: "interrupted", interrupted: true })],
          ["b", WorkerState.Failed({ at: 0, error: "API Error: 401", interrupted: false })],
        ])
        const view = project(inputs(yield* current, { workers }))
        return view.cards.map((c) => [c.ticket, c.status])
      }),
    )
    expect(statuses).toEqual([
      ["a", "stopped"],
      ["b", "failed"],
    ])
  })
})

describe("the 30 Hz throttle", () => {
  test("writes the first change at once and the latest of a burst after the interval", async () => {
    const result = await run(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        yield* go("a", ...dispatched)
        const status = yield* SubscriptionRef.make<Status>({ ...emptyStatus, concurrency: 2 })
        const view = yield* make({
          ledger: ledger.changes,
          workers: Stream.make(new Map()),
          requests: Stream.make([]),
          status: SubscriptionRef.changes(status),
        })
        const seen = yield* Ref.make<ReadonlyArray<RunView>>([])
        yield* SubscriptionRef.changes(view).pipe(
          Stream.runForEach((each) => Ref.update(seen, (all) => [...all, each])),
          Effect.forkScoped,
        )
        yield* flush
        const atOnce = (yield* Ref.get(seen)).length
        const activities = ["editing", "reading", "testing", "editing", "reading"] as const
        for (const activity of activities) {
          yield* ledger.refine("a", Detail.Activity({ activity }))
        }
        yield* flush
        const duringBurst = (yield* Ref.get(seen)).length
        yield* TestClock.adjust(interval)
        yield* flush
        const afterBurst = yield* Ref.get(seen)
        // A change every 10 ms for a second renders at most 30 times, and the last change shows.
        for (let i = 0; i < 100; i++) {
          yield* ledger.refine(
            "a",
            Detail.Activity({ activity: i % 2 === 0 ? "reading" : "editing" }),
          )
          yield* TestClock.adjust("10 millis")
        }
        yield* ledger.refine("a", Detail.Activity({ activity: "testing" }))
        yield* TestClock.adjust("1 second")
        yield* flush
        const all = yield* Ref.get(seen)
        return { atOnce, duringBurst, afterBurst, rendered: all.length - afterBurst.length, all }
      }),
    )
    // The empty view, then the first projection at once.
    expect(result.atOnce).toBe(2)
    expect(result.duringBurst).toBe(2)
    expect(result.afterBurst.length).toBe(3)
    expect(result.afterBurst[2]?.rows[0]?.word).toBe("reading")
    expect(result.rendered).toBeLessThanOrEqual(32)
    expect(result.rendered).toBeGreaterThan(10)
    expect(result.all.at(-1)?.rows[0]?.word).toBe("testing")
  })
})

describe("transitions", () => {
  test("a valid one writes its phase record, then the records beside it", async () => {
    const records = await run(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        yield* ledger.transition("a", Cause.Ready(), { title: "A" })
        yield* ledger.transition("a", Cause.Dispatched(), {
          beside: [
            { kind: "dispatch", ticket: "a", title: "A", n: 1, limit: 0, queued: 0, text: "[1] a" },
          ],
        })
        yield* ledger.transition("a", Cause.Verified({ place: 2 }))
        return yield* (yield* Captured).records
      }),
    )
    expect(records.map((r) => r.kind)).toEqual(["phase", "phase", "dispatch", "phase"])
    expect(records[0]).toMatchObject({ kind: "phase", ticket: "a", to: "Queued", cause: "Ready" })
    expect(records[0]).not.toHaveProperty("from")
    expect(records[1]).toMatchObject({ from: "Queued", to: "Working", cause: "Dispatched" })
    expect(records[3]).toMatchObject({ from: "Working", to: "ToMerge", place: 2 })
  })

  test("an invalid one logs PHASE_BUG once, writes no record, and keeps the phase", async () => {
    const result = await run(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        yield* ledger.transition("a", Cause.Ready())
        const first = yield* ledger.transition("a", Cause.ItsTurn(), {
          beside: [{ kind: "info", ticket: "a", text: "never written" }],
        })
        const second = yield* ledger.transition("a", Cause.ItsTurn())
        const refined = yield* ledger.refine("a", Detail.Step({ step: "check" }))
        const state = yield* current
        return {
          first,
          second,
          refined,
          phase: state.tickets.get("a")?.phase._tag,
          bugs: state.bugs,
          lines: yield* texts,
          records: yield* (yield* Captured).records,
        }
      }),
    )
    expect(Result.isFailure(result.first)).toBe(true)
    expect(Result.isFailure(result.second)).toBe(true)
    expect(Result.isFailure(result.refined)).toBe(true)
    expect(result.phase).toBe("Queued")
    expect(result.lines).toEqual([
      "  PHASE_BUG: a Queued → Merging (ItsTurn)",
      "  PHASE_BUG: a Queued → Queued (Step)",
    ])
    expect(result.bugs).toEqual(result.lines)
    expect(result.records.map((r) => r.kind)).toEqual(["phase"])
  })

  test("tallies count per ticket", async () => {
    const tallies = await run(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        yield* go("a", ...dispatched)
        yield* ledger.count("a", "compactions")
        yield* ledger.count("a", "compactions")
        yield* ledger.count("a", "messages", 3)
        yield* ledger.count("unknown", "messages")
        return (yield* current).tickets.get("a")?.tallies
      }),
    )
    expect(tallies).toEqual({ messages: 3, compactions: 2 })
  })
})

describe("wind-down and hint", () => {
  test("the wind-down marks the tickets running as it began; the hint names the keys", async () => {
    const result = await run(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        yield* go("a", ...dispatched)
        yield* go("b", ...dispatched)
        yield* go("c", ...dispatched)
        yield* go("q", Cause.Ready())
        const before = project(inputs(yield* current, { requests: [permission("r1", "c", true)] }))
        yield* ledger.windDown
        yield* ledger.transition("a", Cause.NoChange())
        yield* ledger.transition("b", Cause.WaitsForMerge({ for: "x" }))
        const during = project(inputs(yield* current))
        yield* ledger.windUp
        const after = project(inputs(yield* current), during)
        return { before, during, after }
      }),
    )
    const hint = (view: RunView) => view.hint.map((key) => `${key.keys} ${key.does}`).join(" · ")
    expect(result.before.windDown).toBeNull()
    expect(hint(result.before)).toBe(
      "Tab select · 1–3 open · d deny · s stop after current · ? keys",
    )
    expect(result.during.windDown).toEqual({
      marks: [
        { ticket: "a", mark: "done" },
        { ticket: "b", mark: "faint" },
        { ticket: "c", mark: "windingDown" },
      ],
      running: 1,
    })
    expect(result.during.totals.queueHeld).toBe(true)
    expect(hint(result.during)).toBe("Tab select · 1–3 open · s keep taking tickets · ? keys")
    expect(result.after.windDown).toBeNull()
    expect(result.after.totals.queueHeld).toBe(false)
  })

  test("ordinals", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "101st",
      "111th",
    ])
  })
})

describe("commands", () => {
  test("carry IDs the run loop resolves against current state", async () => {
    const result = await run(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        yield* go("a", ...dispatched)
        yield* go("b", ...dispatched)
        yield* ledger.transition("a", Cause.NoChange())
        const state = yield* current
        const now = { ledger: state, requests: [permission("r1", "b")] }
        const commands = yield* makeCommands
        offer(commands, UiCommand.OpenWorker({ worker: 2 }))
        offer(commands, UiCommand.Quit({ now: true }))
        const taken = [yield* Queue.take(commands), yield* Queue.take(commands)]
        return {
          taken: taken.map((command) => command._tag),
          open2: resolve(UiCommand.OpenWorker({ worker: 2 }), now),
          open1: resolve(UiCommand.OpenWorker({ worker: 1 }), now),
          answer: resolve(UiCommand.Answer({ requestId: "r1", answer: { _tag: "Deny" } }), now),
          answered: resolve(UiCommand.Answer({ requestId: "r9", answer: { _tag: "Deny" } }), now),
          message: resolve(UiCommand.SendMessage({ ticket: "a", text: "hi", uuid: "u-1" }), now),
          drain: resolve(UiCommand.Drain(), now),
        }
      }),
    )
    const ticket = (r: (typeof result)["open2"]) =>
      Result.isSuccess(r) ? r.success.ticket : `stale: ${r.failure.why}`
    expect(result.taken).toEqual(["OpenWorker", "Quit"])
    expect(ticket(result.open2)).toBe("b")
    // a finished, so worker 1 is free: a key pressed for it reaches nobody.
    expect(ticket(result.open1)).toBe("stale: no worker 1")
    expect(ticket(result.answer)).toBe("b")
    expect(ticket(result.answered)).toBe("stale: request r9 is no longer open")
    expect(ticket(result.message)).toBe("stale: a has no worker")
    expect(ticket(result.drain)).toBeNull()
  })
})
