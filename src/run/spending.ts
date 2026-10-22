// Spending (§ 10): what the workers' turns cost and used, from the SDK's own result messages. Each
// result gives a `turn` record, and is added to its ticket's sums and the run's, which the records
// that end a ticket's part in the run (ledger.ts) and the run's `end` record give.
//
// A result's total_cost_usd and modelUsage are running totals, not the turn's own: the SDK (0.3.x,
// sdk.d.ts) documents them as cumulative across a query()'s turns, and a resumed session as going
// on from the totals its transcript saved; the live contract test (test/contract/sdk.test.ts)
// checks the first. So each session keeps the totals of its last result, and a turn's share is
// the difference. A total lower than the last means it started again from 0 (a /clear, or a resume
// whose transcript saved none): the turn's share is then the whole. A zeroed result, as a crash
// gives, is a turn that spent nothing and leaves the session's totals as they were. num_turns,
// duration_ms and duration_api_ms are the turn's own.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Context, Effect, Layer, Option, Ref } from "effect"
import { noCost, OrganCost } from "../organs/OrganCost.ts"
import type { Event, Tokens, TokensByModel } from "./events.ts"
import { EventStream } from "./eventstream.ts"

/** What turns spent, added up. */
export interface Spent {
  /** Their cost in dollars, as the SDK estimates it. */
  readonly costUsd: number
  /** Their model round-trips: the results' num_turns. */
  readonly turns: number
  /** Their results. */
  readonly results: number
  readonly tokens: TokensByModel
}

export const nothingSpent: Spent = { costUsd: 0, turns: 0, results: 0, tokens: {} }

/** A session's running totals, as its last result gave them. */
export interface Totals {
  readonly costUsd: number
  readonly tokens: TokensByModel
}

const noTokens: Tokens = { input: 0, output: 0, cache_write: 0, cache_read: 0 }

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0

const whole = (value: unknown): number => Math.round(count(value))

// A model's usage in a result's modelUsage, as given: nothing of it is trusted to be a count.
interface UsageFields {
  readonly inputTokens?: unknown
  readonly outputTokens?: unknown
  readonly cacheCreationInputTokens?: unknown
  readonly cacheReadInputTokens?: unknown
}

// The fields of a result Spending reads, as given.
interface ResultFields {
  readonly subtype?: unknown
  readonly is_error?: unknown
  readonly total_cost_usd?: unknown
  readonly modelUsage?: unknown
  readonly num_turns?: unknown
  readonly duration_ms?: unknown
  readonly duration_api_ms?: unknown
}

/** A result's modelUsage as tokens by model; what isn't a count is 0. */
export const tokensOf = (modelUsage: unknown): TokensByModel => {
  if (typeof modelUsage !== "object" || modelUsage === null) return {}
  const tokens: Record<string, Tokens> = {}
  for (const [model, usage] of Object.entries(modelUsage)) {
    const u = (typeof usage === "object" && usage !== null ? usage : {}) as UsageFields
    tokens[model] = {
      input: whole(u["inputTokens"]),
      output: whole(u["outputTokens"]),
      cache_write: whole(u["cacheCreationInputTokens"]),
      cache_read: whole(u["cacheReadInputTokens"]),
    }
  }
  return tokens
}

/** `a` and `b` added up, model by model. */
export const addTokens = (a: TokensByModel, b: TokensByModel): TokensByModel => {
  const sum: Record<string, Tokens> = { ...a }
  for (const [model, t] of Object.entries(b)) {
    const s = sum[model] ?? noTokens
    sum[model] = {
      input: s.input + t.input,
      output: s.output + t.output,
      cache_write: s.cache_write + t.cache_write,
      cache_read: s.cache_read + t.cache_read,
    }
  }
  return sum
}

const fields = ["input", "output", "cache_write", "cache_read"] as const

// Whether `now` goes on from `before`: no total lower than it was.
const goesOn = (before: Totals, now: Totals): boolean =>
  now.costUsd >= before.costUsd &&
  Object.entries(before.tokens).every(([model, b]) => {
    const n = now.tokens[model] ?? noTokens
    return fields.every((field) => n[field] >= b[field])
  })

/** `now`'s share over `before`, model by model; models with nothing left out. */
const less = (now: TokensByModel, before: TokensByModel): TokensByModel => {
  const share: Record<string, Tokens> = {}
  for (const [model, n] of Object.entries(now)) {
    const b = before[model] ?? noTokens
    const t: Tokens = {
      input: n.input - b.input,
      output: n.output - b.output,
      cache_write: n.cache_write - b.cache_write,
      cache_read: n.cache_read - b.cache_read,
    }
    if (fields.some((field) => t[field] > 0)) share[model] = t
  }
  return share
}

