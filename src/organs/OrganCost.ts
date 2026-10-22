// OrganCost (§ 6.1): what each organ call cost. effect/ai's responses carry usage but not cost, so
// the provider (AgentSdkLanguageModel) records each call's last SDK result here as it arrives,
// whatever happens to the answer after: `ORGAN triage: $0.0123 in 1 turn, 4.2s` in the log, and
// the run's total, for the end of the report. In a single-call session the last result's total is
// the call's. A call that ends without a result (timed out, or its session failed first) spent
// tokens no result reports: it is recorded as a call of unknown cost, with the time it ran. So is
// a call that answered through a provider that reports no price (AnthropicProvider's).
import { Context, Effect, Layer, Option, Ref } from "effect"
import { EventStream } from "../run/eventstream.ts"
import { type Line, Log, line, Tag } from "../run/log.ts"

/** One organ call's cost, from its session's last result. */
export interface Cost {
  /** The organ that made the call: `triage`. */
  readonly organ: string
  /** The ticket the call was about, if it was about one. */
  readonly ticket?: string
  /** The result's total_cost_usd. */
  readonly costUsd: number
  /** The result's num_turns. */
  readonly turns: number
  /** The result's duration_ms. */
  readonly durationMs: number
  /** The call's SDK session. */
  readonly sessionId: string
  /** The result's subtype where it isn't a success: `error_max_turns`. */
  readonly subtype?: string
}

/** One organ call that ended without a result, or whose provider reports no price. */
export interface UnknownCost {
  /** The organ that made the call: `triage`. */
  readonly organ: string
  /** The ticket the call was about, if it was about one. */
  readonly ticket?: string
  /** How long the call ran. */
  readonly durationMs: number
  /** The call answered, but its provider reports no price; absent when it ended with no result. */
  readonly unpriced?: true
}

/** The run's organ calls, added up. */
export interface Total {
  /** Every call, those of unknown cost included. */
  readonly calls: number
  readonly costUsd: number
  readonly turns: number
  readonly durationMs: number
  /** The calls that ended without a result, whose cost the total leaves out. */
  readonly unknown: number
  /** The calls whose result wasn't a success. */
  readonly failed: number
}

export const noCost: Total = {
  calls: 0,
  costUsd: 0,
  turns: 0,
  durationMs: 0,
  unknown: 0,
  failed: 0,
}

/** A cost in dollars, to the hundredth of a cent: `$0.0123`. */
export const dollars = (usd: number): string => `$${usd.toFixed(4)}`

/** A duration in seconds, to a tenth: `4.2s`. */
export const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

/** The log line of a call: `ORGAN triage: $0.0123 in 1 turn, 4.2s`. */
export const costLine = (cost: Cost): Line =>
  `${Tag.organ} ${line`${cost.organ}: ${dollars(cost.costUsd)} in ${cost.turns} ${cost.turns === 1 ? "turn" : "turns"}, ${seconds(cost.durationMs)}`}` as Line

/**
 * The log line of a call of unknown cost: `ORGAN triage: cost unknown, no result after 180.0s`, or
 * `ORGAN triage: cost unknown, no price reported, 4.2s` for one that answered.
 */
export const unknownCostLine = (cost: UnknownCost): Line =>
  cost.unpriced === true
    ? (`${Tag.organ} ${line`${cost.organ}: cost unknown, no price reported, ${seconds(cost.durationMs)}`}` as Line)
    : (`${Tag.organ} ${line`${cost.organ}: cost unknown, no result after ${seconds(cost.durationMs)}`}` as Line)

/** `cost` added to `total`. */
export const add = (total: Total, cost: Cost): Total => ({
  ...total,
  calls: total.calls + 1,
  costUsd: total.costUsd + cost.costUsd,
  turns: total.turns + cost.turns,
  durationMs: total.durationMs + cost.durationMs,
  failed: total.failed + (cost.subtype === undefined ? 0 : 1),
})

/** A call of unknown cost added to `total`: a call, its time, and nothing else. */
export const addUnknown = (total: Total, cost: UnknownCost): Total => ({
  ...total,
  calls: total.calls + 1,
  durationMs: total.durationMs + cost.durationMs,
  unknown: total.unknown + 1,
})

/** The `organ` record of a call (§ 10). */
const organRecord = (cost: Cost | UnknownCost) => ({
  kind: "organ" as const,
  organ: cost.organ,
  ...(cost.ticket === undefined ? {} : { ticket: cost.ticket }),
  ...("costUsd" in cost
    ? {
        outcome: "answered" as const,
        cost_usd: cost.costUsd,
        turns: cost.turns,
        session: cost.sessionId,
      }
    : { outcome: cost.unpriced === true ? ("unpriced" as const) : ("no_result" as const) }),
  duration_ms: Math.max(0, Math.round(cost.durationMs)),
})

export class OrganCost extends Context.Service<
  OrganCost,
  {
    /** Logs the call's cost line, writes its `organ` record and adds it to the run's total. */
    record(cost: Cost): Effect.Effect<void>
    /**
     * Logs the line of a call that ended without a result, or with no price, writes its `organ`
     * record and adds it to the run's total.
     */
    recordUnknown(cost: UnknownCost): Effect.Effect<void>
    /** The run's total so far. */
    readonly total: Effect.Effect<Total>
  }
>()("tutti/organs/OrganCost") {
  /**
   * The run's organ costs, logged to its Log and written to its EventStream, where there is one,
   * the total kept in memory.
   */
  static readonly layer: Layer.Layer<OrganCost, never, Log> = Layer.effect(
    OrganCost,
    Effect.gen(function* () {
      const log = yield* Log
      const events = yield* Effect.serviceOption(EventStream)
      const total = yield* Ref.make(noCost)
      const emit = (cost: Cost | UnknownCost) =>
        Option.isSome(events) ? events.value.emit(organRecord(cost)) : Effect.void
      return OrganCost.of({
        record: (cost) =>
          Effect.gen(function* () {
            yield* Ref.update(total, (sum) => add(sum, cost))
            yield* log.writeWith([costLine(cost)], emit(cost))
          }),
        recordUnknown: (cost) =>
          Effect.gen(function* () {
            yield* Ref.update(total, (sum) => addUnknown(sum, cost))
            yield* log.writeWith([unknownCostLine(cost)], emit(cost))
          }),
        total: Ref.get(total),
      })
    }),
  )
}
