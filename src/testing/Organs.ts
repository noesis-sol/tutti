// The Organs test layer (§ 3.3): the live LanguageModel over the Agent SDK (make), its session
// playing canned answers per organ in place of Claude Code. Everything else is the live code's: the
// prompt's checks, each call's cost in OrganCost, the result's mapping to an answer or an AiError,
// and the response's parts. The organ calling is the one OrganCall names. Each organ's answers are
// played in order, the last repeated; an organ with none fails with UnknownError.
//
// A canned answer is one of:
// - the answer's JSON, played as the SDK's structured output in a successful result;
// - the SDK messages of the turn (`messages`), mapped as live ones are: a usage-limit refusal
//   (`limited`) is a QuotaExhaustedError with its reset and limit, a result that ran out of
//   structured-output retries a StructuredOutputError with its subtype, and so on;
// - an Effect giving one of those, as a session that sleeps on the Clock or never ends, or failing
//   with an AiError, as a session that fails before its result.
//
// Its costs go to the OrganCost of the context it is built in, a scenario's, which the usage probe's
// share as in a run, or else to one of its own over the test's Log, which it provides with it:
// `ORGAN triage: $0.0000 in 1 turn, 0.0s`, as the run's organs' do.
// Every call is recorded, with its system prompt as the SDK gets it, its input and how the organ
// ran.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Layer, Stream } from "effect"
import { AiError, LanguageModel } from "effect/ai"
import { make, type OrganCallConfig, type Session } from "../organs/AgentSdkLanguageModel.ts"
import type { OrganCost } from "../organs/OrganCost.ts"
import type { Log } from "../run/log.ts"
import { shared } from "./OrganCost.ts"

/** A turn's SDK messages, played as a session would give them. */
export class Messages {
  constructor(readonly messages: ReadonlyArray<SDKMessage>) {}
}

/** A canned answer: its JSON, its turn's SDK messages, or an Effect giving either. */
export type Canned =
  | Record<string, unknown>
  | Messages
  | Effect.Effect<Record<string, unknown> | Messages, AiError.AiError>

/** Each organ's canned answers, by its name: one, or several played in order. */
export type Answers = { readonly [organ: string]: Canned | ReadonlyArray<Canned> }

/** A call the layer was asked for. */
export interface OrganCallRecord {
  readonly call: OrganCallConfig
  readonly system: string
  /** The user message: the organ's input, its evidence tagged. */
  readonly input: string
}

/** The turn whose SDK messages are `messages`. */
export const messages = (...all: ReadonlyArray<object>): Messages =>
  new Messages(all as ReadonlyArray<SDKMessage>)

/** A turn's result: a success of no cost, `fields` laid over it. */
export const result = (fields: object = {}): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    num_turns: 1,
    total_cost_usd: 0,
    duration_ms: 0,
    stop_reason: "end_turn",
    session_id: "organ",
    ...fields,
  }) as unknown as SDKMessage

/** The turn of a structured-output answer `value`, ending on the StructuredOutput tool call. */
export const answered = (value: Record<string, unknown>, fields: object = {}): Messages =>
  messages(
    result({
      result: JSON.stringify(value),
      structured_output: value,
      stop_reason: "tool_use",
      ...fields,
    }),
  )

/**
 * The turn refused for the account's usage limit `limit`: a rejected rate_limit_event resetting at
 * `resetsAt` (seconds since the epoch, as the API's header has it), then a 429 result.
 */
export const limited = (limit: string, resetsAt: number): Messages =>
  messages(
    {
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt, rateLimitType: limit },
    },
    result({ is_error: true, api_error_status: 429, result: "API Error: 429" }),
  )

const fail = (description: string) =>
  AiError.make({
    module: "testing/Organs",
    method: "generateText",
    reason: new AiError.UnknownError({ description }),
  })

const play = (
  canned: Canned,
): Effect.Effect<Record<string, unknown> | Messages, AiError.AiError> =>
  Effect.isEffect(canned)
    ? (canned as Effect.Effect<Record<string, unknown> | Messages, AiError.AiError>)
    : Effect.succeed(canned as Record<string, unknown> | Messages)

/**
 * A LanguageModel playing `answers`, and the OrganCost its calls' costs go to: the context's, or
 * one logged to the Log; each call is pushed onto `calls`.
 */
export const layer = (
  answers: Answers,
  calls: Array<OrganCallRecord> = [],
): Layer.Layer<LanguageModel.LanguageModel | OrganCost, never, Log> => {
  const left = new Map(
    Object.entries(answers).map(([organ, canned]) => [
      organ,
      Array.isArray(canned) ? [...canned] : [canned as Canned],
    ]),
  )
  const session: Session = ({ turn, call }) =>
    Effect.gen(function* () {
      calls.push({ call, system: turn.systemPrompt, input: turn.userText.join("") })
      const queue = left.get(call.organ) ?? []
      const canned = queue.length > 1 ? queue.shift() : queue[0]
      if (canned === undefined) return yield* fail(`No canned answer for ${call.organ}`)
      const played = yield* play(canned)
      return Stream.fromIterable((played instanceof Messages ? played : answered(played)).messages)
    })
  return Layer.effect(LanguageModel.LanguageModel, make(session)).pipe(Layer.provideMerge(shared))
}
