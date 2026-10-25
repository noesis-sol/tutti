# Event stream

The machine-readable record of each run, for scripts and agents. Back to the
[README](../README.md).

## The stream

The log, `.tutti/tutti.log`, is written for people, and its wording changes. For scripts and agents,
each run also appends its events to `.tutti/run/events.jsonl` in the main checkout, out of git with
the rest of `.tutti/run/`: one JSON object per line, each appended in a single write, so a reader
tailing the file never sees half a line. Like the log, the file keeps every run. An event the log
has a line for is written with its line, so the two give events in one order.

```
{"v":1,"time":"2026-10-21T09:18:12.04+03:00","run":"2026-10-21T06:18:11.587Z","kind":"start","version":"0.1.0","repo":"/Users/me/proj","branch":"main","concurrency":3,"billing":"subscription","permission_mode":"auto"}
{"v":1,"time":"2026-10-21T09:18:13.4+03:00","run":"2026-10-21T06:18:11.587Z","kind":"phase","ticket":"proj-a1","from":"Queued","to":"Working","cause":"Dispatched"}
{"v":1,"time":"2026-10-21T09:18:13.401+03:00","run":"2026-10-21T06:18:11.587Z","kind":"dispatch","ticket":"proj-a1","title":"Add login","n":1,"limit":40,"queued":0,"text":"[1/40] proj-a1 dispatching: Add login"}
{"v":1,"time":"2026-10-21T09:21:02.733+03:00","run":"2026-10-21T06:18:11.587Z","kind":"attention","ticket":"proj-a1","request":"3f9a0c1e","type":"permission","tool":"Bash","summary":"rm -rf build","default_to_no":false}
{"v":1,"time":"2026-10-21T09:21:09.1+03:00","run":"2026-10-21T06:18:11.587Z","kind":"attention_answered","ticket":"proj-a1","request":"3f9a0c1e","answer":"allow","via":"answer_command","after_ms":6367}
{"v":1,"time":"2026-10-21T09:32:40.071+03:00","run":"2026-10-21T06:18:11.587Z","kind":"closed","ticket":"proj-a1","title":"Add login","detail":"ffd6ce4 merged into main","text":"  proj-a1 closed (ffd6ce4 Add login (proj-a1)); merged into main, worktree and branch removed"}
{"v":1,"time":"2026-10-21T10:02:13.6+03:00","run":"2026-10-21T06:18:11.587Z","kind":"done","text":"READY_EMPTY after 4 tickets"}
{"v":1,"time":"2026-10-21T10:03:55.1+03:00","run":"2026-10-21T06:18:11.587Z","kind":"end","code":0}
```

Every record has:

- `v`, the format: `1`;
- `time`, when it was written: RFC 3339 in local time, with milliseconds when there are any;
- `run`, when the run started: RFC 3339 in UTC. It is the same in each of a run's records and in the
  run lock's `started`, so it picks one run's records out of the file;
- `kind`, what the record is.

A field without a value is left out, rather than `null`. Text is kept as it came, JSON-encoded, with
the characters that could steer a terminal escaped, so `tail -f` of the file is safe. Kinds and fields
may be added, but those here keep their names: read the ones you know and skip the rest. The
published JSON Schema, [`schema/events.json`](../schema/events.json), describes every kind.

## The kinds

The kinds orchestra's stream has keep their names and meanings, so its scripts carry over with
`.orchestra` replaced by `.tutti`. Many records carry `text`, the line the log has for them, without
the time.

**The run:**

