// The run's figures under the summary's totals (figures.ts, § 7.1, § 5 item 14 "Then"): the
// records added up, each line as it reads, the styled summary and the plain one, the empty run, a
// subscription and an API key, a narrow terminal; the figures of the analytics fixture's runs, the
// same as docs/analytics.md's queries give over them (with the machine's duckdb, where it has one);
// and a whole run's.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Result } from "effect"
import { type Summary, summary } from "../src/print/summary.ts"
import { summaryLines } from "../src/run/endOfRun.ts"
import { decodeLine, type Event } from "../src/run/events.ts"
import {
  addRecord,
  type Figures,
  figuresLines,
  figuresText,
  median,
  noFigures,
  tokenCount,
} from "../src/run/figures.ts"
import { line } from "../src/run/log.ts"
import { Outcome as Ended, TicketPhase } from "../src/run/phase.ts"
import { type Outcome, run } from "../src/run/run.ts"
import { emptyView, type Row, rowStatus } from "../src/run/runView.ts"
import { Git } from "../src/services/Git.ts"
import { claimsAndCloses } from "../src/testing/AgentHost.ts"
import { windowLabel } from "../src/ui/TitleLine.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { machineWhich, testEnv } from "./env.ts"
import { backlog, expectExitCode, expectLog, type Ran, scenario, type World } from "./harness.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR sequences are what is stripped
const sgr = /\x1b\[[0-9;]*m/g
const strip = (text: string): string => text.replace(sgr, "")

const at = (minutes: number): number => Date.UTC(2026, 9, 23, 9) + minutes * 60_000

/** `events` added up, the first at minute 0, each `[minute, event]`. */
const figuresOf = (events: ReadonlyArray<readonly [number, Event]>): Figures =>
  events.reduce((sum, [minute, event]) => addRecord(sum, event, at(minute)), noFigures)

const phase = (ticket: string, to: string | undefined, why?: string): Event =>
  ({
    kind: "phase",
    ticket,
    ...(to === undefined ? {} : { to }),
    ...(why === undefined ? {} : { why }),
    cause: "Test",
  }) as Event

const check = (
  suite: "merge" | "recheck" | "fix" | "full" | "setup",
  result: "passed" | "failed" | "timed_out" | "not_run",
  seconds: number,
  ticket?: string,
): Event => ({
  kind: "check",
  suite,
  ...(ticket === undefined ? {} : { ticket }),
  command: "scripts/check-fast.sh",
  seconds,
  result,
})

const turn = (ticket: string, cost: number, tokens = 1000, cached = 0): Event => ({
  kind: "turn",
  ticket,
  session: `s-${ticket}`,
  subtype: "success",
  cost_usd: cost,
  turns: 3,
  duration_ms: 1000,
  api_ms: 800,
  tokens: { "claude-opus-5-5": { input: tokens, output: 0, cache_write: 0, cache_read: cached } },
})

const usage = (window: string, utilization: number): Event => ({
  kind: "usage_window",
  window,
  utilization,
})

/**
 * A hundred minutes of a ticket's phases: 63 queued, 19 held back (15 for an overlap), 14 working,
 * 2 merging, and three phases under a minute each.
 */
const timeRecords: ReadonlyArray<readonly [number, Event]> = [
  [0, phase("a", "Queued")],
  [63, phase("a", "HeldBack", "overlap")],
  [78, phase("a", "HeldBack", "merge")],
  [82, phase("a", "Working")],
  [96, phase("a", "Merging")],
  [98, phase("a", "ToMerge")],
  [98.5, phase("a", "Fixing")],
  [99.2, phase("a", "Resolving")],
  [100, phase("a", "Done")],
]

const subscription = { subscription: true, label: windowLabel }
const apiKey = { subscription: false, label: windowLabel }

/** The text of each line `figures` gives on a subscription login. */
const texts = (figures: Figures, options = subscription): ReadonlyArray<string> =>
  figuresLines(figures, options).map(figuresText)

describe("the records added up", () => {
  test("a phase counts from its record to the ticket's next; its last counts nothing", () => {
    const figures = figuresOf([
      [0, phase("a", "Queued")],
      [10, phase("a", "Working")],
      [40, phase("a", "ToMerge")],
      [45, phase("a", "Merging")],
      [50, phase("a", "Done")],
      [55, phase("a", undefined)],
    ])
    expect(Object.fromEntries(figures.phases)).toEqual({
      Queued: 10 * 60_000,
      Working: 30 * 60_000,
      ToMerge: 5 * 60_000,
      Merging: 5 * 60_000,
      Done: 5 * 60_000,
    })
    expect(figures.open.has("a")).toBe(false)
  })

  test("HeldBack counts by its hold too", () => {
    const figures = figuresOf([
      [0, phase("a", "HeldBack", "overlap")],
      [6, phase("a", "HeldBack", "solo")],
      [8, phase("a", "Working")],
    ])
    expect(Object.fromEntries(figures.holds)).toEqual({ overlap: 6 * 60_000, solo: 2 * 60_000 })
    expect(figures.phases.get("HeldBack")).toBe(8 * 60_000)
  })

  test("the turns' tokens, dollars and each ticket's dollars; the windows' first and last", () => {
    const figures = figuresOf([
      [0, usage("five_hour", 0.11)],
      [1, turn("a", 0.5, 100, 900)],
      [2, usage("five_hour", 0.15)],
      [3, turn("b", 0.25)],
      [4, turn("a", 0.5)],
      [5, usage("seven_day", 0.4)],
      [6, usage("five_hour", 0.17)],
    ])
    expect(figures.turns).toBe(3)
    expect(figures.tokens).toEqual({ input: 2100, output: 0, cache_write: 0, cache_read: 900 })
    expect(figures.costUsd).toBe(1.25)
    expect(Object.fromEntries(figures.tickets)).toEqual({ a: 1, b: 0.25 })
    expect([...figures.windows]).toEqual([
      ["five_hour", { first: 0.11, last: 0.17 }],
      ["seven_day", { first: 0.4, last: 0.4 }],
    ])
  })

  test("a record of another kind is nothing to them", () => {
    expect(figuresOf([[0, { kind: "done", text: "READY_EMPTY after 0 tickets" }]])).toBe(noFigures)
  })
})

describe("the figures' lines", () => {
  test("Time: each phase's share, largest first, under 1% left out, held back with its hold", () => {
    const figures = figuresOf([...timeRecords, [100, phase("b", "Queued")]])
    expect(texts(figures)).toEqual([
      "Time    63% queued · 19% held back (overlap 15%) · 14% working · 2% merging",
    ])
  })

  test("Checks: a suite's passes of its runs, then what didn't pass with its tickets and time", () => {
    const merges = [
      ...Array.from({ length: 31 }, (_, i) => check("merge", "passed", 120, `m-${i}`)),
      check("merge", "timed_out", 2072, "mnemos-gts.16"),
    ]
    const figures = figuresOf([
      ...merges.map((each) => [0, each] as const),
      ...Array.from({ length: 32 }, (_, i) => [0, check("setup", "passed", 5, `m-${i}`)] as const),
      [0, check("full", "passed", 600)],
    ])
    expect(texts(figures)).toEqual([
      "Checks  merge 31 of 32 passed, 1 timed out (mnemos-gts.16, 34m32s) · setup 32 of 32 · full passed",
    ])
  })

  test("Checks: up to three tickets, then how many more, and the longest one's time", () => {
    const failing = ["a", "b", "a", "c", "d", "e"].map(
      (ticket, i) => [0, check("merge", "failed", 60 + i * 10, ticket)] as const,
    )
    const figures = figuresOf([
      ...failing,
      [0, check("merge", "not_run", 0, "f")],
      [0, check("recheck", "passed", 30, "a")],
      [0, check("full", "failed", 754)],
    ])
    expect(texts(figures)).toEqual([
      "Checks  merge 0 of 7 passed, 6 failed (a, b, c, +2 more, 1m50s), 1 not run (f, 0s) · recheck 1 of 1 · full failed (12m34s)",
    ])
  })

  test("Spent on a subscription: the tokens, the cache's share, the estimate and the median", () => {
    const figures = figuresOf([
      [0, turn("a", 42.27, 2_000_000, 48_000_000)],
      [1, turn("b", 1.24, 1_000_000, 2_000_000)],
      [2, turn("c", 1.24)],
    ])
    const [spent] = figuresLines(figures, subscription)
    expect(spent === undefined ? "" : figuresText(spent)).toBe(
      "Spent   53M tokens (94% from the cache) · $44.75 (estimate) · $1.24 a ticket (median)",
    )
    expect(spent?.parts.map((part) => part.estimate === true)).toEqual([false, true, true])
  })

  test("Spent on an API key: the dollars plain, and no Usage", () => {
    const figures = figuresOf([
      [0, usage("five_hour", 0.11)],
      [1, turn("a", 2.5, 900, 100)],
    ])
    const lines = figuresLines(figures, apiKey)
    expect(lines.map(figuresText)).toEqual(["Spent   1k tokens (10% from the cache) · $2.50"])
    expect(lines.flatMap((each) => each.parts).some((part) => part.estimate === true)).toBe(false)
  })

  test("Usage: each window as the run started and as it ended, with the title line's labels", () => {
    const figures = figuresOf([
      [0, usage("five_hour", 0.11)],
      [1, usage("seven_day", 0.4)],
      [2, usage("five_hour", 0.17)],
      [3, usage("seven_day", 0.41)],
    ])
    expect(texts(figures)).toEqual([
      `Usage   ${windowLabel("five_hour")} 11% → 17% · ${windowLabel("seven_day")} 40% → 41%`,
    ])
    expect(texts(figuresOf([[0, usage("seven_day", 0.4)]]))).toEqual([
      `Usage   ${windowLabel("seven_day")} 40%`,
    ])
  })

  test("a line with nothing to say is left out: no records give no lines", () => {
    expect(figuresLines(noFigures, subscription)).toEqual([])
    expect(texts(figuresOf([[0, phase("a", "Queued")]]))).toEqual([])
    // A turn that spent nothing, as a scripted one or a crash gives.
    expect(texts(figuresOf([[0, { ...turn("a", 0), tokens: {} } as Event]]))).toEqual([])
  })

  test("tokens to two figures, dollars to the cent, the median of an even count", () => {
    expect([950, 1234, 12_345, 1_234_567, 53_400_000, 2_500_000_000].map(tokenCount)).toEqual([
      "950",
      "1.2k",
      "12k",
      "1.2M",
      "53M",
      "2.5B",
    ])
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([5, 1, 3])).toBe(3)
  })
})

