// What a worker consumes, as the worker view's resource line has it (§ 7.5, worker-view design D2):
// the five-hour window's rise over the run and a ticket's estimated share of it, the context usage
// a session answers, Spending's sums as they change, the hosts' contexts, and a whole run's
// resources on its RunView.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Fiber, Layer, Option, Stream, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { readContextUsage } from "../src/agent/contextUsage.ts"
import { line } from "../src/run/log.ts"
import type { Resources } from "../src/run/resources.ts"
import { allTokens, noSums, resourcesOf, windowShare } from "../src/run/resources.ts"
import { run } from "../src/run/run.ts"
import type { Dashboard } from "../src/run/screen.ts"
import { Spending, type Sums } from "../src/run/spending.ts"
import { riseStep } from "../src/run/usageWindows.ts"
import { Git } from "../src/services/Git.ts"
import {
  claimsAndCloses,
  context,
  emit,
  layer as hostLayer,
  init,
  result,
  type SessionScript,
  sessionState,
  wait,
} from "../src/testing/AgentHost.ts"
import { allowAll, layer as attentionLayer } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as spendingLayer } from "../src/testing/Spending.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { advance, backlog, expectExitCode, scenario } from "./harness.ts"

setDefaultTimeout(30_000)

const model = "claude-opus-5-5"
const hour = 60 * 60 * 1000
const resets = 1_792_754_400_000

/** A five-hour window's figure. */
const window = (utilization: number, resetsAt: number | null = resets) => ({
  name: "five_hour",
  utilization,
  resetsAt,
})

/** A getContextUsage() answer, as the SDK's types give it. */
const answer = {
  categories: [
    { name: "System prompt", tokens: 3_000, color: "x", kind: "used" },
    { name: "System tools", tokens: 20_000, color: "x", kind: "used" },
    { name: "Messages", tokens: 103_000, color: "x", kind: "used" },
    { name: "Free space", tokens: 40_000, color: "x", kind: "free" },
    { name: "Autocompact buffer", tokens: 34_000, color: "x", kind: "buffer" },
    { name: "MCP tools", tokens: 9_000, color: "x", kind: "deferred", isDeferred: true },
  ],
  totalTokens: 126_000,
  maxTokens: 200_000,
  rawMaxTokens: 1_000_000,
  percentage: 63,
  gridRows: [],
  model,
  memoryFiles: [],
  mcpTools: [],
  agents: [],
  isAutoCompactEnabled: true,
}

describe("the five-hour window's rise over the run", () => {
  test("adds each rise; a reset counts the next window's figure from 0", () => {
    expect(riseStep(0, window(0.11), window(0.12))).toBeCloseTo(0.01)
    expect(riseStep(0.01, window(0.12), window(0.12))).toBeCloseTo(0.01)
    // The figure fell: the window reset, and the new one is at 3%.
    expect(riseStep(0.06, window(0.17), window(0.03, resets + 5 * hour))).toBeCloseTo(0.09)
    // Its reset moved on by a window, though the figure rose past the old one's.
    expect(riseStep(0.06, window(0.17), window(0.2, resets + 5 * hour))).toBeCloseTo(0.26)
    // A reset a few seconds off is the same window.
    expect(riseStep(0, window(0.17), window(0.19, resets + 1_000))).toBeCloseTo(0.02)
  })

  test("never falls", () => {
    const figure = fc.record({
      utilization: fc.double({ min: 0, max: 1, noNaN: true }),
      resetsAt: fc.option(fc.integer({ min: resets, max: resets + 48 * hour }), { nil: null }),
    })
    fc.assert(
      fc.property(fc.array(figure, { minLength: 1, maxLength: 20 }), (figures) => {
        let rise = 0
        for (let i = 1; i < figures.length; i++) {
          const last = figures[i - 1]
          const next = figures[i]
          if (last === undefined || next === undefined) continue
          const after = riseStep(
            rise,
            { name: "five_hour", ...last },
            { name: "five_hour", ...next },
          )
          expect(after).toBeGreaterThanOrEqual(rise)
          rise = after
        }
      }),
    )
  })
})

