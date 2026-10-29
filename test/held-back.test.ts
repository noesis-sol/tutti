import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Effect, Fiber, Layer, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import type { EventRecord } from "../src/run/events.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import { ticketFootprint } from "../src/run/footprint.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { Log } from "../src/run/log.ts"
import { overlaps } from "../src/run/overlap.ts"
import { Move, type TicketPhase } from "../src/run/phase.ts"
import { repoFiles } from "../src/run/repoFiles.ts"
import { type Footprints, footprintsOf, make, type Scheduler } from "../src/run/schedule.ts"
import type { Beads, Issue, TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { layer as memoryGit, Repository } from "../src/testing/Git.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"
import { filling } from "./filling.ts"

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

/** The repository the footprint tests share, and what each running ticket's worktree changed. */
const repository = repoFiles(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/z.ts"])

const footprints = (changed: Ref.Ref<ReadonlyMap<string, ReadonlyArray<string>>>): Footprints => ({
  repo: Effect.succeed(repository),
  changed: (ticket) => Effect.map(Ref.get(changed), (all) => all.get(ticket) ?? []),
  mentions: () => Effect.succeed(() => false),
})

/**
 * A scheduler whose tickets each run until the test finishes them: `started` lists the tickets
 * handed to their fibers, and `finish(id)` ends one's fiber, freeing its slot.
 */
const scheduler = (options: { readonly concurrent: number; readonly footprints?: Footprints }) =>
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
      concurrent: options.concurrent,
      limit: 40,
      scope: null,
      excludeTypes: ["epic"],
      ...(options.footprints === undefined ? {} : { footprints: options.footprints }),
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

const phase = (id: TicketId) =>
  Effect.map(
    Effect.flatMap(Ledger, (ledger) => ledger.current),
    (state): TicketPhase | undefined => state.tickets.get(id)?.phase,
  )

/** The phase as a word: `HeldBack:parent`, `Queued`, `Working`. */
const shown = (p: TicketPhase | undefined): string =>
  p === undefined ? "none" : p._tag === "HeldBack" ? `HeldBack:${p.why}` : p._tag

const phases = (...ids: ReadonlyArray<TicketId>) =>
  Effect.gen(function* () {
    const all: Array<string> = []
    for (const id of ids) all.push(shown(yield* phase(id)))
    return all
  })

const transition = (id: TicketId, cause: Move) =>
  Effect.flatMap(Ledger, (ledger) => ledger.transition(id, cause))

/** The ticket's work verified: closed in bd and ToMerge. */
const verified = (id: TicketId) =>
  Effect.gen(function* () {
    const backlog = yield* Backlog
    const issue = yield* backlog.get(id)
    if (issue !== undefined) yield* backlog.put({ ...seedOf(issue), status: "closed" })
    yield* transition(id, Move.Verified({ place: 1 }))
  })

/** The ticket merged: its turn, then fast-forwarded. */
const merged = (id: TicketId) =>
  Effect.gen(function* () {
    yield* transition(id, Move.ItsTurn())
    yield* transition(id, Move.FastForwarded({ commit: "abc1234" }))
  })

/** The issue as a seed, its links kept. */
const seedOf = (issue: Issue): Seed => ({
  id: issue.id,
  title: issue.title,
  status: issue.status,
  ...(issue.priority === undefined ? {} : { priority: issue.priority }),
  type: issue.type,
  labels: issue.labels,
  ...(issue.parent === undefined ? {} : { parent: issue.parent }),
  dependencies: issue.dependencies.filter((link) => link.type !== "parent-child"),
  metadata: issue.metadata,
})

const records = Effect.flatMap(Captured, (captured) => captured.records)

const queues = (all: ReadonlyArray<EventRecord>) =>
  all.flatMap((record) => (record.kind === "queue" ? [record] : []))

describe("a parent", () => {
  test("waits until each subticket is closed and merged", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "p", priority: 0 },
      { id: "p.1", parent: "p", priority: 1 },
    ]
    const steps = await run(
      seeds,
      Effect.gen(function* () {
        const { schedule, started, finish } = yield* scheduler({ concurrent: 2 })
        const steps: Array<unknown> = []
        const filled = yield* schedule.fillTrying
        steps.push([
          filled.heldBack,
          yield* started,
          yield* phases("p" as TicketId, "p.1" as TicketId),
        ])
        // Closed but not merged yet, it still holds its parent back.
        yield* verified("p.1" as TicketId)
        yield* finish("p.1" as TicketId)
        yield* schedule.fillTrying
        steps.push([yield* started, yield* phases("p" as TicketId)])
        yield* merged("p.1" as TicketId)
        yield* schedule.fillTrying
        steps.push([yield* started, yield* phases("p" as TicketId)])
        return steps
      }),
    )
    expect(steps).toEqual([
      [1, ["p.1"], ["HeldBack:parent", "Working"]],
      [["p.1"], ["HeldBack:parent"]],
      [["p.1", "p"], ["Working"]],
    ])
  })

  test("says why once, and is counted held back in its queue records", async () => {
    const [lines, all] = await run(
      [{ id: "p" }, { id: "p.1", parent: "p" }],
      Effect.gen(function* () {
        const { schedule } = yield* scheduler({ concurrent: 1 })
        yield* schedule.fillTrying
        yield* schedule.fillTrying
        return [yield* texts, yield* records] as const
      }),
    )
    const waits = lines.filter((text) => text.includes("waits:"))
    expect(waits).toEqual(["  p waits: after its subtickets: p.1"])
    const held = all.flatMap((record) =>
      record.kind === "phase" && record.ticket === "p" ? [`${record.to}:${record.cause}`] : [],
    )
    expect(held).toEqual(["Queued:Ready", "HeldBack:Held"])
    expect(queues(all).at(-1)).toMatchObject({ queued: 0, held: 1, held_by: { parent: 1 } })
  })
})