/**
 * A turn's share of the session's running totals `now`, given those of its last result, `before`:
 * the difference, or the whole of `now` when it is lower than `before` in anything (it started
 * again from 0) or there was no `before`.
 */
export const shareOf = (before: Totals | undefined, now: Totals): Totals =>
  before === undefined || !goesOn(before, now)
    ? { costUsd: now.costUsd, tokens: less(now.tokens, {}) }
    : {
        costUsd: Math.max(0, now.costUsd - before.costUsd),
        tokens: less(now.tokens, before.tokens),
      }

/** Whether `totals` are a zeroed result's: nothing at all. */
const zeroed = (totals: Totals): boolean =>
  totals.costUsd === 0 &&
  Object.values(totals.tokens).every((t) => fields.every((field) => t[field] === 0))

/** `spent` with a turn of `share`, `turns` round-trips, added. */
export const addSpent = (spent: Spent, share: Totals, turns: number): Spent => ({
  costUsd: spent.costUsd + share.costUsd,
  turns: spent.turns + turns,
  results: spent.results + 1,
  tokens: addTokens(spent.tokens, share.tokens),
})

export class Spending extends Context.Service<
  Spending,
  {
    /**
     * A message of the ticket's worker's session `session`: a result is written as a `turn`
     * record, with its share of the session's totals, and added to the ticket's and the run's sums.
     * Any other message is nothing to it.
     */
    message(ticket: string, session: string, message: SDKMessage): Effect.Effect<void>
    /** What the ticket's workers' turns spent in the run so far. */
    ofTicket(ticket: string): Effect.Effect<Spent>
    /** What every worker's turns spent in the run so far. */
    readonly total: Effect.Effect<Spent>
  }
>()("tutti/run/Spending") {
  /** The run's spending, its turn records written to the EventStream, its sums in memory. */
  static readonly layer: Layer.Layer<Spending, never, EventStream> = Layer.effect(
    Spending,
    Effect.gen(function* () {
      const events = yield* EventStream
      const state = yield* Ref.make<{
        readonly sessions: ReadonlyMap<string, Totals>
        readonly tickets: ReadonlyMap<string, Spent>
        readonly total: Spent
      }>({ sessions: new Map(), tickets: new Map(), total: nothingSpent })

      const message = (ticket: string, session: string, message: SDKMessage) =>
        Effect.gen(function* () {
          if (message.type !== "result") return
          const r = message as unknown as ResultFields
          const now: Totals = {
            costUsd: count(r["total_cost_usd"]),
            tokens: tokensOf(r["modelUsage"]),
          }
          const turns = whole(r["num_turns"])
          const share = yield* Ref.modify(state, (s) => {
            const share = shareOf(s.sessions.get(session), now)
            const sessions = zeroed(now) ? s.sessions : new Map(s.sessions).set(session, now)
            const tickets = new Map(s.tickets).set(
              ticket,
              addSpent(s.tickets.get(ticket) ?? nothingSpent, share, turns),
            )
            return [share, { sessions, tickets, total: addSpent(s.total, share, turns) }]
          })
          yield* events.emit({
            kind: "turn",
            ticket,
            session,
            subtype: typeof r["subtype"] === "string" ? r["subtype"] : "unknown",
            ...(r["is_error"] === true ? { is_error: true as const } : {}),
            cost_usd: share.costUsd,
            turns,
            duration_ms: whole(r["duration_ms"]),
            api_ms: whole(r["duration_api_ms"]),
            ...(Object.keys(share.tokens).length === 0 ? {} : { tokens: share.tokens }),
          })
        })

      return Spending.of({
        message,
        ofTicket: (ticket) =>
          Effect.map(Ref.get(state), (s) => s.tickets.get(ticket) ?? nothingSpent),
        total: Effect.map(Ref.get(state), (s) => s.total),
      })
    }),
  )
}

/**
 * The run's `end` record, `code` its exit code, with the run's totals (§ 10): its workers' `tokens`
 * and `cost_usd`, from Spending, and its `organs`' calls, from OrganCost, each left out when there
 * is none, or no such service.
 */
export const endRecord = (code: number): Effect.Effect<Event> =>
  Effect.gen(function* () {
    const spending = yield* Effect.serviceOption(Spending)
    const organs = yield* Effect.serviceOption(OrganCost)
    const spent = Option.isSome(spending) ? yield* spending.value.total : nothingSpent
    const called = Option.isSome(organs) ? yield* organs.value.total : noCost
    return {
      kind: "end",
      code,
      ...(Object.keys(spent.tokens).length === 0 ? {} : { tokens: spent.tokens }),
      ...(spent.results === 0 ? {} : { cost_usd: spent.costUsd }),
      ...(called.calls === 0
        ? {}
        : { organs: { calls: called.calls, turns: called.turns, cost_usd: called.costUsd } }),
    }
  })
