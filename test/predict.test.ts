import { describe, expect, test } from "bun:test"
import { Duration, Effect, Layer, Ref, type Scope } from "effect"
import { AiError } from "effect/ai"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import { renderInput } from "../src/organs/evidence.ts"
import { OrganHold, Organs } from "../src/organs/Organs.ts"
import {
  keptFiles,
  maxListed,
  maxPredicted,
  predictor,
  predictorInput,
} from "../src/organs/predictor.ts"
import type { EventRecord } from "../src/run/events.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import { type RunFibers, layer as runFibersLayer } from "../src/run/fibers.ts"
import { repoFiles, showFootprint } from "../src/run/footprint.ts"
import { Ledger } from "../src/run/ledger.ts"
import type { Log } from "../src/run/log.ts"
import { footprintOf, make as makePredictor, type Predictor } from "../src/run/predict.ts"
import { type Footprints, make, type Scheduler } from "../src/run/schedule.ts"
import type { Beads, Issue } from "../src/services/Beads.ts"
import type { Git } from "../src/services/Git.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { Captured } from "../src/testing/EventStream.ts"
import { layer as memoryGit } from "../src/testing/Git.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"
import { type Answers, layer as cannedLayer, type OrganCallRecord } from "../src/testing/Organs.ts"

/** The repository's files, in git and as the footprints read them. */
const tracked = ["README.md", "src/a.ts", "src/b.ts", "src/z.ts"]
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
  options: { readonly held?: boolean } = {},
) => {
  const calls: Array<OrganCallRecord> = []
  const base = Layer.mergeAll(beadsLayer(seeds), ledgerLayer(), runFibersLayer)
  const organs = Organs.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        cannedLayer(answers, calls),
        configLayer(appConfig({})),
        Layer.succeed(OrganHold, { held: Effect.succeed(options.held ?? false) }),
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

const footprints = (changed: Ref.Ref<ReadonlyMap<string, ReadonlyArray<string>>>): Footprints => ({
  repo: Effect.succeed(repository),
  changed: (ticket) => Effect.map(Ref.get(changed), (all) => all.get(ticket) ?? []),
  mentions: () => Effect.succeed(() => false),
})

const files = (...names: ReadonlyArray<string>) => ({ files: names })

/**
 * A scheduler with a predictor over the main checkout /repo, whose tickets each run until the
 * test ends; `changed` gives each running ticket's worktree changes.
 */
const scheduler = (options: { readonly concurrent: number; readonly footprints?: boolean }) =>
  Effect.gen(function* () {
    const changed = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<string>>>(new Map())
    const started = yield* Ref.make<ReadonlyArray<string>>([])
    const predictor: Predictor = yield* makePredictor({ repo: "/repo" })
    const schedule: Scheduler = yield* make({
      concurrent: options.concurrent,
      limit: 40,
      scope: null,
      excludeTypes: ["epic"],
      ...(options.footprints === false ? {} : { footprints: footprints(changed) }),
      predictor,
      start: {
        start: (issue: Issue) =>
          Effect.andThen(
            Ref.update(started, (all) => [...all, issue.id]),
            Effect.never,
          ),
      },
    })
    return { schedule, predictor, changed, started: Ref.get(started) }
  })

const phase = (id: string) =>
  Effect.map(
    Effect.flatMap(Ledger, (ledger) => ledger.current),
    (state) => {
      const p = state.tickets.get(id)?.phase
      return p === undefined ? "none" : p._tag === "HeldBack" ? `HeldBack:${p.why}` : p._tag
    },
  )

const issue = (id: string) => Effect.flatMap(Backlog, (backlog) => backlog.get(id))

const records = Effect.flatMap(Captured, (captured) => captured.records)

describe("the predictor organ", () => {
  test("is asked with the ticket and the repository's files, the ticket's ID outside the tags", () => {
    const ticket: Issue = {
      id: "t-1",
      title: "Make the greeting friendlier",
      description: "Say hello by name.",
      design: "",
      acceptance: "The greeting names you.",
      notes: "",
      status: "open",
      priority: 2,
      type: "task",
      assignee: "",
      labels: ["ui"],
      dependencies: [],
      metadata: {},
      files: [],
      predictedFiles: [],
      createdAt: "2026-10-17T00:00:00Z",
      closeReason: "",
    }
    const input = renderInput("abc", predictorInput(ticket, tracked))
    expect(input).toBe(
      '## Ticket (bd show)\n\n<evidence id="abc">\n' +
        "t-1: Make the greeting friendlier\nStatus: open · Priority: P2 · Type: task\nLabels: ui\n\n" +
        "Description:\nSay hello by name.\n\nAcceptance criteria:\nThe greeting names you.\n" +
        '</evidence id="abc">\n\n' +
        '## Repository files (git ls-files)\n\n<evidence id="abc">\n' +
        "README.md\nsrc/a.ts\nsrc/b.ts\nsrc/z.ts\n" +
        '</evidence id="abc">\n\n' +
        "Predict the files ticket t-1 will change.\n",
    )
    const many = Array.from({ length: maxListed + 3 }, (_, i) => `f${i}.ts`)
    const listed = renderInput("abc", predictorInput(ticket, many))
    expect(listed).toContain(`f${maxListed - 1}.ts\n(… and 3 more)\n`)
    expect(listed).not.toContain(`f${maxListed}.ts`)
  })

  test("runs at low effort within 2 minutes, its prompt keeping at most 8 files", () => {
    expect(predictor.effort).toBe("low")
    expect(Duration.toMinutes(predictor.timeLimit)).toBe(2)
    expect(predictor.system).toContain(`at most ${maxPredicted} files from the list`)
    expect(predictor.system).not.toContain("{{")
  })

  test("keeps the repository's files only, once each, up to 8", () => {
    const answer = [
      " ./src/a.ts ",
      "src/a.ts",
      "nowhere.ts",
      "/etc/passwd",
      "../src/b.ts",
      "src/b.ts",
    ]
    expect(keptFiles(answer, tracked)).toEqual(["src/a.ts", "src/b.ts"])
    const nine = Array.from({ length: 9 }, (_, i) => `f${i}.ts`)
    expect(keptFiles(nine, nine)).toEqual(nine.slice(0, maxPredicted))
  })

  test("whatever the model answers, the files kept are the repository's, once each", () => {
    const path = fc.oneof(fc.constantFrom(...tracked, ...tracked.map((f) => `./${f}`)), fc.string())
    fc.assert(
      fc.property(fc.array(path), (answer) => {
        const kept = keptFiles(answer, tracked)
        expect(kept.length).toBeLessThanOrEqual(maxPredicted)
        expect(new Set(kept).size).toBe(kept.length)
        for (const f of kept) expect(tracked).toContain(f)
      }),
    )
  })
})

describe("a ticket naming nothing", () => {
  test("has its predicted files kept as predicted_files metadata, and logged", async () => {
    const { result, calls } = await run(
      [{ id: "t-1", title: "Make the greeting friendlier" }],
      { predictor: { files: ["src/a.ts", "nowhere.ts", "src/b.ts"] } },
      Effect.gen(function* () {
        const { schedule } = yield* scheduler({ concurrent: 1 })
        yield* schedule.fill
        yield* flush
        return [yield* issue("t-1"), yield* texts] as const
      }),
    )
    const [ticket, lines] = result
    expect(ticket?.metadata.predicted_files).toBe('["src/a.ts","src/b.ts"]')
    expect(ticket?.predictedFiles).toEqual(["src/a.ts", "src/b.ts"])
    expect(lines).toContain("  t-1 footprint predicted: src/a.ts, src/b.ts")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.call).toMatchObject({ organ: "predictor", effort: "low" })
    expect(calls[0]?.input).toContain("Predict the files ticket t-1 will change.")
    expect(calls[0]?.input).toContain("src/z.ts")
  })

  test("is asked about once a run; a ticket naming something, or solo, never", async () => {
    const { result, calls } = await run(
      [
        { id: "t-1", priority: 0, metadata: files("src/z.ts") },
        { id: "t-2", priority: 1 },
        { id: "t-3", priority: 2, labels: ["solo"] },
        { id: "t-4", priority: 3, metadata: { predicted_files: '["src/b.ts"]' } },
      ],
      { predictor: { files: [] } },
      Effect.gen(function* () {
        const { schedule } = yield* scheduler({ concurrent: 1 })
        yield* schedule.fill
        yield* flush
        yield* schedule.fill
        yield* flush
        return yield* texts
      }),
    )
    expect(calls.map((c) => c.input.match(/ticket (t-\d) will change/)?.[1])).toEqual(["t-2"])
    expect(result).toContain("  t-2 footprint not predicted: the ticket gives no clue")
  })

  test("is not predicted with footprints off", async () => {
    const { calls } = await run(
      [{ id: "t-1" }],
      { predictor: { files: ["src/a.ts"] } },
      Effect.gen(function* () {
        const { schedule } = yield* scheduler({ concurrent: 1, footprints: false })
        yield* schedule.fill
        yield* flush
      }),
    )
    expect(calls).toEqual([])
  })

  test("keeps an empty footprint when the predictor fails, the log saying why", async () => {
    const failed = AiError.make({
      module: "test",
      method: "generateText",
      reason: new AiError.UnknownError({ description: "the model is down\nand more" }),
    })
    const { result } = await run(
      [{ id: "t-1" }],
      { predictor: Effect.fail(failed) },
      Effect.gen(function* () {
        const { schedule } = yield* scheduler({ concurrent: 1 })
        yield* schedule.fill
        yield* flush
        return [yield* issue("t-1"), yield* texts] as const
      }),
    )
    const [ticket, lines] = result
    expect(ticket?.metadata).not.toHaveProperty("predicted_files")
    const said = lines.filter((text) => text.includes("footprint not predicted"))
    expect(said).toHaveLength(1)
    expect(said[0]).toStartWith("  t-1 footprint not predicted: ")
  })

  test("is not predicted while the usage limit holds organ calls", async () => {
    const { result, calls } = await run(
      [{ id: "t-1" }],
      { predictor: { files: ["src/a.ts"] } },
      Effect.gen(function* () {
        const { schedule } = yield* scheduler({ concurrent: 1 })
        yield* schedule.fill
        yield* flush
        return yield* texts
      }),
      { held: true },
    )
    expect(calls).toEqual([])
    expect(result).toContain("ORGAN predictor: skipped, the usage limit holds the run")
    expect(result.some((text) => text.includes("not predicted"))).toBe(false)
  })
})

