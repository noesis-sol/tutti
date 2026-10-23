// The UsageLimits service (§ 3.3, § 4.12): the account's rate-limit events, as every worker's
// session reports them, the workers waiting for the limit, and whether the usage-limit hold is on.
// AgentHost reports the `rate_limit_info` of each `rate_limit_event` its sessions emit, and each
// worker that becomes UsageLimited or stops being so (makeWorkers); an organ call refused for the
// limit is reported as a rejection (OrganHold, through usageLimit.ts's organHold). The run's hold
// (src/run/usageLimit.ts) reads them and sets the hold, and organ calls are skipped while it is on.
// Every event's `unifiedWindows` gives the account's windows (five-hour, week), which it keeps,
// each at its latest figure, for the title line and their records (src/run/usageWindows.ts).
//
// The live layer keeps them in memory, as the test layer (src/testing/UsageLimits.ts) does; a test
// reports scripted events through it.
import type { SDKMessage, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk"
import {
  Clock,
  Context,
  Effect,
  Layer,
  PubSub,
  Ref,
  Result,
  Schema,
  type Scope,
  Stream,
  SubscriptionRef,
} from "effect"

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

/**
 * The fields of a `rate_limit_info` tutti reads. A CLI of another version may send one without
 * them, or with a status this SDK doesn't name: such an info isn't read.
 */
export const RateLimitInfo = Schema.Struct({
  status: Schema.Literals(["allowed", "allowed_warning", "rejected"]),
  rateLimitType: Schema.optional(Schema.String),
  resetsAt: Schema.optional(Schema.Number),
  utilization: Schema.optional(Schema.Number),
  isUsingOverage: Schema.optional(Schema.Boolean),
})

const decodeInfo = Schema.decodeUnknownResult(RateLimitInfo)

/**
 * The info of a `rate_limit_event` as tutti reads it; undefined for one it can't read, without a
 * status, say: no event, for the reader.
 */
export const rateLimitOf = (info: unknown): RateLimit | undefined => {
  const decoded = decodeInfo(info)
  if (Result.isFailure(decoded)) return undefined
  const read = decoded.success
  return {
    status: read.status,
    limit: read.rateLimitType ?? null,
    resetsAt: read.resetsAt === undefined ? null : epochMillis(read.resetsAt),
    utilization: read.utilization ?? null,
    overage: read.isUsingOverage === true,
  }
}

/**
 * What a turn's messages say of the account's usage limit so far, read one way for a worker's turn
 * (WorkerState), the usage probe's and an organ's.
 */
export interface TurnLimit {
  /** Whether a `rate_limit_event` was read, and whether the last one read was rejected. */
  readonly seen: boolean
  readonly rejected: boolean
  /** The limit the events named and when it resets, in epoch milliseconds: the last said wins. */
  readonly limit: string | null
  readonly resetsAt: number | null
  /** Whether an assistant message carried the `rate_limit` error. */
  readonly rateLimited: boolean
}

/** A turn's limit before any of its messages. */
export const noTurnLimit: TurnLimit = {
  seen: false,
  rejected: false,
  limit: null,
  resetsAt: null,
  rateLimited: false,
}

/** `limit` with `message` read: `limit` itself when the message says nothing of the limit. */
export const turnLimitStep = (limit: TurnLimit, message: SDKMessage): TurnLimit => {
  if (message.type === "rate_limit_event") {
    const info = rateLimitOf(message.rate_limit_info)
    if (info === undefined) return limit
    return {
      ...limit,
      seen: true,
      rejected: info.status === "rejected",
      limit: info.limit ?? limit.limit,
      resetsAt: info.resetsAt ?? limit.resetsAt,
    }
  }
  if (message.type === "assistant" && message.error === "rate_limit" && !limit.rateLimited) {
    return { ...limit, rateLimited: true }
  }
  return limit
}

/** What a turn's `messages` say of the usage limit (`turnLimitStep`, in order). */
export const turnLimit = (messages: ReadonlyArray<SDKMessage>): TurnLimit =>
  messages.reduce(turnLimitStep, noTurnLimit)

/**
 * Whether a turn ended on the usage limit: its result's API error status (`apiStatus`) is 429, its
 * last `rate_limit_event` was rejected, or an assistant message carried the `rate_limit` error.
 */
export const endedOnLimit = (limit: TurnLimit, apiStatus: number | null | undefined): boolean =>
  apiStatus === 429 || limit.rejected || limit.rateLimited

/** A window's figure as one `rate_limit_event` gives it: either part may be left out. */
export interface WindowFigure {
  /** How much of it is used, 0 to 1. */
  readonly utilization?: number
  /** When it resets, in epoch milliseconds. */
  readonly resetsAt?: number
}

/** A finite number at or above 0, or undefined. */
const figure = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The account's windows a `rate_limit_info` carries in `unifiedWindows`, by name (`five_hour`,
 * `seven_day`, …), in the event's order. Claude Code 2.1.301 sends them on every event, `allowed`
 * included, but the SDK's types don't name the field, so it is read defensively: any window name,
 * each part only where it is a number; a window with neither, or a field that isn't an object, is
 * none.
 */
