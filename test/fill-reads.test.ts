// What a fill reads (tutti-l17s): no bd show for a ticket bd ready gives no links to wait on, and
// the repository's files listed again only once the checkout's commit moves.

import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Effect, Layer, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"
import type { EventStream } from "../src/run/eventstream.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { Log } from "../src/run/log.ts"
import type { TicketPhase } from "../src/run/phase.ts"
import { footprintsOf, make } from "../src/run/schedule.ts"
import type { Beads, Issue } from "../src/services/Beads.ts"
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

const shown = (p: TicketPhase | undefined): string =>
  p === undefined ? "none" : p._tag === "HeldBack" ? `HeldBack:${p.why}` : p._tag

describe("a fill with a ticket of the run's pending", () => {
  test("shows no ticket bd ready gives no links to wait on", async () => {
    const seeds: ReadonlyArray<Seed> = [
      { id: "a-1", priority: 0 },
      { id: "t-2", priority: 1 },
      { id: "x-1", status: "deferred" },
      { id: "t-3", priority: 2, dependencies: [{ id: "x-1", type: "discovered-from" }] },
    ]
    const [started, phases, lines] = await run(
      seeds,
      Effect.gen(function* () {
        const started = yield* Ref.make<ReadonlyArray<string>>([])
        const never = yield* Deferred.make<void>()
        const schedule = yield* make({
          concurrent: 3,
          limit: 40,
          scope: null,
          excludeTypes: ["epic"],
          start: {
            start: (issue: Issue) =>
              Effect.gen(function* () {
                yield* Ref.update(started, (all) => [...all, issue.id])
                yield* Deferred.await(never)
              }),
          },
        })
        // Every bd show fails: a ticket that needs one waits, one that doesn't goes ahead.
        yield* (yield* Backlog).fail("show", { times: Infinity })
        yield* schedule.fill
        const state = yield* (yield* Ledger).current
        return [
          yield* Ref.get(started),
          ["t-2", "t-3"].map((id) => shown(state.tickets.get(id)?.phase)),
          yield* texts,
        ] as const
      }),
    )
    expect(started).toEqual(["a-1", "t-2"])
    expect(phases).toEqual(["Working", "HeldBack:merge"])
    expect(lines).toContain("  t-3 waits: its dependencies could not be read")
    expect(lines.filter((text) => text.includes("could not read"))).toEqual([
      expect.stringContaining("could not read t-3's links"),
    ])
  })
})

describe("the checkout's files", () => {
  test("are listed once a commit of the checkout, and again once it moves", async () => {
    const [first, again, moved, listings] = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* Repository
        const source = yield* footprintsOf({
          repo: repo.dir,
          base: "main",
          checkCommands: [],
          worktree: (ticket) => Effect.succeed(`/repo-tutti/${ticket}`),
        })
        const first = (yield* source.repo).resolve("new.ts", false)
        const again = (yield* source.repo).resolve("a.ts", false)
        // A merge moves the checkout's commit.
        yield* repo.commit(repo.dir, "merged", { "src/new.ts": "new" })
        const moved = (yield* source.repo).resolve("new.ts", false)
        yield* source.repo
        const listings = (yield* repo.calls).filter((call) => call.op === "ls-files").length
        return [first, again, moved, listings] as const
      }).pipe(
        Effect.provide(
          Layer.mergeAll(memoryGit({ files: { "src/a.ts": "a" } }), BunServices.layer),
        ),
      ),
    )
    expect(first).toEqual([])
    expect(again).toEqual(["src/a.ts"])
    expect(moved).toEqual(["src/new.ts"])
    expect(listings).toBe(2)
  })
})
