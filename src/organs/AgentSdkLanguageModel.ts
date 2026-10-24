// AgentSdkLanguageModel (§ 6.1): the effect/ai LanguageModel organs are written against, over the
// Agent SDK, one SDK session per call, as the M0 report recommends (docs/spikes/04-effect-ai.md).
//
// - The prompt's system messages become the SDK's systemPrompt, a plain string that starts with a
//   blank line (Claude Code puts its identity line in front of it with no separator), and its one
//   user message the session's one user message. Anything else (history, a second user message, a
//   file part, tools) doesn't fit one fresh turn and is refused with InvalidUserInputError.
// - For a JSON response, the schema goes through effect/ai's AnthropicStructuredOutput codec
//   transformer, and its JSON Schema to the SDK as outputFormat json_schema. The result's
//   structured_output comes back as the text part generateObject decodes. Retries exhausted, and a
//   success without structured_output (a model can decline the StructuredOutput tool), fail with
//   StructuredOutputError; organs see OrganFailed{subtype}.
// - A refusal, from the SDK's model_refusal_no_fallback message or the result's stop_reason, fails
//   with ContentPolicyError (organs see OrganRefused), even when the result says success. A
//   model_refusal_fallback is not one: the turn was retried on the fallback model, and the result
//   is its answer. streamText fails such a turn whose refused attempt had streamed text, as that
//   text can't be taken back.
// - The session is isolated: no tools, no MCP servers, no settings, no prompts, no transcript, a
//   fresh private temp folder removed afterwards, and a worker's environment (§ 4.13). An organ
//   that reads the repository (the scout, § 6.3) names its read-only tools, the folder it reads,
//   the hook that confines them to it and its budget, in OrganCall's `reads`.
// - A turn that ended on the account's usage limit fails with QuotaExhaustedError, with when the
//   limit resets and its name, from the turn's rate_limit_events: Organs puts the run's usage-limit
//   hold on with them (OrganHold).
// - Interrupting the call aborts the SDK's abortController; the turn ends and Claude Code exits.
// - Each result's cost goes to OrganCost as it arrives, whatever happens to the answer after:
//   LanguageModel's own decoding errors don't carry it. A call that ends without a result (its
//   time limit interrupts it, or its session fails first) goes to OrganCost as it ends, as a call
//   of unknown cost with the time it ran.
//
// All of it but the session itself is `make`, over a Session: the live layer's runs Claude Code,
// the test layer's (src/testing/Organs.ts) plays canned SDK messages.
//
// Which organ is calling, and its model and effort, the organ framework says with OrganCall.
import {
  type EffortLevel,
  type Options,
  query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { Clock, Context, DateTime, Effect, FileSystem, Layer, type Scope, Stream } from "effect"
import {
  AiError,
  AnthropicStructuredOutput,
  LanguageModel,
  type Prompt,
  type Response,
} from "effect/ai"
import type { AccountProbe } from "../agent/Account.ts"
import { queryThrew } from "../agent/claudeBinary.ts"
import { workerEnv } from "../agent/env.ts"
import { chromeArgs } from "../agent/mcp.ts"
import { spawnInOwnProcessGroup } from "../agent/options.ts"
import { organCloseLimit, withSessionProcess, withStderr } from "../agent/sessionProcess.ts"
import { endedOnLimit, turnLimit } from "../agent/UsageLimits.ts"
import { AppConfig } from "../cli/AppConfig.ts"
import { type Cost, OrganCost } from "./OrganCost.ts"

const module = "AgentSdkLanguageModel"

/** Which organ makes a call, and how its session runs. */
export interface OrganCallConfig {
  /** The organ's name, for its cost line: `triage`. */
  readonly organ: string
  /** The ticket the call is about, for its `organ` record; none when it is about no ticket. */
  readonly ticket?: string
  /** The model; Claude Code's default when absent. */
  readonly model?: string
  readonly effort?: EffortLevel
  /** The read-only tools it reads the repository with, the scout's (§ 6.3); none when absent. */
  readonly reads?: OrganReads
}

/** An organ's read-only tools, and how they are kept to the folder they read. */
export interface OrganReads {
  /** The tools, listed explicitly: `["Read", "Glob", "Grep"]`. */
  readonly tools: ReadonlyArray<string>
  /** The folder the session runs in, in place of a temp folder: the repository's root. */
  readonly cwd: string
  /** The hooks that confine the tools, PreToolUse coming first in the SDK's evaluation order. */
  readonly hooks: NonNullable<Options["hooks"]>
  /** The most the session may spend, in US dollars. */
  readonly maxBudgetUsd: number
}

/** The organ making the calls in its scope: the organ framework provides it around each call. */
export const OrganCall = Context.Reference<OrganCallConfig>(
  "tutti/organs/AgentSdkLanguageModel/OrganCall",
  { defaultValue: () => ({ organ: "organ" }) },
)

// ---------------------------------------------------------------------------------------------
// The prompt

/** A prompt as one SDK turn. */
export interface Turn {
  readonly systemPrompt: string
  /** The user message's text parts, sent as one text block each. */
  readonly userText: ReadonlyArray<string>
}

/**
 * The prompt as one turn: its system messages, each after a blank line, and then one user message
 * of text. Anything else is what doesn't fit, as a phrase.
 */
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
  return { systemPrompt: `\n\n${systems.join("\n\n")}`, userText }
}

