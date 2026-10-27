// The run's end reads its tickets with one bd list, not a bd show each (tutti-0vbd.5): labelAtEnd
// and the report's gather each make one list and no show; a ticket the list doesn't give is shown
// on its own, and passed over or reported as a failed show, as before; a failing list falls back
// to a show each.
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import { type InputPart, renderInput } from "../src/organs/evidence.ts"
import { OrganCost } from "../src/organs/OrganCost.ts"
import { Ending } from "../src/print/summary.ts"
import { Ledger } from "../src/run/ledger.ts"
import { Move } from "../src/run/phase.ts"
import { gather } from "../src/run/report.ts"
import { unmergedLabel } from "../src/run/scope.ts"
import { labelAtEnd } from "../src/run/unmerged.ts"
import { Beads, type Issue, type ListOptions, type TicketId } from "../src/services/Beads.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer } from "../src/testing/Attention.ts"
import { Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as gitLayer, Repository } from "../src/testing/Git.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"

/** A bd call the run's end made: a show of an ID, or a list with its options. */
type Call =
  | { readonly op: "show"; readonly id: TicketId }
  | { readonly op: "list"; readonly options: ListOptions }

const id = (each: string) => each as TicketId

// Two closed and not merged, to be labelled (merged, for the report); one closed with no change,
// with an earlier run's label, to lose it; one set aside; one still in progress.
const seeds: ReadonlyArray<Seed> = [
  { id: "a", title: "Do a", status: "closed", closeReason: "a is done" },
  { id: "b", title: "Do b", status: "closed", closeReason: "b is done" },
  { id: "c", title: "Do c", status: "closed", labels: [unmergedLabel] },
  { id: "d", title: "Do d", notes: "d waits on a decision" },
  { id: "e", title: "Do e" },
]

interface Ended {
  readonly calls: ReadonlyArray<Call>
  readonly issues: ReadonlyArray<Issue>
  readonly log: ReadonlyArray<string>
  readonly parts: ReadonlyArray<InputPart>
}

/**
 * The run's end over the backlog, its ledger holding `tickets` (each seed's, and `gone`, which bd
 * has no issue for, where given): labelAtEnd, or the report's gather, each show and list it makes
 * logged; `failList` makes every bd list fail first.
 */
const ended = (
  part: "labelAtEnd" | "gather",
  options: { readonly gone?: boolean; readonly failList?: boolean } = {},
): Promise<Ended> => {
  const repo = mkdtempSync(join(tmpdir(), "tutti-end-reads-"))
  const deps = Layer.mergeAll(
    configLayer(appConfig({}, repo)),
    beadsLayer(seeds),
    gitLayer({ dir: repo }),
    logLayer(),
    eventsLayer(),
  )
  const services = Layer.mergeAll(OrganCost.layer, Ledger.layer, attentionLayer()).pipe(
    Layer.provideMerge(deps),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const tickets = [...seeds.map((seed) => seed.id), ...(options.gone ? ["gone"] : [])]
      for (const ticket of tickets) {
        yield* ledger.transition(id(ticket), Move.Ready(), { title: `Ticket ${ticket}` })
        yield* ledger.transition(id(ticket), Move.Dispatched())
      }
      for (const ticket of ["a", "b", ...(options.gone ? ["gone"] : [])]) {
        yield* ledger.transition(id(ticket), Move.Verified({ place: 1 }))
        // The report's closed tickets are those merged; labelAtEnd's, those closed and not merged.
        if (part === "gather") {
          yield* ledger.transition(id(ticket), Move.ItsTurn())
          yield* ledger.transition(id(ticket), Move.FastForwarded({ commit: "abc123" }))
        }
      }
      yield* ledger.transition(id("c"), Move.NoChange())
      yield* ledger.transition(id("d"), Move.Defer({ why: "deferred by its worker" }))
      if (options.failList) yield* (yield* Backlog).fail("list", { times: Infinity })

      const beads = yield* Beads
      const calls = yield* Ref.make<ReadonlyArray<Call>>([])
      const counted = Beads.of({
        ...beads,
        show: (ticket, shown) =>
          Effect.andThen(
            Ref.update(calls, (all) => [...all, { op: "show" as const, id: ticket }]),
            beads.show(ticket, shown),
          ),
        list: (listed = {}) =>
          Effect.andThen(
            Ref.update(calls, (all) => [...all, { op: "list" as const, options: listed }]),
            beads.list(listed),
          ),
      })
      const startHead = yield* (yield* Repository).head("main")
      const parts =
        part === "labelAtEnd"
          ? yield* Effect.as(
              labelAtEnd({ repo, base: "main" }).pipe(Effect.provideService(Beads, counted)),
              [],
            )
          : yield* gather({
              started: 0,
              base: "main",
              startHead,
              ending: Ending.Done({ text: "DONE", tickets: 2, limit: null, took: 0 }),
              exitCode: 0,
              quit: false,
            }).pipe(Effect.provideService(Beads, counted))
      return {
        calls: yield* Ref.get(calls),
        issues: yield* (yield* Backlog).issues,
        log: yield* texts,
        parts,
      }
    }).pipe(Effect.provide(services), Effect.provide(TestClock.layer())),
  )
}