describe("a ticket's share of the window", () => {
  test("the rise in proportion to its dollars at API prices", () => {
    // The mnemos run of 2026-10-23: 11% to 17% over 7 workers.
    expect(windowShare(0.06, 1.84, 9.2)).toEqual({
      share: 0.012,
      rise: 0.06,
      cost: 1.84,
      runCost: 9.2,
    })
    expect(windowShare(0.06, 0, 9.2)?.share).toBe(0)
    // Nothing spent yet: no share.
    expect(windowShare(0.06, 0, 0)?.share).toBe(0)
    // Not heard yet: none.
    expect(windowShare(null, 1, 2)).toBeNull()
  })

  test("the tickets' shares add up to the rise", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 2, noNaN: true }),
        fc.array(fc.double({ min: 0, max: 100, noNaN: true }), { minLength: 1, maxLength: 12 }),
        (rise, costs) => {
          const run = costs.reduce((sum, cost) => sum + cost, 0)
          const shares = costs.map((cost) => windowShare(rise, cost, run)?.share ?? 0)
          const total = shares.reduce((sum, share) => sum + share, 0)
          expect(total).toBeCloseTo(run > 0 ? rise : 0, 6)
        },
      ),
    )
  })

  test("resourcesOf: on a subscription the share, on an API key none; the run's tokens", () => {
    const tokens = { [model]: { input: 1, output: 2, cache_write: 3, cache_read: 4 } }
    const sums: Sums = {
      tickets: new Map([["t-1", { costUsd: 1, turns: 3, results: 2, tokens }]]),
      total: {
        costUsd: 4,
        turns: 9,
        results: 5,
        tokens: { [model]: { ...tokens[model], input: 91 } },
      },
    }
    const inputs = {
      ticket: "t-1",
      took: 5,
      compactions: 1,
      sums,
      subscription: true,
      rise: 0.08,
      context: undefined,
    }
    const on: Resources = resourcesOf(inputs)
    expect(on).toMatchObject({ took: 5, compactions: 1, runTokens: 100, context: null })
    expect(on.window?.share).toBeCloseTo(0.02)
    expect(allTokens(on.spent.tokens)).toBe(10)
    expect(resourcesOf({ ...inputs, subscription: false }).window).toBeNull()
    expect(resourcesOf({ ...inputs, ticket: "t-2", sums: noSums }).spent.turns).toBe(0)
  })
})

describe("a session's context usage", () => {
  test("its tokens, the window it compacts at and what is used in it, largest first", () => {
    expect(readContextUsage(answer)).toEqual({
      tokens: 126_000,
      window: 200_000,
      percentage: 63,
      split: [
        { name: "Messages", tokens: 103_000 },
        { name: "System tools", tokens: 20_000 },
        { name: "System prompt", tokens: 3_000 },
      ],
    })
  })

  test("a CLI that doesn't classify its rows: the free space and the reserve left out", () => {
    const rows = answer.categories.map(({ kind: _, ...row }) => row)
    expect(
      readContextUsage({ ...answer, categories: rows })?.split.map((part) => part.name),
    ).toEqual(["Messages", "System tools", "MCP tools", "System prompt"])
  })

  test("an answer without its figures is none; anything else never throws", () => {
    for (const each of [
      undefined,
      null,
      3,
      "x",
      {},
      { totalTokens: 5 },
      { ...answer, maxTokens: 0 },
    ]) {
      expect(readContextUsage(each)).toBeUndefined()
    }
    fc.assert(
      fc.property(fc.anything(), (any) => {
        const read = readContextUsage(any)
        if (read !== undefined) {
          expect(read.window).toBeGreaterThan(0)
          expect(read.tokens).toBeGreaterThanOrEqual(0)
        }
      }),
    )
    fc.assert(
      fc.property(
        fc.record({
          totalTokens: fc.anything(),
          maxTokens: fc.anything(),
          categories: fc.anything(),
        }),
        (any) => {
          readContextUsage(any)
        },
      ),
    )
  })
})

const resultOf = (cost: number, output: number): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "DONE",
    num_turns: 2,
    total_cost_usd: cost,
    modelUsage: { [model]: { inputTokens: 10, outputTokens: output } },
  }) as unknown as SDKMessage

describe("Spending's sums", () => {
  test("now, then after each result, each ticket's and the run's", async () => {
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const spending = yield* Spending
        const fiber = yield* spending.sums.pipe(Stream.take(3), Stream.runCollect, Effect.forkChild)
        yield* Effect.yieldNow
        yield* spending.message("t-1", { session: "s-1", message: resultOf(0.5, 100) })
        yield* spending.message("t-2", { session: "s-2", message: resultOf(0.25, 10) })
        return [...(yield* Fiber.join(fiber))]
      }).pipe(Effect.provide(spendingLayer().pipe(Layer.provideMerge(eventsLayer())))),
    )
    expect(seen.map((sums) => [...sums.tickets.keys()])).toEqual([[], ["t-1"], ["t-1", "t-2"]])
    expect(seen.at(-1)?.total).toMatchObject({ costUsd: 0.75, turns: 4, results: 2 })
    expect(seen.at(-1)?.tickets.get("t-1")?.tokens[model]?.output).toBe(100)
  })
})

