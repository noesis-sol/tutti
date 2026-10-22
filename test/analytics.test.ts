// docs/analytics.md's DuckDB queries over the event stream, each run against
// test/fixtures/analytics/events.jsonl with the machine's duckdb, and skipped where it has none. The
// fixture is two runs of a project: proj-a1 merges after a fix hand-back, proj-a2 is set aside for
// its failing check, proj-a3 asks a question across a usage-limit window and merges in the second
// run, carried over, and proj-b1 merges there after a conflict hand-back.
import { describe, expect, test } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Result } from "effect"
import { decodeLine } from "../src/run/events.ts"
import { machineWhich, testEnv } from "./env.ts"

const doc = readFileSync(join(import.meta.dir, "../docs/analytics.md"), "utf8")
const fixture = join(import.meta.dir, "fixtures/analytics/events.jsonl")

interface Block {
  /** The paragraph before it, which says what it answers. */
  readonly answers: string
  readonly sql: string
}

const blocks: ReadonlyArray<Block> = [
  ...doc.matchAll(/(?:^|\n\n)((?:[^\n]+\n)+)\n```sql\n([\s\S]*?)```/g),
].map((match) => ({ answers: (match[1] ?? "").trim(), sql: match[2] ?? "" }))

/** What each query gives on the fixture, in the doc's order, the time zone UTC. */
const expected: ReadonlyArray<ReadonlyArray<Record<string, unknown>>> = [
  // Each run
  [
    {
      run: "2026-10-20T06:00:00.000Z",
      started: "2026-10-20 06:00:00.12+00",
      minutes: 44.1,
      merged: 1,
      no_change: 0,
      set_aside: 1,
      needs_you: 1,
      stopped: 0,
      code: 0,
      cost_usd: 3.05,
    },
    {
      run: "2026-10-21T06:18:11.587Z",
      started: "2026-10-21 06:18:12.04+00",
      minutes: 16.1,
      merged: 2,
      no_change: 0,
      set_aside: 0,
      needs_you: 0,
      stopped: 0,
      code: 0,
      cost_usd: 1.1,
    },
  ],
  // Each ticket
  [
    {
      ticket: "proj-a1",
      outcome: "merged",
      runs: 1,
      cost_usd: 1.65,
      tokens: 1356700,
      turns: 52,
      minutes_to_merge: 22.1,
      resumes: 0,
      resolves: 0,
      fixes: 1,
    },
    {
      ticket: "proj-a3",
      outcome: "merged",
      runs: 2,
      cost_usd: 0.85,
      tokens: 528000,
      turns: 27,
      minutes_to_merge: 1474.2,
      resumes: 1,
      resolves: 0,
      fixes: 0,
    },
    {
      ticket: "proj-a2",
      outcome: "set_aside",
      runs: 1,
      cost_usd: 0.8,
      tokens: 580900,
      turns: 25,
      minutes_to_merge: null,
      resumes: 0,
      resolves: 0,
      fixes: 0,
    },
    {
      ticket: "proj-b1",
      outcome: "merged",
      runs: 1,
      cost_usd: 0.8,
      tokens: 655600,
      turns: 26,
      minutes_to_merge: 13,
      resumes: 1,
      resolves: 1,
      fixes: 0,
    },
  ],
  // Time per phase, from the phase records
  [
    ["proj-a1", "Working", 1, 718],
    ["proj-a1", "Merging", 2, 362],
    ["proj-a1", "Fixing", 1, 243],
    ["proj-a1", "ToMerge", 2, 2],
    ["proj-a1", "Queued", 1, 1],
    ["proj-a2", "ToMerge", 1, 788],
    ["proj-a2", "Working", 1, 537],
    ["proj-a2", "Merging", 1, 203],
    ["proj-a2", "Queued", 1, 1],
    ["proj-a3", "Working", 2, 3117],
    ["proj-a3", "ToMerge", 1, 243],
    ["proj-a3", "Merging", 1, 181],
    ["proj-a3", "Asked", 1, 59],
    ["proj-a3", "Queued", 1, 1],
    ["proj-b1", "Working", 1, 419],
    ["proj-b1", "Merging", 2, 184],
    ["proj-b1", "Resolving", 1, 176],
    ["proj-b1", "ToMerge", 2, 2],
    ["proj-b1", "Queued", 1, 1],
  ].map(([ticket, phase, entered, seconds]) => ({ ticket, phase, entered, seconds })),
  // Time per phase, from the records that end a ticket's part in a run
  [
    { ticket: "proj-a1", working: 717, waiting: 2, merging: 361, resolving: null, fixing: 243 },
    { ticket: "proj-a2", working: 538, waiting: 788, merging: 203, resolving: null, fixing: null },
    { ticket: "proj-a3", working: 3119, waiting: 243, merging: 181, resolving: null, fixing: null },
    { ticket: "proj-b1", working: 419, waiting: 2, merging: 184, resolving: 176, fixing: null },
  ],
  // Checks by kind and command
  [
    ["merge", "scripts/check-fast.sh", 5, 2, 179.6, 200.2],
    ["fix", "scripts/check-fast.sh", 1, 0, 170.5, 170.5],
    ["full", "scripts/check-full.sh", 1, 0, 600, 600],
    ["recheck", "scripts/check-fast.sh", 1, 1, 190, 190],
  ].map(([suite, command, runs, failed, median_seconds, max_seconds]) => ({
    suite,
    command,
    runs,
    failed,
    timed_out: 0,
    median_seconds,
    max_seconds,
  })),
  // The checks that didn't pass
  [
    ["2026-10-20 06:25:31.12+00", "recheck", "proj-a2", 190, "proj-a2-2"],
    ["2026-10-20 06:25:30.12+00", "merge", "proj-a2", 200.2, "proj-a2-1"],
    ["2026-10-20 06:15:02.12+00", "merge", "proj-a1", 180, "proj-a1-1"],
  ].map(([time, suite, ticket, seconds, log]) => ({
    time,
    suite,
    ticket,
    command: "scripts/check-fast.sh",
    result: "failed",
    seconds,
    output: `.tutti/run/checks/${log}.log`,
  })),
  // Each request
  [
    {
      time: "2026-10-20 06:04:00.12+00",
      ticket: "proj-a1",
      type: "permission",
      asked: "rm -rf build",
      answered: "allow",
      via: "answer_command",
      waited_seconds: 30,
    },
    {
      time: "2026-10-20 06:06:00.12+00",
      ticket: "proj-a3",
      type: "question",
      asked: "Which storage?",
      answered: '["SQLite"]',
      via: "screen",
      waited_seconds: 135,
    },
    {
      time: "2026-10-20 06:09:00.12+00",
      ticket: "proj-a3",
      type: "permission",
      asked: "https://example.com",
      answered: "withdrawn",
      via: "screen",
      waited_seconds: 20,
    },
  ],
  // The requests by type and tool
  [
    ["permission", "Bash", 1, 0, 30, 0.5],
    ["permission", "WebFetch", 0, 1, null, 0.3],
    ["question", null, 1, 0, 135, 2.3],
  ].map(([type, tool, answered, withdrawn, median_wait_seconds, minutes_waited]) => ({
    type,
    tool,
    requests: 1,
    answered,
    withdrawn,
    median_wait_seconds,
    minutes_waited,
  })),
  // The usage limit
  [
    {
      run: "2026-10-20T06:00:00.000Z",
      reached: "2026-10-20 06:06:00.12+00",
      limit: "five_hour",
      resets_at: "2026-10-20 06:40:00+00",
      lifted: "2026-10-20 06:40:30.12+00",
      minutes_held: 34.5,
      held_in_run: 34.5,
    },
  ],
  // The prompt cache
  [
    ["2026-10-20T06:00:00.000Z", "claude-haiku-5-5", 300, 5000, 20000, 79.1],
    ["2026-10-20T06:00:00.000Z", "claude-opus-5-5", 3000, 190000, 1960000, 91],
    ["2026-10-21T06:18:11.587Z", "claude-opus-5-5", 900, 45000, 800000, 94.6],
  ].map(([run, model, input, cache_write, cache_read, cache_read_pct]) => ({
    run,
    model,
    input,
    cache_write,
    cache_read,
    cache_read_pct,
  })),
  // Every project: the fixture as two projects' streams
  ["other", "proj"].map((project) => ({
    week: "2026-10-19 00:00:00+00",
    project,
    runs: 2,
    merged: 3,
    set_aside: 1,
    hours: 1,
    cost_usd: 4.15,
  })),
  // Two runs side by side
  [
    ["checks", 6, 2, -4],
    ["cost_usd", 3.05, 1.1, -1.95],
    ["failed_checks", 3, 0, -3],
    ["merged", 1, 2, 1],
    ["minutes", 44.1, 16.1, -28],
    ["requests", 3, 0, -3],
    ["set_aside", 1, 0, -1],
    ["turns", 95, 35, -60],
  ].map(([measure, earlier, later, change]) => ({ measure, earlier, later, change })),
]

