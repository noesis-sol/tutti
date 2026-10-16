// Throwaway spike for tutti-nrg.1.4 (spec § 14, M0 (5); § 6.1): an effect/ai LanguageModel built
// with LanguageModel.make over a single Agent SDK turn.
//
// Not product code. It is the smallest provider that answers § 6.1's question: the prompt becomes
// systemPrompt and one user message, structured output goes through AnthropicStructuredOutput and
// the SDK's outputFormat, and the turn's result becomes effect/ai Response parts. Each call is
// recorded through `onCall` so that spike.ts can print what happened.

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type EffortLevel,
  type Options,
  query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { Effect, Stream } from "effect"
import { AiError, AnthropicStructuredOutput, LanguageModel, type Prompt, Response } from "effect/ai"

// ---------------------------------------------------------------------------------------------
// The prompt: § 6.1 says ProviderOptions.prompt becomes the SDK's systemPrompt (a plain string) and
// a single user message. That holds for prompts of system messages followed by one user message of
// text. Anything else is refused with InvalidUserInputError, naming what doesn't fit.

export interface Turn {
  readonly systemPrompt: string
  /** The user message's text parts, sent as one text block each. */
  readonly userText: ReadonlyArray<string>
}

export const toTurn = (prompt: Prompt.Prompt): Turn | string => {
  const systems: Array<string> = []
  let userText: ReadonlyArray<string> | undefined
  for (const message of prompt.content) {
    switch (message.role) {
      case "system":
        if (userText !== undefined) return "a system message after the user message"
        systems.push(message.content)
        break
      case "user": {
        if (userText !== undefined) return "more than one user message"
        const texts: Array<string> = []
        for (const part of message.content) {
          if (part.type !== "text") return `a user message with a ${part.type} part`
          texts.push(part.text)
        }
        userText = texts
        break
      }
      case "assistant":
        return "an assistant message (history has no place in a fresh single-turn session)"
      case "tool":
        return "a tool message (the session has no tools)"
    }
  }
  if (userText === undefined) return "no user message"
  return { systemPrompt: systems.join("\n\n"), userText }
}

// ---------------------------------------------------------------------------------------------
// One SDK turn

export interface Call {
  readonly turn: Turn
  readonly options: Options
  readonly jsonSchema: unknown
  readonly messages: Array<SDKMessage>
  readonly startedAt: number
  /** When the first SDK message (system/init) arrived. */
  firstMessageAt?: number
  endedAt?: number
  aborted?: boolean
}

export interface Config {
  readonly model?: string
  readonly effort?: EffortLevel
  /** Extra environment for the claude subprocess (on top of process.env). */
  readonly env?: Record<string, string>
  /** Overrides the SDK options last, for the scenarios that probe a variation. */
  readonly override?: Partial<Options>
  readonly onCall?: (call: Call) => void
}

const userMessage = (texts: ReadonlyArray<string>): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: texts.map((text) => ({ type: "text", text })) },
  parent_tool_use_id: null,
})

