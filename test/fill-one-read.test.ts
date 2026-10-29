// What a fill reads of bd and git where it read once a ticket (tutti-ejkt.6): the issues the waiting
// tickets link to from the lists the fill has read (tutti-gr4z.7), with no bd show; no bd show for
// the parent of a ticket the run took up without one; no list of the tickets left unmerged nor
// parents' shows with no ticket in line; and the tickets' branches listed in one git call a fill.
import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"
import type { EventStream } from "../src/run/eventstream.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { Log } from "../src/run/log.ts"
import type { TicketPhase } from "../src/run/phase.ts"
import { repoFiles } from "../src/run/repoFiles.ts"
import { type Footprints, footprintsOf, make } from "../src/run/schedule.ts"
import { Beads, type Issue, type ListOptions, type TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import { Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as memoryGit, Repository } from "../src/testing/Git.ts"
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

/**
 * A scheduler over the backlog's Beads, each show and list it makes logged in `calls`, whose
 * tickets run until the test ends.
 */
const scheduler = (options: { readonly concurrent: number; readonly footprints?: Footprints }) =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const calls = yield* Ref.make<ReadonlyArray<Call>>([])
    const counted = Beads.of({
      ...beads,
      show: (id, shown) =>
        Effect.andThen(
          Ref.update(calls, (all) => [...all, { op: "show" as const, id }]),
          beads.show(id, shown),
        ),
      list: (listed = {}) =>
        Effect.andThen(
          Ref.update(calls, (all) => [...all, { op: "list" as const, options: listed }]),
          beads.list(listed),
        ),
    })
    const started = yield* Ref.make<ReadonlyArray<string>>([])
    const schedule = yield* make({
      concurrent: options.concurrent,
      limit: 40,
      scope: null,
      excludeTypes: ["epic"],
      ...(options.footprints === undefined ? {} : { footprints: options.footprints }),
      start: {
        start: (issue: Issue) =>
          Effect.andThen(
            Ref.update(started, (all) => [...all, issue.id]),
            Effect.never,
          ),
      },
    }).pipe(Effect.provideService(Beads, counted))
    // The calls made from here on.
    const since = Effect.map(
      Ref.get(calls),
      (all) => () => Effect.map(Ref.get(calls), (now) => now.slice(all.length)),
    )
    return { schedule, started: Ref.get(started), calls: Ref.get(calls), since }
  })

const shows = (calls: ReadonlyArray<Call>): ReadonlyArray<string> =>
  calls.flatMap((call) => (call.op === "show" ? [call.id] : []))

/** The lists by ID, each with the IDs it asked for. */
const byId = (calls: ReadonlyArray<Call>): ReadonlyArray<ReadonlyArray<string>> =>
  calls.flatMap((call) =>
    call.op === "list" && call.options.ids !== undefined ? [[...call.options.ids].sort()] : [],
  )

/** How many lists of the closed tickets labelled `unmerged`. */
const labelled = (calls: ReadonlyArray<Call>): number =>
  calls.filter((call) => call.op === "list" && (call.options.labels ?? []).includes("unmerged"))
    .length

const phaseOf = (id: string) =>
  Effect.map(
    Effect.flatMap(Ledger, (ledger) => ledger.current),
    (state) => shown(state.tickets.get(id as TicketId)?.phase),
  )

const shown = (p: TicketPhase | undefined): string =>
  p === undefined ? "none" : p._tag === "HeldBack" ? `HeldBack:${p.why}` : p._tag

// A source left unmerged by an earlier run, so each waiting ticket's links are read; a blocker
// closed and merged, a source still open, and a ticket linking to none.
const linkedSeeds: ReadonlyArray<Seed> = [
  { id: "u-1", status: "closed", labels: ["unmerged"] },
  { id: "c-1", status: "closed" },
  { id: "o-1", priority: 4 },
  { id: "t-1", priority: 0, dependencies: [{ id: "u-1", type: "discovered-from" }] },
  { id: "t-2", priority: 1, blockedBy: ["c-1"] },
  { id: "t-3", priority: 2, dependencies: [{ id: "o-1", type: "discovered-from" }] },
  { id: "t-4", priority: 3 },
]

describe("the waiting tickets' links", () => {
  test("are read from the fill's lists, with no bd show nor bd list by ID", async () => {
    const [started, phases, calls, lines] = await run(
      linkedSeeds,
      Effect.gen(function* () {
        const { schedule, started, calls } = yield* scheduler({ concurrent: 4 })
        yield* schedule.fillTrying
        return [yield* started, [yield* phaseOf("t-1")], yield* calls, yield* texts] as const
      }),
    )
    expect(started).toEqual(["t-2", "t-3", "t-4", "o-1"])
    // The source's label came with the list of the tickets labelled unmerged.
    expect(phases).toEqual(["HeldBack:merge"])
    expect(lines).toContain(
      "  t-1 waits: after u-1 merges: filed by its worker, closed but not merged (labelled unmerged)",
    )
    expect(shows(calls)).toEqual([])
    expect(byId(calls)).toEqual([])
  })
})

