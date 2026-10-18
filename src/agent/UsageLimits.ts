// The UsageLimits service (§ 3.3, § 4.12): the account's rate-limit events, as every worker's
// session reports them, the workers waiting for the limit, and whether the usage-limit hold is on.
// AgentHost reports the `rate_limit_info` of each `rate_limit_event` its sessions emit, and each
// worker that becomes UsageLimited or stops being so (makeWorkers); the run's hold
// (src/run/usageLimit.ts) reads them and sets the hold, and organ calls are skipped while it is on
// (OrganHold, through usageLimit.ts's organHold).
//
// The live layer keeps them in memory, as the test layer (src/testing/UsageLimits.ts) does; a test
// reports scripted events through it.
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk"
import { Context, Effect, Layer, PubSub, Ref, type Scope, Stream, SubscriptionRef } from "effect"

/** A `rate_limit_event`'s status. */
export type LimitStatus = SDKRateLimitInfo["status"]

/** A `rate_limit_event`'s `rate_limit_info`, as tutti reads it. */
export interface RateLimit {
  readonly status: LimitStatus
  /** The SDK's `rateLimitType`: `five_hour`, `seven_day`, …; null when the event doesn't say. */
  readonly limit: string | null
  /** When it resets, in epoch milliseconds; null when the event doesn't say. */
  readonly resetsAt: number | null
  /** How much of it is used, 0 to 1; null when the event doesn't say. */
  readonly utilization: number | null
  /** Whether overage is in use (`isUsingOverage`). */
  readonly overage: boolean
}

// resetsAt is in seconds since the epoch, as the API's reset header is; a value already in
// milliseconds is kept, as WorkerState reads it.
const epochMillis = (at: number): number => (at < 1e12 ? at * 1000 : at)

/** The info of a `rate_limit_event` as tutti reads it. */
export const rateLimitOf = (info: SDKRateLimitInfo): RateLimit => ({
  status: info.status,
  limit: info.rateLimitType ?? null,
  resetsAt: info.resetsAt === undefined ? null : epochMillis(info.resetsAt),
  utilization: info.utilization ?? null,
  overage: info.isUsingOverage === true,
})

/** The workers whose turn ended on the limit (UsageLimited), by ticket: when it resets, if known. */
export type Waiting = ReadonlyMap<string, number | null>

export class UsageLimits extends Context.Service<
  UsageLimits,
  {
    /** A worker's session emitted a `rate_limit_event` with this info. */
    report(info: SDKRateLimitInfo): Effect.Effect<void>
    /** The events reported from now on, for the rest of the scope. */
    readonly subscribe: Effect.Effect<Stream.Stream<RateLimit>, never, Scope.Scope>
    /**
     * The ticket's worker is UsageLimited until `resetsAt` (epoch milliseconds, null when
     * unknown), or, with undefined, no longer is: AgentHost says so as its state changes.
     */
    limited(ticket: string, resetsAt: number | null | undefined): Effect.Effect<void>
    /** The workers waiting for the limit: now, then on each change. */
    readonly waiting: Stream.Stream<Waiting>
    /** Whether the usage-limit hold is on. */
    readonly held: Effect.Effect<boolean>
    /** Puts the hold on or lifts it: the run's hold does (src/run/usageLimit.ts). */
    hold(on: boolean): Effect.Effect<void>
  }
>()("tutti/agent/UsageLimits") {
  static readonly layer: Layer.Layer<UsageLimits> = Layer.effect(
    UsageLimits,
    Effect.suspend(() => make),
  )
}

/** UsageLimits in memory: what the live layer and the test layer both are. */
export const make: Effect.Effect<UsageLimits["Service"]> = Effect.gen(function* () {
  const events = yield* PubSub.unbounded<RateLimit>()
  const held = yield* Ref.make(false)
  const waiting = yield* SubscriptionRef.make<Waiting>(new Map())
  return UsageLimits.of({
    report: (info) => Effect.asVoid(PubSub.publish(events, rateLimitOf(info))),
    subscribe: Effect.map(PubSub.subscribe(events), Stream.fromSubscription),
    limited: (ticket, resetsAt) =>
      SubscriptionRef.update(waiting, (all) => {
        if (resetsAt === undefined && !all.has(ticket)) return all
        const next = new Map(all)
        if (resetsAt === undefined) next.delete(ticket)
        else next.set(ticket, resetsAt)
        return next
      }),
    waiting: SubscriptionRef.changes(waiting),
    held: Ref.get(held),
    hold: (on) => Ref.set(held, on),
  })
})