const row = (ticket: string): Row => ({
  ticket,
  label: ticket,
  title: "",
  ...rowStatus(TicketPhase.Done({ outcome: Ended.NoChange() })),
  note: "merged into main",
  verdict: null,
})

const mnemos = figuresOf([
  ...timeRecords,
  [98, check("merge", "passed", 120, "a")],
  [98, check("merge", "timed_out", 2072, "mnemos-gts.16")],
  [98, turn("a", 42.27, 2_000_000, 48_000_000)],
  [98, turn("b", 1.24, 1_000_000, 2_000_000)],
  [98, turn("c", 1.24)],
  [98, usage("five_hour", 0.11)],
  [99, usage("five_hour", 0.17)],
])

const ended = (figures: Figures, rows: ReadonlyArray<Row>, options = subscription): Summary => ({
  version: "0.1.0",
  branch: "main",
  scope: null,
  took: 125_000,
  totals: { ...emptyView.totals, slots: 4, completed: rows.length },
  figures: figuresLines(figures, options),
  rows,
})

describe("under the summary's totals", () => {
  test("the styled summary has them between the totals and the tickets, the estimate in its colour", () => {
    const out = summary(ended(mnemos, [row("a")]), theme, 120)
    const lines = strip(out).split("\n")
    const time = lines.findIndex((each) => each.startsWith("  Time    "))
    expect(time).toBeGreaterThan(lines.findIndex((each) => each.includes("Completed")))
    expect(lines.slice(time, time + 4).map((each) => each.slice(2, 10))).toEqual([
      "Time    ",
      "Checks  ",
      "Spent   ",
      "Usage   ",
    ])
    expect(lines.findIndex((each) => each.includes("Tickets"))).toBe(time + 4)
    expect(out).toContain(theme.styles.dim.paint("Time    "))
    expect(out).toContain(theme.styles.estimate.paint("$44.75 (estimate)"))
    expect(out).toContain(theme.styles.estimate.paint("$1.24 a ticket (median)"))
    expect(theme.styles.estimate.open).toContain("\x1b[3m")
  })

  test("on an API key the dollars are plain, and the Usage line is left out", () => {
    const out = summary(ended(mnemos, [row("a")], apiKey), theme, 120)
    expect(strip(out)).toContain("  Spent   53M tokens (94% from the cache) · $44.75 · $1.24")
    expect(out).not.toContain(theme.styles.estimate.open)
    expect(strip(out)).not.toContain("Usage")
  })

  test("a run that took no tickets prints no block", () => {
    const out = strip(summary(ended(mnemos, []), theme, 120))
    expect(out).not.toContain("Time")
    expect(out).not.toContain("Spent")
    const plain = summaryLines({ ...ended(mnemos, []), base: "main" })
    expect(plain.some((each) => each.includes("Spent"))).toBe(false)
  })

  test("a narrow terminal cuts each line to its width, with …", () => {
    for (const width of [40, 52, 64]) {
      const lines = strip(summary(ended(mnemos, [row("a")]), theme, width)).split("\n")
      for (const each of lines) expect(Bun.stringWidth(each)).toBeLessThanOrEqual(width)
      const checks = lines.find((each) => each.startsWith("  Checks  ")) ?? ""
      expect(checks).toEndWith("…")
    }
    const narrow = strip(summary(ended(mnemos, [row("a")]), theme, 40)).split("\n")
    expect(narrow).toContain("  Time    63% queued · 19% held back (o…")
  })

  test("--plain gives the same lines without styles, under the totals", () => {
    const plain = summaryLines({ ...ended(mnemos, [row("a")]), base: "main" })
    expect(plain.slice(1, 6).map(String)).toEqual([
      "  Completed 1 · Set aside 0 · Needs you 0",
      "  Time    63% queued · 19% held back (overlap 15%) · 14% working · 2% merging",
      "  Checks  merge 1 of 2 passed, 1 timed out (mnemos-gts.16, 34m32s)",
      "  Spent   53M tokens (94% from the cache) · $44.75 (estimate) · $1.24 a ticket (median)",
      `  Usage   ${windowLabel("five_hour")} 11% → 17%`,
    ])
    for (const each of plain) expect(each).not.toContain("\x1b")
  })

  test("the text is sanitised: a ticket ID's controls never reach the terminal", () => {
    const figures = figuresOf([[0, check("merge", "failed", 10, "evil\x1b[2J\nid")]])
    const out = summary(ended(figures, [row("a")]), theme, 120)
    expect(out).not.toContain("\x1b[2J")
    const plain = summaryLines({ ...ended(figures, [row("a")]), base: "main" })
    for (const each of plain) {
      expect(each).not.toContain("\x1b")
      expect(each).not.toContain("\n")
    }
  })
})

