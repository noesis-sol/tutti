// The organs over the Messages API provider (§ 6.1, D10): the language model of
// src/organs/AnthropicProvider.ts as organs call it, through fetch, against a fake Messages API
// served on a local port, so each request goes over HTTP as it would to api.anthropic.com. The
// fake keeps each request and answers with a message, a stream of events, or an error.
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Cause, Effect, Exit, Layer, Schema, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import { FetchHttpClient, type HttpClient } from "effect/http"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { OrganCall } from "../src/organs/AgentSdkLanguageModel.ts"
import {
  chosenLayer,
  defaultModel,
  maxTokens,
  providerVariable,
} from "../src/organs/AnthropicProvider.ts"
import { section } from "../src/organs/evidence.ts"
import { OrganCost } from "../src/organs/OrganCost.ts"
import { make, type Organ, Organs } from "../src/organs/Organs.ts"
import type { EventRecord } from "../src/run/events.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { Captured, layer as eventsLayer } from "../src/testing/EventStream.ts"
import { texts } from "../src/testing/Log.ts"
import { layer as costLayer } from "../src/testing/OrganCost.ts"

/** A request the fake Messages API was sent. */
interface Sent {
  readonly method: string
  readonly path: string
  readonly apiKey: string | null
  readonly body: Record<string, unknown>
}

/** How the fake answers the next requests. */
type Answer =
  | { readonly _tag: "Message"; readonly text: string }
  | { readonly _tag: "Stream"; readonly deltas: ReadonlyArray<string> }
  | {
      readonly _tag: "Error"
      readonly status: number
      readonly type: string
      readonly message: string
    }

const usage = {
  input_tokens: 120,
  output_tokens: 30,
  cache_creation: null,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  server_tool_use: null,
  service_tier: "standard",
}

/** The Messages API's message: `text` as its one text block. */
const message = (model: string, text: string) => ({
  id: "msg_01",
  type: "message",
  role: "assistant",
  model,
  content: text === "" ? [] : [{ type: "text", text }],
  stop_reason: text === "" ? null : "end_turn",
  stop_sequence: null,
  usage,
  container: null,
  context_management: null,
})

/** The Messages API's stream of events for one text block of `deltas`, as SSE. */
const events = (model: string, deltas: ReadonlyArray<string>): string =>
  [
    { type: "message_start", message: message(model, "") },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ...deltas.map((text) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    })),
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
      usage: {
        input_tokens: null,
        output_tokens: 30,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        server_tool_use: null,
      },
      context_management: null,
    },
    { type: "message_stop" },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("")

/** How long the fake takes to answer, so a call's recorded time has something to measure. */
const answerAfterMs = 30

const sent: Array<Sent> = []
let next: Answer = { _tag: "Message", text: "" }

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const body = (await request.json()) as Record<string, unknown>
    sent.push({
      method: request.method,
      path: new URL(request.url).pathname,
      apiKey: request.headers.get("x-api-key"),
      body,
    })
    await Bun.sleep(answerAfterMs)
    const model = String(body.model)
    switch (next._tag) {
      case "Message":
        return Response.json(message(model, next.text))
      case "Stream":
        return new Response(events(model, next.deltas), {
          headers: { "content-type": "text/event-stream" },
        })
      case "Error":
        return Response.json(
          { type: "error", error: { type: next.type, message: next.message } },
          { status: next.status },
        )
    }
  },
})

afterAll(() => server.stop(true))

beforeEach(() => {
  sent.length = 0
})

/**
 * Fetch, with each request to the Messages API sent to the fake instead, and any other refused:
 * the test never reaches the network.
 */
const toFake: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.Fetch, ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.origin !== "https://api.anthropic.com") {
        return Promise.reject(new Error(`not the Messages API: ${url}`))
      }
      return fetch(new URL(`${url.pathname}${url.search}`, server.url), init)
    }) as typeof fetch),
  ),
)

const Verdict = Schema.Struct({
  verdict: Schema.Literals(["merge", "hold", "hand-back"]),
  reasons: Schema.Array(Schema.String),
})

const verdict: typeof Verdict.Type = { verdict: "hand-back", reasons: ["the tests fail"] }

/** An organ as any organ is made, answering with Verdict. */
const triage: Organ<typeof Verdict.Type> = make("triage", {
  prompt: "You are the triage organ.",
  answer: Verdict,
})

const ask = Effect.flatMap(Organs, (organs) =>
  organs.ask(triage, [section("The worker", "tut-1 stopped.")], { ticket: "tut-1" }),
)

