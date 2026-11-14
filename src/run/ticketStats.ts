// What the run knows of how a ticket went, for its row's box (§ 7.2, tutti-149z.9): the scorecard
// its ticket_end was followed by (scorecard.ts), with the follow-ups and audits that came after;
// for a ticket whose part hasn't ended, the same figures so far, from the run's scoring and its
// ledger entry. Spending gives the turns and tokens, which a scorecard doesn't hold. A worker files
// tickets and writes why it stopped, so what the texts say is sanitised here, as it enters RunView.
//
// The median a figure is set against is the run's as it is now, of the other tickets scored of a
// size like this one's (peerMedian), rather than the scorecard's, kept from as its ticket ended, as
// that has no turns or tokens and a ticket that ended first would have none. The box works it out
// as it is drawn, so that the view doesn't for every row at each look.

import type { Spent, Sums } from "../services/Spending.ts"
import {
  median,
  type Score,
  type ScoreAudit,
  type Scoring,
  sizeClass,
  tallyOf,
  verifierOf,
} from "../services/scorecard.ts"
import { sanitizeLine } from "../text/sanitize.ts"
import type { Entry } from "./ledger.ts"
import { factsOf, type PhaseSeconds, type TicketOutcome } from "./phase.ts"
import { allTokens } from "./resources.ts"

/** A ticket's figures, as its row's box shows them. Times are seconds but those said to be times. */
export interface TicketStats {
  /** How its part in the run ended, as its scorecard says; null while it goes on. */
  readonly outcome: TicketOutcome | null
  readonly why: string | null
  /** When the run took it up, epoch milliseconds; null before. */
  readonly took: number | null
  /** From then until its part ended; null while it goes on. */
  readonly seconds: number | null
  /** While it goes on, the phase its time is counting in, from its row's `since`, not yet below. */
  readonly counting: PhaseSeconds | null
  readonly verifier: Score["verifier"]
  readonly handBacks: Score["hand_backs"]
  readonly resolving: number
  readonly fixing: number
  readonly working: number
  readonly checks: Score["checks"]
  readonly flaky: number
  readonly denied: number
  readonly asked: number
  readonly turns: number
  readonly tokens: number
  /** Its dollars; null before its worker has spent any. */
  readonly costUsd: number | null
  /** Workers bill a subscription login: the dollars are an API-price estimate (§ 4.13). */
  readonly estimated: boolean
  /** The files its footprint named; null when its dispatch didn't say. */
  readonly size: number | null
  readonly followUps: ReadonlyArray<string>
  readonly reverts: ReadonlyArray<string>
  readonly audit: ScoreAudit | null
}

/** The figures of a ticket nothing is known of yet. */
export const noStats: TicketStats = {
  outcome: null,
  why: null,
  took: null,
  seconds: null,
  counting: null,
  verifier: { rounds: 0, passed: 0, failed: 0 },
  handBacks: { resolve: 0, fix: 0 },
  resolving: 0,
  fixing: 0,
  working: 0,
  checks: { failed: 0, timed_out: 0 },
  flaky: 0,
  denied: 0,
  asked: 0,
  turns: 0,
  tokens: 0,
  costUsd: null,
  estimated: false,
  size: null,
  followUps: [],
  reverts: [],
  audit: null,
}

const cost = (spent: Spent | undefined): number | null =>
  spent === undefined || spent.costUsd <= 0 ? null : spent.costUsd

/** What a ticket's workers' turns spent, as a count of each. */
const spentFields = (spent: Spent | undefined) => ({
  turns: spent?.turns ?? 0,
  tokens: spent === undefined ? 0 : allTokens(spent.tokens),
})

/**
 * The figures of `entry`: its scorecard once its part in the run has ended, what the run's records
 * say so far before that, or once it has come back after one, or where it has none yet.
 */