// ---------------------------------------------------------------------------------------------
// The session's options

/** What an organ session's options are made from. */
export interface OrganOptionsInput {
  readonly turn: Turn
  /** The JSON Schema of a JSON response; undefined for text. */
  readonly jsonSchema: Record<string, unknown> | undefined
  readonly call: OrganCallConfig
  /** The folder the session runs in: a fresh private temp folder, or `call.reads`'s. */
  readonly cwd: string
  /** workerEnv()'s environment (§ 4.13). */
  readonly env: Record<string, string>
  /** The Claude Code to run (--claude); the embedded one when null. */
  readonly claude: string | null
  readonly abortController: AbortController
  /** Partial messages, for streamText. */
  readonly partial: boolean
  readonly stderr: (data: string) => void
}

/**
 * An organ session's SDK options (§ 6.1): isolated, in a temp folder, one turn. An organ that reads
 * (§ 6.3) gets its tools, its hooks and its budget.
 */
export const organOptions = (input: OrganOptionsInput): Options => ({
  systemPrompt: input.turn.systemPrompt,
  tools: input.call.reads === undefined ? [] : [...input.call.reads.tools],
  ...(input.call.reads === undefined
    ? {}
    : { hooks: input.call.reads.hooks, maxBudgetUsd: input.call.reads.maxBudgetUsd }),
  strictMcpConfig: true,
  // Claude Code turns Claude in Chrome on by itself once it is set up: an organ never gets it.
  extraArgs: chromeArgs({ chrome: false }),
  settingSources: [],
  permissionPrompts: "none",
  persistSession: false,
  cwd: input.cwd,
  env: input.env,
  abortController: input.abortController,
  includePartialMessages: input.partial,
  ...(input.call.model === undefined ? {} : { model: input.call.model }),
  ...(input.call.effort === undefined ? {} : { effort: input.call.effort }),
  ...(input.jsonSchema === undefined
    ? {}
    : { outputFormat: { type: "json_schema", schema: input.jsonSchema } }),
  stderr: input.stderr,
  ...(input.claude === null ? {} : { pathToClaudeCodeExecutable: input.claude }),
  spawnClaudeCodeProcess: spawnInOwnProcessGroup(input.stderr),
})

const userMessage = (texts: ReadonlyArray<string>): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: texts.map((text) => ({ type: "text", text })) },
  parent_tool_use_id: null,
})