export const windowsOf = (info: unknown): ReadonlyMap<string, WindowFigure> => {
  const all = new Map<string, WindowFigure>()
  if (!isRecord(info) || !isRecord(info.unifiedWindows)) return all
  for (const [name, window] of Object.entries(info.unifiedWindows)) {
    if (name === "" || !isRecord(window)) continue
    const utilization = figure(window.utilization)
    const resetsAt = figure(window.resetsAt)
    if (utilization === undefined && resetsAt === undefined) continue
    all.set(name, {
      ...(utilization === undefined ? {} : { utilization }),
      ...(resetsAt === undefined ? {} : { resetsAt: epochMillis(resetsAt) }),
    })
  }
  return all
}

/** One of the account's windows, as the latest event that gave a figure for it says. */
export interface AccountWindow {
  /** How much of it is used, 0 to 1; null while no event has said. */
  readonly utilization: number | null
  /** When it resets, in epoch milliseconds; null while no event has said. */
  readonly resetsAt: number | null
  /** When an event last gave a figure for it, in epoch milliseconds. */
  readonly at: number
}

/** The account's windows by name, in the order they were first reported. */
export type Windows = ReadonlyMap<string, AccountWindow>

/** `windows` with the figures one event gave at `now`: a part it leaves out is kept. */
export const withFigures = (
  windows: Windows,
  figures: ReadonlyMap<string, WindowFigure>,
  now: number,
): Windows => {
  if (figures.size === 0) return windows
  const next = new Map(windows)
  for (const [name, given] of figures) {
    const before = windows.get(name)
    next.set(name, {
      utilization: given.utilization ?? before?.utilization ?? null,
      resetsAt: given.resetsAt ?? before?.resetsAt ?? null,
      at: now,
    })
  }
  return next
}

/** An organ call refused for the limit: which limit and when it resets, null when unknown. */
export interface Refusal {
  readonly limit: string | null
  /** Epoch milliseconds. */
  readonly resetsAt: number | null
}

/** A refusal as the rejection the hold reads it as. */
export const refusalOf = (refusal: Refusal): RateLimit => ({
  status: "rejected",
  limit: refusal.limit,
  resetsAt: refusal.resetsAt,
  utilization: null,
  overage: false,
})

/** The workers whose turn ended on the limit (UsageLimited), by ticket: when it resets, if known. */
export type Waiting = ReadonlyMap<string, number | null>

export class UsageLimits extends Context.Service<
  UsageLimits,
  {
    /** A worker's session emitted a `rate_limit_event` with this info; one it can't read is none. */
    report(info: SDKRateLimitInfo): Effect.Effect<void>
    /** An organ's call was refused for the limit: a rejection, among the events. */
    refused(refusal: Refusal): Effect.Effect<void>
    /** The events reported from now on, for the rest of the scope. */
    readonly subscribe: Effect.Effect<Stream.Stream<RateLimit>, never, Scope.Scope>
    /**
     * The account's windows, each with the latest figure reported for it, from any event's
     * `unifiedWindows`: now, then on each report that gives one.
     */
    readonly windows: Stream.Stream<Windows>
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
  const windows = yield* SubscriptionRef.make<Windows>(new Map())
  return UsageLimits.of({
    // The windows are read apart from the rest: an info this SDK can't read may still carry them.
    report: (info) =>
      Effect.gen(function* () {
        const figures = windowsOf(info)
        if (figures.size > 0) {
          const now = yield* Clock.currentTimeMillis
          yield* SubscriptionRef.update(windows, (all) => withFigures(all, figures, now))
        }
        const read = rateLimitOf(info)
        if (read !== undefined) yield* PubSub.publish(events, read)
      }),
    refused: (refusal) => Effect.asVoid(PubSub.publish(events, refusalOf(refusal))),
    subscribe: Effect.map(PubSub.subscribe(events), Stream.fromSubscription),
    windows: SubscriptionRef.changes(windows),
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