describe("a ticket the run took up without a parent", () => {
  test("is not shown for its parent once it closes", async () => {
    const [shown, phase] = await run(
      [
        { id: "a-1", priority: 0 },
        { id: "b-1", priority: 1 },
      ],
      Effect.gen(function* () {
        const { schedule, since } = yield* scheduler({ concurrent: 1 })
        yield* schedule.fillTrying
        // Its worker closed it; the next fill weighs b-1, still in line.
        yield* (yield* Backlog).put({ id: "a-1", priority: 0, status: "closed" })
        const after = yield* since
        yield* schedule.fillTrying
        return [shows(yield* after()), yield* phaseOf("b-1")] as const
      }),
    )
    expect(shown).toEqual([])
    expect(phase).toBe("Queued")
  })
})

describe("a fill with no ticket in line", () => {
  test("reads neither the tickets left unmerged nor the parents of the run's", async () => {
    const [calls, phase] = await run(
      [
        { id: "e-1", type: "epic" },
        { id: "a-1", parent: "e-1" },
      ],
      Effect.gen(function* () {
        const { schedule, since } = yield* scheduler({ concurrent: 1 })
        yield* schedule.fillTrying
        yield* (yield* Backlog).put({ id: "a-1", parent: "e-1", status: "closed" })
        const after = yield* since
        yield* schedule.fillTrying
        return [yield* after(), yield* phaseOf("a-1")] as const
      }),
    )
    expect(phase).toBe("Working")
    expect(labelled(calls)).toBe(0)
    expect(shows(calls)).toEqual([])
  })
})

describe("the tickets' branches", () => {
  test("are listed once a fill, for every ticket in line", async () => {
    const [listings, asked, started] = await run(
      [{ id: "t-1" }, { id: "t-2" }, { id: "t-3" }],
      Effect.gen(function* () {
        const listings = yield* Ref.make(0)
        const asked = yield* Ref.make<ReadonlyArray<boolean>>([])
        const footprints: Footprints = {
          repo: Effect.succeed(repoFiles(["src/a.ts"])),
          changed: () => Effect.succeed([]),
          branches: Effect.as(
            Ref.update(listings, (n) => n + 1),
            new Set(["tutti/t-2"]),
          ),
          branch: (ticket, existing) =>
            Effect.as(
              Ref.update(asked, (all) => [...all, existing?.has(`tutti/${ticket}`) ?? false]),
              [],
            ),
          mentions: () => Effect.succeed(() => false),
        }
        // Each start reads its branch, and each pick with a ticket running the others'.
        const { schedule, started } = yield* scheduler({ concurrent: 3, footprints })
        yield* schedule.fillTrying
        return [yield* Ref.get(listings), yield* Ref.get(asked), yield* started] as const
      }),
    )
    expect(started).toEqual(["t-1", "t-2", "t-3"])
    expect(listings).toBe(1)
    // Each ticket's branch read once, t-2's found there without asking git.
    expect(asked).toEqual([false, true, false])
  })

  test("are git for-each-ref's, and spare git show-ref", async () => {
    const [branches, t2, t3, ops] = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* Repository
        const git = yield* Git
        yield* Effect.orDie(git.createBranch(repo.dir, "tutti/t-2", "main"))
        yield* Effect.orDie(git.createBranch(repo.dir, "other/t-3", "main"))
        const { branches: listing, branch } = yield* footprintsOf({
          repo: repo.dir,
          base: "main",
          checkCommands: [],
          worktree: (ticket) => Effect.succeed(`/repo-tutti/${ticket}`),
        })
        if (listing === undefined || branch === undefined) throw new Error("no branches read")
        const from = (yield* repo.calls).length
        const branches = (yield* listing) ?? new Set<string>()
        const t2 = yield* branch("t-2" as TicketId, branches)
        const t3 = yield* branch("t-3" as TicketId, branches)
        const ops = (yield* repo.calls).slice(from).map((call) => call.op)
        return [[...branches], t2, t3, ops] as const
      }).pipe(
        Effect.provide(
          Layer.mergeAll(memoryGit({ files: { "src/a.ts": "a" } }), BunServices.layer),
        ),
      ),
    )
    expect(branches).toEqual(["tutti/t-2"])
    expect(t2).toEqual([])
    expect(t3).toEqual([])
    expect(ops).toContain("for-each-ref")
    expect(ops).not.toContain("show-ref")
  })
})
