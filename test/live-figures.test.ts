// The worker view's figures while a turn goes on (§ 7.5): Spending counts each assistant message's
// usage live, once per API message, a subagent's too, until the turn's result replaces it; the
// live dollars are an estimate at API prices; the host asks how full the context is after the
// session's own model calls, at most once every 10 s, and after each finished turn; and a run's
// RunView shows them before the turn ends. What is recorded still comes from the results alone.

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Deferred, Effect, Fiber, Layer, Stream, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { settled } from "../src/agent/WorkerState.ts"
import type { EventRecord } from "../src/run/events.ts"
import { line } from "../src/run/log.ts"
import { inputPrice, weighted } from "../src/run/prices.ts"
import type { Resources } from "../src/run/resources.ts"
import { run } from "../src/run/run.ts"
import type { Dashboard } from "../src/run/screen.ts"
import { nothingSpent, Spending, type Sums, showSums } from "../src/run/spending.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Git } from "../src/services/Git.ts"
import {
  claimsAndCloses,
  context,
  run as doing,
  emit,
  init,
  result,
  type SessionScript,
  sessionState,
  sleep,
  wait,
} from "../src/testing/AgentHost.ts"
import { Captured, layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as spendingLayer } from "../src/testing/Spending.ts"
import { advance, backlog, expectExitCode, scenario } from "./harness.ts"

setDefaultTimeout(30_000)

const model = "claude-opus-5-5"
const t1 = "t-1" as TicketId

interface Usage {
  readonly input?: number
  readonly output?: number
  readonly cacheWrite?: number
  readonly cacheRead?: number
}

/** An assistant message of the API message `id`, as the SDK sends each of its content blocks. */
const assistant = (id: string, u: Usage, fields: object = {}): SDKMessage =>
  ({
    type: "assistant",
    message: {
      id,
      model,
      role: "assistant",
      content: [{ type: "text", text: "working" }],
      usage: {
        input_tokens: u.input ?? 0,
        output_tokens: u.output ?? 0,
        cache_creation_input_tokens: u.cacheWrite ?? 0,
        cache_read_input_tokens: u.cacheRead ?? 0,
      },
    },
    parent_tool_use_id: null,
    ...fields,
  }) as unknown as SDKMessage

/** A model's usage as a result's modelUsage gives it. */
const usage = (input: number, output: number, costUSD = 0, of = model) => ({
  [of]: {
    inputTokens: input,
    outputTokens: output,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    webSearchRequests: 0,
    costUSD,
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
  },
})

/** A result with the running totals `cost` and `modelUsage`. */
const resultMessage = (cost: number, modelUsage: object): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "DONE",
    num_turns: 3,
    duration_ms: 4000,
    duration_api_ms: 3000,
    total_cost_usd: cost,
    modelUsage,
  }) as unknown as SDKMessage

const turnsOf = (records: ReadonlyArray<EventRecord>) =>
  records.flatMap((r) => (r.kind === "turn" ? [r] : []))

/** Spending over captured records: `body`'s value and the records it wrote. */
const spending = <A>(body: Effect.Effect<A, never, Spending>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const value = yield* body
      return { value, records: yield* (yield* Captured).records }
    }).pipe(Effect.provide(spendingLayer().pipe(Layer.provideMerge(eventsLayer())))),
  )

/** Spending's sums now. */
const sumsNow = Effect.flatMap(Spending, (s) =>
  Effect.map(Stream.runHead(s.sums), (sums) => {
    if (sums._tag === "None") throw new Error("Spending gave no sums")
    return sums.value
  }),
)