// The turn as an async generator: a fresh temp cwd, query() in single-message streaming input mode,
// every SDK message yielded. Its finally (reached on completion, error, or the consumer's return()
// when the Effect is interrupted) aborts the query and removes the temp folder.
async function* runTurn(
  config: Config,
  turn: Turn,
  jsonSchema: Record<string, unknown> | undefined,
  includePartialMessages: boolean,
  signal?: AbortSignal,
): AsyncGenerator<SDKMessage> {
  const cwd = mkdtempSync(join(tmpdir(), "tutti-organ-"))
  const abortController = new AbortController()
  // Effect.tryPromise's signal, aborted when the Effect is interrupted (Effect.timeout included).
  signal?.addEventListener("abort", () => abortController.abort(), { once: true })
  const options: Options = {
    systemPrompt: turn.systemPrompt,
    tools: [],
    strictMcpConfig: true,
    settingSources: [],
    permissionPrompts: "none",
    persistSession: false,
    cwd,
    abortController,
    includePartialMessages,
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "tutti-spike/0", ...config.env },
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.effort === undefined ? {} : { effort: config.effort }),
    ...(jsonSchema === undefined
      ? {}
      : { outputFormat: { type: "json_schema", schema: jsonSchema } }),
    ...config.override,
  }
  const call: Call = { turn, options, jsonSchema, messages: [], startedAt: Date.now() }
  config.onCall?.(call)
  // One message, then the input ends: the session closes after its result.
  async function* input() {
    yield userMessage(turn.userText)
  }
  const q = query({ prompt: input(), options })
  let finished = false
  try {
    for await (const message of q) {
      call.firstMessageAt ??= Date.now()
      call.messages.push(message)
      yield message
      if (message.type === "result") break
    }
    finished = true
  } finally {
    call.endedAt = Date.now()
    if (!finished || abortController.signal.aborted) {
      call.aborted = true
      abortController.abort()
    }
    q.close()
    rmSync(cwd, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------------------------
// Results and errors

const fail = (method: string, reason: AiError.AiErrorReason) =>
  AiError.make({ module: "AgentSdkLanguageModel", method, reason })

/** The cost and the rest of the turn's bookkeeping, as provider metadata on the finish part. */
export const costMetadata = (result: SDKResultMessage) => ({
  "agent-sdk": {
    session_id: result.session_id,
    subtype: result.subtype,
    total_cost_usd: result.total_cost_usd,
    num_turns: result.num_turns,
    duration_ms: result.duration_ms,
    stop_reason: result.stop_reason,
    terminal_reason: result.terminal_reason ?? null,
  },
})

const finishReason = (stopReason: string | null): Response.FinishReason => {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop"
    case "max_tokens":
      return "length"
    case "refusal":
      return "content-filter"
    case "tool_use":
      return "tool-calls"
    case "pause_turn":
      return "pause"
    default:
      return stopReason === null ? "unknown" : "other"
  }
}

const usage = (result: SDKResultMessage): typeof Response.Usage.Encoded => ({
  inputTokens: {
    uncached: result.usage.input_tokens,
    total:
      result.usage.input_tokens +
      result.usage.cache_read_input_tokens +
      result.usage.cache_creation_input_tokens,
    cacheRead: result.usage.cache_read_input_tokens,
    cacheWrite: result.usage.cache_creation_input_tokens,
  },
  outputTokens: { total: result.usage.output_tokens },
})

const refusalOf = (messages: ReadonlyArray<SDKMessage>): string | undefined => {
  for (const m of messages) {
    if (
      m.type === "system" &&
      (m.subtype === "model_refusal_no_fallback" || m.subtype === "model_refusal_fallback")
    ) {
      return `${m.subtype}: ${m.api_refusal_category ?? "no category"}: ${m.content}`
    }
  }
  return undefined
}

/**
 * The turn's outcome: the result message, or the AiError it maps to. The order of the checks is
 * § 6.1's: a refusal wins even when the result says success.
 */
export const outcome = (
  method: string,
  messages: ReadonlyArray<SDKMessage>,
): Effect.Effect<SDKResultMessage, AiError.AiError> => {
  const result = messages.findLast((m): m is SDKResultMessage => m.type === "result")
  if (result === undefined) {
    return Effect.fail(
      fail(method, new AiError.UnknownError({ description: "the session ended with no result" })),
    )
  }
  const metadata = costMetadata(result)
  const refusal = refusalOf(messages)
  if (refusal !== undefined || result.stop_reason === "refusal") {
    return Effect.fail(
      fail(
        method,
        new AiError.ContentPolicyError({
          description: refusal ?? `stop_reason refusal (${result.subtype})`,
          metadata,
        }),
      ),
    )
  }
  if (result.subtype === "error_max_structured_output_retries") {
    return Effect.fail(
      fail(
        method,
        new AiError.StructuredOutputError({
          description: `${result.subtype}: ${result.errors.join("; ")}`,
          responseText: "",
          metadata,
        }),
      ),
    )
  }
  if (result.subtype !== "success") {
    return Effect.fail(
      fail(
        method,
        new AiError.UnknownError({
          description: `${result.subtype}: ${result.errors.join("; ")}`,
          metadata,
        }),
      ),
    )
  }
  if (result.is_error) {
    const reason =
      typeof result.api_error_status === "number"
        ? AiError.reasonFromHttpStatus({ status: result.api_error_status, body: result.result })
        : new AiError.UnknownError({ description: result.result, metadata })
    return Effect.fail(fail(method, reason))
  }
  return Effect.succeed(result)
}

const modelOf = (messages: ReadonlyArray<SDKMessage>): string | undefined => {
  for (const m of messages) if (m.type === "system" && m.subtype === "init") return m.model
  return undefined
}

const metadataPart = (
  messages: ReadonlyArray<SDKMessage>,
  result: SDKResultMessage,
): Response.ResponseMetadataPartEncoded => {
  const modelId = modelOf(messages)
  return {
    type: "response-metadata",
    id: result.session_id,
    ...(modelId === undefined ? {} : { modelId }),
    timestamp: new Date().toISOString(),
  }
}

// A structured-output turn ends on the StructuredOutput tool call (stop_reason "tool_use"), which
// for the caller is a normal stop: no tool call is left for it to answer.
const finishPart = (result: SDKResultMessage, json: boolean): Response.FinishPartEncoded => ({
  type: "finish",
  reason:
    json && result.stop_reason === "tool_use" && result.terminal_reason === "completed"
      ? "stop"
      : finishReason(result.stop_reason),
  usage: usage(result),
  metadata: costMetadata(result),
})

// ---------------------------------------------------------------------------------------------
// The provider

const prepare = (
  method: string,
  options: LanguageModel.ProviderOptions,
): Effect.Effect<
  { turn: Turn; jsonSchema: Record<string, unknown> | undefined },
  AiError.AiError
> =>
  Effect.gen(function* () {
    const turn = toTurn(options.prompt)
    if (typeof turn === "string") {
      return yield* fail(
        method,
        new AiError.InvalidUserInputError({
          description: `The prompt doesn't fit one SDK turn: ${turn}`,
        }),
      )
    }
    if (options.tools.length > 0) {
      return yield* fail(
        method,
        new AiError.InvalidUserInputError({ description: "Organs run with no tools" }),
      )
    }
    if (options.responseFormat.type === "text") return { turn, jsonSchema: undefined }
    const schema = options.responseFormat.schema
    const converted = yield* Effect.try({
      try: () => AnthropicStructuredOutput.toCodecAnthropic(schema as never),
      catch: (error) =>
        fail(
          method,
          new AiError.UnsupportedSchemaError({
            description: error instanceof Error ? error.message : String(error),
          }),
        ),
    })
    return { turn, jsonSchema: converted.jsonSchema as Record<string, unknown> }
  })

export const make = (config: Config): Effect.Effect<LanguageModel.LanguageModel> =>
  LanguageModel.make({
    codecTransformer: AnthropicStructuredOutput.toCodecAnthropic,

    generateText: (options) =>
      Effect.gen(function* () {
        const { turn, jsonSchema } = yield* prepare("generateText", options)
        const messages = yield* Effect.tryPromise({
          try: async (signal) => {
            const all: Array<SDKMessage> = []
            for await (const m of runTurn(config, turn, jsonSchema, false, signal)) all.push(m)
            return all
          },
          catch: (error) =>
            fail(
              "generateText",
              new AiError.UnknownError({
                description: error instanceof Error ? error.message : String(error),
              }),
            ),
        })
        const result = yield* outcome("generateText", messages)
        if (result.subtype !== "success") return yield* Effect.die("outcome passed an error")
        // § 6.1: the structured output is returned as the text part generateObject decodes. A
        // model that declines to call the StructuredOutput tool ends the turn with text and a
        // success result that has no structured_output.
        if (jsonSchema !== undefined && result.structured_output === undefined) {
          return yield* fail(
            "generateText",
            new AiError.StructuredOutputError({
              description: "The turn succeeded with no structured output",
              responseText: result.result,
              metadata: costMetadata(result),
            }),
          )
        }
        const text =
          jsonSchema === undefined ? result.result : JSON.stringify(result.structured_output)
        const parts: Array<Response.PartEncoded> = [
          metadataPart(messages, result),
          { type: "text", text },
          finishPart(result, jsonSchema !== undefined),
        ]
        return parts
      }),

    // Streaming, with partial messages on: the turn's text_delta events become text-delta parts,
    // and the result becomes the finish part (or the error).
    streamText: (options) =>
      Stream.unwrap(
        Effect.map(prepare("streamText", options), ({ turn, jsonSchema }) => {
          const seen: Array<SDKMessage> = []
          let open = false
          const id = "text-0"
          return Stream.fromAsyncIterable(runTurn(config, turn, jsonSchema, true), (error) =>
            fail(
              "streamText",
              new AiError.UnknownError({
                description: error instanceof Error ? error.message : String(error),
              }),
            ),
          ).pipe(
            Stream.mapEffect((m) => {
              seen.push(m)
              const out: Array<Response.StreamPartEncoded> = []
              if (m.type === "stream_event" && m.parent_tool_use_id === null) {
                const event = m.event
                if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
                  if (!open) out.push({ type: "text-start", id })
                  open = true
                  out.push({ type: "text-delta", id, delta: event.delta.text })
                }
                return Effect.succeed(out)
              }
              if (m.type !== "result") return Effect.succeed(out)
              return Effect.map(outcome("streamText", seen), (result) => {
                if (open) out.push({ type: "text-end", id })
                out.push(metadataPart(seen, result), finishPart(result, jsonSchema !== undefined))
                return out
              })
            }),
            Stream.flatMap((parts) => Stream.fromIterable(parts)),
          )
        }),
      ),
  })
