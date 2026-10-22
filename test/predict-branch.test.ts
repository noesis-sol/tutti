import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"
import { OrganHold, Organs } from "../src/organs/Organs.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import { repoFiles } from "../src/run/footprint.ts"
import type { Ledger } from "../src/run/ledger.ts"
import type { Log } from "../src/run/log.ts"
import { make as makePredictor } from "../src/run/predict.ts"
import { type Footprints, make } from "../src/run/schedule.ts"
import { Beads, type Issue } from "../src/services/Beads.ts"
import type { Git } from "../src/services/Git.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import type { Captured } from "../src/testing/EventStream.ts"
import { layer as memoryGit } from "../src/testing/Git.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"
import { type Answers, layer as cannedLayer, type OrganCallRecord } from "../src/testing/Organs.ts"

// A reopened or carried-over ticket with commits on its branch is footprinted from what its branch
// changes (§ 5 Footprints): the predictor has nothing to guess for it, though its text names nothing.

const tracked = ["README.md", "src/a.ts", "src/b.ts"]
const repository = repoFiles(tracked)

type Env =
  | Beads
  | Backlog
  | Ledger
  | Log
  | EventStream
  | Captured
  | RunFibers
  | Organs
  | Git
  | Scope.Scope

/** Runs `effect` over the backlog with `seeds`, the predictor's `answers` and git's files. */
const run = async <A, E>(
  seeds: ReadonlyArray<Seed>,
  answers: Answers,
  effect: Effect.Effect<A, E, Env>,
) => {
  const calls: Array<OrganCallRecord> = []
  const base = Layer.mergeAll(beadsLayer(seeds), ledgerLayer(), runFibersLayer)
  const organs = Organs.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        cannedLayer(answers, calls),
        configLayer(appConfig({})),
        Layer.succeed(OrganHold, { held: Effect.succeed(false) }),
      ),
    ),
  )
  const files = Object.fromEntries(tracked.map((f) => [f, `// ${f}\n`]))
  const layers = Layer.mergeAll(organs, memoryGit({ files })).pipe(
    Layer.provideMerge(base),
    Layer.provideMerge(TestClock.layer()),
  )
  const result = await Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(layers)))
  return { result, calls }
}

/** Lets forked fibers run, without moving the clock. */
const flush = Effect.gen(function* () {
  for (let i = 0; i < 200; i++) yield* Effect.yieldNow
})

/** The tickets the predictor was asked about, in order. */
const asked = (calls: ReadonlyArray<OrganCallRecord>) =>
  calls.map((c) => c.input.match(/ticket (t-\d) will change/)?.[1])

const issue = (id: string) => Effect.flatMap(Backlog, (backlog) => backlog.get(id))

describe("a ticket with commits on its branch", () => {
  test("is not predicted by the run: no predictor call, no predicted_files", async () => {
    const { result, calls } = await run(
      [
        { id: "t-1", priority: 0, title: "Carry on with the greeting" },
        { id: "t-2", priority: 1, title: "Make the greeting friendlier" },
      ],
      { predictor: { files: ["src/b.ts"] } },
      Effect.gen(function* () {
        const branches = new Map([["t-1", ["src/a.ts"]]])
        const footprints: Footprints = {
          repo: Effect.succeed(repository),
          changed: () => Effect.succeed([]),
          branch: (ticket) => Effect.succeed(branches.get(ticket) ?? []),
          mentions: () => Effect.succeed(() => false),
        }
        const predictor = yield* makePredictor({ repo: "/repo" })
        const schedule = yield* make({
          concurrent: 2,
          limit: 40,
          scope: null,
          excludeTypes: ["epic"],
          footprints,
          predictor,
          start: { start: () => Effect.never },
        })
        yield* schedule.fill
        yield* flush
        yield* schedule.fill
        yield* flush
        return [yield* issue("t-1"), yield* predictor.predicted, yield* texts] as const
      }),
    )
    const [carried, predicted, lines] = result
    // The ticket without a branch is still predicted, once.
    expect(asked(calls)).toEqual(["t-2"])
    expect(carried?.metadata.predicted_files).toBeUndefined()
    expect([...predicted.keys()]).toEqual(["t-2"])
    expect(lines).toContain("  t-1 footprint: src/a.ts (from its branch)")
    expect(lines.some((text) => text.includes("t-1 footprint predicted"))).toBe(false)
  })

  test("has its branch read only when its text names nothing; one changing nothing is queued", async () => {
    const { result, calls } = await run(
      [
        { id: "t-1", metadata: { files: ["src/a.ts"] } },
        { id: "t-2" },
        { id: "t-3", title: "Make the greeting friendlier" },
      ],
      { predictor: { files: ["src/b.ts"] } },
      Effect.gen(function* () {
        const read = yield* Ref.make<ReadonlyArray<string>>([])
        const branches = new Map([["t-2", ["src/a.ts"]]])
        const branch = (ticket: string) =>
          Effect.as(
            Ref.update(read, (all) => [...all, ticket]),
            branches.get(ticket) ?? [],
          )
        const predictor = yield* makePredictor({ repo: "/repo" })
        const beads = yield* Beads
        const issues: Array<Issue> = []
        for (const id of ["t-1", "t-2", "t-3"]) issues.push(yield* Effect.orDie(beads.show(id)))
        yield* predictor.queue(issues, repository, branch)
        yield* flush
        // Queued once a run: a second fill reads no branch again.
        yield* predictor.queue(issues, repository, branch)
        yield* flush
        return yield* Ref.get(read)
      }),
    )
    expect(result).toEqual(["t-2", "t-3"])
    expect(asked(calls)).toEqual(["t-3"])
  })
})
