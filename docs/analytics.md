# Analytics

Ready-made queries over tutti's [event stream](events.md) with DuckDB: what each run merged and
cost, where a ticket's time went, which checks fail, how long you kept workers waiting, how workers
go about a ticket, what each kind of ticket costs, and how it all changes from run to run. Back to
the [README](../README.md).

DuckDB reads `.tutti/run/events.jsonl` as it is, with no import and nothing to keep in step, and a
glob reads every project's at once. tutti doesn't embed it: you run its command-line tool beside
tutti, which goes on writing the file while you query it.

## Install DuckDB

```sh
brew install duckdb                      # macOS, or Linux with Homebrew
curl https://install.duckdb.org | sh     # elsewhere: into ~/.duckdb/cli/latest; put it on PATH
duckdb --version
```

The queries here are checked with DuckDB 1.5.6 and 2.0 (`test/analytics.test.ts`, which runs each of
them against `test/fixtures/analytics/events.jsonl` where `duckdb` is installed).

## The macros

The queries read the stream through one table macro, `events(path)`, which gives each record's
fields their types: times as timestamps, `tokens` as a map from model to its four counts, `phases`
as a map from phase to seconds. Naming the columns keeps a query working on a file that lacks some
kinds yet (a field no record has is `NULL`, not an error) and skips the fields no query here reads;
add one to `columns` to read it.

```sql
CREATE OR REPLACE MACRO events(path) AS TABLE
SELECT row_number() OVER () AS seq, *
FROM read_json(path, format = 'newline_delimited', filename = true, columns = {
  time: 'TIMESTAMPTZ', run: 'VARCHAR', kind: 'VARCHAR', ticket: 'VARCHAR', title: 'VARCHAR',
  detail: 'VARCHAR', text: 'VARCHAR', repo: 'VARCHAR', code: 'INTEGER', concurrency: 'INTEGER',
  "from": 'VARCHAR', "to": 'VARCHAR', cause: 'VARCHAR', why: 'VARCHAR', outcome: 'VARCHAR',
  seconds: 'DOUBLE', turns: 'INTEGER', cost_usd: 'DOUBLE',
  tokens: 'MAP(VARCHAR, STRUCT(input BIGINT, output BIGINT, cache_write BIGINT, cache_read BIGINT))',
  phases: 'MAP(VARCHAR, DOUBLE)', hand_backs: 'STRUCT(resolve INTEGER, fix INTEGER)',
  carried: 'BOOLEAN', aside: 'BOOLEAN',
  organs: 'STRUCT(calls INTEGER, turns INTEGER, cost_usd DOUBLE)',
  suite: 'VARCHAR', command: 'VARCHAR', result: 'VARCHAR', output: 'VARCHAR',
  request: 'VARCHAR', type: 'VARCHAR', tool: 'VARCHAR', summary: 'VARCHAR', questions: 'JSON',
  answer: 'VARCHAR', via: 'VARCHAR', after_ms: 'BIGINT', cancelled: 'BOOLEAN',
  reason_type: 'VARCHAR', reason: 'VARCHAR',
  status: 'VARCHAR', "limit": 'VARCHAR', resets_at: 'TIMESTAMPTZ', session: 'VARCHAR',
  "window": 'VARCHAR', utilization: 'DOUBLE'
});

CREATE OR REPLACE MACRO transcripts(path) AS TABLE
SELECT regexp_extract(filename, '([^/]+)/messages\.jsonl$', 1) AS ticket, *
FROM read_json(path, format = 'newline_delimited', filename = true, columns = {
  seq: 'BIGINT', session: 'VARCHAR', time: 'TIMESTAMPTZ', message: 'JSON'
});
```

`seq` is the record's place in the file, which orders records written in the same millisecond, and
`filename` the file it came from.

The second macro, `transcripts(path)`, reads the workers' transcripts the same way: each ticket's
worker writes every SDK message its session sends to `.tutti/run/workers/<ticket>/messages.jsonl`,
one a line in tutti's envelope (`seq`, `session`, `time`, and the SDK's `message` as it came), and
`ticket` is the folder's name. A glob, `.tutti/run/workers/*/messages.jsonl`, reads every ticket's.

Save the macros in `~/.duckdbrc`, which the `duckdb` command runs as it starts, and run `duckdb` in
the project's main checkout; or keep them in a file of their own and load it with `duckdb -init
tutti.sql`. For one query from the shell, `duckdb -init tutti.sql -c "<query>"`; `-json` or `-csv`
before `-c` gives its rows to another program.

Costs are the SDK's estimates at list prices, not a bill (see
[What runs spend](events.md#what-runs-spend)). Times show in your time zone (`SET TimeZone = 'UTC'`
for another).

## Runs

Each run: when it started, how long it went, the tickets it merged, closed with no change, set aside,
left waiting on you, stopped and left back in the queue, its exit code (none while it goes, or when it was killed) and what
its workers and organs cost.

```sql
WITH ends AS (  -- each ticket's last ticket_end in a run, which gives its whole
  SELECT run, ticket, outcome FROM events('.tutti/run/events.jsonl')
  WHERE kind = 'ticket_end'
  QUALIFY row_number() OVER (PARTITION BY run, ticket ORDER BY time DESC, seq DESC) = 1
), runs AS (
  SELECT run, min(time) AS started, max(time) AS last, max(code) FILTER (kind = 'end') AS code,
    sum(cost_usd) FILTER (kind IN ('turn', 'organ')) AS cost_usd
  FROM events('.tutti/run/events.jsonl') GROUP BY run
)
SELECT r.run, r.started, round(date_diff('second', r.started, r.last) / 60, 1) AS minutes,
  count(e.ticket) FILTER (e.outcome = 'merged') AS merged,
  count(e.ticket) FILTER (e.outcome = 'no_change') AS no_change,
  count(e.ticket) FILTER (e.outcome = 'set_aside') AS set_aside,
  count(e.ticket) FILTER (e.outcome = 'needs_you') AS needs_you,
  count(e.ticket) FILTER (e.outcome = 'stopped') AS stopped,
  count(e.ticket) FILTER (e.outcome = 'queued') AS queued,
  r.code, round(r.cost_usd, 2) AS cost_usd
