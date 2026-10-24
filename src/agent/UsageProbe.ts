// UsageProbe (§ 4.12): whether the account is under its usage limit again, asked of the account
// itself. The usage-limit hold asks it before it lifts on the clock, at the reset or its next try,
// rather than telling every worker waiting for the limit to carry on into a refusal: one model
// request in place of one per worker.
//
// The probe is one Claude Code session of one turn, isolated as an organ's is (no tools, no MCP
// servers, no settings, no transcript, a fresh temp folder) and billed as workers are (§ 4.13): a
// few tokens to the cheapest model the held limit counts, haiku but for a model's own seven-day
// limit. Its answer is read from the turn's messages as a worker's turn is (answerOf):
//
// - `Refused`: a rejected rate_limit_event, an assistant message's `rate_limit` error or a 429
//   result, with the limit and the reset the event gave.
// - `Allowed`: a result that isn't an error, or an `allowed` rate_limit_event.
// - `Unanswered`: anything else: the session didn't start, failed otherwise or took longer than
//   probeTimeout. The hold lifts on the clock then, as it would without the probe.
//
// Each try spends a model request, about a hundredth of a cent on haiku: its cost goes to OrganCost
// as an organ call's, `ORGAN usage-probe: $0.0001 in 1 turn, 1.4s`.
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import {
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  FileSystem,
  Layer,
  type Scope,
  Stream,
} from "effect"
import { costOf, organOptions } from "../organs/AgentSdkLanguageModel.ts"
import { OrganCost } from "../organs/OrganCost.ts"
import { BilledAs, ClaudeCode } from "./ClaudeCode.ts"
import { turnLimit } from "./reading.ts"
import { organCloseLimit } from "./sessionProcess.ts"
import { endedOnLimit } from "./UsageLimits.ts"

/** What the account answered the probe. Times are epoch milliseconds. */
export type ProbeAnswer = Data.TaggedEnum<{
  /** The turn came back unrefused: the account is under the limit. */
  Allowed: Record<never, never>
  /** Refused for the limit: which, and when it resets, null where the session didn't say. */
  Refused: { readonly limit: string | null; readonly resetsAt: number | null }
  /** The session couldn't say, for `reason`. */
  Unanswered: { readonly reason: string }
}>

export const ProbeAnswer = Data.taggedEnum<ProbeAnswer>()

/** The probe's name, as its cost line and `organ` record give it. */
export const probeOrgan = "usage-probe"

/** How long the probe's session has to answer. */
export const probeTimeout = Duration.minutes(1)

/** The probe's system prompt and message: a turn of a few tokens. */
export const probeSystemPrompt = "\n\nAnswer with the single word OK."
export const probeMessage = "OK?"

/**
 * The model the probe asks for the held limit `limit`: the model a seven-day limit of its own
 * counts (`seven_day_opus`, `seven_day_sonnet`), else haiku, the cheapest, which the account's
 * other limits count as any model.
 */
export const probeModel = (limit: string | null): string =>
  limit === "seven_day_opus" ? "opus" : limit === "seven_day_sonnet" ? "sonnet" : "haiku"

/** The probe's answer from its turn's messages, read as WorkerState reads a worker's turn. */
export const answerOf = (messages: ReadonlyArray<SDKMessage>): ProbeAnswer => {
  const seen = turnLimit(messages)
  const result = messages.findLast((m): m is SDKResultMessage => m.type === "result")
  const status =
    result?.is_error === true && result.subtype === "success" ? result.api_error_status : undefined
  if (endedOnLimit(seen, status)) {
    return ProbeAnswer.Refused({ limit: seen.limit, resetsAt: seen.resetsAt })
  }
  if ((result !== undefined && !result.is_error) || seen.seen) return ProbeAnswer.Allowed()
  if (result === undefined)
    return ProbeAnswer.Unanswered({ reason: "the session ended with no result" })
  const said = result.subtype === "success" ? result.result.trim() : result.subtype
  return ProbeAnswer.Unanswered({
    reason: said === "" ? `its turn ended on an error (${result.subtype})` : said,
  })
}

/** How much of Claude Code's stderr an unanswered probe quotes, at most. */
const stderrLimit = 500

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

