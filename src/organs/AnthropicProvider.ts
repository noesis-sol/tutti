// AnthropicProvider (§ 6.1, D10): the API-key alternative to AgentSdkLanguageModel, for CI and API-key
// users. With TUTTI_ORGAN_PROVIDER=anthropic and ANTHROPIC_API_KEY, organs' LanguageModel is
// @effect/ai-anthropic's over the Messages API instead of the Agent SDK's; the choice is a layer,
// and organs don't change. Unset (or `agent-sdk`), organs use the Agent SDK.
//
// - The variable set to anything else, or `anthropic` with no key, is a setup problem, which the
//   run's start reports (organProvider); the layer takes the provider it read (chosenLayer).
// - Each call takes OrganCall's model and effort as a request override: the model is
//   defaultModel unless --organ-model names one, and an effort above `high` is sent as `high`, the
//   most @effect/ai-anthropic's request config takes.
// - The request sends the prompt's system messages alone: no environment section, no account.
// - An organ that reads the repository with Claude Code's tools (the scout, § 6.3) can't run here,
//   with no Claude Code: its call fails with InvalidUserInputError.
// - Cost: the Messages API reports a response's usage but no price, so each call goes to OrganCost
//   as a call of unknown cost, with the time it ran: answered, or ended with no result.
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Clock, Effect, Exit, type FileSystem, Layer, Redacted, Result, Stream } from "effect"
import { AiError, LanguageModel } from "effect/ai"
import { FetchHttpClient, type HttpClient } from "effect/http"
import type { ClaudeCode } from "../agent/ClaudeCode.ts"
import { apiKeySet, apiKeyVariable } from "../agent/env.ts"
import { layer as agentSdkLayer, OrganCall, type OrganCallConfig } from "./AgentSdkLanguageModel.ts"
import { OrganCost } from "./OrganCost.ts"

const module = "AnthropicProvider"

/** The variable that chooses organs' provider. */
export const providerVariable = "TUTTI_ORGAN_PROVIDER"

/** The providers organs can use: the Agent SDK's (the default) and the Messages API's. */
export const providers = ["agent-sdk", "anthropic"] as const

/** The model organs use over the Messages API, unless --organ-model names one. */
export const defaultModel = "claude-sonnet-5-5"

/** The most an organ's answer may take, in output tokens: organs answer with short JSON. */
export const maxTokens = 16_000

/** The provider organs use, and the API key it needs. */
export type OrganProvider =
  | { readonly _tag: "AgentSdk" }
  | { readonly _tag: "Anthropic"; readonly apiKey: Redacted.Redacted<string> }

/** The provider `env` chooses, or the setup problem with it, as a sentence. */
export const organProvider = (
  env: Readonly<Record<string, string | undefined>>,
): Result.Result<OrganProvider, string> => {
  const chosen = env[providerVariable] ?? ""
  if (chosen === "" || chosen === "agent-sdk") return Result.succeed({ _tag: "AgentSdk" })
  if (chosen !== "anthropic") {
    return Result.fail(
      `${providerVariable} is ${JSON.stringify(chosen)}; it must be ${providers.join(" or ")}`,
    )
  }
  if (!apiKeySet(env)) {
    return Result.fail(
      `${providerVariable}=anthropic needs ${apiKeyVariable}, the API key organs are billed to`,
    )
  }
  return Result.succeed({
    _tag: "Anthropic",
    apiKey: Redacted.make(env[apiKeyVariable] as string),
  })
}

