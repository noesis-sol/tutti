// A carried ticket's footprint line: a resumed or carried-over worker given its issue has
// `<id> footprint: …` logged as a dispatched ticket's is, as orchestra's startFootprint does for a
// ticket it adopts or resumes.
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { layer as runFibersLayer } from "../src/run/fibers.ts"
import { repoFiles } from "../src/run/footprint.ts"
import type { Predictor } from "../src/run/predict.ts"
import { type Footprints, make } from "../src/run/schedule.ts"
import { Beads } from "../src/services/Beads.ts"
import { layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"

const layers = (seeds: ReadonlyArray<Seed>) =>
  Layer.mergeAll(beadsLayer(seeds), ledgerLayer(), runFibersLayer).pipe(
    Layer.provideMerge(TestClock.layer()),
  )

const footprints: Footprints = {
  repo: Effect.succeed(repoFiles(["src/a.ts", "src/b.ts", "src/run/loop.ts"])),
  changed: () => Effect.succeed([]),
  mentions: () => Effect.succeed(() => false),
}

/**
 * The log of carrying `seed`'s ticket, given its issue as bd shows it unless `withIssue` is false,
 * its worker running until the test ends.
 */
const logOfCarry = (
  seed: Seed,
  options: {
    readonly footprints?: Footprints
    readonly predictor?: Predictor
    readonly withIssue?: boolean
  },
): Promise<ReadonlyArray<string>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { withIssue = true, ...rest } = options
      const schedule = yield* make({
        concurrent: 3,
        limit: 40,
        scope: null,
        excludeTypes: ["epic"],
        ...rest,
        start: { start: () => Effect.never },
      })
      const issue = withIssue ? yield* (yield* Beads).show(seed.id) : undefined
      yield* schedule.carry(seed.id, Effect.never, issue)
      return yield* texts
    }).pipe(Effect.scoped, Effect.provide(layers([{ status: "in_progress", ...seed }]))),
  )

describe("a carried ticket's footprint", () => {
  test("is logged: functions, files, then areas", async () => {
    const lines = await logOfCarry(
      {
        id: "t-1",
        description: "Change `Loop.merge` in src/run/loop.ts",
        labels: ["area:run"],
        metadata: { files: ["src/a.ts"] },
      },
      { footprints },
    )
    expect(lines).toEqual(["  t-1 footprint: Loop.merge, src/a.ts, src/run/loop.ts, area:run"])
  })

  test("says when the ticket names nothing", async () => {
    const lines = await logOfCarry({ id: "t-1" }, { footprints })
    expect(lines).toEqual(["  t-1 footprint: nothing named"])
  })

  test("marks the predictor's files as predicted", async () => {
    const predictor: Predictor = {
      queue: () => Effect.void,
      predicted: Effect.succeed(new Map([["t-1", ["src/b.ts"]]])),
      interrupt: Effect.void,
    }
    const lines = await logOfCarry({ id: "t-1" }, { footprints, predictor })
    expect(lines).toEqual(["  t-1 footprint: src/b.ts (predicted)"])
  })

  test("isn't logged without its issue", async () => {
    const lines = await logOfCarry(
      { id: "t-1", metadata: { files: ["src/a.ts"] } },
      { footprints, withIssue: false },
    )
    expect(lines).toEqual([])
  })

  test("isn't logged with the queue's footprint off", async () => {
    expect(await logOfCarry({ id: "t-1", metadata: { files: ["src/a.ts"] } }, {})).toEqual([])
  })
})