| `kind` | What happened | Its other fields |
|---|---|---|
| `start` | the run's first record, once its startup checks pass and it knows its work | `version`; `repo`, the main checkout; `branch`, where finished tickets land; `scope`, the ticket of a `--ticket` or feature run; `feature`, the feature request; `concurrency`; `billing` (`subscription` or `api`); `permission_mode`, the mode workers run in; `auto_answer` with `--auto-answer`, how long a question waits for you first, in ms, 0 for at once; `overnight: true` for an [overnight run](running.md#overnight) its pre-flight cleared |
| `info` | progress about a ticket: its worktree, a hand-back, a recheck, a ticket carried over, an epic closed, … | `ticket`, `text` |
| `warn` | something to review while the run goes on: `CHECKS_FAILED`, `MERGE_CONFLICT`, `LIKELY_CONFLICT`, `FLAKY`, `LONG_RUNNING`, … | `ticket` when it is about one; `aside: true` when that ticket is left for review, with `detail`, why in a few words (`checks failed`, `closed without a commit`, …), and `phases`, `hand_backs`, `carried`, `tokens` and `cost_usd`; `blocked` when its work is done but it can't merge until you act (`merge conflict in a.ts, b.ts`); `text` |
| `hold` | something holds the run: no new tickets while the running ones finish; or a hold is lifted | `text` (`HOLD: <WORD>: …`, or `PROBE: …` for the environment probe's wait); `ticket` and `blocked` on some; `lifted: true` when it is lifted (`HOLD lifted: …`, `HOLD: USAGE_LIMIT lifted`) |
| `drain`, `resume` | the run was asked to wind down (`s`, SIGUSR1), or that was taken back | `text` |
| `probed` | the probe found the machine working after an environment hold: tickets start again | `text` |
| `shared_machine` | another tutti or orchestra run on the machine started (`SHARED_MACHINE: …`), or ended ([Runs that share a machine](running.md#runs-that-share-a-machine)) | `shared`, how many other runs are going, which can be 0; `text` |
| `machine_hold` | a ready ticket waits for a free slot across the machine: the workers across its runs are at `--machine-workers` (`HOLD: MACHINE: …`); once a hold. A `queue` record follows it with `machine_full: true`, which each `queue` and `dispatch` record has meanwhile, and another without it as the hold ends | `text` |
| `slept` | the machine slept, and the run's time limits don't count the time (`SLEPT: …`, [When the machine sleeps](running.md#when-the-machine-sleeps)) | `from`, when the run last saw it awake; `to`, when it woke; `seconds`, between them, to a tenth; `text`, with the cause on macOS where pmset gives it |
| `battery` | the battery, discharging, fell to 20% or to 10% (`BATTERY: …`, [On battery](running.md#on-battery)): once each per discharge, and again after the machine was plugged in; at 10% it notifies | `level`, the percent read; `threshold`, `20` or `10`; `text` |
| `stop` | the run stopped and needs you | `detail`, the word that says why: `REQUIREMENTS_MISSING`, `SETUP_PROBLEM`, `PAUSED`, `BLOCKED`, `TICKET_LIMIT`, `BEADS_FAILED`, `GIT_FAILED`, `WORKTREE_FAILED`, `STATE_UNWRITABLE`, `PANIC`, `DIRTY_TREE`, `MERGE_FAILED`, `ENVIRONMENT`, `USAGE_LIMIT` or `INTERRUPTED`; `ticket` and `blocked` when a ticket stopped it; `text`, every stop, joined by `; also ` |
| `done` | the run finished by itself | `text`: `READY_EMPTY after N tickets`, `LIMIT_REACHED at N tickets` or `DRAINED after N tickets`, with `; SCOPE_DONE: …` or `; SCOPE_OPEN: …` in a scoped run; `READY_EMPTY after 0 tickets: everything is done` or `: nothing ready` when there was nothing to run |
| `full_check` | the [full check](running.md#the-full-check) | `detail`: `passed`, `failed`, `timed out`, `skipped` or `not run`; when it failed, `suite`, `output` (where its whole output is) and `ticket` (the ticket filed for the suite, or the one open for it already); `text` |
| `check` | a check or a setup tutti ran ended; the log has no line for it | `suite`: `merge` (a ticket's merge check, the merge train's included), `recheck` (the check once more of a ticket set aside for its failed check), `fix` (the check of a fix its worker made for a failed check), `full` (the full check) or `setup` (the setup, in a ticket's worktree or before the full check); `ticket`, absent for the full check's; `command`; `seconds`, from its start to its end, to a tenth; `result`: `passed`, `failed`, `timed_out` or `not_run` (it couldn't start); `output`, where its whole output is, when it didn't pass; `train: true` when it ran ahead of its ticket's turn |
| `organ` | an [organ](organs.md) call ended; the log has its `ORGAN` line | `organ` (`triage`, `predictor`, `reviewer`, `scout`, …); `ticket`, the one it was about (triage's and the predictor's); `outcome`: `answered`, `unpriced` (answered by a provider that reports no price) or `no_result` (it timed out or failed first); `cost_usd`, `turns` and `session` when it `answered`; `duration_ms` |
| `end` | the run's last record, as tutti exits | `code`, the [exit code](running.md#exit-codes); `tokens`, its workers' by model, `cost_usd`, their turns' cost, and `organs`, its organ calls' `{"calls":3,"turns":5,"cost_usd":0.0456}`, each left out when there is none (see [What runs spend](#what-runs-spend)) |

**Tickets:**

| `kind` | What happened | Its other fields |
|---|---|---|
| `phase` | a ticket moved from one phase to another | `ticket`; `from`, absent as it enters the run; `to`, absent as it leaves it (gone from `bd ready`); `cause`; and the new phase's details: `place` (`ToMerge`, 1 is next), `step` (`Merging`), `attempt` (`Resolving`, `Fixing`), `why` (`HeldBack`, `Deferred`, `Review`, `Blocked`, `Stopped`) |
| `queue` | the number of ready tickets waiting for a slot, or held back, changed: the dashboard's **In queue** | `queued`; `held` and `held_by` while some are held back; `solo`; `machine_full: true` while the run holds at `--machine-workers` |
| `dispatch` | a ticket was picked up | `ticket`, `title`; `n` and `limit`, as in `[n/limit]` (no `limit` for a run without one); `queued`, `held`, `held_by`, `solo` as for `queue`; `text` |
| `closed` | a ticket merged, or closed with no change of its own to merge | `ticket`, `title`; `detail`, `ffd6ce4 merged into main` or `no change to merge`; `phases`, `hand_backs`, `carried`, `tokens` and `cost_usd` (see [What runs spend](#what-runs-spend)); `text` |
| `deferred` | a ticket was set aside, deferred | `ticket`, `title`; `detail`, why (`by the worker`, `still in_progress, noted for review`, `set aside overnight: BLOCKED`, …); `phases`, `hand_backs`, `carried`, `tokens` and `cost_usd`; `text` |
| `asked` | a ticket waits on a question ticket for you | `ticket`, `title`; `detail`, the question's ID and title; `text` |
| `answered` | its question was answered: it comes back | `ticket`, `title`, `detail`, `text` |
| `auto_answered` | tutti answered a question ticket with its recommended option, by `--auto-answer` | `ticket`, the one waiting on it; `question`; `title`, the question's; `option`, the one chosen; `text` |
| `waits` | a ticket's worker stopped with nothing done, having found it needs a ticket not merged yet: back in the queue until that merges (`WAITS_FOR_MERGE`) | `ticket`, `title`; `detail`, the tickets it waits for; `text` |
| `reopened` | a ticket set aside for failing at once was reopened by an environment hold | `ticket`; `detail`; `text` |
| `triage` | triage's verdict on a deferred ticket | `ticket`; `title`, the verdict; `detail`, as in `environment · high`; `text` |
| `ticket_end` | a ticket's part in the run ended: it merged, closed with no change, was set aside, waits on you or stopped, or the run ended with it back in the queue; again each time it comes back and ends again, so its last in a run gives its whole | `ticket`; `outcome`: `merged`, `no_change`, `set_aside`, `needs_you`, `stopped` or `queued`; `phase`, the one it ended in (`Done`, `Deferred`, `Review`, `Asked`, `Blocked`, `Stopped`, and for `queued` `Waiting`, `Queued` or `HeldBack`); `why`, as that phase gives it (`CHECKS_FAILED`, the question's ID, `PAUSED`, what a Waiting ticket waits for: a ticket's ID, `probe` or `setup`, …); `seconds`, from when the run first took it up; `turns`, its workers' model round-trips; `phases`, `hand_backs`, `carried`, `tokens` and `cost_usd` |

**Workers:**

| `kind` | What happened | Its other fields |
|---|---|---|
| `attention` | a worker waits on you (see [Attention requests](workers.md#attention-requests)) | `ticket`; `request`, the ID `tutti answer` takes; `type`: `permission`, `question` or `elicitation` (an MCP server's); `tool` and `summary` for a permission (for an elicitation, the server and its message); `questions` for a question, each with `question`, `header`, `options` (`label`, `description`) and `multi_select`; `default_to_no`, whether allowing it needs `--confirm` |
| `attention_answered` | a request was answered, or withdrawn | `ticket`, `request`; `answer`: `allow`, `deny`, `allow_run`, or the chosen labels, one per question; `via`: `screen`, `answer_command`, `auto_answer` when `--auto-answer` answered it, or `overnight` when an [overnight run](running.md#overnight) denied it as it set the ticket aside; `after_ms`, how long it was open; `cancelled: true` when Claude Code withdrew it |
| `denied` | Claude Code refused a tool call without asking | `ticket`, `tool`; `reason_type`: `classifier`, `safetyCheck`, `mode`, `rule`, another the SDK gives, or `unknown`; `reason` |
| `usage_limit` | the usage limit's status changed (see [The usage limit](running.md#the-usage-limit)) | `status`: `warning`, `rejected` or `lifted`; `limit`: `five_hour`, `seven_day`, … or `unknown`; `resets_at`; `utilization`, from 0 to 1; `text` on a warning |
| `usage_window` | a figure of one of the account's usage windows, as the workers' sessions report it: the first the run hears, then each that differs | `window`: `five_hour`, `seven_day`, …; `utilization`, from 0 to 1; `resets_at` |
| `message` | you sent a worker a message | `ticket`; `length`, in characters. The message itself is recorded nowhere |
| `steered`, `released` | a worker became steered, or was released (see [Steering](workers.md#steering)) | `ticket`, `text` |
| `suspended` | a worker's session was suspended as the run ended | `ticket`, `session`; `why`: `quit`, `PAUSED`, `TICKET_LIMIT`, `waiting on you`, `run ended`, … |
| `resumed` | a worker's session was resumed | `ticket`, `session`; `why`: `suspended` (by the last run), `answered` (its question), `gone` (it ended unexpectedly), `hand_back`; `text` |
| `turn` | a worker's turn ended: its SDK result | `ticket` (`tutti-probe` for the environment probe's session, `tutti-interview` for the feature interview's); `session`; `subtype`, the result's (`success`, `error_during_execution`, `error_max_turns`, …); `is_error: true` when it ended on an error; `cost_usd`, the turn's share of the session's cost; `turns`, its model round-trips; `duration_ms`, and `api_ms` of it waiting on the API; `tokens`, the turn's share by model, its subagents' and compactions' included |

**Phases.** A `phase` record's `from` and `to` are among `Queued`, `HeldBack`, `Working`, `ToMerge`,
`Merging`, `Resolving`, `Fixing`, `Done`, `Asked`, `Waiting`, `Deferred`, `Review`, `Blocked` and
`Stopped` (the dashboard's rows, see [The tickets table](dashboard.md#the-tickets-table)). Its `cause`
names the transition: `Ready`, `Held`, `Released`, `Unready`, `Dispatched`, `Verified`, `NoChange`,
`FiledQuestion`, `WaitsForMerge`, `SetupFailed`, `Defer`, `Aside`, `StopRun`, `RunEnded`, `Answered`, `Requeued`,
`Reopened`, `Undeferred`, `ItsTurn`, `FastForwarded`, `MergeInterrupted`, `ConflictsHandedBack`,
`CheckHandedBack`, `Block`, `Recheck`, `HandedOver`, and for tickets carried over from the last run,
`Resumed`, `StillAsked` and `Unmerged`. A ticket's `phase` record comes before the records of other
kinds the same change writes (`dispatch`, `closed`, …).

`held_by` says how many ready tickets each reason holds back, as in `{"overlap":3,"merge":1}`:
`overlap`, a footprint overlapping a running ticket's; `parent`, subtickets not all merged; `merge`, a
blocker, or the ticket it was filed from, not merged yet; `solo`, a solo ticket running or next;
`setup`, the setup failed in its worktree (`SETUP_FAILED`, a `warn` record), until a ticket merges or
a probe passes.
`solo` is `{"ticket":"<id>"}` while a ticket labelled `solo` runs, `{"ticket":"<id>","next":true}`
while it is next.

## What runs spend

tutti hosts Claude Code through the Agent SDK, whose result messages say what each turn cost and
used, so the stream has what orchestra's has of a ticket's time and tokens, and its cost besides.

- **Each turn's share.** A result's `total_cost_usd` and `modelUsage` are the session's running
  totals: within one session's process each result carries the turns before it too, and a resumed
  session goes on from the totals its transcript saved (the SDK's docs say so, and the contract
  test `test/contract/sdk.test.ts` checks both). So a `turn` record gives the difference from the
  session's last result: its own share. A total lower than the last means it started
  again from 0 (a `/clear`), and the turn's share is then the whole; a zeroed result, as a crash
  gives, counts as nothing. A session resumed from an earlier run takes its last result from its
  ticket's transcript (`.tutti/run/workers/<id>/messages.jsonl`), so its first turn here counts only
  its own share too. `num_turns`, `duration_ms` and
  `duration_api_ms` are the turn's own.
- **Tokens**, as orchestra's: by model, `input` neither written to the prompt cache nor read from
  it, `cache_write` written to it, `cache_read` read from it, and `output`, thinking included; each
  given, 0 included.
- **What a ticket spent.** The records that end a ticket's part in the run, `closed`, `deferred`, a
  `warn` with `aside: true` and `ticket_end`, give what it spent from when the run first took it up:
  - `phases`, as orchestra's: seconds, to a tenth, in each phase it entered: `working` (Working),
    `waiting` (ToMerge), `merging` (Merging), `resolving` and `fixing`; a ticket that comes back
    adds to the same phases, and the time between, waiting on you or on a merge, counts in none;
  - `hand_backs`: `resolve`, for conflicts, and `fix`, for a failing check, 0 included;
  - `carried: true` for a ticket carried over from an earlier run;
  - `tokens` and `cost_usd`, its workers' turns' shares summed, left out when none reported any.
- **The run's.** The `end` record sums its workers' `tokens` and `cost_usd`, and its organ calls in
  `organs`. Costs are the SDK's estimates at list prices, not a bill: a subscription doesn't pay by
  the token.

## Reading it

Until its `end` record a run is still going, or was killed (`kill -9`, a crash); `lsof .git/tutti.lock`
in the main checkout says whether a run holds the lock. A run with nothing to run writes `start`,
`done` and `end` with code 0. If the stream can't be written, tutti warns once, and the run goes on.

With `jq`, in the main checkout:

```sh
E=.tutti/run/events.jsonl
run=$(jq -rs 'map(select(.kind == "start")) | last | .run' $E)   # the latest run

# how it ended
jq -c --arg run "$run" 'select(.run == $run and (.kind | IN("hold", "stop", "done", "end")))' $E

# what it merged
jq -r --arg run "$run" 'select(.run == $run and .kind == "closed") | "\(.ticket) \(.detail)"' $E

# what it set aside
jq -r --arg run "$run" 'select(.run == $run and (.kind == "deferred" or (.kind == "warn" and .aside))) | "\(.ticket) \(.detail)"' $E

# the requests still open, to answer with tutti answer
jq -rs --arg run "$run" 'map(select(.run == $run))
  | (map(select(.kind == "attention_answered") | .request)) as $answered
  | .[] | select(.kind == "attention" and (.request | IN($answered[]) | not))
  | "\(.request) \(.ticket) \(.summary // .questions[0].question)"' $E

# how long requests waited for an answer, and how
jq -r 'select(.kind == "attention_answered" and (.cancelled | not)) | "\(.request) \(.answer) via \(.via) after \(.after_ms / 1000)s"' $E

# denials by type, across runs
jq -r 'select(.kind == "denied") | .reason_type' $E | sort | uniq -c

# one ticket's way through the run
jq -r --arg t tut-12 'select(.kind == "phase" and .ticket == $t) | "\(.time) \(.from // "-") → \(.to // "-") (\(.cause))"' $E

# each ticket's cost and time, as the run left it
jq -r --arg run "$run" 'select(.run == $run and .kind == "ticket_end") | "\(.ticket) \(.outcome) $\(.cost_usd // 0) \(.seconds)s"' $E

# each suite's runs and their median time
jq -rs 'map(select(.kind == "check")) | group_by(.suite)[] | (map(.seconds) | sort) as $s
  | "\(.[0].suite): \(length) runs, median \($s[length / 2 | floor])s"' $E

# what the latest run's workers and organs cost
jq -r --arg run "$run" 'select(.run == $run and .kind == "end") | "workers $\(.cost_usd // 0), organs $\(.organs.cost_usd // 0)"' $E

# every run's exit code
jq -r 'select(.kind == "end") | "\(.run) \(.code)"' $E

# follow a run
tail -f $E | jq -c 'select(.kind != "queue" and .kind != "phase") | del(.v, .run)'
```

For questions across many records, such as each ticket's time in each phase, the checks that fail
most, or a week across every project, [Analytics](analytics.md) has ready-made DuckDB queries.
