// The API-key provider (§ 6.1, D10): TUTTI_ORGAN_PROVIDER=anthropic with ANTHROPIC_API_KEY swaps
// organs' LanguageModel for @effect/ai-anthropic's, by layer, and organs don't change. The Messages
// API is a fake HttpClient here, which keeps each request and answers with a canned message.
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Cause, Effect, Exit, Layer, Redacted, Result, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import fc from "fast-check"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import {
  apiEffort,
  callConfig,
  chosenLayer,
  defaultModel,
  organProvider,
  providerProblems,
  providerVariable,
} from "../src/organs/AnthropicProvider.ts"
import { section } from "../src/organs/evidence.ts"
import { OrganCost, unknownCostLine } from "../src/organs/OrganCost.ts"
import { make, type Organ, Organs } from "../src/organs/Organs.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { texts } from "../src/testing/Log.ts"
import { layer as costLayer } from "../src/testing/OrganCost.ts"
import { testEnv } from "./env.ts"

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

/** A request the fake Messages API was sent. */
interface Sent {
  readonly url: string
  readonly apiKey: string | undefined
  readonly body: Record<string, unknown>
}

const Verdict = Schema.Struct({
  verdict: Schema.Literals(["merge", "hold", "hand-back"]),
  reasons: Schema.Array(Schema.String),
})

const answer: typeof Verdict.Type = { verdict: "hold", reasons: ["the check is red"] }

/** The Messages API's answer: `text` as its one text block. */
const message = (text: string) => ({
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: defaultModel,
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 120,
    output_tokens: 30,
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    server_tool_use: null,
    service_tier: "standard",
  },
  container: null,
  context_management: null,
})

/** A fake Messages API, keeping each request in `sent`, answering `status` with `body`. */
const fakeApi = (
  sent: Array<Sent>,
  status = 200,
  body: unknown = message(JSON.stringify(answer)),
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.sync(() => {
        const raw = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array()
        sent.push({
          url: url.toString(),
          apiKey: request.headers["x-api-key"],
          body: JSON.parse(new TextDecoder().decode(raw)),
        })
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
        )
      }),
    ),
  )

/** An organ as any organ is made, answering with Verdict. */
const triage: Organ<typeof Verdict.Type> = make("triage", {
  prompt: "You are the triage organ.",
  answer: Verdict,
})

const ask = Effect.flatMap(Organs, (organs) =>
  organs.ask(triage, [section("The worker", "tut-1 stopped.")]),
)

const dir = () => mkdtempSync(join(tmpdir(), "tutti-anthropic-provider-test-"))

/** Organs over the provider `env` chooses, the Messages API faked with `http`. */
const organsWith = (
  env: Record<string, string | undefined>,
  http: Layer.Layer<HttpClient.HttpClient>,
  config = appConfig({ claude: fake }, dir()),
) =>
  Organs.layer.pipe(
    Layer.provideMerge(chosenLayer({ account: { subscription: true }, env, http })),
    Layer.provideMerge(ClaudeCode.layer),
    Layer.provideMerge(Layer.mergeAll(costLayer(), configLayer(config), BunServices.layer)),
  )

const anthropic = { [providerVariable]: "anthropic", ANTHROPIC_API_KEY: "sk-ant-test" }

const failures = (exit: Exit.Exit<unknown, unknown>): ReadonlyArray<unknown> =>
  Exit.isFailure(exit) ? exit.cause.reasons.filter(Cause.isFailReason).map((r) => r.error) : []

describe("organProvider", () => {
  test("unset, empty or agent-sdk chooses the Agent SDK", () => {
    for (const value of [undefined, "", "agent-sdk"]) {
      const chosen = organProvider({ [providerVariable]: value, ANTHROPIC_API_KEY: "sk-ant-test" })
      expect(Result.isSuccess(chosen) && chosen.success._tag).toBe("AgentSdk")
    }
  })

  test("anthropic with a key chooses the Messages API, the key kept redacted", () => {
    const chosen = organProvider(anthropic)
    if (Result.isFailure(chosen) || chosen.success._tag !== "Anthropic") throw new Error("chosen")
    expect(Redacted.value(chosen.success.apiKey)).toBe("sk-ant-test")
    expect(String(chosen.success.apiKey)).not.toContain("sk-ant-test")
  })

  test("anthropic with no key, or an empty one, is a setup problem", () => {
    for (const key of [undefined, ""]) {
      expect(providerProblems({ [providerVariable]: "anthropic", ANTHROPIC_API_KEY: key })).toEqual(
        [
          "TUTTI_ORGAN_PROVIDER=anthropic needs ANTHROPIC_API_KEY, the API key organs are billed to",
        ],
      )
    }
  })

  test("any other value is a setup problem naming the choices", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !["", "agent-sdk", "anthropic"].includes(s)),
        (value) => {
          const problems = providerProblems({ [providerVariable]: value })
          expect(problems).toHaveLength(1)
          expect(problems[0]).toContain("it must be agent-sdk or anthropic")
        },
      ),
    )
  })
})

describe("callConfig", () => {
  test("the call's model and effort, or the default model; above high is high", () => {
    expect(callConfig({ organ: "plan", model: "claude-opus-5-5", effort: "max" })).toMatchObject({
      model: "claude-opus-5-5",
      output_config: { effort: "high" },
    })
    expect(callConfig({ organ: "triage" })).toMatchObject({ model: defaultModel })
    expect(callConfig({ organ: "triage" }).output_config).toBeUndefined()
    expect(["low", "medium", "high", "xhigh", "max"].map((e) => apiEffort(e as never))).toEqual([
      "low",
      "medium",
      "high",
      "high",
      "high",
    ])
  })
})