describe("a blocker", () => {
  test("holds a ticket until it merges, not only until it closes", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "b-1", priority: 0 },
      { id: "t-2", priority: 1, blockedBy: ["b-1"] },
    ]
    const [steps, lines] = await run(
      seeds,
      Effect.gen(function* () {
        const { schedule, started, finish } = yield* scheduler({ concurrent: 2 })
        const steps: Array<unknown> = []
        yield* schedule.fillTrying
        steps.push([yield* started, yield* phases("t-2" as TicketId)])
        // bd ready lists t-2 once b-1 closes, while b-1's worker is still at it.
        const backlog = yield* Backlog
        const b1 = (yield* backlog.get("b-1")) as Issue
        yield* backlog.put({ ...seedOf(b1), status: "closed" })
        yield* schedule.fillTrying
        steps.push([yield* started, yield* phases("t-2" as TicketId)])
        yield* transition("b-1" as TicketId, Move.Verified({ place: 1 }))
        yield* finish("b-1" as TicketId)
        yield* schedule.fillTrying
        steps.push([yield* started, yield* phases("t-2" as TicketId)])
        yield* merged("b-1" as TicketId)
        yield* schedule.fillTrying
        steps.push([yield* started, yield* phases("t-2" as TicketId)])
        return [steps, yield* texts] as const
      }),
    )
    expect(steps).toEqual([
      [["b-1"], ["none"]],
      [["b-1"], ["HeldBack:merge"]],
      [["b-1"], ["HeldBack:merge"]],
      [["b-1", "t-2"], ["Working"]],
    ])
    expect(lines.filter((text) => text.includes("waits:"))).toEqual([
      "  t-2 waits: after b-1 merges",
      "  t-2 waits: after b-1 merges: closed but not merged (waiting to merge)",
    ])
  })
})