FROM runs r LEFT JOIN ends e USING (run)
GROUP BY ALL ORDER BY r.started;
```

## Throughput and bottlenecks

The tickets each run merged in each hour since it started, an hour with none included.

```sql
WITH runs AS (
  SELECT run, min(time) AS started, max(time) AS last FROM events('.tutti/run/events.jsonl')
  GROUP BY run
), hours AS (
  SELECT run, started, unnest(range(ceil(date_diff('second', started, last) / 3600)::BIGINT))
    AS hour
  FROM runs
), merged AS (  -- when each ticket merged
  SELECT run, ticket, max(time) AS time FROM events('.tutti/run/events.jsonl')
  WHERE kind = 'ticket_end' AND outcome = 'merged' GROUP BY ALL
)
SELECT h.run, h.hour + 1 AS hour, count(m.ticket) AS merged
FROM hours h LEFT JOIN merged m
  ON m.run = h.run AND floor(date_diff('second', h.started, m.time) / 3600) = h.hour
GROUP BY ALL ORDER BY h.run, hour;
```

Whether more workers would have helped: how many of each run's slots were busy on average, the
share of its time every slot was busy, the minutes tickets spent queued for a slot (one ticket's
minute each), and how many of those minutes every slot was busy. A slot is busy while its ticket's
worker is at work, in `Working`, `Resolving` or `Fixing`; the time counts from the run's first
`phase` record to its last. Queued minutes with every slot busy were a slot short; queued minutes
with one free waited on something else.

```sql
WITH changes AS (  -- what each phase record adds to the slots busy and to the queue
  SELECT run, time, seq,
    (coalesce("to", '') IN ('Working', 'Resolving', 'Fixing'))::INTEGER
      - (coalesce("from", '') IN ('Working', 'Resolving', 'Fixing'))::INTEGER AS busy,
    (coalesce("to", '') = 'Queued')::INTEGER - (coalesce("from", '') = 'Queued')::INTEGER AS queued
  FROM events('.tutti/run/events.jsonl') WHERE kind = 'phase'
), spans AS (  -- from each phase record to the run's next: the slots busy and the tickets queued
  SELECT run, sum(busy) OVER run_so_far AS busy, sum(queued) OVER run_so_far AS queued,
    date_diff('millisecond', time, lead(time) OVER (PARTITION BY run ORDER BY time, seq)) / 1000
      AS seconds
  FROM changes
  WINDOW run_so_far AS (PARTITION BY run ORDER BY time, seq ROWS UNBOUNDED PRECEDING)
), slots AS (
  SELECT run, max(concurrency) AS slots FROM events('.tutti/run/events.jsonl')
  WHERE kind = 'start' GROUP BY run
)
SELECT run, slots, round(sum(busy * seconds) / sum(seconds), 1) AS busy_slots,
  round(100 * coalesce(sum(seconds) FILTER (busy >= slots), 0) / sum(seconds), 1) AS all_busy_pct,
  round(sum(queued * seconds) / 60, 1) AS queued_minutes,
  round(coalesce(sum(queued * seconds) FILTER (busy >= slots), 0) / 60, 1) AS queued_all_busy
FROM spans JOIN slots USING (run) WHERE seconds IS NOT NULL
GROUP BY ALL ORDER BY run;
```

Where the tickets' time went in each run: the minutes in each phase, all tickets together, and their
share of the run's ticket-time. As in the phase records' query under Tickets, a ticket's last phase
in a run counts no time.

```sql
WITH spans AS (
  SELECT run, "to" AS phase,
    date_diff('millisecond', time,
      lead(time) OVER (PARTITION BY run, ticket ORDER BY time, seq)) / 1000 AS seconds
  FROM events('.tutti/run/events.jsonl') WHERE kind = 'phase'
)
SELECT run, phase, round(sum(seconds) / 60, 1) AS minutes,
  round(100 * sum(seconds) / sum(sum(seconds)) OVER (PARTITION BY run), 1) AS pct
FROM spans WHERE phase IS NOT NULL AND seconds IS NOT NULL
GROUP BY run, phase ORDER BY run, minutes DESC, phase;
```

The time tickets were held back in each run, by the reason their `phase` records give as `why`
(`overlap`, `solo`, `merge`, `parent` or `setup`), with how many times a ticket was held back for
it, how many tickets, and the minutes.

```sql
WITH spans AS (
  SELECT run, ticket, "to" AS phase, why,
    date_diff('millisecond', time,
      lead(time) OVER (PARTITION BY run, ticket ORDER BY time, seq)) / 1000 AS seconds
  FROM events('.tutti/run/events.jsonl') WHERE kind = 'phase'
)
SELECT run, why, count(*) AS times, count(DISTINCT ticket) AS tickets,
  round(sum(seconds) / 60, 1) AS minutes
