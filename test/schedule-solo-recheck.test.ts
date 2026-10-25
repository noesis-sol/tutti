// A solo ticket runs alone (§ 5): one checked once more, or past its work, that took no slot with
// its issue holds back the others while it rebases and merges, footprints on or off, its issue read
// from bd as the overlap check reads it.
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
import type { Beads, Issue, TicketId } from "../src/services/Beads.ts"
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

/** t-2's phase after a fill, with r closed: checked once more in a slot, or waiting to merge. */
const t2After = (r: Seed, rechecked: boolean, withFootprints: boolean) =>
  run(
    [r, { id: "t-2", priority: 1, metadata: { files: ["src/b.ts"] } }],
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const started = yield* Ref.make<ReadonlyArray<string>>([])
      const schedule = yield* make({
        concurrent: 2,
        limit: 40,
        scope: null,
        excludeTypes: ["epic"],
        ...(withFootprints ? { footprints } : {}),
        start: {
          start: (issue: Issue) =>
            Effect.andThen(
              Ref.update(started, (all) => [...all, issue.id]),
              Effect.never,
            ),
        },
      })
      // One checked once more waits in Review, its check failed, until it takes its slot.
      if (!rechecked) yield* ledger.transition("r" as TicketId, Move.Unmerged({ place: 1 }))
      const took = rechecked ? yield* schedule.recheckSlot("r" as TicketId, Effect.never) : false
      yield* schedule.fillTrying
      const state = yield* ledger.current
      return {
        took,
        started: yield* Ref.get(started),
        t2: shown(state.tickets.get("t-2" as TicketId)?.phase),
        solo: (yield* texts).filter((text) => text.includes("solo")),
      }
    }),
  )

const solo: Seed = {
  id: "r",
  status: "closed",
  labels: ["solo"],
  metadata: { files: ["src/a.ts"] },
}

for (const withFootprints of [true, false]) {
  const footprinted = withFootprints ? "footprints on" : "footprints off"

  test(`a solo ticket checked once more in a slot holds back the others (${footprinted})`, async () => {
    expect(await t2After(solo, true, withFootprints)).toEqual({
      took: true,
      started: [],
      t2: "HeldBack:solo",
      solo: ["  waiting for solo ticket r to finish"],
    })
  })

  test(`a solo ticket past its work without a slot holds back the others (${footprinted})`, async () => {
    expect(await t2After(solo, false, withFootprints)).toEqual({
      took: false,
      started: [],
      t2: "HeldBack:solo",
      solo: ["  waiting for solo ticket r to finish"],
    })
  })
}

test("a ticket checked once more without the solo label lets one beside it start", async () => {
  expect(await t2After({ ...solo, labels: [] }, true, true)).toEqual({
    took: true,
    started: ["t-2"],
    t2: "Working",
    solo: [],
  })
})

/** Whether r2 is checked once more, and c carried over, beside r as t2After has it, none in line. */
const besideR = (rechecked: boolean) =>
  run(
    [solo, { id: "r2", status: "closed" }, { id: "c", status: "in_progress" }],
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const schedule = yield* make({
        concurrent: 3,
        limit: 40,
        scope: null,
        excludeTypes: ["epic"],
        start: { start: () => Effect.never },
      })
      if (!rechecked) yield* ledger.transition("r" as TicketId, Move.Unmerged({ place: 1 }))
      const took = rechecked ? yield* schedule.recheckSlot("r" as TicketId, Effect.never) : false
      const r2 = yield* schedule.recheckSlot("r2" as TicketId, Effect.never)
      const c = yield* schedule.carry("c" as TicketId, Effect.succeed(Effect.never))
      return { took, r2, c, running: [...(yield* schedule.running)] }
    }),
  )

test("a solo ticket checked once more keeps the next recheck and a carried worker out", async () => {
  expect(await besideR(true)).toEqual({
    took: true,
    r2: false,
    c: false,
    running: ["r" as TicketId],
  })
})

test("a solo ticket past its work without a slot keeps a recheck and a carried worker out", async () => {
  expect(await besideR(false)).toEqual({ took: false, r2: false, c: false, running: [] })
})

test("a solo ticket past its work without a slot keeps a carried worker out, before any fill", async () => {
  const carried = await run(
    [solo, { id: "c", status: "in_progress" }],
    Effect.gen(function* () {
      const ledger = yield* Ledger
      const schedule = yield* make({
        concurrent: 3,
        limit: 40,
        scope: null,
        excludeTypes: ["epic"],
        start: { start: () => Effect.never },
      })
      yield* ledger.transition("r" as TicketId, Move.Unmerged({ place: 1 }))
      return yield* schedule.carry("c" as TicketId, Effect.succeed(Effect.never))
    }),
  )
  expect(carried).toBe(false)
})
