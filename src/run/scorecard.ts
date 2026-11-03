// Scorecards (§ 9.1's report, § 10): every ticket whose part in the run ends gets one, computed from
// the run's own records about it, so that a later change to how tutti works can be measured
// against the same figures. The EventStream folds each record it writes into the run's scoring
// (`scoreStep`, beside figures.ts's sums), and after each `ticket_end` it writes that ticket's
// `score` (`scoreOf`):
//
// - its outcome, its phase and why, from the `ticket_end`;
// - its verifier rounds, from the `verifier` records its worker's hooks gave: begun, ended PASS or
//   FAIL, the last verdict, and whether its last fix was verified (false once tutti found it
//   deferred with its last fix unverified and no round began after);
// - its hand-backs and its time in Resolving, Fixing and Working, from the `ticket_end`;
// - its merge, recheck and fix checks that failed or timed out, from the `check` records, and its
//   checks' FLAKY warnings, from the `warn` records;
// - its denied tool calls, from the `denied` records and the permissions denied when asked
//   (`attention_answered`), and its questions, from the `asked` records and AskUserQuestion's
//   `attention` records;
// - its working time and cost beside the median of the tickets of a size like its own (the files
//   its footprint named, as its `dispatch` said, in classes: 0–1, 2–3, 4–7, 8–15, 16 or more)
//   that ended in the run before it, the latest score of each;
// - the follow-ups and reverts its `score_update` records named so far. The run writes one when it
//   takes up a ticket filed against it (`followUpsOf`) and when a merge brings a commit reverting
//   it (`revertsIn`); they may come after its last score, in this run or a later one, and a query
//   joins them by ticket.
//
// No composite: the report ranks the scorecards by their parts in a fixed order (`badness`), and
// shows each part, so that what moved stays in sight.

import type { Issue } from "../services/Beads.ts"
import type { Commit } from "../services/Git.ts"
import { escapeMarkdown, sanitizeLine } from "../ui/sanitize.ts"
import type { Event, verdicts } from "./events.ts"

type Verdict = (typeof verdicts)[number]

/** A `score` record, as the run gives it to the EventStream. */
export type Score = Extract<Event, { readonly kind: "score" }>

type TicketEnd = Extract<Event, { readonly kind: "ticket_end" }>

/** What the run's records have said of one ticket so far, for its scorecard. */
export interface Tally {
  readonly rounds: number
  readonly passed: number
  readonly failed: number
  readonly last?: Verdict
  /** tutti found its last fix unverified, and no round has begun since. */
  readonly unverified: boolean
  readonly checksFailed: number
  readonly checksTimedOut: number
  readonly flaky: number
  readonly denied: number
  readonly questions: number
  /** The files its footprint named, as its dispatch said. */
  readonly size?: number
  /** When the run first took it up, epoch milliseconds: its first `phase` record. */
  readonly took?: number
  readonly followUps: ReadonlyArray<string>
  readonly reverts: ReadonlyArray<string>
}

const noTally: Tally = {
  rounds: 0,
  passed: 0,
  failed: 0,
  unverified: false,
  checksFailed: 0,
  checksTimedOut: 0,
  flaky: 0,
  denied: 0,
  questions: 0,
  followUps: [],
  reverts: [],
}

/** The run's scoring: each ticket's tally, and each ticket's latest score, in the order they ended. */
export interface Scoring {
  readonly tallies: ReadonlyMap<string, Tally>
  readonly scores: ReadonlyMap<string, Score>
}

export const noScoring: Scoring = { tallies: new Map(), scores: new Map() }

/**
 * The middle of `values`, or the mean of the two middle ones, which two finite values keep finite
 * however large; 0 for none.
 */
export const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0
  const low = sorted[middle - 1] ?? 0
  const high = sorted[middle] ?? 0
  const sum = low + high
  return Number.isFinite(sum) ? sum / 2 : low / 2 + high / 2
}

/** The size class of a footprint of `files` files: 0–1, 2–3, 4–7, 8–15, 16 or more; -1 unknown. */
export const sizeClass = (files: number | undefined): number =>
  files === undefined ? -1 : files <= 1 ? 0 : Math.min(4, Math.floor(Math.log2(files)))