FROM spans WHERE phase = 'HeldBack'
GROUP BY run, why ORDER BY run, minutes DESC NULLS LAST, why;
```

## Tickets

Each ticket, across the runs that took it up: how it ended, its workers' cost, tokens and model
round-trips, the minutes from its first dispatch to its merge, and how often it was resumed and
handed back.

```sql
WITH ends AS (
  SELECT * FROM events('.tutti/run/events.jsonl') WHERE kind = 'ticket_end'
  QUALIFY row_number() OVER (PARTITION BY run, ticket ORDER BY time DESC, seq DESC) = 1
), spent AS (
  SELECT ticket, count(*) AS runs, arg_max(outcome, time) AS outcome,
    round(sum(cost_usd), 2) AS cost_usd, sum(turns)::BIGINT AS turns,
    sum(list_sum([t.input + t.output + t.cache_write + t.cache_read for t in map_values(tokens)]))
      ::BIGINT AS tokens,
    sum(hand_backs.resolve)::BIGINT AS resolves, sum(hand_backs.fix)::BIGINT AS fixes
  FROM ends GROUP BY ticket
), times AS (
  SELECT ticket, min(time) FILTER (kind = 'dispatch') AS dispatched,
    max(time) FILTER (kind = 'ticket_end' AND outcome = 'merged') AS merged,
    count(*) FILTER (kind = 'resumed') AS resumes
  FROM events('.tutti/run/events.jsonl') GROUP BY ticket
)
SELECT ticket, outcome, runs, cost_usd, tokens, turns,
  round(date_diff('second', dispatched, merged) / 60, 1) AS minutes_to_merge,
  resumes, resolves, fixes
FROM spent JOIN times USING (ticket)
ORDER BY cost_usd DESC NULLS LAST, ticket;
```

Time per phase: how long each ticket spent in each phase it entered, from its `phase` records, and
how many times it entered it. A ticket's last phase in a run has no record after it, so it counts
no time.

```sql
WITH spans AS (
  SELECT ticket, "to" AS phase,
    date_diff('millisecond', time,
      lead(time) OVER (PARTITION BY run, ticket ORDER BY time, seq)) / 1000 AS seconds
  FROM events('.tutti/run/events.jsonl') WHERE kind = 'phase'
)
SELECT ticket, phase, count(*) AS entered, round(sum(seconds), 1) AS seconds
FROM spans WHERE phase IS NOT NULL AND seconds IS NOT NULL
GROUP BY ALL ORDER BY ticket, seconds DESC, phase;
```

The same from the records that end a ticket's part in a run, which count the time in `Working`,
`ToMerge`, `Merging`, `Resolving` and `Fixing` only: seconds by phase, one row a ticket.

```sql
PIVOT (
  SELECT ticket, unnest(map_keys(phases)) AS phase, unnest(map_values(phases)) AS seconds
  FROM events('.tutti/run/events.jsonl') WHERE kind = 'ticket_end'
  QUALIFY row_number() OVER (PARTITION BY run, ticket ORDER BY time DESC, seq DESC) = 1
) ON phase IN ('working', 'waiting', 'merging', 'resolving', 'fixing') USING sum(seconds)
GROUP BY ticket ORDER BY ticket;
```

## Checks

Each kind of check and command: how often it ran and failed, and how long it took.

```sql
SELECT suite, command, count(*) AS runs,
  count(*) FILTER (result <> 'passed') AS failed,
  count(*) FILTER (result = 'timed_out') AS timed_out,
  round(median(seconds), 1) AS median_seconds, round(max(seconds), 1) AS max_seconds
FROM events('.tutti/run/events.jsonl') WHERE kind = 'check'
GROUP BY ALL ORDER BY runs DESC, suite, command;
```

The checks that didn't pass, latest first, with where their output is.

```sql
SELECT time, suite, ticket, command, result, seconds, output
FROM events('.tutti/run/events.jsonl')
WHERE kind = 'check' AND result <> 'passed'
ORDER BY time DESC;
```

## Quality

What each ticket needed besides its first merge check: its hand-backs to its worker, for conflicts
(`resolves`) and for a failing check (`fixes`), its rechecks after a failed check, and its checks
of every kind and those that didn't pass.

```sql
WITH ends AS (  -- each ticket's last ticket_end in a run
  SELECT ticket, hand_backs FROM events('.tutti/run/events.jsonl') WHERE kind = 'ticket_end'
  QUALIFY row_number() OVER (PARTITION BY run, ticket ORDER BY time DESC, seq DESC) = 1
), hand_backs AS (
  SELECT ticket, sum(hand_backs.resolve)::BIGINT AS resolves, sum(hand_backs.fix)::BIGINT AS fixes
  FROM ends GROUP BY ticket
), checks AS (
  SELECT ticket, count(*) FILTER (suite = 'recheck') AS rechecks,
    count(*) FILTER (suite IN ('merge', 'recheck', 'fix')) AS checks,
    count(*) FILTER (suite IN ('merge', 'recheck', 'fix') AND result <> 'passed') AS failed
  FROM events('.tutti/run/events.jsonl') WHERE kind = 'check' AND ticket IS NOT NULL
  GROUP BY ticket
)
SELECT ticket, coalesce(resolves, 0) AS resolves, coalesce(fixes, 0) AS fixes,
  coalesce(rechecks, 0) AS rechecks, coalesce(checks, 0) AS checks, coalesce(failed, 0) AS failed
