// The ticket init files to set the project's checks up, labelled tutti-tests and solo, runs first
// and alone, whatever the priorities of the tickets ready beside it (tutti-z96d): every merge's
// check stands on it. A plain solo ticket, and a test-work ticket that isn't solo, keep their
// places by priority.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import type { Log } from "../src/core/log.ts"
import { testWorkLabel } from "../src/init/checks.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import type { Ledger } from "../src/run/ledger.ts"
import { checksFirstLine, make, type Scheduler } from "../src/run/schedule.ts"
import { byPriority } from "../src/run/scope.ts"
import { setsChecksUp } from "../src/run/solo.ts"
import type { Beads, Issue, TicketId } from "../src/services/Beads.ts"
import type { EventStream } from "../src/services/EventStream.ts"
import { type Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import type { Captured } from "../src/testing/EventStream.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"

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

/** A scheduler whose tickets each run until `finish(id)` ends one's fiber, freeing its slot. */
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

/** What started after each fill, finishing `then` between fills. */
const startsOf = (seeds: ReadonlyArray<Seed>, then: ReadonlyArray<string>) =>
  run(
    seeds,
    Effect.gen(function* () {
      const { schedule, started, finish } = yield* scheduler(3)
      const steps: Array<ReadonlyArray<string>> = []
      yield* schedule.fillTrying
      steps.push(yield* started)
      for (const id of then) {
        yield* finish(id as TicketId)
        yield* schedule.fillTrying
        steps.push(yield* started)
      }
      return { steps, lines: yield* texts }
    }),
  )

describe("the ticket that sets the checks up", () => {
  test("starts first and alone, ahead of older tickets of its priority and higher", async () => {
    const { steps, lines } = await startsOf(
      [
        { id: "t-1", priority: 1, title: "Older" },
        { id: "t-0", priority: 0, title: "Urgent" },
        { id: "t-2", priority: 1, title: "Also older" },
        { id: "s", priority: 1, labels: [testWorkLabel, "solo"], title: "Make the runners pass" },
      ],
      ["s"],
    )
    expect(steps).toEqual([["s"], ["s", "t-0", "t-1", "t-2"]])
    const dispatched = lines.indexOf("[1/40] s dispatching solo: Make the runners pass")
    expect(dispatched).toBeGreaterThanOrEqual(0)
    expect(lines[dispatched + 1]).toBe("  s sets the project's checks up: it runs first, alone")
    expect(String(checksFirstLine("s" as TicketId))).toBe(lines[dispatched + 1] as string)
  })

  test("without one, the order is by priority, a plain solo ticket waiting its turn", async () => {
    const { steps, lines } = await startsOf(
      [
        { id: "t-1", priority: 1 },
        { id: "t-2", priority: 1 },
        { id: "s", priority: 1, labels: ["solo"] },
      ],
      ["t-1", "t-2", "s"],
    )
    expect(steps).toEqual([
      ["t-1", "t-2"],
      ["t-1", "t-2"],
      ["t-1", "t-2", "s"],
      ["t-1", "t-2", "s"],
    ])
    expect(lines.some((text) => text.includes("sets the project's checks up"))).toBe(false)
  })

  test("a test-work ticket that isn't solo keeps its place by priority", async () => {
    const { steps, lines } = await startsOf(
      [
        { id: "t-1", priority: 1 },
        { id: "m", priority: 2, labels: [testWorkLabel] },
      ],
      [],
    )
    expect(steps).toEqual([["t-1", "m"]])
    expect(lines.some((text) => text.includes("sets the project's checks up"))).toBe(false)
  })
})

describe("byPriority with a ticket that sets the checks up", () => {
  const issue = (
    id: string,
    priority: number | undefined,
    labels: ReadonlyArray<string>,
  ): Issue => ({
    id: id as TicketId,
    title: id,
    description: "",
    design: "",
    acceptance: "",
    notes: "",
    status: "open",
    ...(priority === undefined ? {} : { priority }),
    type: "task",
    assignee: "",
    labels,
    dependencies: [],
    metadata: {},
    files: [],
    predictedFiles: [],
    createdAt: "",
    closeReason: "",
  })

  const labelSets = fc.constantFrom<ReadonlyArray<string>>(
    [],
    ["solo"],
    [testWorkLabel],
    [testWorkLabel, "solo"],
    ["solo", testWorkLabel, "area:x"],
  )

  test("puts it ahead of every other, the rest by priority, keeping the given order among equals", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.option(fc.integer({ min: 0, max: 4 }), { nil: undefined }), labelSets),
        ),
        (given) => {
          const issues = given.map(([p, labels], i) => issue(`t-${i}`, p, labels))
          const sorted = byPriority(issues)
          const first = issues.filter(setsChecksUp)
          expect(sorted.slice(0, first.length)).toEqual(first)
          const rest = sorted.slice(first.length)
          expect(rest.some(setsChecksUp)).toBe(false)
          for (let i = 1; i < rest.length; i++) {
            const a = rest[i - 1] as Issue
            const b = rest[i] as Issue
            const rank = (each: Issue) => each.priority ?? 9
            expect(rank(a) <= rank(b)).toBe(true)
            if (rank(a) === rank(b)) expect(issues.indexOf(a) < issues.indexOf(b)).toBe(true)
          }
        },
      ),
    )
  })
})