/** Words of a size class, as the report says it. */
export const sizeWords = (files: number | undefined): string =>
  ["0–1 files", "2–3 files", "4–7 files", "8–15 files", "16 files or more"][sizeClass(files)] ??
  "footprint unknown"

const with1 = (list: ReadonlyArray<string>, item: string): ReadonlyArray<string> =>
  list.includes(item) ? list : [...list, item]

const tallyOf = (scoring: Scoring, ticket: string): Tally => scoring.tallies.get(ticket) ?? noTally

const update = (scoring: Scoring, ticket: string, change: (t: Tally) => Tally): Scoring => ({
  ...scoring,
  tallies: new Map(scoring.tallies).set(ticket, change(tallyOf(scoring, ticket))),
})

const flakyText = /^\s*FLAKY: /

/** `scoring` with `event`, written at `at` (epoch milliseconds), added. */
export const scoreStep = (scoring: Scoring, event: Event, at: number): Scoring => {
  switch (event.kind) {
    case "phase":
      return scoring.tallies.get(event.ticket)?.took !== undefined
        ? scoring
        : update(scoring, event.ticket, (t) => ({ ...t, took: at }))
    case "dispatch": {
      const footprint = event.footprint
      return footprint === undefined
        ? scoring
        : update(scoring, event.ticket, (t) => ({ ...t, size: footprint }))
    }
    case "verifier":
      return update(scoring, event.ticket, (t) => {
        switch (event.detail) {
          case "began":
            return { ...t, rounds: t.rounds + 1, unverified: false }
          case "unverified":
            return { ...t, unverified: true }
          case "ended":
            return event.verdict === undefined
              ? t
              : {
                  ...t,
                  passed: t.passed + (event.verdict === "pass" ? 1 : 0),
                  failed: t.failed + (event.verdict === "fail" ? 1 : 0),
                  last: event.verdict,
                }
        }
        return t
      })
    case "check":
      if (event.ticket === undefined) return scoring
      if (event.suite !== "merge" && event.suite !== "recheck" && event.suite !== "fix") {
        return scoring
      }
      if (event.result === "failed") {
        return update(scoring, event.ticket, (t) => ({ ...t, checksFailed: t.checksFailed + 1 }))
      }
      if (event.result === "timed_out") {
        return update(scoring, event.ticket, (t) => ({
          ...t,
          checksTimedOut: t.checksTimedOut + 1,
        }))
      }
      return scoring
    case "warn":
      return event.ticket === undefined || !flakyText.test(event.text)
        ? scoring
        : update(scoring, event.ticket, (t) => ({ ...t, flaky: t.flaky + 1 }))
    case "denied":
      return update(scoring, event.ticket, (t) => ({ ...t, denied: t.denied + 1 }))
    case "attention_answered":
      return event.answer === "deny"
        ? update(scoring, event.ticket, (t) => ({ ...t, denied: t.denied + 1 }))
        : scoring
    case "asked":
      return update(scoring, event.ticket, (t) => ({ ...t, questions: t.questions + 1 }))
    case "attention":
      return event.type === "question"
        ? update(scoring, event.ticket, (t) => ({ ...t, questions: t.questions + 1 }))
        : scoring
    case "score_update": {
      const changed = update(scoring, event.ticket, (t) => ({
        ...t,
        followUps:
          event.follow_up === undefined ? t.followUps : with1(t.followUps, event.follow_up),
        reverts: event.revert === undefined ? t.reverts : with1(t.reverts, event.revert),
      }))
      const score = changed.scores.get(event.ticket)
      if (score === undefined) return changed
      const t = tallyOf(changed, event.ticket)
      return {
        ...changed,
        scores: new Map(changed.scores).set(event.ticket, { ...score, ...laterOf(t) }),
      }
    }
    case "score":
      return { ...scoring, scores: new Map(scoring.scores).set(event.ticket, event) }
  }
  return scoring
}

const laterOf = (t: Tally): Pick<Score, "follow_ups" | "reverts"> => ({
  ...(t.followUps.length === 0 ? {} : { follow_ups: t.followUps }),
  ...(t.reverts.length === 0 ? {} : { reverts: t.reverts }),
})