FROM hand_backs FULL JOIN checks USING (ticket)
ORDER BY resolves + fixes + rechecks DESC, failed DESC, ticket;
```

The tests that failed and then passed on a rerun, from the `FLAKY` warnings: how often, in how many
runs, when last, and in whose checks. A check that names more flaky tests than tutti keeps says how
many more without naming them: those are left out.

```sql
SELECT regexp_extract(text, 'passed on a rerun: (.*)$', 1) AS test, count(*) AS times,
  count(DISTINCT run) AS runs, max(time) AS last,
  array_to_string(list_sort(list(DISTINCT coalesce(ticket, 'the full check'))), ', ') AS tickets
FROM events('.tutti/run/events.jsonl')
WHERE kind = 'warn' AND regexp_matches(text, '^\s*FLAKY: .* passed on a rerun: ')
GROUP BY test ORDER BY times DESC, last DESC;
```

How long each kind of check took in each run, the latest run of a kind last: the median, the
90th percentile and the longest.

```sql
SELECT run, suite, count(*) AS runs, round(median(seconds), 1) AS median_seconds,
  round(quantile_cont(seconds, 0.9), 1) AS p90_seconds, round(max(seconds), 1) AS max_seconds
FROM events('.tutti/run/events.jsonl') WHERE kind = 'check'
GROUP BY ALL ORDER BY suite, run;
```

The checks that ran out of time (`result = 'timed_out'`), latest first, with their ticket and where
their output is.

```sql
SELECT time, suite, ticket, command, seconds, output
FROM events('.tutti/run/events.jsonl')
WHERE kind = 'check' AND result = 'timed_out'
ORDER BY time DESC;
```

## Waiting on you

Each request a worker made of you: what it asked, how it was answered, and how long it waited.
`answered` is `withdrawn` where Claude Code took the request back, and `open` where it has no answer.

```sql
SELECT a.time, a.ticket, a.type, coalesce(a.summary, a.questions -> 0 ->> 'question') AS asked,
  CASE WHEN w.cancelled THEN 'withdrawn' WHEN w.request IS NULL THEN 'open'
    ELSE w.answer END AS answered,
  w.via, round(w.after_ms / 1000, 1) AS waited_seconds
FROM events('.tutti/run/events.jsonl') a
LEFT JOIN events('.tutti/run/events.jsonl') w
  ON w.kind = 'attention_answered' AND w.run = a.run AND w.request = a.request
WHERE a.kind = 'attention'
ORDER BY a.time;
```

The requests by type and tool: how many, and how long they waited for you.

```sql
SELECT a.type, a.tool, count(*) AS requests,
  count(w.request) FILTER (NOT coalesce(w.cancelled, false)) AS answered,
  count(*) FILTER (w.cancelled) AS withdrawn,
  round(median(w.after_ms) FILTER (NOT coalesce(w.cancelled, false)) / 1000, 1)
    AS median_wait_seconds,
  round(sum(w.after_ms) / 60000, 1) AS minutes_waited
FROM events('.tutti/run/events.jsonl') a
LEFT JOIN events('.tutti/run/events.jsonl') w
  ON w.kind = 'attention_answered' AND w.run = a.run AND w.request = a.request
WHERE a.kind = 'attention'
GROUP BY ALL ORDER BY requests DESC, a.type, a.tool;
```

How long workers waited for your answer, by type of request (`permission`, `question` or
`elicitation`): the requests, those answered, the median and the longest wait for an answer, and
the minutes they waited in all, withdrawn requests included.

```sql
SELECT a.type, count(*) AS requests, count(w.request) FILTER (NOT w.cancelled) AS answered,
  round(median(w.after_ms) FILTER (NOT w.cancelled) / 1000, 1) AS median_seconds,
  round(max(w.after_ms) FILTER (NOT w.cancelled) / 1000, 1) AS longest_seconds,
  round(sum(w.after_ms) / 60000, 1) AS minutes_waited
FROM events('.tutti/run/events.jsonl') a
LEFT JOIN (SELECT * REPLACE (coalesce(cancelled, false) AS cancelled)
    FROM events('.tutti/run/events.jsonl')) w
  ON w.kind = 'attention_answered' AND w.run = a.run AND w.request = a.request
WHERE a.kind = 'attention'
GROUP BY a.type ORDER BY minutes_waited DESC NULLS LAST, a.type;
```

Each question a worker filed for you as a ticket, and how long it took to be answered: from its
`asked` record, as the worker filed it, to its `answered` record, as a run saw the answer, which
may be a later run's. A question not answered yet has no `answered`.

```sql
WITH asked AS (
  SELECT ticket, split_part(detail, ':', 1) AS question, min(time) AS asked
  FROM events('.tutti/run/events.jsonl') WHERE kind = 'asked' GROUP BY ALL
), answered AS (
  SELECT ticket, split_part(detail, ':', 1) AS question, min(time) AS answered
  FROM events('.tutti/run/events.jsonl') WHERE kind = 'answered' GROUP BY ALL
)
SELECT ticket, question, asked, answered,
  round(date_diff('second', asked, answered) / 3600, 1) AS hours