// The analytics fixture's two runs, their records added up as the run adds up its own.
const fixture = join(import.meta.dir, "fixtures/analytics/events.jsonl")
const runsOfFixture: ReadonlyMap<string, Figures> = (() => {
  const runs = new Map<string, Figures>()
  for (const text of readFileSync(fixture, "utf8").trim().split("\n")) {
    const record = Result.getOrThrow(decodeLine(text))
    const { v: _v, time, run: of, ...event } = record
    runs.set(of, addRecord(runs.get(of) ?? noFigures, event as Event, Date.parse(time)))
  }
  return runs
})()
const [first, second] = [...runsOfFixture.values()]

describe("the analytics fixture's runs", () => {
  test("their lines", () => {
    expect(first === undefined ? [] : texts(first)).toEqual([
      "Time    53% working · 17% held back (merge 17%) · 11% to merge · 8% merging · 7% queued · 3% fixing",
      "Checks  merge 1 of 3 passed, 2 failed (proj-a1, proj-a2, 3m20s) · recheck 0 of 1 passed, 1 timed out (proj-a2, 3m10s) · fix 1 of 1 · full passed",
      "Spent   2.3M tokens (91% from the cache) · $3.00 (estimate) · $0.80 a ticket (median)",
      "Usage   Current usage 42% → 3% · This week 30% → 36%",
    ])
    expect(second === undefined ? [] : texts(second)).toEqual([
      "Time    38% working · 27% held back (overlap 27%) · 14% merging · 9% to merge · 7% resolving · 3% queued · 2% asked",
      "Checks  merge 2 of 2",
      "Spent   918k tokens (94% from the cache) · $1.20 (estimate) · $0.30 a ticket (median)",
      "Usage   Current usage 10% → 25% · This week 38% → 40%",
    ])
  })
})

