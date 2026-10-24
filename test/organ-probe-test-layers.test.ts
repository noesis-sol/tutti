// The Organs and UsageProbe test layers run the live code (§ 3.3): AgentSdkLanguageModel's make and
// UsageProbe's probeWith, their sessions playing scripted SDK messages in place of Claude Code. A
// test sees each call's cost line, a refusal mapped as the live layer maps it, and a probe's time
// limit; and for the same turn, the test layer and the live layer over a scripted query() answer
// the same.
import { describe, expect, test } from "bun:test"
import type { Options, query, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { type AiError, LanguageModel, type Prompt } from "effect/ai"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { ProbeAnswer, probeOrgan, UsageProbe } from "../src/agent/UsageProbe.ts"
import {
  limitOf,
  layer as liveLayer,
  OrganCall,
  subtypeOf,
} from "../src/organs/AgentSdkLanguageModel.ts"
import { OrganCost } from "../src/organs/OrganCost.ts"
import { make, Organs, refusalOf } from "../src/organs/Organs.ts"
import type { Log } from "../src/run/log.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import {
  type Canned,
  layer as cannedLayer,
  limited,
  messages,
  result,
} from "../src/testing/Organs.ts"
import { layer as probeLayer, type Scripted } from "../src/testing/UsageProbe.ts"
import { workersIn } from "./workerEnv.ts"

const Verdict = Schema.Struct({ cause: Schema.String })

const triage = make("triage", { prompt: "You are the triage organ.\n", answer: Verdict })

/** Asks triage through Organs over `canned`, under TestClock: its exit, log and cost total. */
const asks = (canned: Canned, during: Effect.Effect<void> = Effect.void) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Effect.exit((yield* Organs).ask(triage, [])))
    yield* during
    const exit = yield* Fiber.join(fiber)
    return { exit, log: yield* texts, total: yield* (yield* OrganCost).total }
  }).pipe(
    Effect.provide(
      Organs.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(cannedLayer({ triage: canned }), configLayer(appConfig())).pipe(
            Layer.provideMerge(logLayer()),
          ),
        ),
      ),
    ),
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  )

const failure = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  exit._tag === "Failure" && exit.cause.reasons[0]?._tag === "Fail"
    ? exit.cause.reasons[0].error
    : undefined

/** A query() that plays `messages`, as the SDK's would. */
const scriptedQuery = (played: ReadonlyArray<SDKMessage>) =>
  ((_: { readonly options?: Options }) =>
    Object.assign(
      (async function* () {
        for (const m of played) yield m
      })(),
      { close: () => {} },
    )) as unknown as typeof query

/** How a call ended, as a test compares it: its answer, or its error's tag, text and metadata. */
const ending = (exit: Exit.Exit<unknown, AiError.AiError>) => {
  if (exit._tag === "Success") return { answer: exit.value }
  const error = failure(exit)
  if (error === undefined) return { cause: String(exit.cause) }
  return {
    reason: error.reason._tag,
    message: error.message,
    limit: limitOf(error),
    subtype: subtypeOf(error),
    refusal: refusalOf(error),
  }
}

const prompt: Prompt.RawInput = [
  { role: "system", content: "You are the triage organ." },
  { role: "user", content: "What became of tut-1?" },
]

/** The call over `model`, as triage: how it ended, and the log. */
const generate = <E>(model: Layer.Layer<LanguageModel.LanguageModel | OrganCost, E, Log>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      LanguageModel.generateObject({ prompt, schema: Verdict }).pipe(
        Effect.map((response) => response.value),
        Effect.provideService(OrganCall, { organ: "triage" }),
      ),
    )
    return { ending: ending(exit), log: yield* texts }
  }).pipe(Effect.provide(model.pipe(Layer.provideMerge(logLayer()))), Effect.runPromise)

describe("the Organs test layer", () => {
  test("an answer's cost goes to OrganCost and the log, as a live call's does", async () => {
    const { exit, log, total } = await asks({ cause: "the tests fail" })
    expect(exit).toEqual(Exit.succeed({ cause: "the tests fail" }))
    expect(log).toEqual(["ORGAN triage: $0.0000 in 1 turn, 0.0s"])
    expect(total).toMatchObject({ calls: 1, unknown: 0, failed: 0 })
  })

  test("a turn refused for the usage limit fails with its limit and reset, as live", async () => {
    const { ending } = await generate(cannedLayer({ triage: limited("five_hour", 3600) }))
    expect(ending).toMatchObject({
      reason: "QuotaExhaustedError",
      refusal: { limit: "five_hour", resetsAt: 3_600_000 },
    })
  })

  test("a turn's own cost and subtype are recorded, as the result gives them", async () => {
    const subtype = "error_max_structured_output_retries"
    const { exit, log, total } = await asks(
      messages(
        result({ subtype, is_error: true, errors: [], total_cost_usd: 0.0123, duration_ms: 4200 }),
      ),
    )
    expect(failure(exit)).toMatchObject({ _tag: "OrganFailed", subtype })
    expect(log).toEqual(["ORGAN triage: $0.0123 in 1 turn, 4.2s"])
    expect(total).toMatchObject({ calls: 1, failed: 1 })
  })

  test("a session past the organ's time limit is a call of unknown cost", async () => {
    const { exit, log, total } = await asks(Effect.never, TestClock.adjust(Duration.minutes(3)))
    expect(failure(exit)).toMatchObject({ _tag: "OrganTimedOut", organ: "triage" })
    expect(log).toEqual(["ORGAN triage: cost unknown, no result after 180.0s"])
    expect(total).toMatchObject({ calls: 1, unknown: 1 })
  })
})