describe("Spending's live count", () => {
  test("counts an assistant message's usage once per API message, a subagent's too", async () => {
    const { value, records } = await spending(
      Effect.gen(function* () {
        const s = yield* Spending
        const call = assistant("msg_1", { input: 10, output: 100, cacheWrite: 20, cacheRead: 1000 })
        // The SDK splits one API message into a message per content block, each with its usage.
        yield* s.message(t1, { session: "s-1", message: call })
        yield* s.message(t1, { session: "s-1", message: call })
        yield* s.message(t1, {
          session: "s-1",
          message: assistant("msg_2", { input: 5, output: 50 }, { parent_tool_use_id: "toolu_1" }),
        })
        return { sums: yield* sumsNow, settled: yield* s.ofTicket(t1), total: yield* s.total }
      }),
    )
    const live = value.sums.tickets.get(t1)
    expect(live?.tokens[model]).toEqual({
      input: 15,
      output: 150,
      cache_write: 20,
      cache_read: 1000,
    })
    expect(live?.turns).toBe(2)
    expect(live?.results).toBe(0)
    // At the model's price: weighted as Anthropic prices the tokens.
    const price = inputPrice(model) ?? 0
    expect(price).toBeGreaterThan(0)
    expect(live?.costUsd).toBeCloseTo(
      (10 + 1.25 * 20 + 0.1 * 1000 + 5 * 100 + 5 + 5 * 50) * price,
      12,
    )
    expect(value.sums.total).toEqual(live ?? nothingSpent)
    // Nothing recorded: what is recorded comes from results.
    expect(value.settled).toEqual(nothingSpent)
    expect(value.total).toEqual(nothingSpent)
    expect(turnsOf(records)).toEqual([])
  })

  test("the turn's result replaces its live count, nothing counted twice", async () => {
    const { value, records } = await spending(
      Effect.gen(function* () {
        const s = yield* Spending
        yield* s.message(t1, { session: "s-1", message: assistant("msg_1", { input: 10 }) })
        yield* s.message(t1, { session: "s-1", message: assistant("msg_2", { output: 100 }) })
        yield* s.message(t1, { session: "s-1", message: resultMessage(0.5, usage(12, 110)) })
        const after = yield* sumsNow
        // The next turn counts live over the result's sums.
        yield* s.message(t1, { session: "s-1", message: assistant("msg_3", { output: 40 }) })
        return { after, next: yield* sumsNow, settled: yield* s.ofTicket(t1) }
      }),
    )
    expect(value.after.tickets.get(t1)).toEqual(value.settled)
    expect(value.after.tickets.get(t1)).toMatchObject({ costUsd: 0.5, turns: 3, results: 1 })
    expect(value.after.tickets.get(t1)?.tokens[model]).toMatchObject({ input: 12, output: 110 })
    expect(value.next.tickets.get(t1)?.tokens[model]).toMatchObject({ input: 12, output: 150 })
    expect(value.next.tickets.get(t1)?.turns).toBe(4)
    expect(turnsOf(records).map((t) => [t.cost_usd, t.tokens?.[model]?.output])).toEqual([
      [0.5, 110],
    ])
  })

  test("a resumed session seeded from its last result counts only what it spends over it", async () => {
    const { value, records } = await spending(
      Effect.gen(function* () {
        const s = yield* Spending
        yield* s.seed("s-1", resultMessage(1, usage(13, 200)))
        yield* s.message(t1, {
          session: "s-1",
          message: assistant("msg_9", { input: 1, output: 50 }),
        })
        const live = yield* sumsNow
        yield* s.message(t1, { session: "s-1", message: resultMessage(1.25, usage(14, 250)) })
        return { live, after: yield* sumsNow }
      }),
    )
    expect(value.live.tickets.get(t1)?.tokens[model]).toMatchObject({ input: 1, output: 50 })
    expect(value.after.tickets.get(t1)).toMatchObject({ costUsd: 0.25, results: 1 })
    expect(value.after.tickets.get(t1)?.tokens[model]).toMatchObject({ input: 1, output: 50 })
    expect(turnsOf(records).map((t) => t.cost_usd)).toEqual([0.25])
  })

  test("dollars at the model's price a result gave, the table's, or else the session's own", async () => {
    const { value } = await spending(
      Effect.gen(function* () {
        const s = yield* Spending
        // A result of another session gives claude-z's price: $2 a thousand weighted tokens.
        yield* s.message("t-2" as TicketId, {
          session: "s-2",
          message: resultMessage(2, usage(1000, 0, 2, "claude-z")),
        })
        // s-1's last result: $1 for a thousand weighted tokens of a model the table doesn't name.
        yield* s.message(t1, { session: "s-1", message: resultMessage(1, usage(1000, 0, 0, "x")) })
        const unknown = assistant("msg_1", { input: 10 }) as unknown as {
          message: { model: string }
        }
        unknown.message.model = "claude-unpriced"
        yield* s.message(t1, { session: "s-1", message: unknown as unknown as SDKMessage })
        const priced = assistant("msg_2", { input: 10 }) as unknown as {
          message: { model: string }
        }
        priced.message.model = "claude-z"
        yield* s.message(t1, { session: "s-1", message: priced as unknown as SDKMessage })
        return yield* sumsNow
      }),
    )
    // The results' $1 and $2, then 10 tokens at the session's $0.001 and 10 at claude-z's $0.002.
    expect(value.tickets.get(t1)?.costUsd).toBeCloseTo(1 + 0.01 + 0.02, 12)
    expect(value.total.costUsd).toBeCloseTo(3.03, 12)
  })
})

