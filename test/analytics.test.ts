// docs/analytics.md's DuckDB queries over the event stream, each run against
// test/fixtures/analytics/events.jsonl with the machine's duckdb, and skipped where it has none. The
// fixture is two runs of a project: proj-a1 merges after a fix hand-back, proj-a2 is set aside for
// its failing check, its recheck timing out, proj-a3 asks a question across a usage-limit window and
// merges in the second run, carried over, proj-b1 merges there after a conflict hand-back, its
// cleanup failing, and proj-b2 closes with no change. proj-a4 waits for a slot, then is held back
// for a merge until it leaves bd ready; proj-b3 waits for a slot, then is held back for an overlap
// as the run drains. Beside it, workers/ has proj-a1's, proj-a3's and proj-b1's transcripts, with
// the verifier's runs, and issues.jsonl is bd's export of the tickets.
import { describe, expect, test } from "bun:test"
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Result } from "effect"
import { decodeItem } from "../src/agent/Transcripts.ts"
import { decodeLine } from "../src/run/events.ts"
import { machineWhich, testEnv } from "./env.ts"

const doc = readFileSync(join(import.meta.dir, "../docs/analytics.md"), "utf8")
const fixtures = join(import.meta.dir, "fixtures/analytics")
const fixture = join(fixtures, "events.jsonl")
const transcripts = ["proj-a1", "proj-a3", "proj-b1"].map((ticket) =>
  join(fixtures, "workers", ticket, "messages.jsonl"),
)

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
      queued: 0,
      code: 0,
      cost_usd: 3.05,
    },
    {
      run: "2026-10-21T06:18:11.587Z",
      started: "2026-10-21 06:18:12.04+00",
      minutes: 16.1,
      merged: 2,
      no_change: 1,
      set_aside: 0,
      needs_you: 0,
      stopped: 0,
      queued: 0,
      code: 0,
      cost_usd: 1.2,
    },
  ],
  // Tickets merged in each hour of each run
  [
    { run: "2026-10-20T06:00:00.000Z", hour: 1, merged: 1 },
    { run: "2026-10-21T06:18:11.587Z", hour: 1, merged: 2 },
  ],
  // The slots busy, and the time queued while every slot was
  [
    ["2026-10-20T06:00:00.000Z", 1.6, 20.3, 9, 8.9],
    ["2026-10-21T06:18:11.587Z", 1.2, 12.4, 1.3, 1.2],
  ].map(([run, busy_slots, all_busy_pct, queued_minutes, queued_all_busy]) => ({
    run,
    slots: 3,
    busy_slots,
    all_busy_pct,
    queued_minutes,
    queued_all_busy,
  })),
  // Where the tickets' time went in each run
  [
    ["2026-10-20T06:00:00.000Z", "Working", 64.9, 53.4],
    ["2026-10-20T06:00:00.000Z", "HeldBack", 21, 17.3],
    ["2026-10-20T06:00:00.000Z", "ToMerge", 13.2, 10.8],
    ["2026-10-20T06:00:00.000Z", "Merging", 9.4, 7.8],
    ["2026-10-20T06:00:00.000Z", "Queued", 9, 7.4],
    ["2026-10-20T06:00:00.000Z", "Fixing", 4.1, 3.3],
    ["2026-10-21T06:18:11.587Z", "Working", 17, 38.3],
    ["2026-10-21T06:18:11.587Z", "HeldBack", 12.1, 27.2],
    ["2026-10-21T06:18:11.587Z", "Merging", 6.1, 13.7],
    ["2026-10-21T06:18:11.587Z", "ToMerge", 4.1, 9.2],
    ["2026-10-21T06:18:11.587Z", "Resolving", 2.9, 6.6],
    ["2026-10-21T06:18:11.587Z", "Queued", 1.3, 2.8],
    ["2026-10-21T06:18:11.587Z", "Asked", 1, 2.2],
  ].map(([run, phase, minutes, pct]) => ({ run, phase, minutes, pct })),
  // Held back, by reason
  [
    { run: "2026-10-20T06:00:00.000Z", why: "merge", times: 1, tickets: 1, minutes: 21 },
    { run: "2026-10-21T06:18:11.587Z", why: "overlap", times: 1, tickets: 1, minutes: 12.1 },
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
    {
      ticket: "proj-b2",
      outcome: "no_change",
      runs: 1,
      cost_usd: 0.1,
      tokens: 47100,
      turns: 5,
      minutes_to_merge: null,
      resumes: 0,
      resolves: 0,
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
    ["proj-a4", "HeldBack", 1, 1259],
    ["proj-a4", "Queued", 1, 535],
    ["proj-b1", "Working", 1, 419],
    ["proj-b1", "Merging", 2, 184],
    ["proj-b1", "Resolving", 1, 176],
    ["proj-b1", "ToMerge", 2, 2],
    ["proj-b1", "Queued", 1, 1],
    ["proj-b2", "Working", 1, 120],
    ["proj-b2", "Queued", 1, 1],
    ["proj-b3", "HeldBack", 1, 724],
    ["proj-b3", "Queued", 1, 73],
  ].map(([ticket, phase, entered, seconds]) => ({ ticket, phase, entered, seconds })),
  // Time per phase, from the records that end a ticket's part in a run
  [
    { ticket: "proj-a1", working: 717, waiting: 2, merging: 361, resolving: null, fixing: 243 },
    { ticket: "proj-a2", working: 538, waiting: 788, merging: 203, resolving: null, fixing: null },
    { ticket: "proj-a3", working: 3119, waiting: 243, merging: 181, resolving: null, fixing: null },
    { ticket: "proj-b1", working: 419, waiting: 2, merging: 184, resolving: 176, fixing: null },
    {
      ticket: "proj-b2",
      working: 120,
      waiting: null,
      merging: null,
      resolving: null,
      fixing: null,
    },
  ],
  // Checks by kind and command
  [
    ["merge", "scripts/check-fast.sh", 5, 2, 0, 179.6, 200.2],
    ["fix", "scripts/check-fast.sh", 1, 0, 0, 170.5, 170.5],
    ["full", "scripts/check-full.sh", 1, 0, 0, 600, 600],
    ["recheck", "scripts/check-fast.sh", 1, 1, 1, 190, 190],
  ].map(([suite, command, runs, failed, timed_out, median_seconds, max_seconds]) => ({
    suite,
    command,
    runs,
    failed,
    timed_out,
    median_seconds,
    max_seconds,
  })),
  // The checks that didn't pass
  [
    ["2026-10-20 06:25:31.12+00", "recheck", "proj-a2", "timed_out", 190, "proj-a2-2"],
    ["2026-10-20 06:25:30.12+00", "merge", "proj-a2", "failed", 200.2, "proj-a2-1"],
    ["2026-10-20 06:15:02.12+00", "merge", "proj-a1", "failed", 180, "proj-a1-1"],
  ].map(([time, suite, ticket, result, seconds, log]) => ({
    time,
    suite,
    ticket,
    command: "scripts/check-fast.sh",
    result,
    seconds,
    output: `.tutti/run/checks/${log}.log`,
  })),
  // Hand-backs and rechecks by ticket
  [
    ["proj-a2", 0, 0, 1, 2, 2],
    ["proj-a1", 0, 1, 0, 3, 1],
    ["proj-b1", 1, 0, 0, 1, 0],
    ["proj-a3", 0, 0, 0, 1, 0],
    ["proj-b2", 0, 0, 0, 0, 0],
  ].map(([ticket, resolves, fixes, rechecks, checks, failed]) => ({
    ticket,
    resolves,
    fixes,
    rechecks,
    checks,
    failed,
  })),
  // FLAKY warnings by test, the one that names no test left out
  [
    {
      test: "test/parse.test.ts reads the header",
      times: 3,
      runs: 2,
      last: "2026-10-21 06:31:14.04+00",
      tickets: "proj-a1, proj-b1",
    },
    {
      test: "test/fetch.test.ts retries the fetch",
      times: 1,
      runs: 1,
      last: "2026-10-20 06:44:02.12+00",
      tickets: "the full check",
    },
  ],
  // Check durations by suite and run
  [
    ["2026-10-20T06:00:00.000Z", "fix", 1, 170.5, 170.5, 170.5],
    ["2026-10-20T06:00:00.000Z", "full", 1, 600, 600, 600],
    ["2026-10-20T06:00:00.000Z", "merge", 3, 180, 196.2, 200.2],
    ["2026-10-21T06:18:11.587Z", "merge", 2, 177.5, 179.2, 179.6],
    ["2026-10-20T06:00:00.000Z", "recheck", 1, 190, 190, 190],
  ].map(([run, suite, runs, median_seconds, p90_seconds, max_seconds]) => ({
    run,
    suite,
    runs,
    median_seconds,
    p90_seconds,
    max_seconds,
  })),
  // The checks that timed out
  [
    {
      time: "2026-10-20 06:25:31.12+00",
      suite: "recheck",
      ticket: "proj-a2",
      command: "scripts/check-fast.sh",
      seconds: 190,
      output: ".tutti/run/checks/proj-a2-2.log",
    },
  ],
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
    {
      time: "2026-10-21 06:23:00.04+00",
      ticket: "proj-b1",
      type: "elicitation",
      asked: "Pick the repository",
      answered: "allow",
      via: "screen",
      waited_seconds: 45,
    },
  ],
  // The requests by type and tool
  [
    ["elicitation", "github", 1, 0, 45, 0.8],
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
  // How long workers waited for an answer, by type
  [
    ["question", 1, 1, 135, 135, 2.3],
    ["elicitation", 1, 1, 45, 45, 0.8],
    ["permission", 2, 1, 30, 30, 0.8],
  ].map(([type, requests, answered, median_seconds, longest_seconds, minutes_waited]) => ({
    type,
    requests,
    answered,
    median_seconds,
    longest_seconds,
    minutes_waited,
  })),
  // Questions asked to answered, across runs
  [
    {
      ticket: "proj-a3",
      question: "proj-q1",
      asked: "2026-10-20 06:44:01.12+00",
      answered: "2026-10-21 06:19:12.04+00",
      hours: 23.6,
    },
  ],
  // Denied tool calls by tool and reason
  [
    ["Bash", "classifier", "Classifier unavailable", 2, "2026-10-20 06:10:00.12+00"],
    ["Edit", "rule", "Edit(.env) is denied", 1, "2026-10-20 06:07:00.12+00"],
  ].map(([tool, reason_type, reason, denied, last]) => ({
    tool,
    reason_type,
    reason,
    denied,
    tickets: 1,
    last,
  })),
  // The tool mix by ticket, the subagents' calls apart
  [
    ["proj-a1", 11, 5, 1, 1, 2, 2, 1],
    ["proj-b1", 6, 1, 2, 0, 1, 2, 1],
    ["proj-a3", 3, 1, 0, 1, 1, 0, 0],
  ].map(([ticket, calls, bash, edit, write, read, agent, subagents]) => ({
    ticket,
    calls,
    bash,
    edit,
    write,
    read,
    agent,
    other: 0,
    subagents,
  })),
  // Bash calls that edit files: a script on stdin, cat >>, sed -i, perl -pi; not a check's log
  [
    ["proj-a1", 1, 1, 3, 60, "python3 -I - <<'EOF'"],
    ["proj-b1", 2, 0, 1, 33.3, "perl -pi -e 's/old/new/' src/b.ts"],
    ["proj-a3", 0, 1, 0, 0, null],
  ].map(([ticket, edit, write, bash_edits, bash_pct, first_bash_edit]) => ({
    ticket,
    edit,
    write,
    bash_edits,
    bash_pct,
    first_bash_edit,
  })),
  // Dispatch to first edit, in each run
  [
    [
      "2026-10-20T06:00:00.000Z",
      "proj-a1",
      "2026-10-20 06:00:03.12+00",
      "2026-10-20 06:03:00+00",
      3,
    ],
    ["2026-10-20T06:00:00.000Z", "proj-a2", "2026-10-20 06:00:04.12+00", null, null],
    ["2026-10-20T06:00:00.000Z", "proj-a3", "2026-10-20 06:00:05.12+00", null, null],
    [
      "2026-10-21T06:18:11.587Z",
      "proj-b1",
      "2026-10-21 06:18:14.04+00",
      "2026-10-21 06:20:00+00",
      1.8,
    ],
    [
      "2026-10-21T06:18:11.587Z",
      "proj-a3",
      "2026-10-21 06:19:12.04+00",
      "2026-10-21 06:19:30+00",
      0.3,
    ],
    ["2026-10-21T06:18:11.587Z", "proj-b2", "2026-10-21 06:20:13.04+00", null, null],
  ].map(([run, ticket, dispatched, first_edit, minutes]) => ({
    run,
    ticket,
    dispatched,
    first_edit,
    minutes,
  })),
  // The verifier's runs: a report handed back, one as the call's result, a verdict at its end
  [
    {
      ticket: "proj-a1",
      round: 1,
      time: "2026-10-20 06:08:30+00",
      verdict: "FAIL",
      found: "CHANGELOG.md has no entry for the rename.",
      report: "FAIL\n\nCHANGELOG.md has no entry for the rename.\nThe rest is done.",
    },
    {
      ticket: "proj-a1",
      round: 2,
      time: "2026-10-20 06:11:00+00",
      verdict: "PASS",
      found: "I found no gaps.",
      report: "PASS. I found no gaps.",
    },
    {
      ticket: "proj-b1",
      round: 1,
      time: "2026-10-21 06:24:00+00",
      verdict: "PASS",
      found: "I found no gaps.",
      report: "I found no gaps.\n\nPASS",
    },
  ],
  // Cost by issue type, priority and label, from bd's export
  [
    ["label", "parser", 3, 2, 3.25, 1.23, 2593200, 17.6],
    ["label", "flaky", 1, 0, 0.8, null, 580900, null],
    ["priority", "P2", 2, 2, 2.5, 1.25, 1884700, 748.1],
    ["priority", "P1", 2, 1, 1.6, 0.8, 1236500, 13],
    ["priority", "P3", 1, 0, 0.1, null, 47100, null],
    ["type", "task", 1, 1, 1.65, 1.65, 1356700, 22.1],
    ["type", "bug", 2, 1, 1.6, 0.8, 1236500, 13],
    ["type", "feature", 1, 1, 0.85, 0.85, 528000, 1474.2],
    ["type", "chore", 1, 0, 0.1, null, 47100, null],
  ].map(([by, value, tickets, merged, cost_usd, cost_per_merged, tokens, minutes]) => ({
    by,
    value,
    tickets,
    merged,
    cost_usd,
    cost_per_merged,
    tokens,
    median_minutes_to_merge: minutes,
  })),
  // Lead time from filing to merge
  [
    ["proj-a1", "task", 2, "2026-10-19 12:00:00+00", "2026-10-20 06:22:08.12+00", 18, 18.4],
    ["proj-b1", "bug", 1, "2026-10-20 21:00:00+00", "2026-10-21 06:31:15.04+00", 9.3, 9.5],
    ["proj-a3", "feature", 2, "2026-10-18 06:00:00+00", "2026-10-21 06:34:17.04+00", 48, 72.6],
  ].map(([ticket, issue_type, priority, filed, merged, hours_to_dispatch, lead_hours]) => ({
    ticket,
    issue_type,
    priority,
    filed,
    merged,
    hours_to_dispatch,
    lead_hours,
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
    ["2026-10-21T06:18:11.587Z", "claude-opus-5-5", 1000, 50000, 840000, 94.3],
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
    cost_usd: 4.25,
  })),
  // Two runs side by side
  [
    ["checks", 6, 2, -4],
    ["cost_usd", 3.05, 1.2, -1.85],
    ["failed_checks", 3, 0, -3],
    ["merged", 1, 2, 1],
    ["minutes", 44.1, 16.1, -28],
    ["requests", 3, 1, -2],
    ["set_aside", 1, 0, -1],
    ["turns", 95, 40, -55],
  ].map(([measure, earlier, later, change]) => ({ measure, earlier, later, change })),
  // Cost and tokens per merged ticket, by run
  [
    ["2026-10-20T06:00:00.000Z", "2026-10-20 06:00:00.12+00", 1, 3.05, 3.05, 2250300],
    ["2026-10-21T06:18:11.587Z", "2026-10-21 06:18:12.04+00", 2, 1.2, 0.6, 459000],
  ].map(([run, started, merged, cost_usd, cost_per_merged, tokens_per_merged]) => ({
    run,
    started,
    merged,
    cost_usd,
    cost_per_merged,
    tokens_per_merged,
  })),
  // The same across projects: the fixture as two projects' streams, the latest run first
  [
    ["2026-10-21 06:18:12.04+00", "2026-10-21T06:18:11.587Z", 2, 1.2, 0.6, 459000],
    ["2026-10-20 06:00:00.12+00", "2026-10-20T06:00:00.000Z", 1, 3.05, 3.05, 2250300],
  ].flatMap(([started, run, merged, cost_usd, cost_per_merged, tokens_per_merged]) =>
    ["other", "proj"].map((project) => ({
      started,
      project,
      run,
      merged,
      cost_usd,
      cost_per_merged,
      tokens_per_merged,
    })),
  ),
  // Each run's first, highest and last usage-window figures
  [
    ["2026-10-20T06:00:00.000Z", "five_hour", 42, 100, 3, "2026-10-20 11:40:00+00"],
    ["2026-10-20T06:00:00.000Z", "seven_day", 30, 36, 36, "2026-10-24 09:00:00+00"],
    ["2026-10-21T06:18:11.587Z", "five_hour", 10, 25, 25, "2026-10-21 10:00:00+00"],
    ["2026-10-21T06:18:11.587Z", "seven_day", 38, 40, 40, "2026-10-24 09:00:00+00"],
  ].map(([run, window, first_pct, peak_pct, last_pct, resets_at]) => ({
    run,
    window,
    first_pct,
    peak_pct,
    last_pct,
    resets_at,
  })),
]