// ---------------------------------------------------------------------------------------------
// Results and errors

const fail = (method: string, reason: AiError.AiErrorReason) =>
  AiError.make({ module, method, reason })

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/** The provider metadata a result's parts and errors carry, under this key. */
export const metadataKey = "agent-sdk"

/** The result's bookkeeping, as provider metadata. */
export const resultMetadata = (result: SDKResultMessage) => ({
  [metadataKey]: {
    session_id: result.session_id,
    subtype: result.subtype,
    total_cost_usd: result.total_cost_usd ?? 0,
    num_turns: result.num_turns ?? 0,
    duration_ms: result.duration_ms ?? 0,
    stop_reason: result.stop_reason ?? null,
    terminal_reason: result.terminal_reason ?? null,
  },
})

/** The result subtype an error's metadata carries: `error_max_structured_output_retries`. */
export const subtypeOf = (error: AiError.AiError): string | undefined => {
  const metadata = (error.reason as { readonly metadata?: Record<string, unknown> }).metadata
  const sdk = metadata?.[metadataKey] as { readonly subtype?: unknown } | undefined
  return typeof sdk?.subtype === "string" ? sdk.subtype : undefined
}

/** The result's cost, for OrganCost. */
export const costOf = (organ: string, result: SDKResultMessage, ticket?: string): Cost => ({
  organ,
  ...(ticket === undefined ? {} : { ticket }),
  costUsd: result.total_cost_usd ?? 0,
  turns: result.num_turns ?? 0,
  durationMs: result.duration_ms ?? 0,
  sessionId: result.session_id,
  ...(result.subtype === "success" ? {} : { subtype: result.subtype }),
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

const usage = (result: SDKResultMessage): typeof Response.Usage.Encoded => {
  const input = result.usage?.input_tokens ?? 0
  const cacheRead = result.usage?.cache_read_input_tokens ?? 0
  const cacheWrite = result.usage?.cache_creation_input_tokens ?? 0
  return {
    inputTokens: { uncached: input, total: input + cacheRead + cacheWrite, cacheRead, cacheWrite },
    outputTokens: { total: result.usage?.output_tokens ?? 0 },
  }
}

/**
 * The refusal among the turn's messages, as a phrase, if any. A model_refusal_fallback isn't one:
 * the turn was retried on the fallback model, whose answer the result carries.
 */
const refusalOf = (messages: ReadonlyArray<SDKMessage>): string | undefined => {
  for (const m of messages) {
    if (m.type === "system" && m.subtype === "model_refusal_no_fallback") {
      return `${m.subtype}: ${m.api_refusal_category ?? "no category"}: ${m.content}`
    }
  }
  return undefined
}

/** The turn's retry on the fallback model after a refusal, as a phrase, if it had one. */
const fallbackOf = (messages: ReadonlyArray<SDKMessage>): string | undefined => {
  for (const m of messages) {
    if (m.type === "system" && m.subtype === "model_refusal_fallback") {
      return `${m.subtype}: ${m.original_model} refused (${m.api_refusal_category ?? "no category"}), retried on ${m.fallback_model}`
    }
  }
  return undefined
}

/** The limit a QuotaExhaustedError's metadata names: `five_hour`; undefined when it names none. */
export const limitOf = (error: AiError.AiError): string | undefined => {
  const metadata = (error.reason as { readonly metadata?: Record<string, unknown> }).metadata
  const sdk = metadata?.[metadataKey] as { readonly rate_limit_type?: unknown } | undefined
  return typeof sdk?.rate_limit_type === "string" ? sdk.rate_limit_type : undefined
}

/**
 * The turn's result, or the error it maps to. A refusal is checked first: it wins even when the
 * result says success. A turn that ended on the account's usage limit (a 429, a rejected
 * rate_limit_event or an assistant message's `rate_limit` error, as for a worker's turn) is a
 * QuotaExhaustedError, with the limit's reset and its name.
 */
export const outcome = (
  method: string,
  messages: ReadonlyArray<SDKMessage>,
): Effect.Effect<SDKResultMessage & { readonly subtype: "success" }, AiError.AiError> => {
  const result = messages.findLast((m): m is SDKResultMessage => m.type === "result")
  if (result === undefined) {
    return Effect.fail(
      fail(method, new AiError.UnknownError({ description: "the session ended with no result" })),
    )
  }
  const metadata = resultMetadata(result)
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
  if (result.is_error) {
    const status = result.subtype === "success" ? result.api_error_status : undefined
    const limit = turnLimit(messages)
    if (endedOnLimit(limit, status)) {
      return Effect.fail(
        fail(
          method,
          new AiError.QuotaExhaustedError({
            ...(limit.resetsAt === null ? {} : { resetAt: DateTime.makeUnsafe(limit.resetsAt) }),
            metadata: {
              [metadataKey]: {
                ...metadata[metadataKey],
                ...(limit.limit === null ? {} : { rate_limit_type: limit.limit }),
              },
            },
          }),
        ),
      )
    }
  }
  if (result.subtype === "error_max_structured_output_retries") {
    return Effect.fail(
      fail(
        method,
        new AiError.StructuredOutputError({
          description: `${result.subtype}: ${(result.errors ?? []).join("; ")}`,
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
          description: `${result.subtype}: ${(result.errors ?? []).join("; ")}`,
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

/**
 * The text a JSON or text turn answers with: the structured output, as JSON, or the result's text.
 * A JSON turn's success without structured output is a structured-output failure, its subtype
 * `success`.
 */
const answerText = (
  method: string,
  result: SDKResultMessage & { readonly subtype: "success" },
  json: boolean,
): Effect.Effect<string, AiError.AiError> => {
  if (!json) return Effect.succeed(result.result)
  if (result.structured_output === undefined) {
    return Effect.fail(
      fail(
        method,
        new AiError.StructuredOutputError({
          description: "The turn succeeded with no structured output",
          responseText: result.result,
          metadata: resultMetadata(result),
        }),
      ),
    )
  }
  return Effect.succeed(JSON.stringify(result.structured_output))
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

// A JSON turn ends on the StructuredOutput tool call (stop_reason "tool_use"), which for the caller
// is a normal stop: no tool call is left for it to answer.
const finishPart = (result: SDKResultMessage, json: boolean): Response.FinishPartEncoded => ({
  type: "finish",
  reason: json && result.stop_reason === "tool_use" ? "stop" : finishReason(result.stop_reason),
  usage: usage(result),
  metadata: resultMetadata(result),
})

// ---------------------------------------------------------------------------------------------
// The provider

/** The turn a call's session plays, and for whom. */
export interface SessionTurn {
  readonly method: string
  readonly turn: Turn
  /** The JSON Schema of a JSON response; undefined for text. */
  readonly jsonSchema: Record<string, unknown> | undefined
  readonly call: OrganCallConfig
  /** Partial messages, for streamText. */
  readonly partial: boolean
  /** Whether the turn's result has come: a session closed before it is a turn not over. */
  readonly ended: () => boolean
}

/**
 * A call's session, the part of a call that reaches the outside world: the SDK's messages of one
 * turn, its resources released as the Scope closes. The live one runs Claude Code through query();
 * the test layer (src/testing/Organs.ts) plays canned messages.
 */
export type Session = (
  turn: SessionTurn,
) => Effect.Effect<Stream.Stream<SDKMessage, AiError.AiError>, AiError.AiError, Scope.Scope>

/**
 * The LanguageModel over `session`, its costs recorded in OrganCost: everything a call does but
 * run its session.
 */
export const make = (
  session: Session,
): Effect.Effect<LanguageModel.LanguageModel, never, OrganCost> =>
  Effect.gen(function* () {
    const costs = yield* OrganCost

    /** The turn's JSON Schema, for a JSON response, from the same transformer the codec uses. */
    const prepare = (method: string, provider: LanguageModel.ProviderOptions) =>
      Effect.gen(function* () {
        const turn = toTurn(provider.prompt)
        if (typeof turn === "string") {
          return yield* fail(
            method,
            new AiError.InvalidUserInputError({
              description: `The prompt doesn't fit one SDK turn: ${turn}`,
            }),
          )
        }
        if (provider.tools.length > 0) {
          return yield* fail(
            method,
            new AiError.InvalidUserInputError({ description: "Organs run with no tools" }),
          )
        }
        if (provider.responseFormat.type === "text") return { turn, jsonSchema: undefined }
        const schema = provider.responseFormat.schema
        const converted = yield* Effect.try({
          try: () => AnthropicStructuredOutput.toCodecAnthropic(schema as never),
          catch: (error) =>
            fail(method, new AiError.UnsupportedSchemaError({ description: messageOf(error) })),
        })
        return { turn, jsonSchema: converted.jsonSchema as Record<string, unknown> }
      })

    /**
     * The session's messages up to its result, its cost recorded as the result arrives. The
     * stream's end, or its interruption, ends the session; with no result, it records a call of
     * unknown cost.
     */
    const messages = (
      method: string,
      turn: Turn,
      jsonSchema: Record<string, unknown> | undefined,
      partial: boolean,
    ): Stream.Stream<SDKMessage, AiError.AiError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const call = yield* OrganCall
          // The call's time runs from before its setup, and is recorded last, after the session
          // has ended: an interruption during the setup records it too.
          const startedAt = yield* Clock.currentTimeMillis
          let ended = false
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              if (ended) return
              const endedAt = yield* Clock.currentTimeMillis
              yield* costs.recordUnknown({
                organ: call.organ,
                ...(call.ticket === undefined ? {} : { ticket: call.ticket }),
                durationMs: endedAt - startedAt,
              })
            }),
          )
          const played = yield* session({
            method,
            turn,
            jsonSchema,
            call,
            partial,
            ended: () => ended,
          })
          return played.pipe(
            Stream.takeUntil((m) => m.type === "result"),
            Stream.tap((m) => {
              if (m.type !== "result") return Effect.void
              ended = true
              return costs.record(costOf(call.organ, m, call.ticket))
            }),
          )
        }),
      )

    return yield* LanguageModel.make({
      codecTransformer: AnthropicStructuredOutput.toCodecAnthropic,

      generateText: (provider) =>
        Effect.gen(function* () {
          const { turn, jsonSchema } = yield* prepare("generateText", provider)
          const all = yield* Stream.runCollect(messages("generateText", turn, jsonSchema, false))
          const result = yield* outcome("generateText", all)
          const json = jsonSchema !== undefined
          const text = yield* answerText("generateText", result, json)
          const parts: Array<Response.PartEncoded> = [
            metadataPart(all, result),
            { type: "text", text },
            finishPart(result, json),
          ]
          return parts
        }),

      // With partial messages, the turn's text_delta events become text-delta parts, and the
      // result becomes the finish part, or the error. A JSON answer comes as one text part. An
      // attempt that streamed text and then ended on a refusal, retried on the fallback model,
      // left text in the stream the answer doesn't have: the turn fails rather than answer both.
      streamText: (provider) =>
        Stream.unwrap(
          Effect.map(prepare("streamText", provider), ({ turn, jsonSchema }) => {
            const seen: Array<SDKMessage> = []
            const json = jsonSchema !== undefined
            const id = "text-0"
            let open = false
            let refusedAfterText = false
            return messages("streamText", turn, jsonSchema, !json).pipe(
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
                  if (event.type === "message_delta" && event.delta.stop_reason === "refusal") {
                    refusedAfterText ||= open
                  }
                  return Effect.succeed(out)
                }
                if (m.type !== "result") return Effect.succeed(out)
                return Effect.gen(function* () {
                  const result = yield* outcome("streamText", seen)
                  const fallback = fallbackOf(seen)
                  if (refusedAfterText && fallback !== undefined) {
                    return yield* fail(
                      "streamText",
                      new AiError.UnknownError({
                        description: `${fallback}, after the refused attempt's text was streamed`,
                        metadata: resultMetadata(result),
                      }),
                    )
                  }
                  if (json) {
                    const text = yield* answerText("streamText", result, json)
                    out.push(
                      { type: "text-start", id },
                      { type: "text-delta", id, delta: text },
                      { type: "text-end", id },
                    )
                  } else if (open) {
                    out.push({ type: "text-end", id })
                  }
                  out.push(metadataPart(seen, result), finishPart(result, json))
                  return out
                })
              }),
              Stream.flatMap((parts) => Stream.fromIterable(parts)),
            )
          }),
        ),
    })
  })