describe("the hosts' contexts", () => {
  test("the scripted host keeps a session's answer as its worker's, until it is ended", async () => {
    const script: SessionScript = [wait, init(), sessionState("running"), context(answer), result()]
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start("t-1", { sessionId: "s-1", cwd: "/work/t-1" })
        yield* host.send("t-1", { text: "Work on t-1", from: "clientComposed" })
        const measured = yield* host.contexts.pipe(
          Stream.filter((all) => all.has("t-1")),
          Stream.runHead,
        )
        yield* host.end("t-1")
        const after = yield* host.contexts.pipe(Stream.runHead)
        return { measured: Option.getOrUndefined(measured)?.get("t-1"), after }
      }).pipe(
        Effect.provide(
          hostLayer({ "t-1": [script] }).pipe(
            Layer.provideMerge(Layer.mergeAll(attentionLayer(allowAll), transcriptsLayer())),
            Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer())),
            Layer.provideMerge(TestClock.layer()),
          ),
        ),
      ),
    )
    expect(seen.measured).toMatchObject({ tokens: 126_000, window: 200_000, percentage: 63 })
    expect(Option.getOrUndefined(seen.after)?.has("t-1")).toBe(false)
  })
})

/** The two allowed rate_limit_events of test/fixtures/usage-limit/allowed.jsonl: 22%, then 23%. */
const allowed = readFileSync(resolve(import.meta.dir, "fixtures/usage-limit/allowed.jsonl"), "utf8")
  .split("\n")
  .filter((text) => text !== "")
  .map((text) => JSON.parse(text) as object)

describe("a run on a subscription", () => {
  test("its worker's resources on the RunView: tokens, the window's share, context", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-resources-repo-")))
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-resources-worktrees-")))
    const seen: Array<Resources> = []
    const ran = await scenario(
      {
        config: { repo },
        backlog: backlog().ticket("t-1").seeds,
        git: { dir: repo },
        worktrees: { root },
        scripts: (world) => {
          const steps = claimsAndCloses("t-1", {
            claim: Effect.asVoid(Effect.orDie(world.beads.update("t-1", { claim: true }))),
            commit: Effect.asVoid(
              Effect.orDie(
                world.repository.commit(join(root, "t-1"), "Change (t-1)", { "t-1.txt": "x\n" }),
              ),
            ),
            close: Effect.asVoid(Effect.orDie(world.beads.close("t-1", "done"))),
          })
          // Its turn's result spends, then the session answers how full its context is.
          const script: SessionScript = [
            ...steps.slice(0, 3),
            ...allowed.map((event) => emit(event)),
            ...steps.slice(3, -2),
            result("Closed t-1.", {
              total_cost_usd: 0.5,
              num_turns: 7,
              modelUsage: { [model]: { inputTokens: 1_000, outputTokens: 2_000 } },
            }),
            context(answer),
            ...steps.slice(-1),
          ]
          return { "t-1": [script] }
        },
      },
      Effect.gen(function* () {
        const git = yield* Git
        yield* git.addWorktree(repo, join(root, "t-1"), { branch: "tutti/t-1", base: "main" })
        const dashboard: Dashboard = (inputs) =>
          SubscriptionRef.changes(inputs.view).pipe(
            Stream.runForEach((view) =>
              Effect.sync(() => {
                const of = view.resources.find((each) => each.ticket === "t-1")
                if (of !== undefined) seen.push(of)
              }),
            ),
            Effect.forkScoped,
            Effect.asVoid,
          )
        const fiber = yield* Effect.forkChild(
          run({
            version: "0.1.0-test",
            base: "main",
            start: [line`START tutti`],
            dashboard,
            subscription: true,
          }),
        )
        const outcome = yield* Fiber.join(fiber)
        yield* advance("100 millis")
        return outcome
      }),
    )
    expectExitCode(ran, 0)
    const last = seen.at(-1)
    expect(last?.subscription).toBe(true)
    expect(last?.spent).toMatchObject({ costUsd: 0.5, turns: 7, results: 1 })
    expect(last?.runTokens).toBe(3_000)
    // The window rose from 22% to 23%: all of it this ticket's, the run's only one.
    expect(last?.window?.rise).toBeCloseTo(0.01)
    expect(last?.window?.share).toBeCloseTo(0.01)
    expect(seen.some((each) => each.context?.tokens === 126_000)).toBe(true)
  })
})
