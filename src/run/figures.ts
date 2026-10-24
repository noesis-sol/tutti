// The run's figures (§ 7.1, § 5 item 14 "Then"): where the tickets' time went, how the checks did,
// what the workers' turns spent and how the account's usage windows rose, for the short block under
// the summary's totals. The EventStream adds up each record of the run as it is written, so the
// figures are those of docs/analytics.md's queries over the same run's records, without DuckDB:
//
// - the time in each phase, from the `phase` records, as "Time per phase" counts it: from a
//   ticket's record to its next, a ticket's last phase in the run counting no time;
// - the checks, from the `check` records, as "Each kind of check and command" counts them;
// - the tokens and dollars of the workers' turns, from the `turn` records, as Spending sums them,
//   the cache's share as "The prompt cache" gives it, a ticket's dollars as "Each ticket" does;
// - the usage windows, from the `usage_window` records: each window's first figure, as the run
//   started, and its last.
import { Duration } from "effect"
import { formatDuration } from "../project/configFile.ts"
import type { checkResults, checkSuites, Event, Tokens } from "./events.ts"

type Suite = (typeof checkSuites)[number]

/** A check that didn't pass. */
export interface Unpassed {
  readonly result: Exclude<(typeof checkResults)[number], "passed">
  /** Whose check it was; none for the full check's. */
  readonly ticket?: string
  readonly seconds: number
}

/** What a suite's checks came to. */
export interface SuiteFigures {
  readonly runs: number
  readonly passed: number
  /** Those that didn't pass, in the order they ended. */
  readonly unpassed: ReadonlyArray<Unpassed>
}

/** What the run's records add up to. Times are epoch milliseconds. */
export interface Figures {
  /** Each ticket's phase as its last `phase` record left it, with its hold and when it began. */
  readonly open: ReadonlyMap<
    string,
    { readonly phase: string; readonly why?: string; readonly at: number }
  >
  /** The tickets' time in each phase, by the phase's name, in milliseconds. */
  readonly phases: ReadonlyMap<string, number>
  /** Their time HeldBack, by its hold, in milliseconds. */
  readonly holds: ReadonlyMap<string, number>
  readonly checks: ReadonlyMap<Suite, SuiteFigures>
  /** The workers' turns: how many, their tokens of every model added up, and their dollars. */
  readonly turns: number
  readonly tokens: Tokens
  readonly costUsd: number
  /** The dollars of each ticket's workers' turns. */
  readonly tickets: ReadonlyMap<string, number>
  /** Each usage window's first and last figure, 0 to 1, in the order first reported. */
  readonly windows: ReadonlyMap<string, { readonly first: number; readonly last: number }>
}

export const noFigures: Figures = {
  open: new Map(),
  phases: new Map(),
  holds: new Map(),
  checks: new Map(),
  turns: 0,
  tokens: { input: 0, output: 0, cache_write: 0, cache_read: 0 },
  costUsd: 0,
  tickets: new Map(),
  windows: new Map(),
}

const plus = <K>(map: ReadonlyMap<K, number>, key: K, n: number): ReadonlyMap<K, number> =>
  new Map(map).set(key, (map.get(key) ?? 0) + n)