test("the fixture's records are the event stream's, each decoding as its kind", () => {
  const lines = readFileSync(fixture, "utf8").trimEnd().split("\n")
  expect(lines.length).toBeGreaterThan(80)
  for (const line of lines) {
    const record = decodeLine(line)
    if (Result.isFailure(record)) throw new Error(`${line}: ${record.failure.message}`)
  }
})

test("the doc defines the events macro first, then each query with a line on what it answers", () => {
  expect(blocks[0]?.sql).toStartWith("CREATE OR REPLACE MACRO events(path) AS TABLE")
  const queries = blocks.slice(1)
  expect(queries).toHaveLength(expected.length)
  for (const query of queries) {
    expect(query.answers).not.toStartWith("```")
    expect(query.answers.length).toBeGreaterThan(40)
    expect(query.sql).toContain("FROM events('")
  }
})

// The machine's duckdb, which the tests' PATH leaves out (test/env.ts).
const duckdb = machineWhich("duckdb")

describe.skipIf(duckdb === null)("with the machine's duckdb", () => {
  // A home with two projects whose streams are the fixture, for the glob over ~/Projects.
  const home = mkdtempSync(join(tmpdir(), "tutti-analytics-"))
  const project = (name: string): string => {
    const dir = join(home, "Projects", name)
    mkdirSync(join(dir, ".tutti/run"), { recursive: true })
    copyFileSync(fixture, join(dir, ".tutti/run/events.jsonl"))
    return dir
  }
  const checkout = project("proj")
  project("other")
  const setup = join(home, "tutti.sql")
  writeFileSync(setup, `${blocks[0]?.sql ?? ""}\nSET TimeZone = 'UTC';\n`)

  const run = (sql: string): unknown => {
    const result = Bun.spawnSync([duckdb ?? "duckdb", "-init", setup, "-json", "-c", sql], {
      cwd: checkout,
      env: { ...testEnv, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) throw new Error(`duckdb: ${result.stderr}${result.stdout}`)
    return JSON.parse(result.stdout.toString())
  }

  blocks.slice(1).forEach((query, i) => {
    test(query.answers.split(/[.:]/)[0]?.replace(/\s+/g, " ") ?? query.sql, () => {
      expect(run(query.sql)).toEqual(expected[i] ?? [])
    })
  })
})