describe("a follow-up", () => {
  test("waits for the ticket it was filed from to merge", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "s-1", priority: 0 },
      { id: "f-1", priority: 1, dependencies: [{ id: "s-1", type: "discovered-from" }] },
      // Its source is open and not running: it may never run, so it holds nothing.
      { id: "x-1", status: "deferred" },
      { id: "f-2", priority: 2, dependencies: [{ id: "x-1", type: "discovered-from" }] },
    ]
    const [steps, lines] = await run(
      seeds,
      Effect.gen(function* () {
        const { schedule, started, finish } = yield* scheduler({ concurrent: 3 })
        const steps: Array<unknown> = []
        yield* schedule.fillTrying
        steps.push([yield* started, yield* phases("f-1" as TicketId, "f-2" as TicketId)])
        yield* verified("s-1" as TicketId)
        yield* finish("s-1" as TicketId)
        yield* merged("s-1" as TicketId)
        yield* schedule.fillTrying
        steps.push([yield* started, yield* phases("f-1" as TicketId)])
        return [steps, yield* texts] as const
      }),
    )
    expect(steps).toEqual([
      [
        ["s-1", "f-2"],
        ["HeldBack:merge", "Working"],
      ],
      [["s-1", "f-2", "f-1"], ["Working"]],
    ])
    expect(lines).toContain("  f-1 waits: after s-1 merges: filed by its worker")
  })

  test("waits for a source left unmerged by an earlier run, with nothing else running", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "s-1", status: "closed", labels: ["unmerged"] },
      { id: "f-1", dependencies: [{ id: "s-1", type: "discovered-from" }] },
    ]
    const [started, held, lines] = await run(
      seeds,
      Effect.gen(function* () {
        const { schedule, started } = yield* scheduler({ concurrent: 2 })
        yield* schedule.fillTrying
        return [yield* started, yield* phases("f-1" as TicketId), yield* texts] as const
      }),
    )
    expect(started).toEqual([])
    expect(held).toEqual(["HeldBack:merge"])
    expect(lines).toContain(
      "  f-1 waits: after s-1 merges: filed by its worker, closed but not merged (labelled unmerged)",
    )
  })
})

describe("a ticket left unmerged by an earlier run", () => {
  test("holds back the ticket it blocks, until the run merges it", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "b-1", status: "closed", labels: ["unmerged"] },
      { id: "t-2", blockedBy: ["b-1"] },
    ]
    const steps = await run(
      seeds,
      Effect.gen(function* () {
        const { schedule, started } = yield* scheduler({ concurrent: 2 })
        yield* schedule.fillTrying
        const steps: Array<unknown> = [[yield* started, yield* phases("t-2" as TicketId)]]
        // Carried over and merged by this run, though bd may still label it.
        yield* transition("b-1" as TicketId, Move.Unmerged({ place: 1 }))
        yield* merged("b-1" as TicketId)
        yield* schedule.fillTrying
        steps.push([yield* started, yield* phases("t-2" as TicketId)])
        return steps
      }),
    )
    expect(steps).toEqual([
      [[], ["HeldBack:merge"]],
      [["t-2"], ["Working"]],
    ])
  })

  test("holds back its parent", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "p" },
      { id: "p.1", parent: "p", status: "closed", labels: ["unmerged"] },
    ]
    const [started, held] = await run(
      seeds,
      Effect.gen(function* () {
        const { schedule, started } = yield* scheduler({ concurrent: 2 })
        yield* schedule.fillTrying
        return [yield* started, yield* phases("p" as TicketId)] as const
      }),
    )
    expect(started).toEqual([])
    expect(held).toEqual(["HeldBack:parent"])
  })
})