FROM asked LEFT JOIN answered USING (ticket, question)
ORDER BY asked;
```

The tool calls Claude Code refused without asking you (`denied`), by tool and the reason it gave:
how many, for how many tickets, and when last.

```sql
SELECT tool, reason_type, reason, count(*) AS denied, count(DISTINCT ticket) AS tickets,
  max(time) AS last
FROM events('.tutti/run/events.jsonl') WHERE kind = 'denied'
GROUP BY ALL ORDER BY denied DESC, tool, reason_type, reason;
```

## How workers work

The tools each ticket's worker called, from its transcript: `Bash`, `Edit`, `Write`, `Read`, `Agent`
and the rest, and the calls its subagents made under its `Agent` calls, which the others leave
out.

```sql
WITH calls AS (  -- each tool call, and the Agent call it was made under, if a subagent made it
  SELECT ticket, message ->> 'parent_tool_use_id' AS parent,
    unnest(message -> '$.message.content[*]') AS block
  FROM transcripts('.tutti/run/workers/*/messages.jsonl') WHERE message ->> 'type' = 'assistant'
)
SELECT ticket, count(*) FILTER (parent IS NULL) AS calls,
  count(*) FILTER (parent IS NULL AND block ->> 'name' = 'Bash') AS bash,
  count(*) FILTER (parent IS NULL AND block ->> 'name' = 'Edit') AS edit,
  count(*) FILTER (parent IS NULL AND block ->> 'name' = 'Write') AS write,
  count(*) FILTER (parent IS NULL AND block ->> 'name' = 'Read') AS read,
  count(*) FILTER (parent IS NULL AND block ->> 'name' = 'Agent') AS agent,
  count(*) FILTER (parent IS NULL
    AND block ->> 'name' NOT IN ('Bash', 'Edit', 'Write', 'Read', 'Agent')) AS other,
  count(*) FILTER (parent IS NOT NULL) AS subagents
FROM calls WHERE block ->> 'type' = 'tool_use'
GROUP BY ticket ORDER BY calls DESC, ticket;
```

The Bash calls that edit files, beside the `Edit` and `Write` calls: a script on standard input
(`python3 - <<'EOF'`), `sed -i`, `perl -i`, `cat >` and `tee`; their share of the worker's edits;
and the first of them. A script on standard input may only read; the pattern counts it all the
same.

```sql
WITH calls AS (  -- the workers' own tool calls, and whether each edits a file
  SELECT ticket, time, block ->> 'name' AS tool, block ->> '$.input.command' AS command,
    tool IN ('Edit', 'MultiEdit', 'Write', 'NotebookEdit') AS edits,
    tool = 'Bash' AND regexp_matches(command,
      '(python3?|node|bun|ruby|perl)( +-[A-Za-z]+)* +- *<<|sed +(-[A-Za-z]+ +)*-i|perl +-[a-z]*i'
      || '|cat +(<<[^>]*)?>|\btee\b') AS bash_edits
  FROM (
    SELECT ticket, time, unnest(message -> '$.message.content[*]') AS block
    FROM transcripts('.tutti/run/workers/*/messages.jsonl')
    WHERE message ->> 'type' = 'assistant' AND message ->> 'parent_tool_use_id' IS NULL
  ) WHERE block ->> 'type' = 'tool_use'
)
SELECT ticket, count(*) FILTER (tool = 'Edit') AS edit, count(*) FILTER (tool = 'Write') AS write,
  count(*) FILTER (bash_edits) AS bash_edits,
  round(100 * count(*) FILTER (bash_edits) / count(*) FILTER (edits OR bash_edits), 1) AS bash_pct,
  arg_min(split_part(command, chr(10), 1), time) FILTER (bash_edits) AS first_bash_edit
FROM calls GROUP BY ticket ORDER BY bash_edits DESC, ticket;
```

The minutes from a ticket's dispatch in a run to its worker's first edit there (an `Edit`, a
`Write`, or a Bash call as above): how long it read before it changed anything. A ticket whose
worker edited nothing in the run has none.

```sql
WITH dispatched AS (  -- each ticket's first dispatch in a run, and the run's last record
  SELECT run, ticket, min(time) FILTER (kind = 'dispatch') AS dispatched,
    any_value(last) AS last
  FROM (SELECT *, max(time) OVER (PARTITION BY run) AS last FROM events('.tutti/run/events.jsonl'))
  GROUP BY run, ticket HAVING dispatched IS NOT NULL
), edits AS (  -- the workers' own calls that edit a file: Edit, Write, or Bash as above
  SELECT ticket, time FROM (
    SELECT ticket, time, unnest(message -> '$.message.content[*]') AS block
    FROM transcripts('.tutti/run/workers/*/messages.jsonl')
    WHERE message ->> 'type' = 'assistant' AND message ->> 'parent_tool_use_id' IS NULL
  )
  WHERE block ->> 'type' = 'tool_use'
    AND (block ->> 'name' IN ('Edit', 'MultiEdit', 'Write', 'NotebookEdit')
      OR block ->> 'name' = 'Bash' AND regexp_matches(block ->> '$.input.command',
        '(python3?|node|bun|ruby|perl)( +-[A-Za-z]+)* +- *<<|sed +(-[A-Za-z]+ +)*-i'
        || '|perl +-[a-z]*i|cat +(<<[^>]*)?>|\btee\b'))
)
SELECT d.run, d.ticket, d.dispatched, min(e.time) AS first_edit,
  round(date_diff('second', d.dispatched, min(e.time)) / 60, 1) AS minutes