describe("the sums shown", () => {
  test("the first at once, live counts at most once a second, a result's at once", async () => {
    const shown = await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* Spending
        const seen: Array<Sums> = []
        yield* Effect.forkScoped(
          showSums(s.sums, (sums) => Effect.sync(() => void seen.push(sums))),
        )
        yield* TestClock.adjust("10 millis")
        // A burst of live counts: the latest of it shown once the second is out.
        for (let i = 1; i <= 5; i++) {
          yield* s.message(t1, { session: "s-1", message: assistant(`msg_${i}`, { output: 10 }) })
          yield* TestClock.adjust("10 millis")
        }
        const burst = seen.length
        yield* TestClock.adjust("1 second")
        const second = seen.length
        yield* s.message(t1, { session: "s-1", message: assistant("msg_6", { output: 10 }) })
        yield* TestClock.adjust("10 millis")
        // The result's sums, inside the second: at once.
        yield* s.message(t1, { session: "s-1", message: resultMessage(0.5, usage(0, 60)) })
        yield* TestClock.adjust("10 millis")
        return {
          burst,
          second,
          outputs: seen.map((sums) => sums.total.tokens[model]?.output ?? 0),
          results: seen.map((sums) => sums.total.results),
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(
          spendingLayer().pipe(
            Layer.provideMerge(Layer.mergeAll(eventsLayer(), TestClock.layer())),
          ),
        ),
      ),
    )
    expect(shown.burst).toBe(1)
    expect(shown.second).toBe(2)
    expect(shown.outputs).toEqual([0, 50, 60])
    expect(shown.results).toEqual([0, 0, 1])
  })
})

describe("the price table", () => {
  test("weighs cache reads 0.1×, cache writes 1.25× and output 5× the input", () => {
    expect(weighted({ input: 100, output: 10, cache_write: 8, cache_read: 1000 })).toBe(
      100 + 50 + 10 + 100,
    )
  })

  test("prices the models by family; a model it doesn't name has none", () => {
    expect(inputPrice("claude-opus-5-5")).toBeCloseTo(4e-6, 15)
    expect(inputPrice("claude-sonnet-5-5")).toBeCloseTo(2e-6, 15)
    expect(inputPrice("claude-haiku-4-5-20251001")).toBeCloseTo(1e-6, 15)
    expect(inputPrice("claude-fable-5-1")).toBeCloseTo(1e-5, 15)
    expect(inputPrice("gpt-4")).toBeUndefined()
  })
})

/** A getContextUsage() answer. */
const answer = {
  categories: [{ name: "Messages", tokens: 90_000, color: "x", kind: "used" }],
  totalTokens: 126_000,
  maxTokens: 200_000,
  percentage: 63,
}

describe("the host's context asks", () => {
  test("after its own model calls at most once every 10 s, not a subagent's, and after the turn", async () => {
    // The script's phase as each ask is answered.
    let phase = "a"
    const asks: Array<string> = []
    const counted = () => {
      asks.push(phase)
      return answer
    }
    const at = (next: string) =>
      doing(
        Effect.sync(() => {
          phase = next
        }),
      )
    const script: SessionScript = [
      wait,
      init(),
      sessionState("running"),
      context(counted),
      // 0 s: asked.
      emit(assistant("msg_1", { input: 10 })),
      sleep("11 seconds"),
      at("b"),
      // 11 s: a subagent's call isn't asked after.
      emit(assistant("msg_2", { input: 10 }, { parent_tool_use_id: "toolu_1" })),
      sleep("1 second"),
      at("c"),
      // 12 s: asked; 15 s: not, 3 s after.
      emit(assistant("msg_3", { input: 10 })),
      sleep("3 seconds"),
      at("d"),
      emit(assistant("msg_4", { input: 10 })),
      sleep("1 second"),
      at("e"),
      // After the turn's result: asked.
      result(),
      sessionState("idle"),
    ]
    const ran = await scenario(
      { backlog: backlog().ticket("t-1").seeds, scripts: { "t-1": [script] } },
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start(t1, { sessionId: "s-1", cwd: "/w/t-1" })
        yield* host.send(t1, { text: "Work on t-1.", from: "clientComposed" })
        for (let i = 0; i < 20; i++) yield* advance("1 second")
        yield* host.state(t1).pipe(Stream.filter(settled), Stream.take(1), Stream.runDrain)
        yield* advance("100 millis")
        yield* host.end(t1)
      }),
    )
    if (ran.exit._tag !== "Success") throw new Error(`the scenario failed: ${String(ran.exit)}`)
    expect(asks).toEqual(["a", "c", "e"])
  })
})

