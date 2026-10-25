import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import type { EventRecord } from "../src/run/events.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { Log } from "../src/run/log.ts"
import type { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project } from "../src/run/runView.ts"
import { make, type Scheduler } from "../src/run/schedule.ts"
import type { Beads, Issue, TicketId } from "../src/services/Beads.ts"
import { Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"

type Env = Beads | Backlog | Ledger | Log | EventStream | Captured | RunFibers | Scope.Scope

const layers = (seeds: ReadonlyArray<Seed>) =>
  Layer.mergeAll(beadsLayer(seeds), ledgerLayer(), runFibersLayer).pipe(
    Layer.provideMerge(TestClock.layer()),
  )

/** Runs `effect` in a scope over the in-memory backlog with `seeds`, under TestClock. */
const run = <A, E>(seeds: ReadonlyArray<Seed>, effect: Effect.Effect<A, E, Env>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(layers(seeds))))

/** Lets forked fibers run, without moving the clock. */
const flush = Effect.gen(function* () {
  for (let i = 0; i < 50; i++) yield* Effect.yieldNow
})

/**
 * A scheduler whose tickets each run until the test finishes them: `started` lists the tickets
 * handed to their fibers, and `finish(id)` ends one's fiber, freeing its slot.
 */
const scheduler = (concurrent: number) =>
  Effect.gen(function* () {
    const started = yield* Ref.make<ReadonlyArray<string>>([])
    const gates = new Map<string, Deferred.Deferred<void>>()
    const gate = (id: TicketId) =>
      Effect.gen(function* () {
        const known = gates.get(id)
        if (known !== undefined) return known
        const made = yield* Deferred.make<void>()
        gates.set(id, made)
        return made
      })
    const schedule: Scheduler = yield* make({
      concurrent,
      limit: 40,
      scope: null,
      excludeTypes: ["epic"],
      start: {
        start: (issue: Issue) =>
          Effect.gen(function* () {
            yield* Ref.update(started, (all) => [...all, issue.id])
            yield* Deferred.await(yield* gate(issue.id))
          }),
      },
    })
    const finish = (id: TicketId) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(yield* gate(id), undefined)
        yield* flush
      })
    return { schedule, started: Ref.get(started), finish }
  })

const current = Effect.flatMap(Ledger, (ledger) => ledger.current)

/** The phase as a word: `HeldBack:parent`, `Queued`, `Working`; `none` out of the run. */
const shown = (p: TicketPhase | undefined): string =>
  p === undefined ? "none" : p._tag === "HeldBack" ? `HeldBack:${p.why}` : p._tag

const phases = (...ids: ReadonlyArray<TicketId>) =>
  Effect.map(current, (state) => ids.map((id) => shown(state.tickets.get(id)?.phase)))

/** RunView's In queue total and its held back count, as the dashboard shows them. */
const inQueue = Effect.map(current, (ledger) => {
  const { totals } = project({
    ledger,
    workers: new Map(),
    requests: [],
    status: { ...emptyStatus, branch: "main", concurrency: 1 },
  })
  return [totals.queued, totals.heldBack]
})

/** Changes the issue in the backlog, as you would with bd outside the run. */
const change = (id: string, to: (seed: Seed) => Seed) =>
  Effect.gen(function* () {
    const backlog = yield* Backlog
    const issue = yield* backlog.get(id)
    if (issue === undefined) throw new Error(`no ${id} in the backlog`)
    yield* backlog.put(
      to({
        id: issue.id,
        title: issue.title,
        status: issue.status,
        ...(issue.priority === undefined ? {} : { priority: issue.priority }),
        type: issue.type,
        labels: issue.labels,
        ...(issue.parent === undefined ? {} : { parent: issue.parent }),
        dependencies: issue.dependencies.filter((link) => link.type !== "parent-child"),
      }),
    )
  })

const records = Effect.flatMap(Captured, (captured) => captured.records)

/** The ticket's `phase` records as `<from>><to>:<cause>`, "" for outside the run. */
const pathOf = (all: ReadonlyArray<EventRecord>, id: string) =>
  all.flatMap((record) =>
    record.kind === "phase" && record.ticket === id
      ? [`${record.from ?? ""}>${record.to ?? ""}:${record.cause}`]
      : [],
  )

const queues = (all: ReadonlyArray<EventRecord>) =>
  all.flatMap((record) => (record.kind === "queue" ? [record] : []))

