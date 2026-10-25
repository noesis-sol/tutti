// Organs (§ 3.3, § 6): the one-shot advisers, triage, the predictor, the reviewer, the screen, the
// plan and the scout, written against effect/ai's LanguageModel. An organ is a name, a prompt (from
// prompts/), the Schema of its answer, an effort and a time limit, both as orchestra sets them.
// `--organ-model` and `--organ-effort`, or the settings' organs.model and organs.effort, override
// every organ's model and effort; AppConfig has them resolved.
//
// Each call:
// - is skipped, with a log line, while the usage-limit hold is on (§ 4.12), as OrganHold says, and
//   puts that hold on when it is refused for the account's usage limit;
// - draws a fresh evidence ID and tags the input's sections with it (evidence.ts, § 6.2), its
//   system prompt ending with the evidence rule;
// - runs generateObject as the organ (OrganCall), within the organ's time limit: the provider
//   aborts the session when the limit interrupts it;
// - fails with OrganRefused for a refusal, OrganTimedOut past its limit, and OrganFailed for the
//   rest, with the SDK result's subtype when there was one.
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk"
import { Context, DateTime, Duration, Effect, Layer, Schema } from "effect"
import { type AiError, LanguageModel } from "effect/ai"
import { AppConfig } from "../cli/AppConfig.ts"
import { type Line, Log, line, Tag } from "../run/log.ts"
import type { TicketId } from "../services/Beads.ts"
import { timeoutAwake } from "../services/Wake.ts"
import { limitOf, OrganCall, type OrganReads, subtypeOf } from "./AgentSdkLanguageModel.ts"
import { evidenceId, fromTheRun, type InputPart, renderInput, systemPrompt } from "./evidence.ts"

/** The organs, by the names their log lines and costs carry. */
export const organNames = ["triage", "predictor", "reviewer", "screen", "plan", "scout"] as const
export type OrganName = (typeof organNames)[number]

/** Each organ's effort and time limit, as orchestra sets them (§ 6.1). */
export const organDefaults: {
  readonly [N in OrganName]: { readonly effort: EffortLevel; readonly timeLimit: Duration.Duration }
} = {
  triage: { effort: "low", timeLimit: Duration.minutes(3) },
  predictor: { effort: "low", timeLimit: Duration.minutes(2) },
  reviewer: { effort: "medium", timeLimit: Duration.minutes(5) },
  screen: { effort: "low", timeLimit: Duration.minutes(2) },
  plan: { effort: "high", timeLimit: Duration.minutes(10) },
  scout: { effort: "medium", timeLimit: Duration.minutes(5) },
}

/** An organ's answer: a Schema of a JSON object, needing no services. */
export type Answer<A> = Schema.Codec<A, Record<string, unknown>>

/** One organ. */
export interface Organ<A> {
  readonly name: OrganName
  /** Its system prompt, the evidence rule at its end. */
  readonly system: string
  readonly answer: Answer<A>
  /** Its effort, unless AppConfig's organs.effort overrides it. */
  readonly effort: EffortLevel
  readonly timeLimit: Duration.Duration
  /** The read-only tools it reads the repository with: the scout's (§ 6.3). Others have none. */
  readonly reads?: OrganReads
}

/** What an organ is made from. */
export interface OrganSpec<A> {
  /** Its own prompt, from prompts/<name>.md; the evidence rule is added after it. */
  readonly prompt: string
  readonly answer: Answer<A>
  /** Where its evidence comes from, as the evidence rule says: `fromTheRun` by default. */
  readonly evidenceSource?: string
}

/** The organ `name`, with its effort and time limit as orchestra sets them. */
export const make = <A>(name: OrganName, spec: OrganSpec<A>): Organ<A> => ({
  name,
  system: systemPrompt(spec.prompt, spec.evidenceSource ?? fromTheRun),
  answer: spec.answer,
  ...organDefaults[name],
})

// ---------------------------------------------------------------------------------------------
// Errors

/** The organ gave no answer: the SDK result's subtype says how its call ended, when it did. */
export class OrganFailed extends Schema.TaggedError<OrganFailed>()("OrganFailed", {
  organ: Schema.String,
  /** The SDK result's subtype (`error_max_structured_output_retries`), or null with no result. */
  subtype: Schema.NullOr(Schema.String),
  /** What effect/ai said of it. */
  reason: Schema.String,
}) {}

/** The model declined to answer, even when the SDK reported success. */
export class OrganRefused extends Schema.TaggedError<OrganRefused>()("OrganRefused", {
  organ: Schema.String,
  reason: Schema.String,
}) {}

/** The organ ran past its time limit, and its session was aborted. */
export class OrganTimedOut extends Schema.TaggedError<OrganTimedOut>()("OrganTimedOut", {
  organ: Schema.String,
  timeLimit: Schema.Duration,
}) {}

