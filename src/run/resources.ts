// What a worker consumes (§ 7.5's resource line, worker-view design D2): its time on the ticket,
// its tokens and dollars (Spending's sums), how full its context window is (the host's reading
// after each finished turn), its compactions (the ledger's tallies), and on a subscription login
// its ticket's estimated share of the account's five-hour window.
//
// Claude Code reports the account's windows, not a session's: so the share is an estimate, the
// window's rise over the run (usageWindows.ts riseStep) shared among the run's workers in proportion
// to each one's API-equivalent dollars, which weigh the model and the cache's reads roughly as the
// limits do. It overstates while the account is used beside the run, which tutti can't see.
import type { ContextUsage } from "../agent/contextUsage.ts"
import type { TicketId } from "../services/Beads.ts"
import type { TokensByModel } from "./events.ts"
// Types alone from spending.ts: the UI reads this module, and Spending's needs the EventStream's.
import type { Spent, Sums } from "./spending.ts"

/** Nothing spent: a ticket whose worker has had no result yet. */
const nothing: Spent = { costUsd: 0, turns: 0, results: 0, tokens: {} }

/** The sums before any result. */
export const noSums: Sums = { tickets: new Map(), total: nothing }

/** A ticket's estimated share of the five-hour window, and what it is made from. */
export interface WindowShare {
  /** Its share, 0 to 1 of the window. */
  readonly share: number
  /** How much the window rose over the run, 0 to 1. */
  readonly rise: number
  /** The ticket's dollars at API prices, and every worker's in the run. */
  readonly cost: number
  readonly runCost: number
}

/** What a ticket's worker consumes, for its view's resource line and its breakdown. */
export interface Resources {
  readonly ticket: TicketId
  /** When the run took the ticket up, in epoch milliseconds: its worker's time counts from then. */
  readonly took: number
  /** What its workers' turns spent in the run. */
  readonly spent: Spent
  /** Every worker's tokens in the run, for the ticket's share of them. */
  readonly runTokens: number
  /** Workers bill a subscription login: the dollars are an API-price estimate (§ 4.13). */
  readonly subscription: boolean
  /** On a subscription, its share of the five-hour window, once the run has heard the window. */
  readonly window: WindowShare | null
  /** How full its worker's context window is, once its session has said. */
  readonly context: ContextUsage | null
  /** Its worker's compactions in the run. */
  readonly compactions: number
}

/** Every token of `tokens`, of every model: input, cache writes, cache reads and output. */
export const allTokens = (tokens: TokensByModel): number =>
  Object.values(tokens).reduce(
    (sum, t) => sum + t.input + t.output + t.cache_write + t.cache_read,
    0,
  )

/**
 * A ticket's share of the five-hour window that rose `rise` over the run (null: not heard yet), its
 * workers' dollars `cost` of the run's `runCost`: the rise in proportion to the dollars, none while
 * nothing has been spent.
 */
export const windowShare = (
  rise: number | null,
  cost: number,
  runCost: number,
): WindowShare | null =>
  rise === null
    ? null
    : {
        share: runCost > 0 ? (Math.max(rise, 0) * Math.min(cost, runCost)) / runCost : 0,
        rise,
        cost,
        runCost,
      }

/** What `resourcesOf` reads, for one ticket. */
export interface ResourceInputs {
  readonly ticket: TicketId
  readonly took: number
  readonly compactions: number
  readonly sums: Sums
  readonly subscription: boolean
  readonly rise: number | null
  readonly context: ContextUsage | undefined
}

/** A ticket's resources from the run's figures. */
export const resourcesOf = (inputs: ResourceInputs): Resources => {
  const spent = inputs.sums.tickets.get(inputs.ticket)
  const cost = spent?.costUsd ?? 0
  return {
    ticket: inputs.ticket,
    took: inputs.took,
    spent: spent ?? nothing,
    runTokens: allTokens(inputs.sums.total.tokens),
    subscription: inputs.subscription,
    window: inputs.subscription ? windowShare(inputs.rise, cost, inputs.sums.total.costUsd) : null,
    context: inputs.context ?? null,
    compactions: inputs.compactions,
  }
}