const anthropic = { [providerVariable]: "anthropic", ANTHROPIC_API_KEY: "sk-ant-local" }

const dir = () => mkdtempSync(join(tmpdir(), "tutti-anthropic-language-model-test-"))

/** The organs' settings: --organ-model and --organ-effort, or neither. */
const configWith = (organs: { readonly model?: string; readonly effort?: "max" } = {}) => {
  const base = appConfig({}, dir())
  return {
    ...base,
    settings: { ...base.settings, organs: { ...base.settings.organs, ...organs } },
  }
}

/**
 * Organs and their LanguageModel over the Messages API provider, as TUTTI_ORGAN_PROVIDER=anthropic
 * chooses it, with OrganCost writing to a captured Log and EventStream.
 */
const provider = (config = configWith()) =>
  Organs.layer.pipe(
    Layer.provideMerge(
      chosenLayer({ account: { subscription: true }, env: anthropic, http: toFake }),
    ),
    Layer.provideMerge(ClaudeCode.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        costLayer().pipe(Layer.provideMerge(eventsLayer())),
        configLayer(config),
        BunServices.layer,
      ),
    ),
  )

/** What the run kept of its organ calls: its log lines, `organ` records and total. */
const kept = Effect.gen(function* () {
  const logged = yield* texts
  const records = yield* Effect.flatMap(Captured, (captured) => captured.records)
  const total = yield* Effect.flatMap(OrganCost, (costs) => costs.total)
  return { logged, records: records.filter((r) => r.kind === "organ"), total }
})

const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof provider>>>,
  config = configWith(),
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* Effect.exit(effect)
      return { result, ...(yield* kept) }
    }).pipe(Effect.provide(provider(config))),
  )

const failures = (exit: Exit.Exit<unknown, unknown>): ReadonlyArray<unknown> =>
  Exit.isFailure(exit) ? exit.cause.reasons.filter(Cause.isFailReason).map((r) => r.error) : []

const organRecord = (records: ReadonlyArray<EventRecord>) => records[0] as Record<string, unknown>

describe("an organ over the Messages API", () => {
  test("gets the fake's answer, its prompt and key in the request", async () => {
    next = { _tag: "Message", text: JSON.stringify(verdict) }
    const { result } = await run(ask)
    if (Exit.isFailure(result)) throw new Error(String(result.cause))
    expect(result.value).toEqual(verdict)
    expect(sent).toHaveLength(1)
    const request = sent[0] as Sent
    expect(request).toMatchObject({ method: "POST", path: "/v1/messages", apiKey: "sk-ant-local" })
    expect(request.body.stream).not.toBe(true)
    expect(JSON.stringify(request.body.system)).toContain("You are the triage organ.")
    expect(JSON.stringify(request.body.messages)).toContain("tut-1 stopped.")
    expect(JSON.stringify(request.body.output_config)).toContain("hand-back")
  })

  test("the organ's own effort and the default model reach the request", async () => {
    next = { _tag: "Message", text: JSON.stringify(verdict) }
    await run(ask)
    expect(sent[0]?.body).toMatchObject({
      model: defaultModel,
      max_tokens: maxTokens,
      output_config: { effort: "low" },
    })
  })

  test("--organ-model and --organ-effort reach the request, an effort above high as high", async () => {
    next = { _tag: "Message", text: JSON.stringify(verdict) }
    const config = configWith({ model: "claude-opus-5-5", effort: "max" })
    const { result } = await run(ask, config)
    expect(Exit.isSuccess(result)).toBe(true)
    expect(sent[0]?.body).toMatchObject({
      model: "claude-opus-5-5",
      output_config: { effort: "high" },
    })
  })

  test("an error response is the organ's failure, with the API's message", async () => {
    for (const [status, type] of [
      [400, "invalid_request_error"],
      [403, "permission_error"],
    ] as const) {
      next = { _tag: "Error", status, type, message: `the fake says no (${status})` }
      const { result, records, total } = await run(ask)
      const [failure] = failures(result) as ReadonlyArray<{ _tag: string; organ: string }>
      expect(failure).toMatchObject({ _tag: "OrganFailed", organ: "triage", subtype: null })
      expect(JSON.stringify(failure)).toContain(`the fake says no (${status})`)
      // The call still counts: of unknown cost, with no result.
      expect(total).toMatchObject({ calls: 1, costUsd: 0, unknown: 1 })
      expect(organRecord(records)).toMatchObject({ organ: "triage", outcome: "no_result" })
    }
  })

  test("an answer that isn't the organ's schema is the organ's failure", async () => {
    next = { _tag: "Message", text: JSON.stringify({ verdict: "maybe" }) }
    const { result } = await run(ask)
    expect(failures(result).map((e) => (e as { _tag: string })._tag)).toEqual(["OrganFailed"])
  })

  test("its cost is recorded as OrganCost expects: unpriced, with its ticket and time", async () => {
    next = { _tag: "Message", text: JSON.stringify(verdict) }
    const { logged, records, total } = await run(ask)
    expect(total).toMatchObject({ calls: 1, costUsd: 0, turns: 0, failed: 0, unknown: 1 })
    expect(total.durationMs).toBeGreaterThanOrEqual(answerAfterMs - 5)
    expect(records).toHaveLength(1)
    expect(organRecord(records)).toMatchObject({
      kind: "organ",
      organ: "triage",
      ticket: "tut-1",
      outcome: "unpriced",
    })
    expect(organRecord(records).duration_ms).toBe(Math.round(total.durationMs))
    expect(logged.filter((l) => l.startsWith("ORGAN "))).toEqual([
      expect.stringMatching(/^ORGAN triage: cost unknown, no price reported, \d+\.\ds$/),
    ])
  })
})