// The machine's duckdb, which the tests' PATH leaves out (test/env.ts).
const duckdb = machineWhich("duckdb")

describe.skipIf(duckdb === null)("agree with docs/analytics.md's queries, by duckdb", () => {
  const doc = readFileSync(join(import.meta.dir, "../docs/analytics.md"), "utf8")
  const sql = [...doc.matchAll(/```sql\n([\s\S]*?)```/g)].map((match) => match[1] ?? "")
  /** The doc's query after the paragraph that starts `answers`, without its `;`. */
  const query = (answers: string): string => {
    const at = doc.indexOf(answers)
    const block = sql.find((each) => doc.indexOf(each) > at) ?? ""
    return block.trim().replace(/;$/, "")
  }
  const home = mkdtempSync(join(tmpdir(), "tutti-figures-"))
  mkdirSync(join(home, ".tutti/run"), { recursive: true })
  writeFileSync(join(home, ".tutti/run/events.jsonl"), readFileSync(fixture))
  const setup = join(home, "tutti.sql")
  writeFileSync(setup, `${sql[0] ?? ""}\nSET TimeZone = 'UTC';\n`)
  const rows = (text: string): ReadonlyArray<Record<string, number | string | null>> => {
    const result = Bun.spawnSync([duckdb ?? "duckdb", "-init", setup, "-json", "-c", text], {
      cwd: home,
      env: { ...testEnv, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) throw new Error(`duckdb: ${result.stderr}${result.stdout}`)
    return JSON.parse(result.stdout.toString())
  }
  const both = [first ?? noFigures, second ?? noFigures]

  test("the time in each phase, as Time per phase counts it", () => {
    const counted = rows(
      `SELECT phase, sum(seconds) AS seconds FROM (${query("Time per phase:")}) GROUP BY phase`,
    )
    expect(counted.length).toBeGreaterThan(0)
    for (const { phase: name, seconds } of counted) {
      const ours = both.reduce((sum, f) => sum + (f.phases.get(String(name)) ?? 0), 0) / 1000
      // The query rounds each ticket's time to a tenth.
      expect(Math.abs(ours - Number(seconds))).toBeLessThan(0.5)
    }
  })

  test("each suite's runs, failures and time-outs, as the checks query counts them", () => {
    const counted = rows(query("Each kind of check and command:"))
    for (const { suite, runs, failed, timed_out } of counted) {
      const ours = both.flatMap((f) => {
        const of = f.checks.get(String(suite) as "merge")
        return of === undefined ? [] : [of]
      })
      expect({
        suite,
        runs: ours.reduce((sum, of) => sum + of.runs, 0),
        failed: ours.reduce((sum, of) => sum + of.runs - of.passed, 0),
        timed_out: ours.reduce(
          (sum, of) => sum + of.unpassed.filter((each) => each.result === "timed_out").length,
          0,
        ),
      }).toEqual({
        suite,
        runs: Number(runs),
        failed: Number(failed),
        timed_out: Number(timed_out),
      })
    }
  })

  test("the cache's share of each run's input, as The prompt cache gives it", () => {
    const counted = rows(
      `SELECT run, sum(input) AS input, sum(cache_write) AS cache_write, sum(cache_read) AS cache_read
       FROM (${query("The cache's share of the input tokens")}) GROUP BY run ORDER BY run`,
    )
    // duckdb gives a BIGINT as a string.
    expect(
      counted.map((each) => [each.input, each.cache_write, each.cache_read].map(Number)),
    ).toEqual(both.map((f) => [f.tokens.input, f.tokens.cache_write, f.tokens.cache_read]))
  })

  test("each ticket's dollars, as Each ticket gives them", () => {
    const counted = rows(`SELECT ticket, cost_usd FROM (${query("Each ticket, across the runs")})`)
    for (const { ticket, cost_usd } of counted) {
      const ours = both.reduce((sum, f) => sum + (f.tickets.get(String(ticket)) ?? 0), 0)
      expect(Math.round(ours * 100) / 100).toBe(Number(cost_usd))
    }
  })
})

describe("a whole run", () => {
  test("its plain summary has the figures, and its outcome the styled summary's", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-figures-repo-")))
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tutti-figures-worktrees-")))
    const finishes = (world: World): ReturnType<typeof claimsAndCloses> =>
      claimsAndCloses("t-1", {
        claim: Effect.asVoid(Effect.orDie(world.beads.update("t-1", { claim: true }))),
        commit: Effect.asVoid(
          Effect.orDie(
            world.repository.commit(join(root, "t-1"), "Change (t-1)", { "t.txt": "x\n" }),
          ),
        ),
        close: Effect.asVoid(Effect.orDie(world.beads.close("t-1", "done"))),
      })
    const ran: Ran<Outcome> = await scenario(
      {
        backlog: backlog().ticket("t-1", { title: "One ticket" }).seeds,
        config: { repo },
        git: { dir: repo },
        worktrees: { root },
        scripts: (world: World) => ({ "t-1": [finishes(world)] }),
      },
      Effect.gen(function* () {
        const git = yield* Git
        yield* git.addWorktree(repo, join(root, "t-1"), { branch: "tutti/t-1", base: "main" })
        const fiber = yield* Effect.forkChild(
          run({ version: "0.1.0-test", base: "main", start: [line`START tutti 0.1.0-test`] }),
        )
        return yield* Fiber.join(fiber)
      }),
    )
    expectExitCode(ran, 0)
    // Its time doesn't move under TestClock, and its scripted turn spends nothing.
    expectLog(ran, [
      "  Completed 1 · Set aside 0 · Needs you 0",
      "  Checks  merge 1 of 1",
      /^ {2}✓ t-1 done: /,
      "READY_EMPTY after 1 tickets",
    ])
    if (ran.exit._tag !== "Success") throw new Error("the run failed")
    expect(ran.exit.value.summary.figures.map(figuresText)).toEqual(["Checks  merge 1 of 1"])
  })
})