/** What the live layer takes beside its services. */
export interface LiveOptions {
  /** What the account probe found: whether there's a subscription login (§ 4.13). */
  readonly account: Pick<AccountProbe, "subscription">
  /** tutti's environment, organs' is made from; process.env by default. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** The Agent SDK's query(), which a test stands in for. */
  readonly query?: typeof query
}

/** How much of Claude Code's stderr an error quotes, at most. */
const stderrLimit = 2000

/** The live LanguageModel over the Agent SDK, its costs recorded in OrganCost. */
export const layer = (
  options: LiveOptions,
): Layer.Layer<LanguageModel.LanguageModel, never, AppConfig | OrganCost | FileSystem.FileSystem> =>
  Layer.effect(
    LanguageModel.LanguageModel,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const fs = yield* FileSystem.FileSystem
      const openQuery = options.query ?? query
      const env = workerEnv({
        subscription: options.account.subscription,
        billing: config.billing,
        ...(options.env === undefined ? {} : { env: options.env }),
      })

      /**
       * One Claude Code session of the turn, in a fresh private temp folder, or the one the organ
       * reads. Its end aborts the session if the turn isn't over, and removes its folder.
       */
      const session: Session = ({ method, turn, jsonSchema, call, partial, ended }) =>
        Effect.gen(function* () {
          const cwd =
            call.reads?.cwd ??
            (yield* fs
              .makeTempDirectoryScoped({ prefix: "tutti-organ-" })
              .pipe(
                Effect.mapError((error) =>
                  fail(method, new AiError.UnknownError({ description: messageOf(error) })),
                ),
              ))
          const abortController = new AbortController()
          const { options, process } = withSessionProcess(
            organOptions({
              turn,
              jsonSchema,
              call,
              cwd,
              env,
              claude: config.claude,
              abortController,
              partial,
              stderr: () => {},
            }),
          )
          // query() throws as it is called when there is no Claude Code for the platform.
          const q = yield* Effect.try({
            try: () =>
              openQuery({
                prompt: (async function* () {
                  yield userMessage(turn.userText)
                })(),
                options,
              }),
            catch: (cause) =>
              fail(method, new AiError.UnknownError({ description: queryThrew(cause) })),
          })
          // A turn not over is unwanted: its Claude Code is killed at once, not given the SDK's
          // grace. Either way the call ends once its process has exited, before its folder goes.
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              if (!ended()) {
                yield* process.kill
                abortController.abort()
              }
              yield* process.closeAndWait(() => q.close(), organCloseLimit)
            }),
          )
          const failed = (error: unknown) =>
            fail(
              method,
              new AiError.UnknownError({
                description: withStderr(messageOf(error), process.stderrTail(stderrLimit)),
              }),
            )
          return Stream.fromAsyncIterable(q, failed)
        })

      return yield* make(session)
    }),
  )