test("the fixture's records are the event stream's, each decoding as its kind", () => {
  const lines = readFileSync(fixture, "utf8").trimEnd().split("\n")
  expect(lines.length).toBeGreaterThan(80)
  for (const line of lines) {
    const record = decodeLine(line)
    if (Result.isFailure(record)) throw new Error(`${line}: ${record.failure.message}`)
  }
})

test("the fixture's transcripts are tutti's, each line an item", () => {
  for (const file of transcripts) {
    const lines = readFileSync(file, "utf8").trimEnd().split("\n")
    expect(lines.length).toBeGreaterThan(3)
    for (const [i, line] of lines.entries()) {
      expect(decodeItem(line)?.seq).toBe(i + 1)
    }
  }
})

test("the doc defines the events and transcripts macros first, then each query with a line on what it answers", () => {
  expect(blocks[0]?.sql).toStartWith("CREATE OR REPLACE MACRO events(path) AS TABLE")
  expect(blocks[0]?.sql).toContain("CREATE OR REPLACE MACRO transcripts(path) AS TABLE")
  const queries = blocks.slice(1)
  expect(queries).toHaveLength(expected.length)
  for (const query of queries) {
    expect(query.answers).not.toStartWith("```")
    expect(query.answers.length).toBeGreaterThan(40)
    expect(query.sql).toMatch(/FROM (events|transcripts)\('/)
  }
})

// The machine's duckdb, which the tests' PATH leaves out (test/env.ts).
const duckdb = machineWhich("duckdb")

describe.skipIf(duckdb === null)("with the machine's duckdb", () => {
  // A home with two projects whose streams, transcripts and bd exports are the fixture's, for the
  // glob over ~/Projects.
  const home = mkdtempSync(join(tmpdir(), "tutti-analytics-"))
  const project = (name: string): string => {
    const dir = join(home, "Projects", name)
    mkdirSync(join(dir, ".tutti/run"), { recursive: true })
    mkdirSync(join(dir, ".beads"))
    copyFileSync(fixture, join(dir, ".tutti/run/events.jsonl"))
    cpSync(join(fixtures, "workers"), join(dir, ".tutti/run/workers"), { recursive: true })
    copyFileSync(join(fixtures, "issues.jsonl"), join(dir, ".beads/issues.jsonl"))
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