FROM dispatched d
LEFT JOIN edits e ON e.ticket = d.ticket AND e.time BETWEEN d.dispatched AND d.last
GROUP BY d.run, d.ticket, d.dispatched ORDER BY d.run, d.dispatched;
```

Each run of the verifier subagent, by ticket and round: its verdict, `PASS` or `FAIL` (`?` where its
report gives neither), the first line of its report after the verdict, and the whole report. The
report comes back in a `task_notification` message, or as the `Agent` call's result.

```sql
WITH messages AS (
  SELECT ticket, time, seq, message,
    unnest(message -> '$.message.content[*]') AS block
  FROM transcripts('.tutti/run/workers/*/messages.jsonl')
  WHERE message ->> 'parent_tool_use_id' IS NULL
), runs AS (  -- the worker's Agent calls of the verifier
  SELECT ticket, time, seq, block ->> 'id' AS id FROM messages
  WHERE message ->> 'type' = 'assistant' AND block ->> 'name' = 'Agent'
    AND block ->> '$.input.subagent_type' = 'verifier'
), reports AS (  -- its report: handed back in a task_notification, or as the call's result
  SELECT message ->> 'tool_use_id' AS id, message ->> '$.handback_report.text' AS report
  FROM transcripts('.tutti/run/workers/*/messages.jsonl')
  WHERE message ->> 'subtype' = 'task_notification' AND message ->> '$.handback_report.text' <> ''
  UNION ALL
  SELECT block ->> 'tool_use_id', CASE json_type(block -> 'content')
      WHEN 'VARCHAR' THEN block ->> 'content' ELSE block ->> '$.content[0].text' END
  FROM messages WHERE block ->> 'type' = 'tool_result'
)
SELECT r.ticket, row_number() OVER (PARTITION BY r.ticket ORDER BY r.time, r.seq) AS round,
  r.time, coalesce(nullif(regexp_extract(any_value(p.report), '\b(PASS|FAIL)\b', 1), ''), '?')
    AS verdict,
  left(regexp_extract(regexp_replace(any_value(p.report), '^\W*(PASS|FAIL)\W*', ''), '^[^\n]*'),
    100) AS found,
  any_value(p.report) AS report
FROM runs r LEFT JOIN reports p
  ON p.id = r.id AND NOT starts_with(p.report, 'This agent''s report was delivered')
GROUP BY r.ticket, r.time, r.seq ORDER BY r.ticket, round;
```

## The backlog

These join the events with bd's export of the tickets, `.beads/issues.jsonl` in the main checkout,
for each ticket's type, priority, labels and filing time. Where the project doesn't keep the
export, `bd export -o .beads/issues.jsonl` writes it. Costs are the SDK's estimates at list prices.

What each issue type, priority and label cost: the tickets the runs took up, those merged, their
workers' cost, the cost for each ticket merged, their tokens and the median minutes from dispatch to
merge. A ticket with two labels counts under each.

```sql
WITH issues AS (  -- bd's export: an issue's type, priority and labels
  SELECT * FROM read_json('.beads/issues.jsonl', format = 'newline_delimited', columns = {
    _type: 'VARCHAR', id: 'VARCHAR', issue_type: 'VARCHAR', priority: 'INTEGER',
    labels: 'VARCHAR[]', created_at: 'TIMESTAMPTZ'
  }) WHERE coalesce(_type, 'issue') = 'issue'
), facets AS (
  SELECT id, 'type' AS by, issue_type AS value FROM issues
  UNION ALL SELECT id, 'priority', 'P' || priority FROM issues
  UNION ALL SELECT id, 'label', unnest(labels) FROM issues
), ends AS (  -- each ticket's last ticket_end in a run
  SELECT * FROM events('.tutti/run/events.jsonl') WHERE kind = 'ticket_end'
  QUALIFY row_number() OVER (PARTITION BY run, ticket ORDER BY time DESC, seq DESC) = 1
), spent AS (  -- what each ticket's workers spent across runs, and whether it merged
  SELECT ticket, sum(cost_usd) AS cost_usd, bool_or(outcome = 'merged') AS merged,
    sum(list_sum([t.input + t.output + t.cache_write + t.cache_read for t in map_values(tokens)]))
      AS tokens
  FROM ends GROUP BY ticket
), times AS (
  SELECT ticket, date_diff('second', min(time) FILTER (kind = 'dispatch'),
      max(time) FILTER (kind = 'ticket_end' AND outcome = 'merged')) / 60 AS minutes_to_merge
  FROM events('.tutti/run/events.jsonl') GROUP BY ticket
)
SELECT f.by, f.value, count(*) AS tickets, count(*) FILTER (s.merged) AS merged,
  round(sum(s.cost_usd), 2) AS cost_usd,
  round(sum(s.cost_usd) FILTER (s.merged) / count(*) FILTER (s.merged), 2) AS cost_per_merged,
  sum(s.tokens)::BIGINT AS tokens, round(median(t.minutes_to_merge), 1) AS median_minutes_to_merge