describe("a solo ticket", () => {
  test("running, holds back every other ticket, which start once it ends", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "s", priority: 0, labels: ["solo"], title: "Alone" },
      { id: "t-1", priority: 1 },
      { id: "t-2", priority: 2 },
    ]
    const [steps, lines, all] = await run(
      seeds,
      Effect.gen(function* () {
        const { schedule, started, finish } = yield* scheduler({ concurrent: 3 })
        const fiber = yield* Effect.forkChild(filling(schedule))
        yield* flush
        const steps: Array<unknown> = [
          [yield* started, yield* phases("t-1" as TicketId, "t-2" as TicketId)],
        ]
        yield* TestClock.adjust("30 seconds")
        yield* flush
        steps.push([yield* started])
        yield* finish("s" as TicketId)
        steps.push([yield* started, yield* phases("t-1" as TicketId, "t-2" as TicketId)])
        yield* Fiber.interrupt(fiber)
        return [steps, yield* texts, yield* records] as const
      }),
    )
    expect(steps).toEqual([
      [["s"], ["HeldBack:solo", "HeldBack:solo"]],
      [["s"]],
      [
        ["s", "t-1", "t-2"],
        ["Working", "Working"],
      ],
    ])
    expect(lines).toContain("[1/40] s dispatching solo: Alone")
    expect(lines.filter((text) => text.includes("solo ticket"))).toEqual([
      "  waiting for solo ticket s to finish",
    ])
    expect(all.find((record) => record.kind === "dispatch")).toMatchObject({
      solo: { ticket: "s" },
    })
    expect(queues(all).find((record) => record.held !== undefined)).toMatchObject({
      held_by: { solo: 1 },
      solo: { ticket: "s" },
    })
  })

  test("next, waits for the running tickets to finish, holding back those behind it", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "t-1", priority: 0 },
      { id: "s", priority: 1, labels: ["solo"] },
      { id: "t-2", priority: 2 },
    ]
    const [steps, lines] = await run(
      seeds,
      Effect.gen(function* () {
        const { schedule, started, finish } = yield* scheduler({ concurrent: 3 })
        const steps: Array<unknown> = []
        yield* schedule.fillTrying
        steps.push([yield* started, yield* phases("s" as TicketId, "t-2" as TicketId)])
        yield* finish("t-1" as TicketId)
        yield* schedule.fillTrying
        steps.push([yield* started, yield* phases("s" as TicketId, "t-2" as TicketId)])
        yield* finish("s" as TicketId)
        yield* schedule.fillTrying
        steps.push([yield* started, yield* phases("t-2" as TicketId)])
        return [steps, yield* texts] as const
      }),
    )
    expect(steps).toEqual([
      [["t-1"], ["HeldBack:solo", "HeldBack:solo"]],
      [
        ["t-1", "s"],
        ["Working", "HeldBack:solo"],
      ],
      [["t-1", "s", "t-2"], ["Working"]],
    ])
    expect(lines.filter((text) => text.includes("solo ticket"))).toEqual([
      "  solo ticket s is next: no new tickets start until the running ones finish, then it runs alone",
      "  waiting for solo ticket s to finish",
    ])
  })

  test("holds nothing back while every slot is taken", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "t-1", priority: 0 },
      { id: "s", priority: 1, labels: ["solo"] },
      { id: "t-2", priority: 2 },
    ]
    const steps = await run(
      seeds,
      Effect.gen(function* () {
        const { schedule, started, finish } = yield* scheduler({ concurrent: 1 })
        yield* schedule.fillTrying
        const steps: Array<unknown> = [
          [yield* started, yield* phases("s" as TicketId, "t-2" as TicketId)],
        ]
        yield* finish("t-1" as TicketId)
        yield* schedule.fillTrying
        steps.push([yield* started, yield* phases("t-2" as TicketId)])
        return steps
      }),
    )
    expect(steps).toEqual([
      [["t-1"], ["Queued", "Queued"]],
      [["t-1", "s"], ["Queued"]],
    ])
  })
})