describe("a Queued ticket that bd ready no longer lists", () => {
  const seeds: ReadonlyArray<Seed> = [
    { id: "a", priority: 0 },
    { id: "b", priority: 1 },
  ]

  test("closed by hand, leaves the run and In queue", async () => {
    const [steps, all] = await run(
      seeds,
      Effect.gen(function* () {
        const { schedule, started, finish } = yield* scheduler(1)
        const steps: Array<unknown> = []
        yield* schedule.fillTrying
        steps.push([yield* phases("a" as TicketId, "b" as TicketId), yield* inQueue])
        yield* change("b", (seed) => ({ ...seed, status: "closed" }))
        const filled = yield* schedule.fillTrying
        steps.push([yield* phases("a" as TicketId, "b" as TicketId), yield* inQueue, filled.queued])
        // Its slot free, nothing is left to start.
        yield* finish("a" as TicketId)
        yield* schedule.fillTrying
        steps.push(yield* started)
        return [steps, yield* records] as const
      }),
    )
    expect(steps).toEqual([
      [
        ["Working", "Queued"],
        [1, 0],
      ],
      [["Working", "none"], [0, 0], 0],
      ["a"],
    ])
    expect(pathOf(all, "b")).toEqual([">Queued:Ready", "Queued>:Unready"])
    // The phase record for leaving has no `to`, and the queue record beside it counts nothing.
    const left = all.find(
      (record) => record.kind === "phase" && record.ticket === "b" && record.cause === "Unready",
    )
    expect(left).not.toHaveProperty("to")
    expect(queues(all).at(-1)).toMatchObject({ queued: 0 })
  })

  test("deferred outside the run, is queued anew once it is ready again", async () => {
    const steps = await run(
      seeds,
      Effect.gen(function* () {
        const { schedule, started, finish } = yield* scheduler(1)
        const steps: Array<unknown> = []
        yield* schedule.fillTrying
        yield* change("b", (seed) => ({ ...seed, status: "deferred" }))
        yield* schedule.fillTrying
        steps.push(yield* phases("b" as TicketId))
        yield* change("b", (seed) => ({ ...seed, status: "open" }))
        yield* schedule.fillTrying
        steps.push(yield* phases("b" as TicketId))
        yield* finish("a" as TicketId)
        yield* schedule.fillTrying
        steps.push([yield* started, yield* phases("b" as TicketId)])
        return steps
      }),
    )
    expect(steps).toEqual([["none"], ["Queued"], [["a", "b"], ["Working"]]])
  })

  test("newly blocked, leaves the run until its blocker closes", async () => {
    const [steps, all] = await run(
      [...seeds, { id: "c", status: "in_progress" }],
      Effect.gen(function* () {
        const { schedule } = yield* scheduler(1)
        const steps: Array<unknown> = []
        yield* schedule.fillTrying
        yield* change("b", (seed) => ({ ...seed, dependencies: [{ id: "c", type: "blocks" }] }))
        yield* schedule.fillTrying
        steps.push([yield* phases("b" as TicketId), yield* inQueue])
        yield* change("c", (seed) => ({ ...seed, status: "closed" }))
        yield* schedule.fillTrying
        steps.push([yield* phases("b" as TicketId), yield* inQueue])
        return [steps, yield* records] as const
      }),
    )
    expect(steps).toEqual([
      [["none"], [0, 0]],
      [["Queued"], [1, 0]],
    ])
    expect(pathOf(all, "b")).toEqual([">Queued:Ready", "Queued>:Unready", ">Queued:Ready"])
  })
})

describe("a HeldBack ticket that bd ready no longer lists", () => {
  test("leaves the run at once, not released to Queued first, and says why again if back", async () => {
    const [steps, all, lines] = await run(
      [{ id: "p" }, { id: "p.1", parent: "p" }],
      Effect.gen(function* () {
        const { schedule } = yield* scheduler(1)
        const steps: Array<unknown> = []
        yield* schedule.fillTrying
        steps.push([yield* phases("p" as TicketId), yield* inQueue])
        yield* change("p", (seed) => ({ ...seed, status: "deferred" }))
        yield* schedule.fillTrying
        steps.push([yield* phases("p" as TicketId), yield* inQueue])
        yield* change("p", (seed) => ({ ...seed, status: "open" }))
        yield* schedule.fillTrying
        steps.push([yield* phases("p" as TicketId), yield* inQueue])
        return [steps, yield* records, yield* texts] as const
      }),
    )
    expect(steps).toEqual([
      [["HeldBack:parent"], [0, 1]],
      [["none"], [0, 0]],
      [["HeldBack:parent"], [0, 1]],
    ])
    expect(pathOf(all, "p")).toEqual([
      ">Queued:Ready",
      "Queued>HeldBack:Held",
      "HeldBack>:Unready",
      ">Queued:Ready",
      "Queued>HeldBack:Held",
    ])
    expect(lines.filter((text) => text.includes("p waits:"))).toHaveLength(2)
  })
})

describe("the queue, whatever bd ready lists from poll to poll", () => {
  test("holds no ticket bd ready doesn't list", async () => {
    const ids = ["t1", "t2", "t3", "t4"]
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.subarray(ids), { minLength: 1, maxLength: 6 }),
        async (polls) => {
          const failures = await run(
            ids.map((id) => ({ id, status: "deferred" })),
            Effect.gen(function* () {
              // No slot: every ticket waits in the queue.
              const { schedule } = yield* scheduler(0)
              const failures: Array<string> = []
              for (const listed of polls) {
                for (const id of ids) {
                  const status = listed.includes(id) ? "open" : "deferred"
                  yield* change(id, (seed) => ({ ...seed, status }))
                }
                yield* schedule.fillTrying
                const state = yield* current
                const queued = [...state.tickets.keys()].sort()
                if (queued.join(" ") !== [...listed].sort().join(" ")) {
                  failures.push(`listed ${listed.join(" ")}, queued ${queued.join(" ")}`)
                }
              }
              return failures
            }),
          )
          expect(failures).toEqual([])
        },
      ),
      { numRuns: 40 },
    )
  })
})