FROM spent s JOIN facets f ON f.id = s.ticket JOIN times t USING (ticket)
GROUP BY ALL ORDER BY f.by, cost_usd DESC, f.value;
```

Each merged ticket's lead time, from its filing in bd (`created_at`) to its merge, and the hours of
it before its first dispatch.

```sql
WITH issues AS (
  SELECT * FROM read_json('.beads/issues.jsonl', format = 'newline_delimited', columns = {
    _type: 'VARCHAR', id: 'VARCHAR', issue_type: 'VARCHAR', priority: 'INTEGER',
    created_at: 'TIMESTAMPTZ'
  }) WHERE coalesce(_type, 'issue') = 'issue'
), times AS (
  SELECT ticket, min(time) FILTER (kind = 'dispatch') AS dispatched,
    max(time) FILTER (kind = 'ticket_end' AND outcome = 'merged') AS merged
  FROM events('.tutti/run/events.jsonl') GROUP BY ticket HAVING merged IS NOT NULL
)
SELECT t.ticket, i.issue_type, i.priority, i.created_at AS filed, t.merged,
  round(date_diff('second', i.created_at, t.dispatched) / 3600, 1) AS hours_to_dispatch,
  round(date_diff('second', i.created_at, t.merged) / 3600, 1) AS lead_hours
FROM times t JOIN issues i ON i.id = t.ticket
ORDER BY t.merged;
```

## The usage limit

Each time the account reached a usage limit: when, which limit, when it said it resets, when the
run's hold lifted, and the minutes the run held; `held_in_run` sums them over the run. A window
the run ended in has no `lifted`.

```sql
WITH changes AS (
  SELECT run, time, status, "limit", resets_at,
    lead(time) OVER (PARTITION BY run ORDER BY time, seq) AS lifted
  FROM events('.tutti/run/events.jsonl')
  WHERE kind = 'usage_limit' AND status IN ('rejected', 'lifted')
)
SELECT run, time AS reached, "limit", resets_at, lifted,
  round(date_diff('second', time, lifted) / 60, 1) AS minutes_held,
  round(sum(date_diff('second', time, lifted)) OVER (PARTITION BY run) / 60, 1) AS held_in_run
FROM changes WHERE status = 'rejected'
ORDER BY reached;
```

## The prompt cache

The cache's share of the input tokens, by run and model: the tokens read from the prompt cache, of
all the tokens the workers' turns gave the model (`input`, `cache_write` and `cache_read`). The
higher, the cheaper the turns.

```sql
WITH used AS (
  SELECT run, unnest(map_keys(tokens)) AS model, unnest(map_values(tokens)) AS t
  FROM events('.tutti/run/events.jsonl') WHERE kind = 'turn'
)
SELECT run, model, sum(t.input)::BIGINT AS input, sum(t.cache_write)::BIGINT AS cache_write,
  sum(t.cache_read)::BIGINT AS cache_read,
  round(100 * sum(t.cache_read) / sum(t.input + t.cache_write + t.cache_read), 1) AS cache_read_pct
FROM used GROUP BY ALL ORDER BY run, model;
```

## Every project

Each week across every project under `~/Projects`, a glob over their streams: the runs, the tickets
merged and set aside, the hours the runs went, and the cost. The latest week is the first row.

```sql
WITH stream AS (
  SELECT regexp_extract(filename, '([^/]+)/\.tutti/run/events\.jsonl$', 1) AS project, *
  FROM events('~/Projects/*/.tutti/run/events.jsonl')
), ends AS (  -- each ticket's last ticket_end in a run
  SELECT project, run, ticket, outcome FROM stream WHERE kind = 'ticket_end'
  QUALIFY row_number() OVER (PARTITION BY project, run, ticket ORDER BY time DESC, seq DESC) = 1
), tickets AS (
  SELECT project, run, count(*) FILTER (outcome = 'merged') AS merged,
    count(*) FILTER (outcome = 'set_aside') AS set_aside
  FROM ends GROUP BY ALL
), runs AS (
  SELECT project, run, min(time) AS started, date_diff('second', min(time), max(time)) AS seconds,
    sum(cost_usd) FILTER (kind IN ('turn', 'organ')) AS cost_usd
  FROM stream GROUP BY ALL
)
SELECT date_trunc('week', started) AS week, project, count(*) AS runs,
  coalesce(sum(merged), 0)::BIGINT AS merged, coalesce(sum(set_aside), 0)::BIGINT AS set_aside,
  round(sum(seconds) / 3600, 1) AS hours, round(sum(cost_usd), 2) AS cost_usd