// `n` to a tenth, or as it is where a tenth of it can't be written.
const tenth = (n: number): number => {
  const rounded = Math.round(n * 10) / 10
  return Number.isFinite(rounded) ? rounded || 0 : n
}

/**
 * The median of the latest scores, other than `ticket`'s, of the tickets of `size`'s class; absent
 * when there are none.
 */
const medianOf = (
  scores: Iterable<Score>,
  size: number | undefined,
  ticket?: string,
): Score["median"] => {
  const peers = [...scores].filter(
    (each) => each.ticket !== ticket && sizeClass(each.size) === sizeClass(size),
  )
  if (peers.length === 0) return undefined
  const costs = peers.flatMap((each) => (each.cost_usd === undefined ? [] : [each.cost_usd]))
  return {
    tickets: peers.length,
    working: tenth(median(peers.map((each) => each.working))),
    ...(costs.length === 0 ? {} : { cost_usd: median(costs) }),
  }
}

/** The scorecard of the ticket `end` ends, from `scoring`, which has every record before `end`. */
export const scoreOf = (scoring: Scoring, end: TicketEnd): Score => {
  const t = tallyOf(scoring, end.ticket)
  const median = medianOf(scoring.scores.values(), t.size, end.ticket)
  return {
    kind: "score",
    ticket: end.ticket,
    outcome: end.outcome,
    phase: end.phase,
    ...(end.why === undefined ? {} : { why: end.why }),
    verifier: {
      rounds: t.rounds,
      passed: t.passed,
      failed: t.failed,
      ...(t.last === undefined ? {} : { last: t.last }),
      ...(t.rounds === 0 ? {} : { last_fix_verified: !t.unverified }),
    },
    hand_backs: end.hand_backs ?? { resolve: 0, fix: 0 },
    resolving: end.phases?.resolving ?? 0,
    fixing: end.phases?.fixing ?? 0,
    working: end.phases?.working ?? 0,
    seconds: end.seconds,
    checks: { failed: t.checksFailed, timed_out: t.checksTimedOut },
    flaky: t.flaky,
    denied: t.denied,
    asked: t.questions,
    ...(end.cost_usd === undefined ? {} : { cost_usd: end.cost_usd }),
    ...(t.size === undefined ? {} : { size: t.size }),
    ...(median === undefined ? {} : { median }),
    ...laterOf(t),
  }
}

/**
 * The tickets `issue`, as the run takes it up, is a follow-up of, that no score_update has named
 * it a follow-up of yet: those it was discovered from, and those blocking it that the run took up
 * before it was filed. A ticket blocked by one filed before is ordinary ordering, not a follow-up.
 */
export const followUpsOf = (issue: Issue, scoring: Scoring): ReadonlyArray<string> => {
  const filed = Date.parse(issue.createdAt)
  return [
    ...new Set(
      issue.dependencies.flatMap((dependency) => {
        const t = scoring.tallies.get(dependency.id)
        if (dependency.id === issue.id || t?.followUps.includes(issue.id) === true) return []
        if (dependency.type === "discovered-from") return [dependency.id]
        if (dependency.type !== "blocks" || t?.took === undefined) return []
        return Number.isFinite(filed) && filed > t.took ? [dependency.id] : []
      }),
    ),
  ]
}

// A revert's subject, as git revert writes it, `Revert "…"`, and the ticket IDs it names in
// parentheses, as this project's commit subjects end: `(tutti-5fs7.1)`, `(tut-1, tut-2)`.
const revertSubject = /^\s*Revert\b/
const parenthesised = /\(([^()]*)\)/g
const ticketId = /^[A-Za-z0-9_]+-[A-Za-z0-9_]+(?:\.[0-9]+)*$/

/**
 * The tickets the commits `commits`, merged with ticket `by`, revert, and the commit reverting
 * each: a commit whose subject starts with Revert, and each ticket ID its subject names in
 * parentheses, other than `by`.
 */