export class UsageProbe extends Context.Service<
  UsageProbe,
  {
    /** Asks the account whether the held limit `limit` (null when the hold names none) refuses. */
    probe(limit: string | null): Effect.Effect<ProbeAnswer>
  }
>()("tutti/agent/UsageProbe") {
  /** The live layer, over Claude Code, billed as workers are, in the run's WorkerEnv. */
  static readonly layer: Layer.Layer<
    UsageProbe,
    never,
    ClaudeCode | OrganCost | FileSystem.FileSystem
  > = Layer.effect(
    UsageProbe,
    Effect.gen(function* () {
      const claudeCode = yield* ClaudeCode
      const fs = yield* FileSystem.FileSystem

      /** One Claude Code session of the probe's turn, in a fresh temp folder. */
      const session: ProbeSession = ({ limit, answered }) =>
        Effect.gen(function* () {
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "tutti-usage-probe-" })
          const claude = yield* claudeCode.open({
            options: {
              ...organOptions({
                turn: { systemPrompt: probeSystemPrompt, userText: [probeMessage] },
                jsonSchema: undefined,
                call: { organ: probeOrgan, model: probeModel(limit) },
                cwd,
                partial: false,
              }),
              maxTurns: 1,
            },
            prompt: (async function* () {
              yield {
                type: "user" as const,
                message: { role: "user" as const, content: probeMessage },
                parent_tool_use_id: null,
              }
            })(),
            billedAs: BilledAs.Workers(),
            closeLimit: organCloseLimit,
          })
          // A turn not over is unwanted: its Claude Code is killed at once, not given the SDK's
          // grace. Either way the probe ends once its process has exited.
          yield* Effect.addFinalizer(() => (answered() ? Effect.void : claude.kill))
          return claude.messages.pipe(Stream.mapError((error) => error.quoted(stderrLimit)))
        })

      return yield* probeWith(session)
    }),
  )
}

/** The probe a session is asked to play. */
export interface ProbeTurn {
  /** The held limit the probe asks about; null when the hold names none. */
  readonly limit: string | null
  /** Whether the turn's result has come: a session closed before it is a turn not over. */
  readonly answered: () => boolean
}

/**
 * A probe's session, the part of a probe that reaches the outside world: the SDK messages of its
 * one turn, its resources released as the Scope closes. Whatever it fails with is the reason the
 * probe is Unanswered. The live one runs Claude Code through query(); the test layer
 * (src/testing/UsageProbe.ts) plays scripted messages.
 */
export type ProbeSession = (
  turn: ProbeTurn,
) => Effect.Effect<Stream.Stream<SDKMessage, unknown>, unknown, Scope.Scope>

/**
 * UsageProbe over `session`, its costs recorded in OrganCost: everything a probe does but run its
 * session.
 */
export const probeWith = (
  session: ProbeSession,
): Effect.Effect<UsageProbe["Service"], never, OrganCost> =>
  Effect.gen(function* () {
    const costs = yield* OrganCost

    const played = (limit: string | null) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis
        let result: SDKResultMessage | undefined
        // Its cost is recorded last, after the session is closed and its folder removed.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (result !== undefined) return yield* costs.record(costOf(probeOrgan, result))
            const endedAt = yield* Clock.currentTimeMillis
            yield* costs.recordUnknown({ organ: probeOrgan, durationMs: endedAt - startedAt })
          }),
        )
        const messages = yield* session({ limit, answered: () => result !== undefined })
        const all = yield* Stream.runCollect(
          messages.pipe(
            Stream.takeUntil((m) => m.type === "result"),
            Stream.tap((m) =>
              Effect.sync(() => {
                if (m.type === "result") result = m
              }),
            ),
          ),
        )
        return answerOf(all)
      })

    const probe = (limit: string | null): Effect.Effect<ProbeAnswer> =>
      Effect.scoped(played(limit)).pipe(
        Effect.catch((cause) =>
          Effect.succeed(ProbeAnswer.Unanswered({ reason: messageOf(cause) })),
        ),
        Effect.timeoutOrElse({
          duration: probeTimeout,
          orElse: () =>
            Effect.succeed(
              ProbeAnswer.Unanswered({
                reason: `no answer within ${Duration.format(probeTimeout)}`,
              }),
            ),
        }),
      )
    return UsageProbe.of({ probe: Effect.fn("UsageProbe.probe")(probe) })
  })