describe("a predicted footprint", () => {
  test("is the run's prediction when bd hasn't handed back the one kept on the ticket", () => {
    const ticket = { id: "t-1", title: "Say hello" } as const
    const bare: Issue = {
      ...ticket,
      description: "",
      design: "",
      acceptance: "",
      notes: "",
      status: "open",
      type: "task",
      assignee: "",
      labels: [],
      dependencies: [],
      metadata: {},
      files: [],
      predictedFiles: [],
      createdAt: "2026-10-17T00:00:00Z",
      closeReason: "",
    }
    const predicted = new Map([["t-1", ["src/a.ts"]]])
    expect(showFootprint(footprintOf(bare, repository, new Map()))).toBe("nothing named")
    expect(showFootprint(footprintOf(bare, repository, predicted))).toBe("src/a.ts (predicted)")
    // A ticket naming something keeps its own footprint.
    const named = { ...bare, files: ["src/b.ts"] }
    expect(showFootprint(footprintOf(named, repository, predicted))).toBe("src/b.ts")
  })

  test("grows a running ticket's footprint: a ticket touching its file is held back", async () => {
    const { result } = await run(
      [{ id: "t-1", title: "Make the greeting friendlier" }],
      { predictor: { files: ["src/a.ts"] } },
      Effect.gen(function* () {
        const { schedule, started } = yield* scheduler({ concurrent: 2 })
        yield* schedule.fill
        yield* flush
        yield* (yield* Backlog).put({ id: "t-2", metadata: files("src/a.ts") })
        yield* schedule.fill
        return [yield* started, yield* phase("t-2"), yield* texts] as const
      }),
    )
    const [started, held, lines] = result
    expect(started).toEqual(["t-1"])
    expect(held).toBe("HeldBack:overlap")
    expect(lines).toContain("  skipping t-2: touches src/a.ts, like running t-1")
  })

  test("holds back a queued ticket predicted to touch a running ticket's file", async () => {
    const { result } = await run(
      [
        { id: "t-1", priority: 0, metadata: files("src/a.ts") },
        { id: "t-2", priority: 1, title: "Make the greeting friendlier" },
      ],
      { predictor: { files: ["src/a.ts"] } },
      Effect.gen(function* () {
        const { schedule, predictor, started } = yield* scheduler({ concurrent: 2 })
        // The ticket is predicted first, as when an earlier fill had no slot for it.
        yield* predictor.queue([(yield* issue("t-2")) as Issue], repository)
        yield* flush
        yield* schedule.fill
        return [yield* started, yield* phase("t-2"), yield* texts] as const
      }),
    )
    const [started, held, lines] = result
    expect(started).toEqual(["t-1"])
    expect(held).toBe("HeldBack:overlap")
    expect(lines).toContain("  skipping t-2: touches src/a.ts, like running t-1")
  })

  test("comes too late for tickets already running: LIKELY_CONFLICT when both edit it", async () => {
    // The predictor answers after a while: picking never waits for it.
    const late = Effect.as(Effect.sleep(Duration.seconds(10)), { files: ["src/a.ts"] })
    const { result } = await run(
      [{ id: "t-1" }, { id: "t-2" }],
      { predictor: late },
      Effect.gen(function* () {
        const { schedule, started, changed } = yield* scheduler({ concurrent: 2 })
        yield* schedule.fill
        const both = yield* started
        yield* TestClock.adjust(Duration.seconds(30))
        yield* flush
        yield* Ref.set(
          changed,
          new Map([
            ["t-1", ["src/a.ts"]],
            ["t-2", ["src/a.ts"]],
          ]),
        )
        yield* schedule.fill
        yield* schedule.fill
        return [both, yield* texts, yield* records] as const
      }),
    )
    const [both, lines, all] = result
    expect(both).toEqual(["t-1", "t-2"])
    expect(lines).toContain("  t-1 footprint predicted: src/a.ts")
    expect(lines).toContain("  t-2 footprint predicted: src/a.ts")
    const warning =
      "  LIKELY_CONFLICT: t-1 and t-2 both edit src/a.ts; the second to merge may conflict"
    expect(lines.filter((text) => text.includes("LIKELY_CONFLICT"))).toEqual([warning])
    expect(all.filter((r: EventRecord) => r.kind === "warn")).toMatchObject([{ text: warning }])
  })
})