/** The text of a stream's text deltas. */
const streamed = (stream: Stream.Stream<unknown, unknown>) =>
  Effect.map(Stream.runCollect(stream), (parts) =>
    Array.from(parts)
      .flatMap((part) => {
        const each = part as { type: string; delta?: string }
        return each.type === "text-delta" && each.delta !== undefined ? [each.delta] : []
      })
      .join(""),
  )

/** streamText over the provider, as the organ in OrganCall. */
const stream = (call: typeof OrganCall.Service) =>
  Effect.flatMap(LanguageModel.LanguageModel, (model) =>
    streamed(
      model
        .streamText({ prompt: [{ role: "user", content: "Say so." }] })
        .pipe(Stream.provideService(OrganCall, call)),
    ),
  )

describe("streamText over the Messages API", () => {
  test("streams the fake's text, with the call's model and effort", async () => {
    next = { _tag: "Stream", deltas: ["The tests ", "fail."] }
    const call = {
      organ: "reviewer",
      ticket: "tut-2",
      model: "claude-opus-5-5",
      effort: "xhigh",
    } as const
    const { result, records, total } = await run(stream(call))
    if (Exit.isFailure(result)) throw new Error(String(result.cause))
    expect(result.value).toBe("The tests fail.")
    expect(sent[0]?.body).toMatchObject({
      stream: true,
      model: "claude-opus-5-5",
      max_tokens: maxTokens,
      output_config: { effort: "high" },
    })
    expect(total).toMatchObject({ calls: 1, costUsd: 0, unknown: 1 })
    expect(organRecord(records)).toMatchObject({
      organ: "reviewer",
      ticket: "tut-2",
      outcome: "unpriced",
    })
  })

  test("no model or effort in the call: the default model, and no effort sent", async () => {
    next = { _tag: "Stream", deltas: ["ok"] }
    const { result } = await run(stream({ organ: "screen" }))
    expect(Exit.isSuccess(result)).toBe(true)
    expect(sent[0]?.body.model).toBe(defaultModel)
    expect(sent[0]?.body.output_config).toBeUndefined()
  })

  test("an error response fails the stream, a call of unknown cost with no result", async () => {
    next = { _tag: "Error", status: 400, type: "invalid_request_error", message: "bad stream" }
    const { result, records, logged } = await run(stream({ organ: "reviewer" }))
    const [failure] = failures(result)
    expect(failure).toMatchObject({ _tag: "AiError" })
    expect(String(failure)).toContain("bad stream")
    expect(organRecord(records)).toMatchObject({ organ: "reviewer", outcome: "no_result" })
    expect(logged.some((l) => /^ORGAN reviewer: cost unknown, no result after/.test(l))).toBe(true)
  })

  test("an organ that reads with Claude Code's tools is refused before any request", async () => {
    const reads = { tools: ["Read"], cwd: "/work/project", hooks: {}, maxBudgetUsd: 1 }
    const { result, records } = await run(stream({ organ: "scout", reads }))
    expect(String(failures(result)[0])).toContain("Claude Code's tools")
    expect(sent).toHaveLength(0)
    expect(records).toHaveLength(0)
  })
})
