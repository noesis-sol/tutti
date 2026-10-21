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
| `start` | the run's first record, once its startup checks pass and it knows its work | `version`; `repo`, the main checkout; `branch`, where finished tickets land; `scope`, the ticket of a `--ticket` or feature run; `feature`, the feature request; `concurrency`; `billing` (`subscription` or `api`); `permission_mode`, the mode workers run in |
| `info` | progress about a ticket: its worktree, a hand-back, a recheck, a ticket carried over, an epic closed, … | `ticket`, `text` |
| `warn` | something to review while the run goes on: `CHECKS_FAILED`, `MERGE_CONFLICT`, `LIKELY_CONFLICT`, `FLAKY`, `LONG_RUNNING`, … | `ticket` when it is about one; `aside: true` when that ticket is left for review, with `detail`, why in a few words (`checks failed`, `closed without a commit`, …); `blocked` when its work is done but it can't merge until you act (`merge conflict in a.ts, b.ts`); `text` |
| `hold` | something holds the run: no new tickets while the running ones finish; or a hold is lifted | `text` (`HOLD: <WORD>: …`, or `PROBE: …` for the environment probe's wait); `ticket` and `blocked` on some; `lifted: true` when it is lifted (`HOLD lifted: …`, `HOLD: USAGE_LIMIT lifted`) |
| `drain`, `resume` | the run was asked to wind down (`s`, SIGUSR1), or that was taken back | `text` |
| `probed` | the probe found the machine working after an environment hold: tickets start again | `text` |
| `shared_machine` | another tutti or orchestra run on the machine started (`SHARED_MACHINE: …`), or ended ([Runs that share a machine](running.md#runs-that-share-a-machine)) | `shared`, how many other runs are going, which can be 0; `text` |
| `machine_hold` | a ready ticket waits for a free slot across the machine: the workers across its runs are at `--machine-workers` (`HOLD: MACHINE: …`); once a hold. A `queue` record follows it with `machine_full: true`, which each `queue` and `dispatch` record has meanwhile, and another without it as the hold ends | `text` |
| `stop` | the run stopped and needs you | `detail`, the word that says why: `PAUSED`, `BLOCKED`, `TICKET_LIMIT`, `BEADS_FAILED`, `GIT_FAILED`, `AGENT_FAILED`, `WORKTREE_FAILED`, `STATE_UNWRITABLE`, `PANIC`, `DIRTY_TREE`, `MERGE_FAILED`, `ENVIRONMENT`, `USAGE_LIMIT` or `INTERRUPTED`; `ticket` and `blocked` when a ticket stopped it; `text`, every stop, joined by `; also ` |
| `done` | the run finished by itself | `text`: `READY_EMPTY after N tickets`, `LIMIT_REACHED at N tickets` or `DRAINED after N tickets`, with `; SCOPE_DONE: …` or `; SCOPE_OPEN: …` in a scoped run; `READY_EMPTY after 0 tickets: everything is done` or `: nothing ready` when there was nothing to run |
| `full_check` | the [full check](running.md#the-full-check) | `detail`: `passed`, `failed`, `timed out`, `skipped` or `not run`; when it failed, `suite`, `output` (where its whole output is) and `ticket` (the ticket filed for the suite, or the one open for it already); `text` |
| `end` | the run's last record, as tutti exits | `code`, the [exit code](running.md#exit-codes) |

**Tickets:**

| `kind` | What happened | Its other fields |
|---|---|---|
| `phase` | a ticket moved from one phase to another | `ticket`; `from`, absent as it enters the run; `to`, absent as it leaves it (gone from `bd ready`); `cause`; and the new phase's details: `place` (`ToMerge`, 1 is next), `step` (`Merging`), `attempt` (`Resolving`, `Fixing`), `why` (`HeldBack`, `Deferred`, `Review`, `Blocked`, `Stopped`) |
| `queue` | the number of ready tickets waiting for a slot, or held back, changed: the dashboard's **In queue** | `queued`; `held` and `held_by` while some are held back; `solo`; `machine_full: true` while the run holds at `--machine-workers` |
| `dispatch` | a ticket was picked up | `ticket`, `title`; `n` and `limit`, as in `[n/limit]` (no `limit` for a run without one); `queued`, `held`, `held_by`, `solo` as for `queue`; `text` |
| `closed` | a ticket merged, or closed with no change of its own to merge | `ticket`, `title`; `detail`, `ffd6ce4 merged into main` or `no change to merge`; `text` |
| `deferred` | a ticket was set aside, deferred | `ticket`, `title`; `detail`, why (`by the worker`, `still in_progress, noted for review`, …); `text` |
| `asked` | a ticket waits on a question ticket for you | `ticket`, `title`; `detail`, the question's ID and title; `text` |
| `answered` | its question was answered: it comes back | `ticket`, `title`, `detail`, `text` |
| `waits` | a ticket's worker stopped with nothing done, having found it needs a ticket not merged yet: back in the queue until that merges (`WAITS_FOR_MERGE`) | `ticket`, `title`; `detail`, the tickets it waits for; `text` |
| `reopened` | a ticket set aside for failing at once was reopened by an environment hold | `ticket`; `detail`; `text` |
| `triage` | triage's verdict on a deferred ticket | `ticket`; `title`, the verdict; `detail`, as in `environment · high`; `text` |

**Workers:**

| `kind` | What happened | Its other fields |
|---|---|---|
| `attention` | a worker waits on you (see [Attention requests](workers.md#attention-requests)) | `ticket`; `request`, the ID `tutti answer` takes; `type`: `permission`, `question` or `elicitation` (an MCP server's); `tool` and `summary` for a permission (for an elicitation, the server and its message); `questions` for a question, each with `question`, `header`, `options` (`label`, `description`) and `multi_select`; `default_to_no`, whether allowing it needs `--confirm` |
| `attention_answered` | a request was answered, or withdrawn | `ticket`, `request`; `answer`: `allow`, `deny`, `allow_run`, or the chosen labels, one per question; `via`: `screen` or `answer_command`; `after_ms`, how long it was open; `cancelled: true` when Claude Code withdrew it |
| `denied` | Claude Code refused a tool call without asking | `ticket`, `tool`; `reason_type`: `classifier`, `safetyCheck`, `mode`, `rule`, another the SDK gives, or `unknown`; `reason` |
| `usage_limit` | the usage limit's status changed (see [The usage limit](running.md#the-usage-limit)) | `status`: `warning`, `rejected` or `lifted`; `limit`: `five_hour`, `seven_day`, … or `unknown`; `resets_at`; `utilization`, from 0 to 1; `text` on a warning |
| `message` | you sent a worker a message | `ticket`; `length`, in characters. The message itself is recorded nowhere |
| `steered`, `released` | a worker became steered, or was released (see [Steering](workers.md#steering)) | `ticket`, `text` |
| `suspended` | a worker's session was suspended as the run ended | `ticket`, `session`; `why`: `quit`, `PAUSED`, `TICKET_LIMIT`, `waiting on you`, `run ended`, … |
| `resumed` | a worker's session was resumed | `ticket`, `session`; `why`: `suspended` (by the last run), `answered` (its question), `gone` (it ended unexpectedly), `hand_back`; `text` |

**Phases.** A `phase` record's `from` and `to` are among `Queued`, `HeldBack`, `Working`, `ToMerge`,
`Merging`, `Resolving`, `Fixing`, `Done`, `Asked`, `Waiting`, `Deferred`, `Review`, `Blocked` and
`Stopped` (the dashboard's rows, see [The tickets table](dashboard.md#the-tickets-table)). Its `cause`
names the transition: `Ready`, `Held`, `Released`, `Unready`, `Dispatched`, `Verified`, `NoChange`,
`FiledQuestion`, `WaitsForMerge`, `SetupFailed`, `Defer`, `Aside`, `StopRun`, `RunEnded`, `Answered`, `Requeued`,
`Reopened`, `ItsTurn`, `FastForwarded`, `MergeInterrupted`, `ConflictsHandedBack`,
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

# every run's exit code
jq -r 'select(.kind == "end") | "\(.run) \(.code)"' $E

# follow a run
tail -f $E | jq -c 'select(.kind != "queue" and .kind != "phase") | del(.v, .run)'
```
