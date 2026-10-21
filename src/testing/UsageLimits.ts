// UsageLimits' test layer (§ 3.3): the live layer's memory, with scripted events. The scripted
// AgentHost reports the rate_limit_events its scripts emit, as the live host does; a test can also
// report events of its own with `scripted`, and read back every event reported with Reported, an
// organ's refusal among them.
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk"
import { Context, Effect, Layer, Ref } from "effect"
import { make, type RateLimit, rateLimitOf, refusalOf, UsageLimits } from "../agent/UsageLimits.ts"

/** The events the test layer was reported, for a test to look at. */
export class Reported extends Context.Service<
  Reported,
  {
    /** Every event so far, in order. */
    readonly events: Effect.Effect<ReadonlyArray<RateLimit>>
  }
>()("tutti/testing/UsageLimits/Reported") {}

/** A UsageLimits in memory, and Reported, to read what it was reported. */
export const layer: Layer.Layer<UsageLimits | Reported> = Layer.effectContext(
  Effect.gen(function* () {
    const usage = yield* make
    const events = yield* Ref.make<ReadonlyArray<RateLimit>>([])
    const recording = UsageLimits.of({
      ...usage,
      report: (info) =>
        Effect.andThen(
          Ref.update(events, (all) => [...all, rateLimitOf(info)]),
          usage.report(info),
        ),
      refused: (refusal) =>
        Effect.andThen(
          Ref.update(events, (all) => [...all, refusalOf(refusal)]),
          usage.refused(refusal),
        ),
    })
    return Context.make(UsageLimits, recording).pipe(
      Context.add(Reported, Reported.of({ events: Ref.get(events) })),
    )
  }),
)

/** Reports `events`, in order, as workers' sessions would. */
export const scripted = (
  events: ReadonlyArray<SDKRateLimitInfo>,
): Effect.Effect<void, never, UsageLimits> =>
  Effect.gen(function* () {
    const usage = yield* UsageLimits
    yield* Effect.forEach(events, (info) => usage.report(info), { discard: true })
  })