FROM runs LEFT JOIN tickets USING (project, run)
GROUP BY ALL ORDER BY week DESC, project;
```

## Two runs side by side

The latest two runs compared, a row for each measure; to compare two others, pick them by their
`run` in `two`, as the comment there says.

```sql
WITH ends AS (  -- each ticket's last ticket_end in a run
  SELECT run, ticket, outcome FROM events('.tutti/run/events.jsonl') WHERE kind = 'ticket_end'
  QUALIFY row_number() OVER (PARTITION BY run, ticket ORDER BY time DESC, seq DESC) = 1
), tickets AS (
  SELECT run, count(*) FILTER (outcome = 'merged') AS merged,
    count(*) FILTER (outcome = 'set_aside') AS set_aside
  FROM ends GROUP BY run
), per_run AS (
  SELECT run,
    coalesce(any_value(t.merged), 0)::DOUBLE AS merged,
    coalesce(any_value(t.set_aside), 0)::DOUBLE AS set_aside,
    round(date_diff('second', min(time), max(time)) / 60, 1)::DOUBLE AS minutes,
    round(sum(cost_usd) FILTER (kind IN ('turn', 'organ')), 2)::DOUBLE AS cost_usd,
    sum(turns) FILTER (kind = 'turn')::DOUBLE AS turns,
    count(*) FILTER (kind = 'check')::DOUBLE AS checks,
    count(*) FILTER (kind = 'check' AND result <> 'passed')::DOUBLE AS failed_checks,
    count(*) FILTER (kind = 'attention')::DOUBLE AS requests
  FROM events('.tutti/run/events.jsonl') LEFT JOIN tickets t USING (run) GROUP BY run
), two AS (
  SELECT *, row_number() OVER (ORDER BY run) AS pos
  FROM (SELECT * FROM per_run ORDER BY run DESC LIMIT 2)
  -- or two runs of your choice: FROM per_run WHERE run IN ('2026-10-20T06:00:00.000Z', '…')
), measures AS (
  UNPIVOT two ON COLUMNS(* EXCLUDE (run, pos)) INTO NAME measure VALUE value
)
SELECT measure, max(value) FILTER (pos = 1) AS earlier, max(value) FILTER (pos = 2) AS later,
  round(later - earlier, 2) AS change
FROM measures GROUP BY measure ORDER BY measure;
```

## Trends

What each run spent for each ticket it merged, over time: its workers' and organs' cost and its
workers' tokens, divided by the tickets merged. Costs are the SDK's estimates at list prices.

```sql
WITH ends AS (  -- each ticket's last ticket_end in a run
  SELECT run, ticket, outcome FROM events('.tutti/run/events.jsonl') WHERE kind = 'ticket_end'
  QUALIFY row_number() OVER (PARTITION BY run, ticket ORDER BY time DESC, seq DESC) = 1
), merged AS (
  SELECT run, count(*) FILTER (outcome = 'merged') AS merged FROM ends GROUP BY run
), runs AS (
  SELECT run, min(time) AS started,
    sum(cost_usd) FILTER (kind IN ('turn', 'organ')) AS cost_usd,
    sum(list_sum([t.input + t.output + t.cache_write + t.cache_read for t in map_values(tokens)]))
      FILTER (kind = 'turn') AS tokens
  FROM events('.tutti/run/events.jsonl') GROUP BY run
)
SELECT run, started, coalesce(merged, 0) AS merged, round(cost_usd, 2) AS cost_usd,
  round(cost_usd / nullif(merged, 0), 2) AS cost_per_merged,
  (tokens / nullif(merged, 0))::BIGINT AS tokens_per_merged
FROM runs LEFT JOIN merged USING (run) ORDER BY started;
```

The same for every project under `~/Projects`, as Every project reads them: a row for each run of
each project, the latest first.

```sql
WITH stream AS (
  SELECT regexp_extract(filename, '([^/]+)/\.tutti/run/events\.jsonl$', 1) AS project, *
  FROM events('~/Projects/*/.tutti/run/events.jsonl')
), ends AS (  -- each ticket's last ticket_end in a run
  SELECT project, run, ticket, outcome FROM stream WHERE kind = 'ticket_end'
  QUALIFY row_number() OVER (PARTITION BY project, run, ticket ORDER BY time DESC, seq DESC) = 1
), merged AS (
  SELECT project, run, count(*) FILTER (outcome = 'merged') AS merged FROM ends GROUP BY ALL
), runs AS (
  SELECT project, run, min(time) AS started,
    sum(cost_usd) FILTER (kind IN ('turn', 'organ')) AS cost_usd,
    sum(list_sum([t.input + t.output + t.cache_write + t.cache_read for t in map_values(tokens)]))
      FILTER (kind = 'turn') AS tokens
  FROM stream GROUP BY ALL
)
SELECT started, project, run, coalesce(merged, 0) AS merged, round(cost_usd, 2) AS cost_usd,
  round(cost_usd / nullif(merged, 0), 2) AS cost_per_merged,
  (tokens / nullif(merged, 0))::BIGINT AS tokens_per_merged
FROM runs LEFT JOIN merged USING (project, run) ORDER BY started DESC, project;
```

How each run used the account's usage windows, from its `usage_window` records (`five_hour`,
`seven_day`, …), in percent. Each window's figure as the run first heard it, its highest and its
last, and when it resets; a window that reset during the run ends lower than it began.

```sql
SELECT run, "window", round(100 * arg_min(utilization, time)) AS first_pct,
  round(100 * max(utilization)) AS peak_pct, round(100 * arg_max(utilization, time)) AS last_pct,
  arg_max(resets_at, time) AS resets_at
FROM events('.tutti/run/events.jsonl') WHERE kind = 'usage_window'
GROUP BY ALL ORDER BY run, "window";
```