export const revertsIn = (
  commits: ReadonlyArray<Pick<Commit, "hash" | "subject">>,
  by: string,
): ReadonlyArray<{ readonly ticket: string; readonly commit: string }> =>
  commits.flatMap((commit) => {
    if (!revertSubject.test(commit.subject)) return []
    const named = [...commit.subject.matchAll(parenthesised)].flatMap((match) =>
      (match[1] ?? "")
        .split(",")
        .map((each) => each.trim())
        .filter((each) => ticketId.test(each) && each !== by),
    )
    return [...new Set(named)].map((ticket) => ({ ticket, commit: commit.hash }))
  })

// ---------------------------------------------------------------------------------------------
// The report

/** How bad an outcome is, for the ranking: merged or closed first, set aside or stopped last. */
const outcomeRank: Readonly<Record<Score["outcome"], number>> = {
  merged: 0,
  no_change: 0,
  queued: 1,
  needs_you: 2,
  stopped: 3,
  set_aside: 3,
}

/** `n` over `of`, or 0 where `of` says nothing. */
const ratio = (n: number | undefined, of: number | undefined): number =>
  n === undefined || of === undefined || of <= 0 ? 0 : n / of

/** The run's median for each score's size class, every latest score counted. */
const runMedians = (scores: ReadonlyArray<Score>): ((score: Score) => Score["median"]) => {
  const byClass = new Map<number, Score["median"]>()
  return (score) => {
    const of = sizeClass(score.size)
    if (!byClass.has(of)) byClass.set(of, medianOf(scores, score.size))
    return byClass.get(of)
  }
}

/**
 * A scorecard's parts in the order the ranking weighs them, larger worse: its reverts, its
 * outcome, its hand-backs and failed checks, an unverified last fix, its failed verifier rounds,
 * its follow-ups, its FLAKY warnings, its denials and questions, then its cost and working time
 * over the run's median for its size.
 */
export const badness = (score: Score, of: Score["median"]): ReadonlyArray<number> => [
  score.reverts?.length ?? 0,
  outcomeRank[score.outcome],
  score.hand_backs.resolve + score.hand_backs.fix + score.checks.failed + score.checks.timed_out,
  score.verifier.last_fix_verified === false ? 1 : 0,
  score.verifier.failed,
  score.follow_ups?.length ?? 0,
  score.flaky,
  score.denied + score.asked,
  ratio(score.cost_usd, of?.cost_usd),
  ratio(score.working, of?.working),
]

const compare = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** `scores`, worst first, ties by ticket, each with the run's median for its size. */
export const ranked = (
  scores: ReadonlyArray<Score>,
): ReadonlyArray<{ readonly score: Score; readonly median: Score["median"] }> => {
  const medianFor = runMedians(scores)
  return scores
    .map((score) => ({ score, median: medianFor(score), bad: badness(score, medianFor(score)) }))
    .sort((a, b) => compare(b.bad, a.bad) || a.score.ticket.localeCompare(b.score.ticket))
    .map(({ score, median }) => ({ score, median }))
}

/** How many of the worst and of the best the report shows; a run with no more shows them all. */
export const shownEach = 5