const shows = (calls: ReadonlyArray<Call>): ReadonlyArray<string> =>
  calls.flatMap((call) => (call.op === "show" ? [call.id] : []))

/** The lists by ID, each with the IDs it asked for, and whether closed ones too. */
const listsById = (calls: ReadonlyArray<Call>) =>
  calls.flatMap((call) =>
    call.op === "list" && call.options.ids !== undefined
      ? [{ ids: call.options.ids.map(String).sort(), all: call.options.all === true }]
      : [],
  )

const labelsOf = (issues: ReadonlyArray<Issue>) =>
  Object.fromEntries(issues.map((issue) => [issue.id, issue.labels]))

const labelled = {
  a: [unmergedLabel],
  b: [unmergedLabel],
  c: [],
  d: [],
  e: [],
}

describe("labelAtEnd reads the run's tickets", () => {
  test("with one bd list and no show, and labels them as before", async () => {
    const run = await ended("labelAtEnd")
    expect(listsById(run.calls)).toEqual([{ ids: ["a", "b", "c", "d", "e"], all: true }])
    expect(shows(run.calls)).toEqual([])
    expect(labelsOf(run.issues)).toEqual(labelled)
  })

  test("a ticket the list doesn't give is shown on its own, and passed over", async () => {
    const run = await ended("labelAtEnd", { gone: true })
    expect(listsById(run.calls)).toEqual([{ ids: ["a", "b", "c", "d", "e", "gone"], all: true }])
    expect(shows(run.calls)).toEqual(["gone"])
    expect(labelsOf(run.issues)).toEqual(labelled)
    expect(run.log.some((each) => each.includes("gone"))).toBe(false)
  })

  test("a failing list falls back to a show each", async () => {
    const run = await ended("labelAtEnd", { failList: true })
    expect(shows(run.calls)).toEqual(["a", "b", "c", "d", "e"])
    expect(labelsOf(run.issues)).toEqual(labelled)
  })
})

describe("the report reads the tickets closed and set aside", () => {
  const input = (run: Ended) => renderInput("0123456789abcdef", run.parts)

  test("with one bd list and no show", async () => {
    const run = await ended("gather")
    expect(listsById(run.calls)).toEqual([{ ids: ["a", "b", "c", "d"], all: true }])
    expect(shows(run.calls)).toEqual([])
    expect(input(run)).toContain("a: Do a\n")
    expect(input(run)).toContain("Close reason: b is done")
    expect(input(run)).toContain("Notes:\nd waits on a decision")
  })

  test("a ticket the list doesn't give is shown, and reported as a failed show", async () => {
    const run = await ended("gather", { gone: true })
    expect(listsById(run.calls)).toEqual([{ ids: ["a", "b", "c", "d", "gone"], all: true }])
    expect(shows(run.calls)).toEqual(["gone"])
    expect(input(run)).toContain("gone: Ticket gone\n(bd show failed: ")
    expect(input(run)).toContain("Close reason: a is done")
  })

  test("a failing list falls back to a show each", async () => {
    const run = await ended("gather", { failList: true })
    expect([...shows(run.calls)].sort()).toEqual(["a", "b", "c", "d"])
    expect(input(run)).toContain("Close reason: a is done")
    expect(input(run)).toContain("Notes:\nd waits on a decision")
  })
})