describe("a footprint overlapping a running ticket's", () => {
  const files = (...names: ReadonlyArray<string>) => ({ files: names })

  test("is skipped for the next ticket while a slot is free, and runs once that one ends", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "t-1", priority: 0, metadata: files("src/a.ts") },
      { id: "t-2", priority: 1, metadata: files("src/a.ts") },
      { id: "t-3", priority: 2, metadata: files("src/b.ts") },
    ]
    const [steps, lines] = await run(
      seeds,
      Effect.gen(function* () {
        const changed = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<string>>>(new Map())
        const { schedule, started, finish } = yield* scheduler({
          concurrent: 3,
          footprints: footprints(changed),
        })
        const steps: Array<unknown> = []
        yield* schedule.fillTrying
        steps.push([yield* started, yield* phases("t-2" as TicketId)])
        yield* finish("t-1" as TicketId)
        yield* schedule.fillTrying
        steps.push([yield* started, yield* phases("t-2" as TicketId)])
        return [steps, yield* texts] as const
      }),
    )
    expect(steps).toEqual([
      [["t-1", "t-3"], ["HeldBack:overlap"]],
      [["t-1", "t-3", "t-2"], ["Working"]],
    ])
    expect(lines.filter((text) => text.includes("skipping"))).toEqual([
      "  skipping t-2: after t-1: both touch src/a.ts",
    ])
  })

  test("counts the files the running ticket's worktree changed", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "t-1", priority: 0, metadata: files("src/a.ts") },
      { id: "t-2", priority: 1, metadata: files("src/c.ts") },
    ]
    const [steps, lines] = await run(
      seeds,
      Effect.gen(function* () {
        const changed = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<string>>>(new Map())
        const { schedule, started } = yield* scheduler({
          concurrent: 1,
          footprints: footprints(changed),
        })
        yield* schedule.fillTrying
        yield* Ref.set(changed, new Map([["t-1", ["src/c.ts"]]]))
        // With every slot taken, t-2 waits for a slot as it would anyway.
        yield* schedule.fillTrying
        return [[yield* started, yield* phases("t-2" as TicketId)], yield* texts] as const
      }),
    )
    expect(steps).toEqual([["t-1"], ["Queued"]])
    expect(lines.some((text) => text.includes("skipping"))).toBe(false)

    const [free, freeLines] = await run(
      seeds,
      Effect.gen(function* () {
        const changed = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<string>>>(new Map())
        const { schedule, started } = yield* scheduler({
          concurrent: 2,
          footprints: footprints(changed),
        })
        yield* Ref.set(changed, new Map([["t-1", ["src/c.ts"]]]))
        yield* schedule.fillTrying
        return [[yield* started, yield* phases("t-2" as TicketId)], yield* texts] as const
      }),
    )
    // t-1 is dispatched in the same fill: its worktree's changes are read as it runs.
    expect(free).toEqual([["t-1"], ["HeldBack:overlap"]])
    expect(freeLines).toContain("  skipping t-2: after t-1: both touch src/c.ts")
  })

  test("a solo ticket is never skipped for an overlap: it waits for every running ticket", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "t-1", priority: 0, metadata: files("src/a.ts") },
      { id: "s", priority: 1, labels: ["solo"], metadata: files("src/a.ts") },
    ]
    const [held, lines] = await run(
      seeds,
      Effect.gen(function* () {
        const changed = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<string>>>(new Map())
        const { schedule } = yield* scheduler({ concurrent: 2, footprints: footprints(changed) })
        yield* schedule.fillTrying
        return [yield* phases("s" as TicketId), yield* texts] as const
      }),
    )
    expect(held).toEqual(["HeldBack:solo"])
    expect(lines.some((text) => text.includes("skipping"))).toBe(false)
  })

  test("two running worktrees changing one file give LIKELY_CONFLICT once", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "t-1", metadata: files("src/a.ts") },
      { id: "t-2", metadata: files("src/b.ts") },
    ]
    const [lines, all] = await run(
      seeds,
      Effect.gen(function* () {
        const changed = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<string>>>(new Map())
        const { schedule } = yield* scheduler({ concurrent: 2, footprints: footprints(changed) })
        yield* schedule.fillTrying
        yield* Ref.set(
          changed,
          new Map([
            ["t-1", ["src/z.ts"]],
            ["t-2", ["src/z.ts"]],
          ]),
        )
        yield* schedule.fillTrying
        yield* schedule.fillTrying
        return [yield* texts, yield* records] as const
      }),
    )
    const warning =
      "  LIKELY_CONFLICT: t-1 and t-2 both edit src/z.ts; the second to merge may conflict"
    expect(lines.filter((text) => text.includes("LIKELY_CONFLICT"))).toEqual([warning])
    expect(all.filter((record) => record.kind === "warn")).toMatchObject([{ text: warning }])
  })

  test("overlapping tickets never run side by side", async () => {
    const names = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]
    const ticket = fc.record({
      files: fc.subarray(names, { minLength: 1, maxLength: 2 }),
      priority: fc.integer({ min: 0, max: 4 }),
    })
    await fc.assert(
      fc.asyncProperty(
        fc.array(ticket, { minLength: 2, maxLength: 7 }),
        fc.integer({ min: 1, max: 4 }),
        fc.array(fc.nat(), { minLength: 10, maxLength: 10 }),
        async (tickets, concurrent, picks) => {
          const seeds = tickets.map(
            (t, i): Seed => ({ id: `t-${i}`, priority: t.priority, metadata: files(...t.files) }),
          )
          const footprintOf = new Map(
            seeds.map((seed) => [
              seed.id,
              ticketFootprint(
                {
                  title: seed.id,
                  description: "",
                  design: "",
                  acceptance: "",
                  labels: [],
                  metadata: seed.metadata ?? {},
                  files: (seed.metadata?.files ?? []) as ReadonlyArray<string>,
                  predictedFiles: [],
                },
                repository,
              ),
            ]),
          )
          const result = await run(
            seeds,
            Effect.gen(function* () {
              const changed = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<string>>>(new Map())
              const { schedule, started, finish } = yield* scheduler({
                concurrent,
                footprints: footprints(changed),
              })
              const done = new Set<string>()
              const sideBySide: Array<ReadonlyArray<string>> = []
              for (const pick of [...picks, ...seeds.map(() => 0)]) {
                yield* schedule.fillTrying
                const now = [...(yield* schedule.running)].sort()
                for (const [i, a] of now.entries()) {
                  for (const b of now.slice(i + 1)) {
                    const fa = footprintOf.get(a)
                    const fb = footprintOf.get(b)
                    if (fa !== undefined && fb !== undefined && overlaps(fa, fb)) {
                      sideBySide.push([a, b])
                    }
                  }
                }
                const id = now[pick % Math.max(now.length, 1)]
                if (id === undefined) continue
                // Finished and merged: closed in bd, and Done in the ledger.
                const backlog = yield* Backlog
                const issue = (yield* backlog.get(id)) as Issue
                yield* backlog.put({ ...seedOf(issue), status: "closed" })
                yield* transition(id, Move.NoChange())
                yield* finish(id)
                done.add(id)
              }
              return { sideBySide, started: yield* started, done }
            }),
          )
          expect(result.sideBySide).toEqual([])
          // Every ticket runs in the end.
          expect([...result.started].sort()).toEqual(seeds.map((seed) => seed.id).sort())
        },
      ),
      { numRuns: 40 },
    )
  })
})