/** A turn's result, as Claude Code may end one. */
const anyResult = fc
  .record({
    subtype: fc.constantFrom("success", "error_max_structured_output_retries", "error_max_turns"),
    is_error: fc.boolean(),
    api_error_status: fc.constantFrom(undefined, 429, 500),
    stop_reason: fc.constantFrom("end_turn", "tool_use", "refusal"),
    structured_output: fc.constantFrom(undefined, { cause: "flaky" }, { cause: 1 }),
    total_cost_usd: fc.integer({ min: 0, max: 1000 }).map((n) => n / 10_000),
    duration_ms: fc.integer({ min: 0, max: 100_000 }),
    num_turns: fc.integer({ min: 1, max: 5 }),
  })
  .map((fields) => result({ errors: [], result: "", ...fields }))

/** What may come before it: rate_limit_events and a refusal. */
const before = fc.array(
  fc.oneof(
    fc
      .record({
        status: fc.constantFrom("allowed", "rejected"),
        resetsAt: fc.integer({ min: 1, max: 2_000_000_000 }),
        rateLimitType: fc.constantFrom("five_hour", "seven_day"),
      })
      .map((info) => ({ type: "rate_limit_event", rate_limit_info: info })),
    fc.constant({
      type: "system",
      subtype: "model_refusal_no_fallback",
      api_refusal_category: "cyber",
      content: "refused",
    }),
  ),
  { maxLength: 3 },
)

const anyTurn = fc
  .tuple(before, anyResult)
  .map(([some, last]) => [...some, last] as unknown as ReadonlyArray<SDKMessage>)

describe("the test layers and the live ones", () => {
  test("property: a turn's messages end a call the same, its cost line too", async () => {
    await fc.assert(
      fc.asyncProperty(anyTurn, async (turn) => {
        const live = await generate(
          liveLayer.pipe(
            Layer.provideMerge(OrganCost.layer),
            Layer.provide(
              ClaudeCode.layerWith(scriptedQuery(turn)).pipe(Layer.provide(workersIn({}))),
            ),
            Layer.provide(Layer.mergeAll(configLayer(appConfig()), BunServices.layer)),
          ),
        )
        const canned = await generate(cannedLayer({ triage: messages(...turn) }))
        expect(canned).toEqual(live)
      }),
      { numRuns: 40 },
    )
  })

  test("property: a probe's turn answers the same, its cost line too", async () => {
    await fc.assert(
      fc.asyncProperty(anyTurn, async (turn) => {
        const probing = (layer: Layer.Layer<UsageProbe, never, Log>) =>
          Effect.gen(function* () {
            const answer = yield* (yield* UsageProbe).probe(null)
            return { answer, log: yield* texts }
          }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(logLayer()))), Effect.runPromise)
        const live = await probing(
          UsageProbe.layer.pipe(
            Layer.provideMerge(OrganCost.layer),
            Layer.provide(
              ClaudeCode.layerWith(scriptedQuery(turn)).pipe(Layer.provide(workersIn({}))),
            ),
            Layer.provide(Layer.mergeAll(configLayer(appConfig()), BunServices.layer)),
          ),
        )
        const canned = await probing(probeLayer([turn]))
        expect(canned).toEqual(live)
      }),
      { numRuns: 40 },
    )
  })
})

/** The test layer's answer to one probe scripted `scripted`, with the log. */
const probed = (scripted: Scripted, during: Effect.Effect<void> = Effect.void) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild((yield* UsageProbe).probe("five_hour"))
    yield* during
    return { answer: yield* Fiber.join(fiber), log: yield* texts }
  }).pipe(
    Effect.provide(probeLayer([scripted]).pipe(Layer.provideMerge(logLayer()))),
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  )

describe("the UsageProbe test layer", () => {
  const anyAnswer: fc.Arbitrary<ProbeAnswer> = fc.oneof(
    fc.constant(ProbeAnswer.Allowed()),
    fc
      .record({
        limit: fc.constantFrom(null, "five_hour", "seven_day", "seven_day_opus"),
        resetsAt: fc.option(fc.integer({ min: 1, max: 2_000_000_000 }).map((s) => s * 1000)),
      })
      .map(ProbeAnswer.Refused),
    fc.string().map((reason) => ProbeAnswer.Unanswered({ reason })),
  )

  test("property: a scripted answer is answered, played as the turn that gives it", async () => {
    await fc.assert(
      fc.asyncProperty(anyAnswer, async (answer) => {
        expect((await probed(answer)).answer).toEqual(answer)
      }),
      { numRuns: 60 },
    )
  })

  test("an answer's cost goes to the log as an organ call's", async () => {
    const { log } = await probed(ProbeAnswer.Allowed())
    expect(log).toEqual([`ORGAN ${probeOrgan}: $0.0000 in 1 turn, 0.0s`])
  })

  test("a probe with no answer within its time limit is Unanswered, of unknown cost", async () => {
    const { answer, log } = await probed(Effect.never, TestClock.adjust(Duration.minutes(1)))
    expect(answer).toEqual(ProbeAnswer.Unanswered({ reason: "no answer within 1m" }))
    expect(log).toEqual([`ORGAN ${probeOrgan}: cost unknown, no result after 60.0s`])
  })
})