/** The two allowed rate_limit_events of test/fixtures/usage-limit/allowed.jsonl: 22%, then 23%. */
const allowed = readFileSync(resolve(import.meta.dir, "fixtures/usage-limit/allowed.jsonl"), "utf8")
  .split("\n")
  .filter((text) => text !== "")
  .map((text) => JSON.parse(text) as object)

describe("a run's RunView while a turn goes on", () => {
  test("its worker's tokens, the window's share and context move before the turn ends", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-live-figures-repo-")))
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-live-figures-worktrees-")))
    const seen: Array<Resources> = []
    // Opened once the view shows the live figures, which the turn's result waits for, and once it
    // shows the result's, which the turn's end waits for: the ticket leaves the view when it ends.
    const shown = Deferred.makeUnsafe<Resources>()
    const settledShown = Deferred.makeUnsafe<Resources>()
    const live = (r: Resources) =>
      (r.spent.tokens[model]?.output ?? 0) > 0 &&
      r.spent.results === 0 &&
      (r.window?.share ?? 0) > 0 &&
      r.context !== null
    const ran = await scenario(
      {
        config: { repo },
        backlog: backlog().ticket("t-1").seeds,
        git: { dir: repo },
        worktrees: { root },
        scripts: (world) => {
          const steps = claimsAndCloses(t1, {
            claim: Effect.asVoid(Effect.orDie(world.beads.update(t1, { claim: true }))),
            commit: Effect.asVoid(
              Effect.orDie(
                world.repository.commit(join(root, "t-1"), "Change (t-1)", { "t-1.txt": "x\n" }),
              ),
            ),
            close: Effect.asVoid(Effect.orDie(world.beads.close(t1, "done"))),
          })
          const script: SessionScript = [
            ...steps.slice(0, 3),
            ...allowed.map((event) => emit(event)),
            context(answer),
            emit(assistant("msg_1", { input: 1_000, output: 2_000 })),
            emit(assistant("msg_1", { input: 1_000, output: 2_000 })),
            ...steps.slice(3, -2),
            doing(Effect.asVoid(Deferred.await(shown))),
            result("Closed t-1.", {
              total_cost_usd: 0.5,
              num_turns: 7,
              modelUsage: { [model]: { inputTokens: 1_000, outputTokens: 2_000 } },
            }),
            doing(Effect.asVoid(Deferred.await(settledShown))),
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
              Effect.gen(function* () {
                const of = view.resources.find((each) => each.ticket === "t-1")
                if (of === undefined) return
                seen.push(of)
                if (live(of)) yield* Deferred.succeed(shown, of)
                if (of.spent.results === 1) yield* Deferred.succeed(settledShown, of)
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
        // The view projects at most every 33 ms and the live sums at most once a second.
        for (let i = 0; i < 80 && !(yield* Deferred.isDone(settledShown)); i++) {
          yield* advance("100 millis")
        }
        const outcome = yield* Fiber.join(fiber)
        yield* advance("100 millis")
        return outcome
      }),
    )
    expectExitCode(ran, 0)
    const before = seen.find(live)
    const after = seen.find((each) => each.spent.results === 1)
    expect(before?.spent.tokens[model]).toEqual({
      input: 1_000,
      output: 2_000,
      cache_write: 0,
      cache_read: 0,
    })
    expect(before?.spent.costUsd).toBeCloseTo((1_000 + 5 * 2_000) * (inputPrice(model) ?? 0), 12)
    expect(before?.context?.tokens).toBe(126_000)
    // The result settles them: its figures, the live count gone.
    expect(after?.spent).toMatchObject({ costUsd: 0.5, turns: 7, results: 1 })
    expect(after?.spent.tokens[model]).toEqual(before?.spent.tokens[model])
    expect(turnsOf(ran.events).map((t) => t.cost_usd)).toEqual([0.5])
  })
})