/** The setup problems with organs' provider in `env`: none, or one. */
export const providerProblems = (
  env: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<string> => {
  const chosen = organProvider(env)
  return Result.isFailure(chosen) ? [chosen.failure] : []
}

/** The request's effort for an organ's: @effect/ai-anthropic's config takes none above `high`. */
export const apiEffort = (
  effort: NonNullable<OrganCallConfig["effort"]>,
): "low" | "medium" | "high" => (effort === "low" || effort === "medium" ? effort : "high")

/** The request overrides of `call`: its model, or defaultModel, and its effort. */
export const callConfig = (
  call: OrganCallConfig,
): typeof AnthropicLanguageModel.Config.Service => ({
  model: call.model ?? defaultModel,
  max_tokens: maxTokens,
  ...(call.effort === undefined ? {} : { output_config: { effort: apiEffort(call.effort) } }),
})

const readsRefused = (method: string, call: OrganCallConfig) =>
  AiError.make({
    module,
    method,
    reason: new AiError.InvalidUserInputError({
      description: `The ${call.organ} reads the repository with Claude Code's tools, which the API-key provider (${providerVariable}=anthropic) doesn't have`,
    }),
  })

/**
 * The LanguageModel over the Messages API, through the AnthropicClient in context, each call as
 * its OrganCall says, its cost recorded in OrganCost as unknown.
 */
export const languageModel: Effect.Effect<
  LanguageModel.LanguageModel,
  never,
  AnthropicClient.AnthropicClient | OrganCost
> = Effect.gen(function* () {
  const costs = yield* OrganCost
  const model = yield* AnthropicLanguageModel.make({ model: defaultModel })

  /** `effect` run as the organ in OrganCall, its time recorded as a call of unknown cost. */
  const asOrgan = <A, E, R>(
    method: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | AiError.AiError, R> =>
    Effect.gen(function* () {
      const call = yield* OrganCall
      if (call.reads !== undefined) return yield* readsRefused(method, call)
      const startedAt = yield* Clock.currentTimeMillis
      return yield* effect.pipe(
        AnthropicLanguageModel.withConfigOverride(callConfig(call)),
        Effect.onExit((exit) =>
          Effect.flatMap(Clock.currentTimeMillis, (endedAt) =>
            costs.recordUnknown({
              organ: call.organ,
              ...(call.ticket === undefined ? {} : { ticket: call.ticket }),
              durationMs: endedAt - startedAt,
              ...(Exit.isSuccess(exit) ? { unpriced: true as const } : {}),
            }),
          ),
        ),
      )
    })

  // LanguageModel's methods are overloaded on their options, which pass through as they are: only
  // the context they run in changes.
  type Untyped<A> = (options: unknown) => A
  const generateText = model.generateText as unknown as Untyped<Effect.Effect<unknown, unknown>>
  const generateObject = model.generateObject as unknown as Untyped<Effect.Effect<unknown, unknown>>
  const streamText = model.streamText as unknown as Untyped<Stream.Stream<unknown, unknown>>
  return LanguageModel.LanguageModel.of({
    ...model,
    generateText: ((options: unknown) =>
      asOrgan("generateText", generateText(options))) as unknown as typeof model.generateText,
    generateObject: ((options: unknown) =>
      asOrgan("generateObject", generateObject(options))) as unknown as typeof model.generateObject,
    streamText: ((options: unknown) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const call = yield* OrganCall
          if (call.reads !== undefined) return Stream.fail(readsRefused("streamText", call))
          const startedAt = yield* Clock.currentTimeMillis
          return streamText(options).pipe(
            Stream.provideService(AnthropicLanguageModel.Config, callConfig(call)),
            Stream.onExit((exit) =>
              Effect.flatMap(Clock.currentTimeMillis, (endedAt) =>
                costs.recordUnknown({
                  organ: call.organ,
                  ...(call.ticket === undefined ? {} : { ticket: call.ticket }),
                  durationMs: endedAt - startedAt,
                  ...(Exit.isSuccess(exit) ? { unpriced: true as const } : {}),
                }),
              ),
            ),
          )
        }),
      )) as unknown as typeof model.streamText,
  })
})

/** The LanguageModel over the Messages API, billed to `apiKey`, through `HttpClient`. */
export const layer = (
  apiKey: Redacted.Redacted<string>,
): Layer.Layer<LanguageModel.LanguageModel, never, OrganCost | HttpClient.HttpClient> =>
  Layer.effect(LanguageModel.LanguageModel, languageModel).pipe(
    Layer.provide(AnthropicClient.layer({ apiKey })),
  )

/** What the chosen provider's layer takes: the provider, as the run's start chose it. */
export interface ChosenOptions {
  /** The provider organs use, which the run's start read from its environment (organProvider). */
  readonly provider: OrganProvider
  /** The HTTP client the Messages API is called through; fetch by default. */
  readonly http?: Layer.Layer<HttpClient.HttpClient>
}

/**
 * Organs' LanguageModel, from `provider`: the Agent SDK's, or the Messages API's, billed to its key.
 */
export const chosenLayer = (
  options: ChosenOptions,
): Layer.Layer<
  LanguageModel.LanguageModel,
  never,
  ClaudeCode | OrganCost | FileSystem.FileSystem
> =>
  options.provider._tag === "AgentSdk"
    ? agentSdkLayer
    : layer(options.provider.apiKey).pipe(Layer.provide(options.http ?? FetchHttpClient.layer))
