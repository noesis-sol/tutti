// The Organs test layer (§ 3.3): a LanguageModel with canned answers per organ, under which the
// live Organs service runs as it does over the Agent SDK. The organ calling is the one OrganCall
// names. Each organ's answers are played in order, the last repeated; an organ with none fails with
// UnknownError. A canned answer is the answer's JSON, as the SDK's structured output would give it,
// or an Effect giving one: one that fails with an AiError, or sleeps on the Clock, or never ends.
// Every call is recorded, with its system prompt, its input and how the organ ran.
import { Effect, Layer, Stream } from "effect"
import { AiError, AnthropicStructuredOutput, LanguageModel, type Response } from "effect/ai"
import { OrganCall, type OrganCallConfig, toTurn } from "../organs/AgentSdkLanguageModel.ts"

/** A canned answer: its JSON, or an Effect giving it. */
export type Canned =
  | Record<string, unknown>
  | Effect.Effect<Record<string, unknown>, AiError.AiError>

/** Each organ's canned answers, by its name: one, or several played in order. */
export type Answers = { readonly [organ: string]: Canned | ReadonlyArray<Canned> }

/** A call the layer was asked for. */
export interface OrganCallRecord {
  readonly call: OrganCallConfig
  readonly system: string
  /** The user message: the organ's input, its evidence tagged. */
  readonly input: string
}

const fail = (description: string) =>
  AiError.make({
    module: "testing/Organs",
    method: "generateText",
    reason: new AiError.UnknownError({ description }),
  })

const finish: Response.FinishPartEncoded = {
  type: "finish",
  reason: "stop",
  usage: {
    inputTokens: { uncached: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0 },
  },
}

const play = (canned: Canned): Effect.Effect<Record<string, unknown>, AiError.AiError> =>
  Effect.isEffect(canned)
    ? (canned as Effect.Effect<Record<string, unknown>, AiError.AiError>)
    : Effect.succeed(canned as Record<string, unknown>)

/** A LanguageModel playing `answers`; each call is pushed onto `calls`. */
export const layer = (
  answers: Answers,
  calls: Array<OrganCallRecord> = [],
): Layer.Layer<LanguageModel.LanguageModel> => {
  const left = new Map(
    Object.entries(answers).map(([organ, canned]) => [
      organ,
      Array.isArray(canned) ? [...canned] : [canned as Canned],
    ]),
  )
  const answer = (provider: LanguageModel.ProviderOptions) =>
    Effect.gen(function* () {
      const call = yield* OrganCall
      const turn = toTurn(provider.prompt)
      if (typeof turn === "string") return yield* fail(`The prompt doesn't fit one turn: ${turn}`)
      calls.push({ call, system: turn.systemPrompt, input: turn.userText.join("") })
      const queue = left.get(call.organ) ?? []
      const canned = queue.length > 1 ? queue.shift() : queue[0]
      if (canned === undefined) return yield* fail(`No canned answer for ${call.organ}`)
      const value = yield* play(canned)
      return JSON.stringify(value)
    })
  return Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      codecTransformer: AnthropicStructuredOutput.toCodecAnthropic,
      generateText: (provider) =>
        Effect.map(
          answer(provider),
          (text): Array<Response.PartEncoded> => [{ type: "text", text }, finish],
        ),
      streamText: (provider) =>
        Stream.unwrap(
          Effect.map(answer(provider), (text) =>
            Stream.fromIterable<Response.StreamPartEncoded>([
              { type: "text-start", id: "text-0" },
              { type: "text-delta", id: "text-0", delta: text },
              { type: "text-end", id: "text-0" },
              finish,
            ]),
          ),
        ),
    }),
  )
}