/** `figures` with `event`, written at `at`, added. */
export const addRecord = (figures: Figures, event: Event, at: number): Figures => {
  switch (event.kind) {
    case "phase": {
      const was = figures.open.get(event.ticket)
      const spent = was === undefined ? 0 : Math.max(0, at - was.at)
      const open = new Map(figures.open)
      if (event.to === undefined) open.delete(event.ticket)
      else {
        open.set(event.ticket, {
          phase: event.to,
          ...(event.why === undefined ? {} : { why: event.why }),
          at,
        })
      }
      if (was === undefined) return { ...figures, open }
      return {
        ...figures,
        open,
        phases: plus(figures.phases, was.phase, spent),
        holds: was.phase === "HeldBack" ? plus(figures.holds, was.why ?? "", spent) : figures.holds,
      }
    }
    case "check": {
      const suite = figures.checks.get(event.suite) ?? { runs: 0, passed: 0, unpassed: [] }
      const passed = event.result === "passed"
      const unpassed: ReadonlyArray<Unpassed> =
        event.result === "passed"
          ? suite.unpassed
          : [
              ...suite.unpassed,
              {
                result: event.result,
                ...(event.ticket === undefined ? {} : { ticket: event.ticket }),
                seconds: event.seconds,
              },
            ]
      return {
        ...figures,
        checks: new Map(figures.checks).set(event.suite, {
          runs: suite.runs + 1,
          passed: suite.passed + (passed ? 1 : 0),
          unpassed,
        }),
      }
    }
    case "turn": {
      const tokens = { ...figures.tokens }
      for (const t of Object.values(event.tokens ?? {})) {
        tokens.input += t.input
        tokens.output += t.output
        tokens.cache_write += t.cache_write
        tokens.cache_read += t.cache_read
      }
      return {
        ...figures,
        turns: figures.turns + 1,
        tokens,
        costUsd: figures.costUsd + event.cost_usd,
        tickets: plus(figures.tickets, event.ticket, event.cost_usd),
      }
    }
    case "usage_window": {
      const was = figures.windows.get(event.window)
      return {
        ...figures,
        windows: new Map(figures.windows).set(event.window, {
          first: was?.first ?? event.utilization,
          last: event.utilization,
        }),
      }
    }
  }
  return figures
}

/** A part of a figures line: its text, and whether it is an estimate, drawn in its colour. */
export interface Part {
  readonly text: string
  readonly estimate?: true
}

/** A line of the figures: its label, and its parts, joined by ` · `. */
export interface FiguresLine {
  readonly label: "Time" | "Checks" | "Spent" | "Usage"
  readonly parts: ReadonlyArray<Part>
}

/** The widest label, which the parts are lined up after. */
export const labelWidth = 6

/** A phase's name in words: `HeldBack` is `held back`, `ToMerge` `to merge`. */
export const phaseWords = (phase: string): string =>
  phase.replace(/(?<=[a-z])(?=[A-Z])/g, " ").toLowerCase()

/** `seconds` to the second, as the summary's times: `34m32s`, `45s`. */
const took = (seconds: number): string =>
  seconds < 1 ? "0s" : formatDuration(Duration.seconds(Math.floor(seconds)))

/** `n` of 100, to the whole. */
const percent = (share: number): string => `${Math.round(share * 100)}%`

/**
 * The Time line's parts: each phase's share of the tickets' time, largest first, those under 1%
 * left out; held back with its largest hold's share.
 */
const timeParts = (figures: Figures): ReadonlyArray<Part> => {
  const total = [...figures.phases.values()].reduce((sum, ms) => sum + ms, 0)
  if (total <= 0) return []
  const largest = [...figures.holds].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))[0]
  return [...figures.phases]
    .filter(([, ms]) => ms / total >= 0.01)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([phase, ms]) => {
      const hold =
        phase === "HeldBack" && largest !== undefined && largest[0] !== ""
          ? ` (${largest[0]} ${percent(largest[1] / total)})`
          : ""
      return { text: `${percent(ms / total)} ${phaseWords(phase)}${hold}` }
    })
}

/** The suites in the order the Checks line names them. */
const suiteOrder: ReadonlyArray<Suite> = ["merge", "recheck", "fix", "setup", "full"]

/** How a check that didn't pass ended, in words. */
const endedWords: Readonly<Record<Unpassed["result"], string>> = {
  failed: "failed",
  timed_out: "timed out",
  not_run: "not run",
}

/** The tickets most named, the rest counted. */
const named = 3

/** `2 failed (tut-1, tut-2, 3m10s)`: how many ended so, their tickets, and the longest one's time. */
const unpassedPart = (all: ReadonlyArray<Unpassed>): string => {
  const tickets = [
    ...new Set(all.flatMap((each) => (each.ticket === undefined ? [] : [each.ticket]))),
  ]
  const shown = tickets.slice(0, named)
  const more = tickets.length > named ? [`+${tickets.length - named} more`] : []
  const longest = Math.max(...all.map((each) => each.seconds))
  const words = endedWords[all[0]?.result ?? "failed"]
  return `${all.length} ${words} (${[...shown, ...more, took(longest)].join(", ")})`
}

