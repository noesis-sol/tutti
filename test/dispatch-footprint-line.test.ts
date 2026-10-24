// The dispatch's footprint line (§ 5 item 5): with the queue's footprint on, each ticket dispatched
// has `<id> footprint: …` logged under its `dispatching` line, as orchestra's startFootprint does.
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { layer as runFibersLayer } from "../src/run/fibers.ts"
import type { Predictor } from "../src/run/predict.ts"
import { repoFiles } from "../src/run/repoFiles.ts"
import { type Footprints, make } from "../src/run/schedule.ts"
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

/** The log of one fill over `seeds`, each ticket started running until the test ends. */
const logOfFill = (
  seeds: ReadonlyArray<Seed>,
  options: { readonly footprints?: Footprints; readonly predictor?: Predictor },
): Promise<ReadonlyArray<string>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const schedule = yield* make({
        concurrent: 3,
        limit: 40,
        scope: null,
        excludeTypes: ["epic"],
        ...options,
        start: { start: () => Effect.never },
      })
      yield* schedule.fillTrying
      return yield* texts
    }).pipe(Effect.scoped, Effect.provide(layers(seeds))),
  )

describe("a dispatched ticket's footprint", () => {
  test("is logged under its dispatch line: functions, files, then areas", async () => {
    const lines = await logOfFill(
      [
        {
          id: "t-1",
          title: "Fix it",
          description: "Change `Loop.merge` in src/run/loop.ts",
          labels: ["area:run"],
          metadata: { files: ["src/a.ts"] },
        },
      ],
      { footprints },
    )
    const at = lines.indexOf("[1/40] t-1 dispatching: Fix it")
    expect(at).toBeGreaterThanOrEqual(0)
    expect(lines[at + 1]).toBe("  t-1 footprint: Loop.merge, src/a.ts, src/run/loop.ts, area:run")
  })

  test("says when the ticket names nothing", async () => {
    const lines = await logOfFill([{ id: "t-1", title: "Tidy up" }], { footprints })
    expect(lines).toContain("  t-1 footprint: nothing named")
  })

  test("marks the predictor's files as predicted", async () => {
    const predictor: Predictor = {
      queue: () => Effect.void,
      predicted: Effect.succeed(new Map([["t-1", ["src/b.ts"]]])),
      interrupt: Effect.void,
    }
    const lines = await logOfFill([{ id: "t-1", title: "Tidy up" }], { footprints, predictor })
    expect(lines).toContain("  t-1 footprint: src/b.ts (predicted)")
  })

  test("logs one line for each ticket dispatched", async () => {
    const lines = await logOfFill(
      [
        { id: "t-1", priority: 0, metadata: { files: ["src/a.ts"] } },
        { id: "t-2", priority: 1, metadata: { files: ["src/b.ts"] } },
      ],
      { footprints },
    )
    expect(lines.filter((text) => text.includes("footprint:"))).toEqual([
      "  t-1 footprint: src/a.ts",
      "  t-2 footprint: src/b.ts",
    ])
  })

  test("isn't logged with the queue's footprint off", async () => {
    const lines = await logOfFill([{ id: "t-1", metadata: { files: ["src/a.ts"] } }], {})
    expect(lines.some((text) => text.includes("t-1 dispatching"))).toBe(true)
    expect(lines.filter((text) => text.includes("footprint"))).toEqual([])
  })
})