export const statsOf = (
  entry: Entry,
  scoring: Scoring,
  sums: Sums,
  estimated: boolean,
): TicketStats => {
  const facts = factsOf(entry.phase)
  const ended = !facts.inQueue && facts.ends(entry.phase) !== null
  const score = ended ? scoring.scores.get(entry.ticket) : undefined
  const spent = sums.tickets.get(entry.ticket)
  const took = entry.account?.took ?? null
  if (score !== undefined) {
    return {
      outcome: score.outcome,
      why: score.why === undefined ? null : sanitizeLine(score.why),
      took,
      seconds: score.seconds,
      counting: null,
      verifier: score.verifier,
      handBacks: score.hand_backs,
      resolving: score.resolving,
      fixing: score.fixing,
      working: score.working,
      checks: score.checks,
      flaky: score.flaky,
      denied: score.denied,
      asked: score.asked,
      ...spentFields(spent),
      costUsd: score.cost_usd ?? cost(spent),
      estimated,
      size: score.size ?? null,
      followUps: (score.follow_ups ?? []).map(sanitizeLine),
      reverts: (score.reverts ?? []).map(sanitizeLine),
      audit: score.audit ?? null,
    }
  }
  const t = tallyOf(scoring, entry.ticket)
  const spentIn = entry.account?.spentIn ?? {}
  const secondsIn = (phase: PhaseSeconds) => (spentIn[phase] ?? 0) / 1000
  return {
    outcome: ended ? facts.ends(entry.phase) : null,
    why: null,
    took,
    seconds: null,
    counting: ended ? null : facts.spentIn,
    verifier: verifierOf(t),
    handBacks: entry.account?.handBacks ?? { resolve: 0, fix: 0 },
    resolving: secondsIn("resolving"),
    fixing: secondsIn("fixing"),
    working: secondsIn("working"),
    checks: { failed: t.checksFailed, timed_out: t.checksTimedOut },
    flaky: t.flaky,
    denied: t.denied,
    asked: t.questions,
    ...spentFields(spent),
    costUsd: cost(spent),
    estimated,
    size: t.size ?? null,
    followUps: t.followUps.map(sanitizeLine),
    reverts: t.reverts.map(sanitizeLine),
    audit: t.audit ?? null,
  }
}

/** A ticket scored in the run, as another's median counts it. */
export interface Peer {
  readonly ticket: string
  /** Its size class (scorecard.ts). */
  readonly size: number
  readonly working: number
  readonly turns: number
  readonly tokens: number
  readonly costUsd: number | null
}

/** Each ticket scored in the run. */
export const peersOf = (scoring: Scoring, sums: Sums): ReadonlyArray<Peer> =>
  [...scoring.scores.values()].map((score) => {
    const spent = sums.tickets.get(score.ticket)
    return {
      ticket: score.ticket,
      size: sizeClass(score.size),
      working: score.working,
      ...spentFields(spent),
      costUsd: score.cost_usd ?? cost(spent),
    }
  })

/** The middle of the figures of a ticket's peers, and how many they are. */
export interface PeerMedian {
  readonly tickets: number
  readonly working: number
  readonly turns: number
  readonly tokens: number
  /** Null where none of them has a cost. */
  readonly costUsd: number | null
}

/** The median of `peers` but `ticket`, of the class of a footprint of `size` files; null for none. */
export const peerMedian = (
  peers: ReadonlyArray<Peer>,
  ticket: string,
  size: number | null,
): PeerMedian | null => {
  const like = peers.filter(
    (each) => each.ticket !== ticket && each.size === sizeClass(size ?? undefined),
  )
  if (like.length === 0) return null
  const costs = like.flatMap((each) => (each.costUsd === null ? [] : [each.costUsd]))
  return {
    tickets: like.length,
    working: median(like.map((each) => each.working)),
    turns: median(like.map((each) => each.turns)),
    tokens: median(like.map((each) => each.tokens)),
    costUsd: costs.length === 0 ? null : median(costs),
  }
}