/** The call was skipped: the usage-limit hold was on (§ 4.12). */
export class OrganSkipped extends Schema.TaggedError<OrganSkipped>()("OrganSkipped", {
  organ: Schema.String,
}) {}

export type OrganError = OrganFailed | OrganRefused | OrganTimedOut | OrganSkipped

/** The organ error an effect/ai error maps to. */
export const organError = (organ: string, error: AiError.AiError): OrganFailed | OrganRefused =>
  error.reason._tag === "ContentPolicyError"
    ? new OrganRefused({ organ, reason: error.message })
    : new OrganFailed({ organ, subtype: subtypeOf(error) ?? null, reason: error.message })

// ---------------------------------------------------------------------------------------------
// The usage-limit hold

/** Whether organ calls are held, and what puts the hold on: the usage-limit hold (§ 4.12). */
export interface OrganHoldValue {
  readonly held: Effect.Effect<boolean>
  /**
   * A call was refused for the account's usage limit, which resets at `resetsAt`, if known; a hold
   * without it ignores refusals.
   */
  readonly refused?: (refusal: {
    readonly limit: string | null
    readonly resetsAt: number | null
  }) => Effect.Effect<void>
}

/** The hold organ calls are skipped under; never held unless a layer provides one. */
export const OrganHold = Context.Reference<OrganHoldValue>("tutti/organs/Organs/OrganHold", {
  defaultValue: () => ({ held: Effect.succeed(false) }),
})

/**
 * The limit and reset a call refused for the account's usage limit carries
 * (AgentSdkLanguageModel's QuotaExhaustedError); undefined for any other error.
 */
export const refusalOf = (
  error: AiError.AiError,
): { readonly limit: string | null; readonly resetsAt: number | null } | undefined => {
  const reason = error.reason
  if (reason._tag !== "QuotaExhaustedError") return undefined
  return {
    limit: limitOf(error) ?? null,
    resetsAt: reason.resetAt === undefined ? null : DateTime.toEpochMillis(reason.resetAt),
  }
}

/** The log line of a skipped call: `ORGAN triage: skipped, the usage limit holds the run`. */
export const skippedLine = (organ: string): Line =>
  `${Tag.organ} ${line`${organ}: skipped, the usage limit holds the run`}` as Line

// ---------------------------------------------------------------------------------------------
// The service

export class Organs extends Context.Service<
  Organs,
  {
    /**
     * The organ's answer to `input`, its sections tagged as evidence; `about.ticket` is the ticket
     * the call is about, for its `organ` record.
     */
    ask<A>(
      organ: Organ<A>,
      input: ReadonlyArray<InputPart>,
      about?: { readonly ticket?: TicketId },
    ): Effect.Effect<A, OrganError>
  }
>()("tutti/organs/Organs") {
  /** Organs over the LanguageModel in context, with AppConfig's overrides and OrganHold's hold. */
  static readonly layer: Layer.Layer<Organs, never, LanguageModel.LanguageModel | AppConfig | Log> =
    Layer.effect(
      Organs,
      Effect.gen(function* () {
        const model = yield* LanguageModel.LanguageModel
        const config = yield* AppConfig
        const log = yield* Log
        const hold = yield* OrganHold
        const overrides = config.settings.organs
        return Organs.of({
          // Named with a span, as Effect.fn names the other boundaries: Effect.fn would lose A.
          ask: <A>(
            organ: Organ<A>,
            input: ReadonlyArray<InputPart>,
            about: { readonly ticket?: TicketId } = {},
          ) =>
            Effect.gen(function* () {
              if (yield* hold.held) {
                yield* log.write(skippedLine(organ.name))
                return yield* new OrganSkipped({ organ: organ.name })
              }
              const id = yield* evidenceId
              const response = yield* LanguageModel.generateObject({
                prompt: [
                  { role: "system", content: organ.system },
                  { role: "user", content: renderInput(id, input) },
                ],
                schema: organ.answer,
                objectName: organ.name,
              }).pipe(
                Effect.provideService(LanguageModel.LanguageModel, model),
                Effect.provideService(OrganCall, {
                  organ: organ.name,
                  ...(about.ticket === undefined ? {} : { ticket: about.ticket }),
                  effort: overrides.effort ?? organ.effort,
                  ...(overrides.model === null ? {} : { model: overrides.model }),
                  ...(organ.reads === undefined ? {} : { reads: organ.reads }),
                }),
                Effect.tapError((error) => {
                  const refusal = refusalOf(error)
                  return refusal === undefined || hold.refused === undefined
                    ? Effect.void
                    : hold.refused(refusal)
                }),
                Effect.mapError((error) => organError(organ.name, error)),
                timeoutAwake({
                  duration: organ.timeLimit,
                  orElse: () =>
                    Effect.fail(
                      new OrganTimedOut({ organ: organ.name, timeLimit: organ.timeLimit }),
                    ),
                }),
              )
              return response.value
            }).pipe(Effect.withSpan("Organs.ask", { attributes: { organ: organ.name } })),
        })
      }),
    )
}
