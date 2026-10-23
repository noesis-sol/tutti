import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Ref, type Scope, Semaphore } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import type { EventRecord } from "../src/run/events.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { Log } from "../src/run/log.ts"
import { Cause, type PhaseTag } from "../src/run/phase.ts"
import { make, readTries, type Scheduler } from "../src/run/schedule.ts"
import { byPriority, end, ledgerView, line, ready, takes } from "../src/run/scope.ts"
import { Beads, BeadsFailed, type Issue } from "../src/services/Beads.ts"
import { Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"

type Env = Beads | Backlog | Ledger | Log | EventStream | Captured | RunFibers | Scope.Scope

/** The in-memory backlog with `seeds`, the ledger over captured logs and events, and RunFibers. */
const layers = (seeds: ReadonlyArray<Seed>, beads?: Layer.Layer<Beads | Backlog>) =>
  Layer.mergeAll(beads ?? beadsLayer(seeds), ledgerLayer(), runFibersLayer).pipe(
    Layer.provideMerge(TestClock.layer()),
  )

/** Runs `effect` in a scope with `layers`, under TestClock. */
const run = <A, E>(
  seeds: ReadonlyArray<Seed>,
  effect: Effect.Effect<A, E, Env>,
  beads?: Layer.Layer<Beads | Backlog>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(layers(seeds, beads))))

/** Lets forked fibers run, without moving the clock. */
const flush = Effect.gen(function* () {
  for (let i = 0; i < 50; i++) yield* Effect.yieldNow
})

/**
 * A scheduler whose tickets each run until the test finishes them: `started` lists the tickets
 * handed to their fibers, in order, and `finish(id)` ends one's fiber, freeing its slot.
 */
const scheduler = (options: {
  readonly concurrent?: number
  readonly limit?: number
  readonly scope?: string | null
  readonly excludeTypes?: ReadonlyArray<string>
  readonly taking?: Effect.Effect<boolean>
}) =>
  Effect.gen(function* () {
    const started = yield* Ref.make<ReadonlyArray<string>>([])
    const gates = new Map<string, Deferred.Deferred<void>>()
    const gate = (id: string) =>
      Effect.gen(function* () {
        const known = gates.get(id)
        if (known !== undefined) return known
        const made = yield* Deferred.make<void>()
        gates.set(id, made)
        return made
      })
    const schedule: Scheduler = yield* make({
      concurrent: options.concurrent ?? 1,
      limit: options.limit ?? 40,
      scope: options.scope ?? null,
      excludeTypes: options.excludeTypes ?? ["epic"],
      ...(options.taking === undefined ? {} : { taking: options.taking }),
      start: {
        start: (issue: Issue) =>
          Effect.gen(function* () {
            yield* Ref.update(started, (all) => [...all, issue.id])
            yield* Deferred.await(yield* gate(issue.id))
          }),
      },
    })
    const finish = (id: string) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(yield* gate(id), undefined)
        yield* flush
      })
    return { schedule, started: Ref.get(started), finish }
  })

const phaseOf = (id: string) =>
  Effect.map(
    Effect.flatMap(Ledger, (ledger) => ledger.current),
    (state): PhaseTag | undefined => state.tickets.get(id)?.phase._tag,
  )

const records = Effect.flatMap(Captured, (captured) => captured.records)

const recordsOf = (all: ReadonlyArray<EventRecord>, ticket: string) =>
  all.filter((record) => "ticket" in record && record.ticket === ticket)

