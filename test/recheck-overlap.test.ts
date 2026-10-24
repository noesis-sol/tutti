// A ticket checked once more takes a slot as a running ticket does (§ 5 item 8): its footprint
// holds back a ready ticket overlapping it while it rebases and merges, though the scheduler took
// its slot without its issue.
import { expect, test } from "bun:test"
import { Effect, Layer, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"
import type { EventStream } from "../src/run/eventstream.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { Log } from "../src/run/log.ts"
import { Move, type TicketPhase } from "../src/run/phase.ts"
import { repoFiles } from "../src/run/repoFiles.ts"
import { type Footprints, make } from "../src/run/schedule.ts"
import type { Beads, Issue } from "../src/services/Beads.ts"
import { layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"

type Env = Beads | Ledger | Log | EventStream | RunFibers | Scope.Scope

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

const footprints: Footprints = {
  repo: Effect.succeed(repoFiles(["src/a.ts", "src/b.ts"])),
  changed: () => Effect.succeed([]),
  mentions: () => Effect.succeed(() => false),
}

const shown = (p: TicketPhase | undefined): string =>
  p === undefined ? "none" : p._tag === "HeldBack" ? `HeldBack:${p.why}` : p._tag

// r, closed and waiting to merge, touches src/a.ts; t-2, ready, touches it too.
const seeds: ReadonlyArray<Seed> = [
  { id: "r", status: "closed", metadata: { files: ["src/a.ts"] } },
  { id: "t-2", priority: 1, metadata: { files: ["src/a.ts"] } },
]

/** t-2's phase after a fill, with r past its work, checked once more in a slot or not. */
const t2After = (rechecked: boolean) =>
  run(
    seeds,
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const started = yield* Ref.make<ReadonlyArray<string>>([])
      const schedule = yield* make({
        concurrent: 2,
        limit: 40,
        scope: null,
        excludeTypes: ["epic"],
        footprints,
        start: {
          start: (issue: Issue) =>
            Effect.andThen(
              Ref.update(started, (all) => [...all, issue.id]),
              Effect.never,
            ),
        },
      })
      yield* ledger.transition("r", Move.Unmerged({ place: 1 }))
      const took = rechecked ? yield* schedule.recheckSlot("r", Effect.never) : false
      yield* schedule.fill
      const state = yield* ledger.current
      return {
        took,
        started: yield* Ref.get(started),
        t2: shown(state.tickets.get("t-2")?.phase),
        skipping: (yield* texts).filter((text) => text.includes("skipping")),
      }
    }),
  )

test("a ticket past its work without a slot holds back one overlapping it", async () => {
  expect(await t2After(false)).toEqual({
    took: false,
    started: [],
    t2: "HeldBack:overlap",
    skipping: ["  skipping t-2: touches src/a.ts, like running r"],
  })
})

test("a ticket checked once more in a slot holds back one overlapping it", async () => {
  expect(await t2After(true)).toEqual({
    took: true,
    started: [],
    t2: "HeldBack:overlap",
    skipping: ["  skipping t-2: touches src/a.ts, like running r"],
  })
})
