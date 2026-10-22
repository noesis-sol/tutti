# Analytics

Ready-made queries over tutti's [event stream](events.md) with DuckDB: what each run merged and
cost, where a ticket's time went, which checks fail, how long you kept workers waiting. Back to the
[README](../README.md).

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

## The events macro

Every query reads the stream through one table macro, `events(path)`, which gives each record's
fields their types: times as timestamps, `tokens` as a map from model to its four counts, `phases`
as a map from phase to seconds. Naming the columns keeps a query working on a file that lacks some
kinds yet (a field no record has is `NULL`, not an error) and skips the fields no query here reads;
add one to `columns` to read it.

```sql
CREATE OR REPLACE MACRO events(path) AS TABLE
SELECT row_number() OVER () AS seq, *
FROM read_json(path, format = 'newline_delimited', filename = true, columns = {
  time: 'TIMESTAMPTZ', run: 'VARCHAR', kind: 'VARCHAR', ticket: 'VARCHAR', title: 'VARCHAR',
  detail: 'VARCHAR', text: 'VARCHAR', repo: 'VARCHAR', code: 'INTEGER',
  "from": 'VARCHAR', "to": 'VARCHAR', cause: 'VARCHAR', why: 'VARCHAR', outcome: 'VARCHAR',
  seconds: 'DOUBLE', turns: 'INTEGER', cost_usd: 'DOUBLE',
  tokens: 'MAP(VARCHAR, STRUCT(input BIGINT, output BIGINT, cache_write BIGINT, cache_read BIGINT))',
  phases: 'MAP(VARCHAR, DOUBLE)', hand_backs: 'STRUCT(resolve INTEGER, fix INTEGER)',
  carried: 'BOOLEAN', aside: 'BOOLEAN',
  organs: 'STRUCT(calls INTEGER, turns INTEGER, cost_usd DOUBLE)',
  suite: 'VARCHAR', command: 'VARCHAR', result: 'VARCHAR', output: 'VARCHAR',
  request: 'VARCHAR', type: 'VARCHAR', tool: 'VARCHAR', summary: 'VARCHAR', questions: 'JSON',
  answer: 'VARCHAR', via: 'VARCHAR', after_ms: 'BIGINT', cancelled: 'BOOLEAN',
  status: 'VARCHAR', "limit": 'VARCHAR', resets_at: 'TIMESTAMPTZ', session: 'VARCHAR'
});
```

`seq` is the record's place in the file, which orders records written in the same millisecond, and
`filename` the file it came from. Save the macro in `~/.duckdbrc`, which the `duckdb` command runs
as it starts, and run `duckdb` in the project's main checkout; or keep it in a file of its own and
load it with `duckdb -init tutti.sql`. For one query from the shell, `duckdb -init tutti.sql -c
"<query>"`; `-json` or `-csv` before `-c` gives its rows to another program.

Costs are the SDK's estimates at list prices, not a bill (see
[What runs spend](events.md#what-runs-spend)). Times show in your time zone (`SET TimeZone = 'UTC'`
for another).

## Runs

Each run: when it started, how long it went, the tickets it merged, closed with no change, set aside,
left waiting on you and stopped, its exit code (none while it goes, or when it was killed) and what
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
  r.code, round(r.cost_usd, 2) AS cost_usd
FROM runs r LEFT JOIN ends e USING (run)
GROUP BY ALL ORDER BY r.started;
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
    max(time) FILTER (kind = 'closed' AND detail LIKE '% merged into %') AS merged,
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

## Questions and permission requests

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
WITH runs AS (
  SELECT regexp_extract(filename, '([^/]+)/\.tutti/run/events\.jsonl$', 1) AS project, run,
    min(time) AS started,
    date_diff('second', min(time), max(time)) AS seconds,
    count(*) FILTER (kind = 'closed') AS merged,
    count(*) FILTER (kind = 'deferred' OR (kind = 'warn' AND aside)) AS set_aside,
    sum(cost_usd) FILTER (kind IN ('turn', 'organ')) AS cost_usd
  FROM events('~/Projects/*/.tutti/run/events.jsonl') GROUP BY ALL
)
SELECT date_trunc('week', started) AS week, project, count(*) AS runs, sum(merged)::BIGINT AS merged,
  sum(set_aside)::BIGINT AS set_aside, round(sum(seconds) / 3600, 1) AS hours,
  round(sum(cost_usd), 2) AS cost_usd
FROM runs GROUP BY ALL ORDER BY week DESC, project;
```

## Two runs side by side

The latest two runs compared, a row for each measure; to compare two others, pick them by their
`run` in `two`, as the comment there says.

```sql
WITH per_run AS (
  SELECT run,
    count(*) FILTER (kind = 'closed')::DOUBLE AS merged,
    count(*) FILTER (kind = 'deferred' OR (kind = 'warn' AND aside))::DOUBLE AS set_aside,
    round(date_diff('second', min(time), max(time)) / 60, 1)::DOUBLE AS minutes,
    round(sum(cost_usd) FILTER (kind IN ('turn', 'organ')), 2)::DOUBLE AS cost_usd,
    sum(turns) FILTER (kind = 'turn')::DOUBLE AS turns,
    count(*) FILTER (kind = 'check')::DOUBLE AS checks,
    count(*) FILTER (kind = 'check' AND result <> 'passed')::DOUBLE AS failed_checks,
    count(*) FILTER (kind = 'attention')::DOUBLE AS requests
  FROM events('.tutti/run/events.jsonl') GROUP BY run
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