/** `34m`, `1h5m`, `45s`. */
const minutes = (seconds: number): string => {
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 === 0 ? "" : `${m % 60}m`}`
}

/** `1.8×`, beside the median it is over; nothing with no median to be over. */
const over = (n: number | undefined, of: number | undefined): string =>
  n === undefined || of === undefined || of <= 0 ? "" : ` (${(n / of).toFixed(1)}×)`

const outcomeWords: Readonly<Record<Score["outcome"], string>> = {
  merged: "merged",
  no_change: "no change",
  set_aside: "set aside",
  needs_you: "needs you",
  stopped: "stopped",
  queued: "queued",
}

/** A scorecard's parts, as the report's table and the reviewer's lines give them. */
export const scoreParts = (score: Score, of: Score["median"]) => {
  const v = score.verifier
  const verdicts = [
    ...(v.failed > 0 ? [`${v.failed} FAIL`] : []),
    ...(v.last === undefined ? [] : [`last ${v.last.toUpperCase()}`]),
    ...(v.last_fix_verified === false ? ["last fix unverified"] : []),
  ]
  const hand = score.hand_backs
  const handTime = score.resolving + score.fixing
  const checks = [
    ...(score.checks.failed > 0 ? [`${score.checks.failed} failed`] : []),
    ...(score.checks.timed_out > 0 ? [`${score.checks.timed_out} timed out`] : []),
    ...(score.flaky > 0 ? [`${score.flaky} FLAKY`] : []),
  ]
  const later = [
    ...(score.follow_ups ?? []).map((id) => `follow-up ${id}`),
    ...(score.reverts ?? []).map((hash) => `reverted by ${hash.slice(0, 7)}`),
  ]
  return {
    ticket: score.ticket,
    outcome:
      score.why === undefined
        ? outcomeWords[score.outcome]
        : `${outcomeWords[score.outcome]} (${score.why})`,
    verifier:
      v.rounds === 0
        ? "none"
        : `${v.rounds} round${v.rounds === 1 ? "" : "s"}${verdicts.length === 0 ? "" : ` (${verdicts.join(", ")})`}`,
    handBacks:
      hand.resolve + hand.fix === 0
        ? "0"
        : `${hand.resolve} resolve, ${hand.fix} fix (${minutes(handTime)})`,
    checks: checks.length === 0 ? "0" : checks.join(", "),
    denied: String(score.denied),
    questions: String(score.asked),
    working: `${minutes(score.working)}${over(score.working, of?.working)}`,
    cost:
      score.cost_usd === undefined
        ? "unknown"
        : `$${score.cost_usd.toFixed(2)}${over(score.cost_usd, of?.cost_usd)}`,
    size: sizeWords(score.size),
    later: later.length === 0 ? "" : later.join(", "),
  }
}

/** A table cell of text from the run: one line, Markdown escaped, sanitised. */
const cell = (untrusted: string): string => escapeMarkdown(sanitizeLine(untrusted))

const header =
  "| Ticket | Outcome | Verifier | Hand-backs | Checks | Denied | Questions | Working | Cost | Later |\n" +
  "|---|---|---|---|---|---|---|---|---|---|"

const row = (score: Score, of: Score["median"]): string => {
  const p = scoreParts(score, of)
  return `| ${[p.ticket, p.outcome, p.verifier, p.handBacks, p.checks, p.denied, p.questions, p.working, p.cost, p.later].map(cell).join(" | ")} |`
}

const table = (
  rows: ReadonlyArray<{ readonly score: Score; readonly median: Score["median"] }>,
): string => [header, ...rows.map(({ score, median }) => row(score, median))].join("\n")

/**
 * The report's Scorecards section, after the reviewer's text: the worst and the best of the run's
 * tickets by their scorecards, or every ticket, worst first, where there are no more than twice
 * `shownEach`; nothing when no ticket ended.
 */
export const scorecardsReport = (scores: ReadonlyArray<Score>): string => {
  if (scores.length === 0) return ""
  const all = ranked(scores)
  const intro =
    "Each ticket's scorecard, from the run's records (`score` in .tutti/run/events.jsonl): its " +
    "working time and cost beside the run's median for tickets of its size, as ×."
  if (all.length <= 2 * shownEach) {
    return `\n## Scorecards\n\n${intro} Worst first.\n\n${table(all)}\n`
  }
  const worst = all.slice(0, shownEach)
  const best = all.slice(-shownEach).reverse()
  return (
    `\n## Scorecards\n\n${intro} ${all.length} tickets ended; the worst and the best ${shownEach}.\n\n` +
    `### Worst\n\n${table(worst)}\n\n### Best\n\n${table(best)}\n`
  )
}

/**
 * The reviewer's evidence of the scorecards: one line a ticket, best first, so that a section cut
 * to its end (report.ts cappedEvidence) keeps the worst.
 */
export const scorecardsEvidence = (scores: ReadonlyArray<Score>): ReadonlyArray<string> =>
  [...ranked(scores)].reverse().map(({ score, median }) => {
    const p = scoreParts(score, median)
    return (
      `${p.ticket}: ${p.outcome}; verifier ${p.verifier}; hand-backs ${p.handBacks}; ` +
      `checks ${p.checks}; denied ${p.denied}; questions ${p.questions}; working ${p.working}; ` +
      `cost ${p.cost}; ${p.size}${p.later === "" ? "" : `; ${p.later}`}`
    )
  })