describe("the candidates", () => {
  test("are dispatched highest priority first, bd's order kept among equals", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "t-1", priority: 3 },
      { id: "t-2", priority: 0 },
      { id: "t-3", priority: 2 },
      { id: "t-4", priority: 0 },
    ]
    const order = await run(
      seeds,
      Effect.gen(function* () {
        const { schedule, started, finish } = yield* scheduler({ concurrent: 1 })
        const fiber = yield* Effect.forkChild(schedule.run)
        yield* flush
        for (const id of ["t-2", "t-4", "t-3"]) yield* finish(id)
        const order = yield* started
        yield* Fiber.interrupt(fiber)
        return order
      }),
    )
    expect(order).toEqual(["t-2", "t-4", "t-3", "t-1"])
  })

  test("leave out questions, the excluded types and epics", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "t-1" },
      { id: "q-1", labels: ["human"] },
      { id: "c-1", type: "chore" },
      { id: "e-1", type: "epic" },
    ]
    const [filled, started, queued] = await run(
      seeds,
      Effect.gen(function* () {
        const { schedule, started } = yield* scheduler({
          concurrent: 4,
          excludeTypes: ["chore"],
        })
        const filled = yield* schedule.fill
        yield* flush
        return [filled, yield* started, yield* phaseOf("q-1")] as const
      }),
    )
    expect(filled.dispatched).toEqual(["t-1"])
    expect(started).toEqual(["t-1"])
    expect(queued).toBeUndefined()
  })

  test("epics stay out with exclude_types empty", async () => {
    const issues = await run(
      [{ id: "e-1", type: "epic" }, { id: "t-1" }],
      Effect.gen(function* () {
        return yield* ready(yield* Beads, null, { excludeTypes: [] })
      }),
    )
    expect(issues.map((issue) => issue.id)).toEqual(["t-1"])
  })

  test("enter the ledger as Queued with a queue record, and go to Working with a dispatch record", async () => {
    const [all, phases] = await run(
      [{ id: "t-1", title: "First" }, { id: "t-2" }],
      Effect.gen(function* () {
        const { schedule } = yield* scheduler({ concurrent: 1 })
        yield* schedule.fill
        return [yield* records, [yield* phaseOf("t-1"), yield* phaseOf("t-2")]] as const
      }),
    )
    expect(phases).toEqual(["Working", "Queued"])
    expect(
      all.map((record) =>
        record.kind === "phase" ? `${record.ticket}:${record.to}` : record.kind,
      ),
    ).toEqual(["t-1:Queued", "queue", "t-2:Queued", "queue", "t-1:Working", "dispatch"])
    const dispatch = all.find((record) => record.kind === "dispatch")
    expect(dispatch).toMatchObject({
      ticket: "t-1",
      title: "First",
      n: 1,
      limit: 40,
      queued: 1,
      text: "[1/40] t-1 dispatching: First",
    })
    const queues = all.filter((record) => record.kind === "queue")
    expect(queues.map((record) => record.kind === "queue" && record.queued)).toEqual([1, 2])
  })
})

describe("the slots", () => {
  test("are filled up to concurrent, and a freed slot is filled at once", async () => {
    const seeds: ReadonlyArray<Seed> = [{ id: "t-1" }, { id: "t-2" }, { id: "t-3" }]
    const [first, second, running] = await run(
      seeds,
      Effect.gen(function* () {
        const { schedule, started, finish } = yield* scheduler({ concurrent: 2 })
        const fiber = yield* Effect.forkChild(schedule.run)
        yield* flush
        const first = yield* started
        yield* finish("t-1")
        const second = yield* started
        const running = yield* schedule.running
        yield* Fiber.interrupt(fiber)
        return [first, second, [...running]] as const
      }),
    )
    expect(first).toEqual(["t-1", "t-2"])
    expect(second).toEqual(["t-1", "t-2", "t-3"])
    expect(running).toEqual(["t-2", "t-3"])
  })

  test("the ready poll every 30 s fills them with tickets that became ready", async () => {
    const [before, after] = await run(
      [],
      Effect.gen(function* () {
        const { schedule, started } = yield* scheduler({ concurrent: 2 })
        const fiber = yield* Effect.forkChild(schedule.run)
        yield* flush
        yield* (yield* Backlog).put({ id: "t-1" })
        yield* TestClock.adjust("29 seconds")
        yield* flush
        const before = yield* started
        yield* TestClock.adjust("1 second")
        yield* flush
        const after = yield* started
        yield* Fiber.interrupt(fiber)
        return [before, after] as const
      }),
    )
    expect(before).toEqual([])
    expect(after).toEqual(["t-1"])
  })

  test("never take a ticket twice", async () => {
    const [started, phases] = await run(
      [{ id: "t-1" }, { id: "t-2" }],
      Effect.gen(function* () {
        const { schedule, started } = yield* scheduler({ concurrent: 4 })
        yield* schedule.fill
        yield* schedule.fill
        // A ticket the run set aside that bd still lists as ready, as after a defer that failed.
        const ledger = yield* Ledger
        yield* ledger.transition("t-1", Cause.Defer({ why: "deferred" }))
        yield* schedule.fill
        yield* flush
        return [yield* started, [yield* phaseOf("t-1"), yield* phaseOf("t-2")]] as const
      }),
    )
    expect(started).toEqual(["t-1", "t-2"])
    expect(phases).toEqual(["Deferred", "Working"])
  })

  test("a carried-over worker takes a slot and counts toward no limit", async () => {
    const [started, count] = await run(
      [{ id: "t-1" }, { id: "t-2" }],
      Effect.gen(function* () {
        const { schedule, started } = yield* scheduler({ concurrent: 2, limit: 1 })
        yield* schedule.carry("c-1", Effect.succeed(Effect.never))
        yield* schedule.fill
        yield* flush
        return [yield* started, yield* schedule.started] as const
      }),
    )
    expect(started).toEqual(["t-1"])
    expect(count).toBe(1)
  })

  test("no new tickets start while the run doesn't take them, or winds down", async () => {
    const [held, wound, after] = await run(
      [{ id: "t-1" }],
      Effect.gen(function* () {
        const open = yield* Ref.make(false)
        const { schedule, started } = yield* scheduler({ taking: Ref.get(open) })
        yield* schedule.fill
        const held = yield* started
        yield* Ref.set(open, true)
        const ledger = yield* Ledger
        yield* ledger.windDown
        yield* schedule.fill
        const wound = yield* started
        yield* ledger.windUp
        yield* schedule.fill
        yield* flush
        return [held, wound, yield* started] as const
      }),
    )
    expect(held).toEqual([])
    expect(wound).toEqual([])
    expect(after).toEqual(["t-1"])
  })
})

