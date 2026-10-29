// The issues a waiting ticket links to, taken from the lists a fill has read (tutti-gr4z.7): bd's
// open list and its closed tickets labelled unmerged. One in neither is closed without the label, or
// a tombstone bd hides from both, and git says whether its work is on the base. No bd list --id.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"
import type { ClosedBranches } from "../src/run/closedBranches.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { Log } from "../src/run/log.ts"
import type { TicketPhase } from "../src/run/phase.ts"
import { make } from "../src/run/schedule.ts"
import { Beads, type Issue, type ListOptions, type TicketId } from "../src/services/Beads.ts"
import { type Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"

type Env = Beads | Backlog | Ledger | Log | EventStream | RunFibers | Scope.Scope

const run = <A, E>(seeds: ReadonlyArray<Seed>, effect: Effect.Effect<A, E, Env>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(beadsLayer(seeds), ledgerLayer(), runFibersLayer).pipe(
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

/** A bd call the scheduler made: a show of an ID, or a list with its options. */
type Call =
  | { readonly op: "show"; readonly id: TicketId }
  | { readonly op: "list"; readonly options: ListOptions }

const shown = (p: TicketPhase | undefined): string =>
  p === undefined ? "none" : p._tag === "HeldBack" ? `HeldBack:${p.why}` : p._tag

// r-1 runs first; t-1 was filed from it. t-2 waits on a blocker left unmerged by an earlier run,
// t-3 on one closed and merged, t-4 on one closed whose branch git finds off the base, and t-5 on
// one bd lists nowhere, as a tombstone.
const seeds: ReadonlyArray<Seed> = [
  { id: "r-1", priority: 0 },
  { id: "u-1", status: "closed", labels: ["unmerged"] },
  { id: "c-1", status: "closed" },
  { id: "g-1", status: "closed" },
  { id: "t-1", priority: 1, dependencies: [{ id: "r-1", type: "discovered-from" }] },
  { id: "t-2", priority: 2, blockedBy: ["u-1"] },
  { id: "t-3", priority: 3, blockedBy: ["c-1"] },
  { id: "t-4", priority: 4, blockedBy: ["g-1"] },
  { id: "t-5", priority: 4, blockedBy: ["x-9"] },
]

describe("a fill's waiting tickets' links", () => {
  test("are read from the open and unmerged lists, held or released as bd show gave them", async () => {
    const [started, phases, calls, asked, lines] = await run(
      seeds,
      Effect.gen(function* () {
        const beads = yield* Beads
        const calls = yield* Ref.make<ReadonlyArray<Call>>([])
        const counted = Beads.of({
          ...beads,
          show: (id, options) =>
            Effect.andThen(
              Ref.update(calls, (all) => [...all, { op: "show" as const, id }]),
              beads.show(id, options),
            ),
          list: (options = {}) =>
            Effect.andThen(
              Ref.update(calls, (all) => [...all, { op: "list" as const, options }]),
              beads.list(options),
            ),
        })
        const asked = yield* Ref.make<ReadonlyArray<string>>([])
        const closedBranches: ClosedBranches = {
          head: Effect.succeed("abc123"),
          why: (id) =>
            Effect.as(
              Ref.update(asked, (all) => [...all, id]),
              id === "g-1" ? "tutti/g-1 is not on main" : undefined,
            ),
        }
        const started = yield* Ref.make<ReadonlyArray<string>>([])
        const schedule = yield* make({
          concurrent: 4,
          limit: 40,
          scope: null,
          excludeTypes: ["epic"],
          closedBranches,
          start: {
            start: (issue: Issue) =>
              Effect.andThen(
                Ref.update(started, (all) => [...all, issue.id]),
                Effect.never,
              ),
          },
        }).pipe(Effect.provideService(Beads, counted))
        yield* schedule.fillTrying
        const state = yield* (yield* Ledger).current
        return [
          yield* Ref.get(started),
          ["t-1", "t-2", "t-4"].map((id) => shown(state.tickets.get(id as TicketId)?.phase)),
          yield* Ref.get(calls),
          yield* Ref.get(asked),
          yield* texts,
        ] as const
      }),
    )
    expect(started).toEqual(["r-1", "t-3", "t-5"])
    expect(phases).toEqual(["HeldBack:merge", "HeldBack:merge", "HeldBack:merge"])
    expect(lines).toContain("  t-1 waits: after r-1 merges: filed by its worker")
    expect(lines).toContain(
      "  t-2 waits: after u-1 merges: closed but not merged (labelled unmerged)",
    )
    expect(lines).toContain(
      "  t-4 waits: after g-1 merges: closed but not merged (tutti/g-1 is not on main)",
    )
    // The label came with the unmerged list, so git isn't asked about u-1; nor about r-1, open.
    expect([...new Set(asked)].sort()).toEqual(["c-1", "g-1", "x-9"])
    // bd's open list and its unmerged list, each once, and nothing else.
    expect(calls.filter((call) => call.op === "show")).toEqual([])
    expect(calls.map((call) => (call.op === "list" ? call.options : call))).toEqual([
      {},
      { status: "closed", labels: ["unmerged"] },
    ])
  })
})