describe("chosenLayer", () => {
  test("TUTTI_ORGAN_PROVIDER=anthropic: the organ asks the Messages API, with its key", async () => {
    const sent: Array<Sent> = []
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const verdict = yield* ask
        const logged = yield* texts
        const total = yield* Effect.flatMap(OrganCost, (costs) => costs.total)
        return { verdict, logged, total }
      }).pipe(Effect.provide(organsWith(anthropic, fakeApi(sent)))),
    )
    if (Exit.isFailure(exit)) throw new Error(String(exit.cause))
    expect(exit.value.verdict).toEqual(answer)
    expect(sent).toHaveLength(1)
    const request = sent[0] as Sent
    expect(request.url).toStartWith("https://api.anthropic.com/v1/messages")
    expect(request.apiKey).toBe("sk-ant-test")
    // The organ's own effort and the default model; its system prompt alone; its answer's schema.
    expect(request.body.model).toBe(defaultModel)
    expect(request.body.output_config).toMatchObject({ effort: "low" })
    expect(JSON.stringify(request.body.system)).toContain("You are the triage organ.")
    expect(JSON.stringify(request.body.system)).not.toContain("Claude Agent SDK")
    expect(JSON.stringify(request.body.output_config)).toContain("hand-back")
    // No price comes back: a call of unknown cost that answered.
    expect(exit.value.total).toMatchObject({ calls: 1, costUsd: 0, unknown: 1 })
    expect(
      exit.value.logged.some((l) => /ORGAN triage: cost unknown, no price reported/.test(l)),
    ).toBe(true)
  })

  test("--organ-model and --organ-effort reach the request", async () => {
    const sent: Array<Sent> = []
    const base = appConfig({ claude: fake }, dir())
    const config = {
      ...base,
      settings: {
        ...base.settings,
        organs: { ...base.settings.organs, model: "claude-opus-5-5", effort: "high" as const },
      },
    }
    await Effect.runPromise(ask.pipe(Effect.provide(organsWith(anthropic, fakeApi(sent), config))))
    expect(sent[0]?.body.model).toBe("claude-opus-5-5")
    expect(sent[0]?.body.output_config).toMatchObject({ effort: "high" })
  })

  test("an API error fails the organ as an organ failure, of unknown cost with no result", async () => {
    const sent: Array<Sent> = []
    const error = { type: "error", error: { type: "authentication_error", message: "bad key" } }
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const asked = yield* Effect.exit(ask)
        return { asked, logged: yield* texts }
      }).pipe(Effect.provide(organsWith(anthropic, fakeApi(sent, 401, error)))),
    )
    if (Exit.isFailure(exit)) throw new Error(String(exit.cause))
    expect(failures(exit.value.asked).map((e) => (e as { _tag: string })._tag)).toEqual([
      "OrganFailed",
    ])
    expect(
      exit.value.logged.some((l) => /ORGAN triage: cost unknown, no result after/.test(l)),
    ).toBe(true)
  })

  test("an organ that reads with Claude Code's tools can't run over the Messages API", async () => {
    const sent: Array<Sent> = []
    const reads = { tools: ["Read"], cwd: "/work/project", hooks: {}, maxBudgetUsd: 1 }
    const scout: Organ<typeof Verdict.Type> = { ...triage, name: "scout", reads }
    const refused = await Effect.runPromiseExit(
      Effect.flatMap(Organs, (organs) => organs.ask(scout, [])).pipe(
        Effect.provide(organsWith(anthropic, fakeApi(sent))),
      ),
    )
    expect((failures(refused)[0] as { reason: string }).reason).toContain("Claude Code's tools")
    expect(sent).toHaveLength(0)
  })

  test("unset: the organ runs over the Agent SDK, and never calls the Messages API", async () => {
    const sent: Array<Sent> = []
    const scenario = {
      turns: [[{ result: { structured_output: answer, result: JSON.stringify(answer) } }]],
      eofAfterTurn: true,
    }
    const env = {
      ...testEnv,
      [providerVariable]: undefined,
      ANTHROPIC_API_KEY: "sk-ant-test",
      FAKE_CLAUDE_SCENARIO: JSON.stringify(scenario),
    }
    const exit = await Effect.runPromiseExit(
      ask.pipe(Effect.provide(organsWith(env, fakeApi(sent)))),
    )
    if (Exit.isFailure(exit)) throw new Error(String(exit.cause))
    expect(exit.value).toEqual(answer)
    expect(sent).toHaveLength(0)
  })

  test("a choice that can't be used fails the layer with the setup problem", async () => {
    const exit = await Effect.runPromiseExit(
      ask.pipe(Effect.provide(organsWith({ [providerVariable]: "anthropic" }, fakeApi([])))),
    )
    expect(failures(exit).map((e) => (e as { _tag: string })._tag)).toEqual(["SetupProblem"])
  })
})

describe("unknownCostLine", () => {
  test("names a call that answered with no price apart from one with no result", () => {
    expect(String(unknownCostLine({ organ: "triage", durationMs: 4200, unpriced: true }))).toBe(
      "ORGAN triage: cost unknown, no price reported, 4.2s",
    )
    expect(String(unknownCostLine({ organ: "triage", durationMs: 180_000 }))).toBe(
      "ORGAN triage: cost unknown, no result after 180.0s",
    )
  })
})