describe("--limit", () => {
  test("counts the tickets this run starts, and stops starting them once reached", async () => {
    const seeds: ReadonlyArray<Seed> = [{ id: "t-1" }, { id: "t-2" }, { id: "t-3" }]
    const [order, count, reached, dispatches, phase] = await run(
      seeds,
      Effect.gen(function* () {
        const { schedule, started, finish } = yield* scheduler({ concurrent: 3, limit: 2 })
        const fiber = yield* Effect.forkChild(schedule.run)
        yield* flush
        yield* finish("t-1")
        yield* TestClock.adjust("30 seconds")
        yield* flush
        const order = yield* started
        yield* Fiber.interrupt(fiber)
        const dispatches = (yield* records).flatMap((record) =>
          record.kind === "dispatch" ? [record.text] : [],
        )
        return [
          order,
          yield* schedule.started,
          yield* schedule.limitReached,
          dispatches,
          yield* phaseOf("t-3"),
        ] as const
      }),
    )
    expect(order).toEqual(["t-1", "t-2"])
    expect(count).toBe(2)
    expect(reached).toBe(true)
    expect(dispatches).toEqual(["[1/2] t-1 dispatching: t-1", "[2/2] t-2 dispatching: t-2"])
    expect(phase).toBe("Queued")
  })
})

describe("BAD_TICKET_ID", () => {
  test("sets aside a ticket whose ID can't be a worktree or a branch, without a worker", async () => {
    const [started, phase, issue, lines, all, count] = await run(
      [{ id: "x-../y", title: "Bad" }, { id: "t-1" }],
      Effect.gen(function* () {
        const { schedule, started } = yield* scheduler({ concurrent: 1 })
        const filled = yield* schedule.fill
        yield* flush
        expect(filled.setAside).toEqual(["x-../y"])
        return [
          yield* started,
          yield* phaseOf("x-../y"),
          yield* (yield* Backlog).get("x-../y"),
          yield* texts,
          yield* records,
          yield* schedule.started,
        ] as const
      }),
    )
    expect(started).toEqual(["t-1"])
    expect(phase).toBe("Deferred")
    expect(issue?.status).toBe("deferred")
    expect(issue?.notes).toContain("bd rename x-../y <new-id>")
    expect(lines).toContain(
      "  BAD_TICKET_ID: IDs with path characters can't be run: x-../y -> deferred without starting a worker; rename it (bd rename x-../y <new-id>), then bd undefer <new-id>",
    )
    const bad = recordsOf(all, "x-../y").map((record) =>
      record.kind === "phase" ? `phase:${record.to}` : record.kind,
    )
    expect(bad).toEqual([
      "phase:Queued",
      "phase:Working",
      "phase:Deferred",
      "deferred",
      "ticket_end",
    ])
    expect(count).toBe(1)
  })
})