describe("the checkout's footprints", () => {
  test("give git's files, the check's left out, and each running worktree's changes", async () => {
    const [named, check, changed, none] = await Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* Git
        const repo = yield* Repository
        yield* git.addWorktree(repo.dir, "/repo-tutti/t-1", { branch: "tutti/t-1", base: "main" })
        yield* repo.commit("/repo-tutti/t-1", "work", { "src/b.ts": "changed" })
        yield* repo.write("/repo-tutti/t-1", { "src/new.ts": "new" })
        const source = yield* footprintsOf({
          repo: repo.dir,
          base: "main",
          checkCommands: ["scripts/check.sh"],
          worktree: (ticket) => Effect.succeed(`/repo-tutti/${ticket}`),
        })
        const files = yield* source.repo
        return [
          files.resolve("a.ts", false),
          files.checks("scripts/check.sh"),
          yield* source.changed("t-1" as TicketId),
          // A ticket without a worktree has changed nothing git can say.
          yield* source.changed("t-9" as TicketId),
        ] as const
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            memoryGit({
              files: { "src/a.ts": "a", "src/b.ts": "b", "scripts/check.sh": "check" },
            }),
            BunServices.layer,
          ),
        ),
      ),
    )
    expect(named).toEqual(["src/a.ts"])
    expect(check).toBe(true)
    expect(changed).toEqual(["src/b.ts", "src/new.ts"])
    expect(none).toEqual([])
  })
})