/**
 * A suite's part of the Checks line: `setup 32 of 32` when all passed; `merge 31 of 32 passed, 1
 * timed out (tut-9, 34m32s)` when some didn't; the full check's one run as `full passed`.
 */
const suitePart = (suite: Suite, figures: SuiteFigures): string => {
  const byResult = (["failed", "timed_out", "not_run"] as const)
    .map((result) => figures.unpassed.filter((each) => each.result === result))
    .filter((each) => each.length > 0)
  if (suite === "full" && figures.runs === 1) {
    const one = figures.unpassed[0]
    return one === undefined
      ? "full passed"
      : `full ${endedWords[one.result]} (${took(one.seconds)})`
  }
  const count = `${suite} ${figures.passed} of ${figures.runs}`
  return byResult.length === 0
    ? count
    : `${count} passed, ${byResult.map((each) => unpassedPart(each)).join(", ")}`
}

const checksParts = (figures: Figures): ReadonlyArray<Part> =>
  suiteOrder.flatMap((suite) => {
    const of = figures.checks.get(suite)
    return of === undefined || of.runs === 0 ? [] : [{ text: suitePart(suite, of) }]
  })

/** A count of tokens to two figures at most: `950`, `12k`, `1.2M`, `53M`. */
export const tokenCount = (n: number): string => {
  for (const [size, unit] of [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ] as const) {
    if (n >= size) {
      const amount = n / size
      return `${amount < 10 ? Math.round(amount * 10) / 10 : Math.round(amount)}${unit}`
    }
  }
  return String(Math.round(n))
}

/** Dollars to the cent: `$44.75`. */
export const dollarsText = (usd: number): string => `$${usd.toFixed(2)}`

/** The middle of `values`, or the mean of the two middle ones. */
export const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

/**
 * The Spent line's parts, where the turns spent anything: the tokens, the cache's share of the
 * input, the dollars and a ticket's median dollars, where two tickets or more had turns; on a subscription login the dollars are the
 * API-price estimate, in its colour, and said so once.
 */
const spentParts = (figures: Figures, subscription: boolean): ReadonlyArray<Part> => {
  const t = figures.tokens
  const all = t.input + t.output + t.cache_write + t.cache_read
  if (all === 0 && figures.costUsd === 0) return []
  const given = t.input + t.cache_write + t.cache_read
  const cache = given > 0 ? ` (${percent(t.cache_read / given)} from the cache)` : ""
  const estimate = subscription ? { estimate: true as const } : {}
  const said = subscription ? " (estimate)" : ""
  const costs = [...figures.tickets.values()]
  return [
    { text: `${tokenCount(all)} tokens${cache}` },
    { text: `${dollarsText(figures.costUsd)}${said}`, ...estimate },
    ...(costs.length < 2
      ? []
      : [{ text: `${dollarsText(median(costs))} a ticket (median)`, ...estimate }]),
  ]
}

/** The Usage line's parts: each window's figure as the run started, and at its end if it moved. */
const usageParts = (figures: Figures, label: (window: string) => string): ReadonlyArray<Part> =>
  [...figures.windows].map(([window, { first, last }]) => {
    const from = percent(first)
    const to = percent(last)
    return { text: `${label(window)} ${from === to ? to : `${from} → ${to}`}` }
  })

/**
 * The figures' lines, each left out with nothing to say: Time, Checks, Spent and, on a
 * `subscription` login, Usage, its windows named by `label`, as the title line names them.
 */
export const figuresLines = (
  figures: Figures,
  options: { readonly subscription: boolean; readonly label: (window: string) => string },
): ReadonlyArray<FiguresLine> =>
  (
    [
      { label: "Time", parts: timeParts(figures) },
      { label: "Checks", parts: checksParts(figures) },
      { label: "Spent", parts: spentParts(figures, options.subscription) },
      {
        label: "Usage",
        parts: options.subscription ? usageParts(figures, options.label) : [],
      },
    ] satisfies ReadonlyArray<FiguresLine>
  ).filter((each) => each.parts.length > 0)

/** A figures line as plain text: `Time    63% queued · 19% held back (overlap 15%)`. */
export const figuresText = (each: FiguresLine): string =>
  `${each.label.padEnd(labelWidth + 2)}${each.parts.map((part) => part.text).join(" · ")}`