describe("reading bd ready", () => {
  /** Beads whose ready fails `failures` times, then answers as the backlog does. */
  const failing = (seeds: ReadonlyArray<Seed>, failures: number) =>
    Layer.effectContext(
      Effect.gen(function* () {
        const left = yield* Ref.make(failures)
        const beads = yield* Beads
        const once = yield* Semaphore.make(1)
        const ready: Beads["Service"]["ready"] = (options) =>
          once.withPermit(
            Effect.flatMap(
              Ref.getAndUpdate(left, (n) => n - 1),
              (n) =>
                n > 0
                  ? Effect.fail(
                      new BeadsFailed({
                        command: "bd ready --json",
                        exitCode: 1,
                        stderr: "database is locked",
                        noSuchIssue: false,
                      }),
                    )
                  : beads.ready(options),
            ),
          )
        return Context.make(Beads, { ...beads, ready }).pipe(Context.add(Backlog, yield* Backlog))
      }),
    ).pipe(Layer.provide(beadsLayer(seeds)))

  test("tries again a few seconds later while bd fails", async () => {
    const started = await run(
      [{ id: "t-1" }],
      Effect.gen(function* () {
        const { schedule, started } = yield* scheduler({})
        const fiber = yield* Effect.forkChild(schedule.run)
        yield* flush
        yield* TestClock.adjust("3 seconds")
        yield* flush
        const order = yield* started
        yield* Fiber.interrupt(fiber)
        return order
      }),
      failing([{ id: "t-1" }], 1),
    )
    expect(started).toEqual(["t-1"])
  })

  test(`fails after ${readTries} failed reads`, async () => {
    const exit = await run(
      [{ id: "t-1" }],
      Effect.gen(function* () {
        const { schedule } = yield* scheduler({})
        const fiber = yield* Effect.forkChild(schedule.run)
        yield* flush
        for (let i = 0; i < readTries; i++) {
          yield* TestClock.adjust("3 seconds")
          yield* flush
        }
        return yield* Fiber.await(fiber)
      }),
      failing([{ id: "t-1" }], 10),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("the scope", () => {
  const tree: ReadonlyArray<Seed> = [
    { id: "r", type: "epic" },
    { id: "r.1", parent: "r" },
    { id: "r.2", parent: "r" },
    { id: "r.2.1", parent: "r.2" },
    { id: "o-1", priority: 0 },
  ]

  test("--ticket takes that ticket and its descendants only", async () => {
    const [epicScope, taskScope] = await run(
      [...tree, { id: "t", priority: 1 }, { id: "t.1", parent: "t" }],
      Effect.gen(function* () {
        const beads = yield* Beads
        const filter = { excludeTypes: ["epic"] }
        const ids = (issues: ReadonlyArray<Issue>) => issues.map((issue) => issue.id)
        return [
          ids(yield* ready(beads, "r", filter)),
          ids(yield* ready(beads, "t", filter)),
        ] as const
      }),
    )
    expect(epicScope).toEqual(["r.1", "r.2", "r.2.1"])
    expect(taskScope).toEqual(["t", "t.1"])
  })

  test("a scoped scheduler dispatches nothing outside the scope", async () => {
    const [started, parent] = await run(
      tree,
      Effect.gen(function* () {
        const { schedule, started } = yield* scheduler({ concurrent: 8, scope: "r.2" })
        yield* schedule.fill
        yield* flush
        return [yield* started, yield* phaseOf("r.2")] as const
      }),
    )
    // r.2 waits for its subticket.
    expect(started).toEqual(["r.2.1"])
    expect(parent).toBe("HeldBack")
  })

  const endOf = (root: string, closed: ReadonlySet<string> = new Set()) =>
    Effect.gen(function* () {
      const state = yield* (yield* Ledger).current
      return line(
        yield* end(yield* Beads, root, ledgerView(state, closed), { excludeTypes: ["epic"] }),
      )
    })

  test("SCOPE_DONE once the ticket and its subtickets are closed and merged", async () => {
    const closed = (seed: Seed): Seed => ({ ...seed, status: "closed" })
    const lines = await run(
      [
        ...tree.map(closed),
        { id: "t", status: "closed" },
        { id: "t.1", parent: "t", status: "closed" },
        { id: "e", type: "epic" },
        { id: "e.1", parent: "e", status: "closed" },
      ],
      Effect.gen(function* () {
        return [yield* endOf("t"), yield* endOf("r", new Set(["r"])), yield* endOf("e")]
      }),
    )
    expect(lines).toEqual([
      "SCOPE_DONE: t and its 1 subticket are merged",
      "SCOPE_DONE: r's 3 subtickets are merged; tutti closed r",
      "SCOPE_DONE: e's 1 subticket is merged; close it with: bd close e",
    ])
  })

  test("SCOPE_OPEN names each ticket not done and why", async () => {
    const result = await run(
      [
        { id: "r", type: "epic" },
        { id: "r.1", parent: "r" },
        { id: "r.2", parent: "r", status: "deferred" },
        { id: "r.3", parent: "r", blockedBy: ["o-1"] },
        { id: "r.4", parent: "r", blockedBy: ["q-1"] },
        { id: "r.5", parent: "r", status: "closed" },
        { id: "r.6", parent: "r" },
        { id: "r.6.1", parent: "r.6", status: "in_progress" },
        { id: "o-1" },
        { id: "q-1", labels: ["human"] },
      ],
      Effect.gen(function* () {
        // r.5 is closed but waits to merge, and r.1 was set aside in this run.
        const ledger = yield* Ledger
        for (const cause of [Cause.Ready(), Cause.Dispatched(), Cause.Verified({ place: 1 })]) {
          yield* ledger.transition("r.5", cause)
        }
        for (const cause of [
          Cause.Ready(),
          Cause.Dispatched(),
          Cause.Aside({ why: "OFF_BRANCH" }),
        ]) {
          yield* ledger.transition("r.1", cause)
        }
        return yield* endOf("r")
      }),
    )
    expect(result).toBe(
      "SCOPE_OPEN: r: 7 of its 7 subtickets not done: r.6 (waiting for its subtickets), " +
        "r.5 (closed but not merged: waiting to merge), r.4 (waiting on your answer to q-1), " +
        "r.3 (blocked by o-1 outside the scope), r.2 (deferred), r.1 (set aside in this run), " +
        "r.6.1 (in progress)",
    )
  })

  test("SCOPE_OPEN when only the ticket itself is left", async () => {
    const result = await run(
      [{ id: "t" }, { id: "t.1", parent: "t", status: "closed" }],
      endOf("t"),
    )
    expect(result).toBe(
      "SCOPE_OPEN: t: its 1 subticket is merged, but t itself is not done (not started)",
    )
  })

  test("SCOPE_UNREADABLE when bd can't show the ticket", async () => {
    const result = await run([], endOf("gone"))
    expect(result).toMatch(/^SCOPE_UNREADABLE: could not read gone: /)
  })
})

describe("byPriority", () => {
  const issue = (id: string, priority: number | undefined): Issue => ({
    id,
    title: id,
    description: "",
    design: "",
    acceptance: "",
    notes: "",
    status: "open",
    ...(priority === undefined ? {} : { priority }),
    type: "task",
    assignee: "",
    labels: [],
    dependencies: [],
    metadata: {},
    files: [],
    predictedFiles: [],
    createdAt: "",
    closeReason: "",
  })

  test("orders by priority, none last, keeping the given order among equals", () => {
    fc.assert(
      fc.property(fc.array(fc.option(fc.integer({ min: 0, max: 4 }), { nil: undefined })), (ps) => {
        const given = ps.map((p, i) => issue(`t-${i}`, p))
        const sorted = byPriority(given)
        expect([...sorted].map((each) => each.id).sort()).toEqual(
          given.map((each) => each.id).sort(),
        )
        for (let i = 1; i < sorted.length; i++) {
          const a = sorted[i - 1] as Issue
          const b = sorted[i] as Issue
          const rank = (each: Issue) => each.priority ?? 9
          expect(rank(a) <= rank(b)).toBe(true)
          if (rank(a) === rank(b)) expect(given.indexOf(a) < given.indexOf(b)).toBe(true)
        }
      }),
    )
  })

  test("takes reads labels and types as given, whatever their text", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), fc.string(), (labels, type) => {
        const each = { ...issue("t", 2), labels, type }
        const expected = !labels.includes("human") && type !== "epic" && type !== "chore"
        expect(takes({ excludeTypes: ["chore"] }, each)).toBe(expected)
      }),
    )
  })
})
