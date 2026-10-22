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
import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import { Clock, Context, Data, Duration, Effect, FileSystem, Layer, Stream } from "effect"
import { AppConfig } from "../cli/AppConfig.ts"
import { costOf, organOptions } from "../organs/AgentSdkLanguageModel.ts"
import { OrganCost } from "../organs/OrganCost.ts"
import type { AccountProbe } from "./Account.ts"
import { queryThrew } from "./claudeBinary.ts"
import { workerEnv } from "./env.ts"
import { rateLimitOf } from "./UsageLimits.ts"

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
  let rejected = false
  let allowed = false
  let limit: string | null = null
  let resetsAt: number | null = null
  let rateLimited = false
  for (const m of messages) {
    if (m.type === "rate_limit_event") {
      const info = rateLimitOf(m.rate_limit_info)
      rejected = info.status === "rejected"
      allowed = !rejected
      if (rejected) {
        limit = info.limit ?? limit
        resetsAt = info.resetsAt ?? resetsAt
      }
    } else if (m.type === "assistant" && m.error === "rate_limit") {
      rateLimited = true
    }
  }
  const result = messages.findLast((m): m is SDKResultMessage => m.type === "result")
  const status =
    result?.is_error === true && result.subtype === "success" ? result.api_error_status : undefined
  if (rejected || rateLimited || status === 429) return ProbeAnswer.Refused({ limit, resetsAt })
  if ((result !== undefined && !result.is_error) || allowed) return ProbeAnswer.Allowed()
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

/** What the live layer takes beside its services. */
export interface LiveOptions {
  /** What the account probe found: whether there's a subscription login (§ 4.13). */
  readonly account: Pick<AccountProbe, "subscription">
  /** tutti's environment, the probe's is made from; process.env by default. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

export class UsageProbe extends Context.Service<
  UsageProbe,
  {
    /** Asks the account whether the held limit `limit` (null when the hold names none) refuses. */
    probe(limit: string | null): Effect.Effect<ProbeAnswer>
  }
>()("tutti/agent/UsageProbe") {
  /** The layer over `open`, the SDK's query(): the live layer's is the Agent SDK's. */
  static readonly layerWith = (
    open: typeof query,
    options: LiveOptions,
  ): Layer.Layer<UsageProbe, never, AppConfig | OrganCost | FileSystem.FileSystem> =>
    Layer.effect(
      UsageProbe,
      Effect.gen(function* () {
        const config = yield* AppConfig
        const costs = yield* OrganCost
        const fs = yield* FileSystem.FileSystem
        const env = workerEnv({
          subscription: options.account.subscription,
          billing: config.billing,
          ...(options.env === undefined ? {} : { env: options.env }),
        })

        const session = (limit: string | null) =>
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
            const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "tutti-usage-probe-" })
            const abortController = new AbortController()
            let stderr = ""
            const q = yield* Effect.acquireRelease(
              Effect.try({
                try: () =>
                  open({
                    prompt: (async function* () {
                      yield {
                        type: "user" as const,
                        message: { role: "user" as const, content: probeMessage },
                        parent_tool_use_id: null,
                      }
                    })(),
                    options: {
                      ...organOptions({
                        turn: { systemPrompt: probeSystemPrompt, userText: [probeMessage] },
                        jsonSchema: undefined,
                        call: { organ: probeOrgan, model: probeModel(limit) },
                        cwd,
                        env,
                        claude: config.claude,
                        abortController,
                        partial: false,
                        stderr: (data) => {
                          stderr = (stderr + data).slice(-stderrLimit)
                        },
                      }),
                      maxTurns: 1,
                    },
                  }),
                catch: queryThrew,
              }),
              (q) =>
                Effect.sync(() => {
                  if (result === undefined) abortController.abort()
                  q.close()
                }),
            )
            const failed = (cause: unknown) => {
              const said = stderr.trim()
              return said === "" ? messageOf(cause) : `${messageOf(cause)}: ${said}`
            }
            const all = yield* Stream.runCollect(
              Stream.fromAsyncIterable(q, failed).pipe(
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
          Effect.scoped(session(limit)).pipe(
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
        return UsageProbe.of({ probe })
      }),
    )

  /** The live layer, over the Agent SDK. */
  static readonly layer = (options: LiveOptions) => UsageProbe.layerWith(query, options)
}
