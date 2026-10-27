---
name: tutti
description: Run and look after tutti, which works through a Beads backlog with several Claude Code workers side by side, each an Agent SDK session in tutti's own process with its own git worktree. Use when the user asks to set a project up for tutti, launch a run from an agent with --plain, answer a worker's permission request or question with tutti answer, quit or resume a run, or find out why a run stopped, why a ticket was set aside or where a worker's work went.
---

<!--
Install: copy this folder to ~/.claude/skills/tutti/ (every project) or to .claude/skills/tutti/ in
one project, then ask the agent to "run tutti". tutti itself installs with
curl -fsSL https://github.com/noesis-sol/tutti/releases/latest/download/install.sh | sh
(or bunx @noesis-sol/tutti, for development and agents). This is orchestra v0.7.7's orchestra
skill, rewritten for tutti.
-->

# tutti

`tutti` picks the highest-priority ticket from `bd ready`, gives it a git worktree
(`<repo>-tutti/<ticket>` on branch `tutti/<ticket>`) and starts a worker there: a Claude Code
session, run through the Agent SDK inside tutti's own process, with the project's worker prompt and
the MCP servers `.tutti/settings.json` names. When the worker's turn ends, tutti reads the ticket
in Beads. A closed ticket with a commit naming it is rebased, checked with the merge check and
fast-forwarded into the branch the main checkout is on; its worktree and branch are removed.
Anything else is set aside for review, and the loop moves on or stops. It never pushes.

Two words, kept apart: **workers** do tickets, one session and worktree each; **organs** are
tutti's one-shot advisers (triage, the predictor, the reviewer that writes the run report, the
screen and plan for `--feature`), each a model call with no tools and no MCP servers. Organs never
change a ticket or the code.

Workers live inside tutti's process: there are no tabs, panes or windows to read. What a worker
does is in its transcript, and when it needs a person it raises an **attention request**, which you
list and answer with `tutti answer`.

## First, find out where the project stands

Run these in the main checkout before launching anything or answering questions about a run:

```
tutti --version                             # installed, and which build (-v for short)
git rev-parse --show-toplevel               # the repository (use the main checkout, not a worktree)
git rev-parse --absolute-git-dir            # equal to --git-common-dir in the main checkout
git branch --show-current                   # finished tickets land on this branch
git worktree list                           # per-ticket worktrees still around
bd ready; bd list --status=in_progress      # what a run would pick up; what is claimed
bd human list                               # questions waiting for the user
lsof -t .git/tutti.lock                     # is a run going here? its PID; nothing if not
cat .git/tutti.lock                         # which run (or init) holds it; empty once it has ended
tutti answer                                # workers waiting on a person right now
tail -n 1 .tutti/run/events.jsonl | jq -c . # the last run's last record: "end" with its exit code once over
jq . .tutti/run/state.json                  # the sessions the last run saved, for the next to resume
```

A run holds `<git-common-dir>/tutti.lock` (`.git/tutti.lock` from the main checkout) for as long as
it runs, with `flock`, and the system lets go of it however tutti exits, `kill -9` included, so only
a running tutti has it open. The file is JSON: `pid`, `started` (the same as the run's `run` in the
event stream), `version`, `branch`, and `scope` (`--ticket`), `feature` or `spec`; `tutti init` writes it
too, with `"init": true`. A run that ends empties it; one killed with `kill -9` or crashed leaves
its JSON behind, so whether `lsof` lists a PID is what says a run is going. A run also holds orchestra's `.git/orchestra.lock`, so neither tool runs while the other does.

The project's tutti files:

| File | What it is |
|---|---|
| `.tutti/settings.json` | committed: the checks and their time limits, the `requires` list of what the machine must have, `concurrent`, the workers' MCP servers, permission mode, effort and model, `ticket_limit`, the queue, merge and hold settings |
| `.tutti/worker-prompt.md` | committed: the worker prompt, read once as a run starts (`--prompt <file>` names another) |
| `.tutti/tutti.log` | the log, for people; a plain run prints the same lines on stdout |
| `.tutti/reports/<start time>.md` | the run reports: Finished, Set aside, Needs you |
| `.tutti/run/events.jsonl` | every run's events, one JSON object per line, for you to read (below) |
| `.tutti/run/state.json` | what the last run left: each ticket's session, worktree, branch, phase, and why it was `suspended` |
| `.tutti/run/attention/` | the open attention requests, one `<request-id>.json` each; `tutti answer` reads and answers them |
| `.tutti/run/workers/<id>/messages.jsonl` | a worker's transcript, every SDK message; its Claude Code's stderr in `stderr.log` beside it |
| `.tutti/run/check-full.log` | the whole output of the last full check that failed |

Leave `.tutti/run/` to tutti; don't edit `state.json` or the attention folder by hand. Read the event
stream rather than grepping the log, whose wording is for people and may change.

A repository with `.orchestra/` is orchestra's. tutti doesn't read orchestra's run files or adopt
its workers; if `.orchestra/run/state.json` names workers, tutti's startup warns `orchestra left
workers on <ids>; finish them with orchestra first`. Branches differ (`wt/<id>` for orchestra,
`tutti/<id>` for tutti), and so do the worktree folders (`<repo>-worktrees/` and `<repo>-tutti/`).

## Setting a project up

```
tutti init --check-fast "<the project's check command>" --concurrent 1 --mcp ""
```

Run from the main checkout, between runs. In a terminal it asks what its flags don't give; run by an
agent, with no terminal, it asks nothing and its summary says `not asked (no terminal)` for each
choice it left, so ask the user first and pass the answers as flags:

- `--check-fast "<command>"` (lint, build and the fast tests: the merge check), `--check-full
  "<command>"` (the slower suites, run once at the end of a run), `--check-fast-timeout 5m` and
  `--check-full-timeout 90m` (defaults 30m and 60m: a few times the check's usual running time).
  `--check-fast ""` writes a runner that checks nothing yet.
- `--concurrent N` / `-c N`, 1 to 16: tickets at the same time. Above 1 needs checks that can run
  side by side, and about 1 GiB of memory per worker; say so.
- `--mcp a,b`, the MCP servers workers get, by name (`claude mcp list` shows what this machine
  defines), or `--mcp ""` for none. Unlike orchestra, no `mcp_servers` means no servers.
- `--setup "<command>"`, which installs dependencies in a worktree when a rebase changes a lockfile
  (`bun install --frozen-lockfile`, `npm ci`, `uv sync`, …), or `--setup ""`.
- `--changelog-union` / `--changelog-union=false`, where the project keeps a `CHANGELOG.md`.
- `--install-beads` / `--install-beads=false` where `bd` is missing: installing software is the
  user's call. In a repository without `.beads/`, init runs `bd init` itself; `bd init` commits the
  files it adds along with anything already staged, so check `git status` first.
- `--verifier` / `--verifier=false`: a subagent that checks each ticket's change before its worker
  closes it. `--prefix <name>`: the Beads ticket prefix.
- `--force` replaces an existing `.tutti/worker-prompt.md` with the built-in template. Don't pass it
  without the user's say-so.

Importing orchestra's settings and prompt from `.orchestra/` is offered only in a terminal: leave
that to the user. Afterwards, show the user `.tutti/settings.json`, the prompt and the runners
(`scripts/check-fast.sh`, `scripts/check-full.sh`), and commit `.tutti/` and `scripts/` (and
`.gitattributes`, and what `bd init` left uncommitted) if they agree.

## Launching a run

The startup checks list every problem at once on stderr and exit 2:

- not set up: `tutti isn't set up in this repository yet. Run this first: tutti init`, then any other
  problem under `Also fix before a run:` (otherwise under `tutti cannot start:`);
- run from the main checkout (`<path> is a linked worktree. Run this from the main checkout.`), on a
  branch;
- no uncommitted changes outside `.tutti/run/`, `.orchestra/run/` and `.beads/`;
- `bd` installed;
- a Claude login: `Not logged in to Claude: run claude /login, or tutti login`. Both open a browser
  and wait for a pasted code, so the user runs them: suggest `! tutti login`;
- settings files Claude Code can parse (it skips one that doesn't, deny rules and all), and a
  trusted main checkout when the project's settings allow commands: the message says to run `claude`
  once in the main checkout and accept the trust dialog, or `tutti init` in a terminal, which offers
  to mark it trusted. Both are the user's;
- `.tutti/settings.json` valid, its MCP server names defined on this machine;
- no other run: `tutti is already running in <repo> (pid …, since …, <branch>)` or `orchestra is
  running in <repo> (pid …)`. Follow that run instead, or ask the user before stopping it.

Run it on the branch finished tickets should land on. Unless the user says otherwise, propose a
batch branch from the main branch (`git switch -c batch/$(date +%F)`), so the work reaches main
through one pull request.

From an agent, always run `tutti --plain --tickets` (or `--ticket <id>`), in the background, from
the main checkout, with its output in a file:

- `--plain` prints the log's lines on stdout instead of drawing the dashboard. Without a terminal
  tutti would be plain anyway (`Plain output: stdout isn't a terminal.`), but say it.
- `--tickets` runs the current tickets without the start question. `--ticket <id>` runs only that
  ticket and its subtickets, each parent after its children; an epic is never dispatched itself.
- A run lasts hours. Start it with your shell tool's background mode (in Claude Code, Bash with
  `run_in_background`), not in the foreground and not with `&` in a shell that may close: a closing
  terminal sends SIGHUP, which quits the run. Or start it in a tmux session the user can attach to:
  `tmux new-session -d -s tutti -c "$PWD" 'tutti --plain --tickets'`.

```
mkdir -p .tutti/run && tutti --plain --tickets > .tutti/run/plain.out 2>&1   # in the background
grep -m1 -E "^.{20}START |cannot start|isn't set up|Also fix|READY_EMPTY|All done|Nothing ready" .tutti/run/plain.out
```

The `START` line says the version, the repository, the branch and the run's settings, then, indented,
the billing (`billing: subscription`, or that `ANTHROPIC_API_KEY` is set but not used), the
permission mode in effect (`permission mode: auto`), the workers' MCP servers and any warning. Relay
a warning, and any billing other than the user expects.

A run with nothing to run (nothing ready, or only tickets held back, and no session to resume)
prints a box, `✓ All done` or `○ Nothing ready to run` with what holds each ticket and the command
that frees it, and exits 0 without a report. Tell the user what it says.

`--feature "<request>"` has the screen and plan organs turn a request into an epic and its tickets,
then runs them. Without a terminal it can't ask whether to file the plan: it prints the plan, says
`tutti has no terminal to ask on: nothing was filed. Pass --yes to file the plan without asking.`
and exits 2. Show the user that plan, and pass `--yes` only once they approve it. The interview
(**New feature** at the start question) needs the dashboard: leave it to a user at the keyboard.

`--spec <file>` (or an `https://` URL, fetched and committed as a copy) builds what a spec
describes, unattended: tutti commits it, breaks it down into
tickets under a root epic and runs them, starting on its environment ticket while the rest is filed.
Run again, the same command carries on, or updates the tickets for a changed spec; `✓ <path> is
built` (exit 0) once its root epic is closed. A request for a feature run by an agent goes in a file
for `--spec`. `--refine` breaks the spec down with the user and needs the dashboard: leave it to a
user at the keyboard.

Useful flags (each also a `TUTTI_*` variable, `--concurrent` as `TUTTI_CONCURRENT`; on-or-off ones
take `=false` or `0`): `-c N` / `--concurrent N`, `--limit N` (tickets this run starts, default 40),
`--ticket-limit 2h` (stop when a worker is still going that long; `0` for none), `--check-timeout
30m`, `--check-full-timeout 60m`, `--worker-model`, `--worker-effort`, `--organ-model`,
`--organ-effort`, `--triage=false`, `--review=false`, `--notify=false`, `--resolve-conflicts=false`,
`--usage-limit-wait 6h`, `--machine-workers N` (the most workers across the machine's tutti and
orchestra runs), `--billing api` (bill `ANTHROPIC_API_KEY` beside a subscription login: the
user's call), `--worktrees <dir>`, `--prompt <file>`, `--claude <path>`. `tutti --help` lists them
all. orchestra's unprefixed variables (`LIMIT`, `NOTIFY`, `TRIAGE`, …) are not read.

With several at once, a ticket labelled `solo` runs alone: suggest `bd label add <id> solo` for one
that restructures code most tickets touch. Tickets that name the same function or file as a running
one, share an `area:<name>` label with it, or touch a file its worktree has changed wait for a later
slot. `bd update <id> --set-metadata files=a.ts,b.ts` names a ticket's files. After a batch of
tickets is filed, `tutti plan` proposes blocks links between tickets touching the same code and
changes nothing; run `tutti plan --apply` only once the user approves the proposal.

## While it runs

- **Leave the main checkout alone.** An uncommitted change outside `.tutti/run/`, `.orchestra/run/`
  and `.beads/`, or a branch switch there, holds the run and ends it `DIRTY_TREE` (exit 5), the
  finished ticket left unmerged for review. A commit on the base branch is fine: running tickets are
  rebased onto it and checked again before they merge. So are `bd update` and `bd create`.
- **The prompt and settings are read once**, as the run starts.
- **Follow it** with `tail -f .tutti/run/events.jsonl | jq -c 'select(.kind | IN("info", "queue",
  "phase") | not) | {kind, ticket, text}'`, or the plain output file. A worker's own steps are in
  its transcript: `tail -n 5 .tutti/run/workers/<id>/messages.jsonl | jq -c .message.type`.
- **Answer attention requests** as they come (next section). A plain run holds once a request has
  waited 4 minutes.
- **To wind the run down** (orchestra's drain: no new tickets, the running ones finish and merge,
  the run ends `DRAINED`, exit 0), send `kill -USR1 <pid>`, the PID from `lsof -t .git/tutti.lock`.
  The log says `DRAIN: stopping after …, asked by SIGUSR1`. SIGUSR2 does the same.
- **To quit now**, `kill <pid>` (SIGTERM; SIGINT and SIGHUP do the same). See [Quitting and
  resuming](#quitting-and-resuming). Never `kill -9`.
- **Don't send a worker messages or take it over**: steering is the dashboard's, for the user.

## Answering attention requests

A worker waits on a person when Claude Code asks before a tool call (in auto mode, only when its
classifier can't decide or an `ask` rule matches), when the worker asks a question with
`AskUserQuestion`, or when an MCP server asks for input or a login. Each request shows as:

- a log line naming the command that answers it:

  ```
    PERMISSION: tut-9a1's worker asks: Bash(rm -rf build) (held by the safety check); answer with: tutti answer a3f9c2d1 allow --confirm | deny
    QUESTION: tut-7k2's worker asks: Which store? (SQLite | Postgres); answer with: tutti answer 5be01c7a allow --choice "<option>" | deny
  ```

- an `attention` record in the event stream, with `request`, `type` (`permission`, `question`,
  `elicitation`), `tool` and `summary` or `questions`, and `default_to_no`;
- a file in `.tutti/run/attention/`, which `tutti answer` lists.

**Listing.** `tutti answer` lists the open requests for people: the request ID, the ticket, what it
asks, why (`why: …`), a question's options, and `answer with: …`. `tutti answer --json` prints them
as a JSON array, one object per request: `id`, `ticket`, `kind`, `tool` and `summary` (a
permission), `questions` (each with `question`, `options[].label` and `multi_select`), `server`,
`message`, `mode` and `url` (an elicitation), `title`, `display_name`, `description`, `decision_reason`,
`blocked_path`, `answers` (the answers it takes), `default_to_no`, `suppress_always_allow_rule` and
`created_at`. It finds the main checkout from any of the repository's worktrees. `No open requests.`
(or `[]`) when there are none.

**Answering.** `tutti answer <request-id> allow|allow-run|deny`:

- `allow`: this call, once. `allow-run`: allow it, and keep its suggested rule for the rest of the
  run, so no worker is asked again for the same command; only where `answers` lists it.
- `deny`, optionally with `--reason "…"`, which the worker is told; its turn goes on with the
  refusal.
- A question: `allow` with one `--choice "<label>"` per question, in order, each an option's label
  exactly (for a `multi_select` question, labels joined by `, `), or `deny`.
- An MCP URL login (`mode: url`): `allow` once the user has opened the URL, or `deny`. A form
  elicitation takes only `deny`: its fields can be given only in the dashboard.
- `--confirm` is needed to allow a `default_to_no` request: Claude Code's safety check held it (a
  removal whose target can't be checked first, such as `rm -rf $T/*`), or it must not be approved by
  a stray keystroke.

```
tutti answer --json
tutti answer a3f9c2d1 deny --reason "use git clean -fdX instead"
tutti answer a3f9c2d1 allow --confirm        # only with the user's yes for this request
tutti answer 5be01c7a allow --choice "SQLite"
```

The command checks the answer against the request, writes it, and waits up to 10 seconds for the
run to take it: `The run took the answer to request <id>: allow.` Otherwise it exits 1 with
`tutti answer: …`: `there is no open request <id>` (answered on screen or withdrawn meanwhile: list
again), `allowing request <id> needs --confirm`, a choice that isn't an option, or `the run didn't
take the answer … within 10 s, so it was withdrawn; is tutti running in this repository?`.

**Who decides.** The answers are the user's. Show the user each request (the tool call, the
`decision_reason`, the worker's ticket) and answer as they say; answer on your own only the kinds of
request the user has told you to. Never pass `--confirm` without the user's explicit yes for that
request: it is the one check standing between a worker and a removal nobody looked at. A request the
user would have allowed but wants allowed for good belongs in their Claude Code settings' allow
rules, for the next run; `allow-run` lasts only this run.

**Time.** A request open for 4 minutes holds the run (`BLOCKED >4min: <id> needs you: …`): no new
tickets, the running ones finish. Answering lifts the hold (`HOLD lifted: <id>'s requests were
answered`) and the run goes on. A plain run doesn't wait for requests at its end: once nothing else
is left and the hold is on, it ends `BLOCKED` (exit 3), suspending the waiting worker (`waiting on
you`). The next run resumes it, and the worker asks again, under a new request ID.

**Denials.** `DENIED: <id>'s worker: Bash(…), by the classifier: <reason>` (or `by the safety
check`, `by the permission mode`, `by a rule`) and a `denied` record mean Claude Code refused a
call without asking. There is nothing to answer: the worker's turn goes on with the refusal. In auto
mode the safety check refuses held removals outright; the worker prompt tells workers to overwrite
instead or remove a file by its literal absolute path. Report repeated denials a ticket needed; the
run report's Needs you recommends rules.

**Questions as tickets** are different: a worker that needs a decision which can wait files a
`human` ticket and stops (`ASKED: <id> waits on your answer to <question> (…); answer with: bd human
respond <question>`). Only the user answers it: `bd human respond <question> --response "…"`. The
ticket comes back to the queue (`ANSWERED`), in this run or the next, and its session is resumed and
told the answer is in.

## Usage limits

On a subscription login, many workers at once reach the account's usage limits.

- `USAGE: 85% of the five-hour limit · resets 14:05`: a warning, once per limit. Nothing changes.
- `USAGE_LIMIT: the five-hour limit is reached; no new tickets until it resets at 14:05`: a hold.
  Workers whose turn ended on the limit wait for it; they aren't nudged, triaged or counted toward
  the environment hold. At the reset (plus a minute) the log says `USAGE_LIMIT lifted` and they
  carry on.
- With nothing else running, the run waits for the reset (`USAGE_LIMIT: nothing else runs; waiting
  for the five-hour limit to reset at 14:05, in 2h10m`, then a line every 10 minutes). Leave it
  waiting; `kill <pid>` quits during the wait, saving the sessions.
- It ends `USAGE_LIMIT` (exit 8) only when the reset is unknown or later than `--usage-limit-wait`
  (default 6h): `… N workers wait for it; run tutti again once it resets`. Their sessions are saved;
  start the run again after the reset time and it resumes them.

Each change is a `usage_limit` record (`status`: `warning`, `rejected`, `lifted`; `limit`,
`resets_at`, `utilization`) and, for the hold, a `hold` record whose `text` starts `HOLD:
USAGE_LIMIT` (`lifted: true` when it lifts).

## Runs that share a machine

Checks slow each other down across runs. `SHARED_MACHINE: another orchestra run is going in <repo>
with 3 workers; their checks slow each other down` (or `another tutti run`) says so once for each
other run on the machine; tell the user, as checks failing on time limits may come of it. With
`--machine-workers N`, `HOLD: MACHINE: …` means a free slot waits until a worker in one of the runs
finishes: it lifts by itself, within seconds. The records are `shared_machine` and `machine_hold`.

`SLEPT: the machine slept 34m (14:03-14:37); checks and limits don't count it` (a `slept` record)
means the machine went to sleep under the run: its time limits count only the time awake, so nothing
failed for it, but the run made no progress meanwhile. A run keeps the machine awake unless
`keep_awake` is `false` in `.tutti/settings.json` or the user's `~/.config/tutti/config.json`
(theirs wins); under the first SLEPT of such a run, `keep_awake is false for this run` says so:
suggest setting it true for an unattended run. There is no flag for it.

## Quitting and resuming

Quitting (SIGTERM, SIGINT or SIGHUP; `q` or a second Ctrl+C in the dashboard) stops scheduling,
interrupts every worker's turn at once, cancels their open requests, lets a merge under way finish
its protected step (a rebase in progress is aborted, a check killed and its ticket left waiting to
merge), closes the sessions, saves each one in `.tutti/run/state.json`, and ends `INTERRUPTED`
(exit 130) with no triage and no report:

```
QUIT by SIGTERM: no new tickets; interrupting the workers of tut-1, tut-2 and saving their sessions for the next run
INTERRUPTED: quit by SIGTERM; the sessions of tut-1, tut-2 are saved for the next run
```

A second signal says what is under way (`<id>'s merge is under way; send SIGTERM again to abandon
it`); a third exits at once (`INTERRUPTED: quit at once …`), and `abandoned <id>'s merge` means git
may still be finishing it: check `git status` and `git worktree list` with the user before another
run. Only send a second signal when the user asks.

The next run resumes every saved session, in a slot of its own and counting toward no limit, with a
message saying it was interrupted and to carry on. Its `START` is followed by a line per ticket,
`<id>, carried over from the last run, …`: resumed (`RESUMED: …; resuming its session <session>`),
`is closed, so it waits to merge`, `is deferred since, so it isn't resumed`, `is dropped: its
worktree … is gone`, `still waits on your answer to <question> …`, or `is kept for a later run: it is
outside this run's scope` (a `--ticket` run). `PAUSED` and `TICKET_LIMIT` workers are saved the same
way. A run killed with `kill -9` or a crash saved nothing new; the next run finds the dead PID and
takes up its tickets in progress as suspended, told the last run crashed.

`WORKER_GONE: …` means a session couldn't be resumed (its worktree or transcript gone, Claude Code
refused to start): the line says what brings the ticket back, usually `bd update <id> --status
open`. Look at its worktree with the user first.

A ticket closed but not merged when a run ends is labelled `unmerged`, which holds the tickets that
wait on it; the run that merges it, or finds it merged by hand, removes the label. If the ticket
needs no merge after all: `bd label remove <id> unmerged`.

## Reading a run's events

Each record has `v` (1), `kind`, `time` and `run`, the run's start time, which is the same in all
its records. A run's records go `start` (with `version`, `repo`, `branch`, `scope`, `feature`,
`concurrency`, `billing`, `permission_mode`), then its events (`dispatch`, `phase`, `closed`,
`deferred`, `asked`, `answered`, `waits`, `warn`, `hold`, `attention`, `attention_answered`,
`denied`, `usage_limit`, `suspended`, `resumed`, `triage`, `info`, …), then `stop` or `done`, and
last `end`, with `code`, the exit code. No `end` yet: the run is still going (`lsof` lists its PID),
or was killed. `schema/events.json` in tutti's repository has every kind and field.

```
E=.tutti/run/events.jsonl
run=$(jq -rs 'map(select(.kind == "start")) | last | .run' $E)   # the latest run's start
jq -c --arg run "$run" 'select(.run == $run and (.kind | IN("hold", "stop", "done", "end"))) | {kind, code, text}' $E
jq -c --arg run "$run" 'select(.run == $run and (.kind | IN("deferred", "asked", "warn", "triage"))) | {kind, ticket, text}' $E
jq -r --arg run "$run" 'select(.run == $run and .kind == "closed") | .ticket' $E
jq -c --arg run "$run" 'select(.run == $run and (.kind | IN("attention", "attention_answered", "denied"))) | {kind, ticket, request, answer, via, text}' $E
jq -c --arg run "$run" 'select(.run == $run and .kind == "phase") | {ticket, from, to, cause, why}' $E
```

The first says how the run ended: the `end` record's `code`, and the `stop` or `done` record's
`text`, which starts with the word in the table below (`PAUSED: …`, `READY_EMPTY after …`), after
any `hold` that came first; a `stop` record's `detail` is that word. The second lists what was set
aside or needs looking at, the third what was merged, the fourth every request, its answer
(`via`: `screen` or `answer_command`) and every denial, the fifth each ticket's path through the
phases. A `warn` record with `"aside": true` left its ticket for review; a `hold`, `stop` or `warn`
record with `blocked` is a ticket whose work is done but which can't merge until the user acts, and
says why. A `full_check` record, after `done`, says how the full check went (`detail`: `passed`,
`failed`, `timed out`, `skipped`, `not run`); a failed one has `suite`, `output` and `ticket`.

## When a ticket is set aside or the run stops

Read the run report first (`.tutti/reports/<start time>.md`: Finished, Set aside, Needs you; a plain
run also prints it at its end), then the run's events, then the tickets (`bd show <id>`: the
worker's notes, tutti's, `Triage …`). The exit code and the last `stop` or `done` line say why it
ended:

| Last line | Exit | Meaning | What to do |
|---|---|---|---|
| `READY_EMPTY`, `LIMIT_REACHED` | 0 | queue empty, or `--limit` reached. `READY_EMPTY after 0 tickets: …` is a run that had nothing to run, which printed its box and wrote no report | Read the report; the next step is usually the batch PR. With nothing to run, relay the box. |
| `DRAINED`, after a `DRAIN: …` line | 0 | wound down by SIGUSR1 (or the dashboard's `s`) | As for `READY_EMPTY`; the queue may still hold tickets. |
| `…; SCOPE_DONE: …` | 0 | a `--ticket` run: the ticket and its subtickets are merged | Close an epic left open (`close it with: bd close <id>`); then the batch PR. |
| `…; SCOPE_OPEN: …` | 0 | a `--ticket` run with subtickets not done, each named with why | Handle each reason: answer a question, merge a ticket left for review, unblock or rerun. |
| any of the lines below, after a `HOLD: …` line | as below | with several tickets at once, a stop first holds: no new tickets, the running ones finish | Handle the reason as below; the `HOLD` line names the ticket. |
| `REQUIREMENTS_MISSING` | 2 | the machine lacks what the project's requires list (`"requires"` in `.tutti/settings.json`) names, and its install didn't help or it is a manual step; nothing started. Each one is named with what to do: its manual step, or why its install failed and where its output is (`.tutti/run/requires-<name>.log`) | Tell the user what is missing and what to do; `tutti requires` checks the list again. Install nothing the list doesn't name. |
| `SETUP_PROBLEM` | 2 | a worker's first `system/init` showed a setup problem: MCP servers it wasn't given (a claude.ai connector, say), or an API key it would bill beside the subscription login. The worker was stopped before it did anything; its ticket is reopened, its worktree kept, and the next run starts it afresh | Tell the user the problem the line names and what to change (the API key in the environment, the MCP setup); run tutti again once it is fixed. |
| `PAUSED` | 3 | a worker settled with its ticket still `in_progress`, was told twice to continue, then sat idle for 10 minutes (or its session went again after a resume) | Read the end of its transcript; relay any question to the user. Its session is saved: the next run resumes it. |
| `BLOCKED >4min` | 3 | a worker waited on an attention request for 4 minutes, and the run ended before it was answered | Show the user the request; the next run resumes the worker, which asks again. |
| `TICKET_LIMIT` | 3 | a worker was still going after `--ticket-limit` | Read its transcript: a hung command, or a big ticket. Tell the user; the next run resumes it. |
| `ENVIRONMENT` | 7 | the last tickets' workers all failed at once (settled soon after starting with nothing done), or triage blamed the environment for each: the machine, not the tickets. A `PROBE:` line before it means tutti waited and tried once more in the main checkout | Read the workers' transcripts and stderr logs and the triage notes for the cause (a refused permission, a missing tool, the network, the classifier down). Tell the user. Tickets that failed at once were reopened already. Then restart the run. |
| `USAGE_LIMIT` | 8 | the account's usage limit, with its reset unknown or later than `--usage-limit-wait` | Start the run again after the reset; it resumes the waiting workers. |
| `MERGE_FAILED` | 6 | a ticket's branch doesn't fast-forward after rebasing | Rare: something else changed the base. Rebase the worktree, check, merge by hand (below). |
| `DIRTY_TREE` | 5 | uncommitted changes in the main checkout, or it left its branch | `git status`. These are the user's changes: ask before touching them. |
| `BEADS_FAILED`, `GIT_FAILED`, `WORKTREE_FAILED`, `STATE_UNWRITABLE`, `PANIC` | 4 | Beads, git or the filesystem failed, or tutti hit a bug | The line ends with the tool's error; the log has the rest. Workers still running are suspended for the next run. |
| `INTERRUPTED` | 130 | quit (a signal, or `q` in the dashboard) | Nothing is lost: the next run resumes the saved sessions. After `quit at once` with `abandoned <id>'s merge`, check `git status` and `git worktree list` first. |
| (printed on stderr, not logged) | 2 | setup problem, another run going, or `--feature` with nothing filed | The output lists each problem and its fix. |

Lines about single tickets, which don't stop the run (indented under the run's lines; in the events,
`closed`, `deferred`, `asked`, `answered`, `waits`, `warn` and `info` records with the line as
`text`):

- `closed (…); merged into …` (a `closed` record): done; its worktree and branch are removed.
  `<id> closed with no change`: closed with nothing to merge, cleaned up the same way.
- `deferred …`: set aside. A `triage` line follows with the triage organ's verdict (cause:
  environment, instructions or problem), also appended to the ticket's notes.
- `START_FAILED`: its worker didn't start; deferred, worktree left as it is. `BAD_TICKET_ID`,
  `RUN_FILES_OUTSIDE`: deferred without starting a worker; the line names the fix and `bd undefer`.
- `WAITS_FOR_MERGE`: its worker stopped with nothing done, waiting for a blocker that hasn't merged;
  back in the queue until it does. `<id> waits: …` and `skipping <id>: …`: held for a blocker, a
  parent's subtickets, an overlap with a running ticket, or a solo ticket. Normal.
- `CLOSED_WITHOUT_COMMIT`: closed, but no commit on `tutti/<id>` names it. `CLOSED_UNCOMMITTED`:
  closed with a commit, but its worktree has uncommitted changes. Both left for review.
- `OFF_BRANCH`: its worktree has another branch checked out. `DIRTY_WORKTREE`: uncommitted changes
  at merge time. `REBASE_FAILED`: a returning ticket's branch conflicts with the base. Left for
  review: look at the worktree with the user.
- `RESOLVING: tutti/<id> conflicts with <base> in <files>; handed back to its worker to resolve`,
  `FIXING: '<check>' fails on tutti/<id> rebased onto <base>; handed back to its worker to fix (1 of
  2, …)`: its own worker resolves the conflict or fixes the check; tutti checks the result itself and
  merges it, or sets it aside with `MERGE_CONFLICT` or `CHECKS_FAILED`. Leave it alone meanwhile.
- `MERGE_CONFLICT`, `CHECKS_FAILED`: closed, not merged; the ticket stays closed. Rebase or fix in
  its worktree, run the checks, merge by hand, with the user. `did not finish within 30m` means the
  check hung or ran past its limit. `RECHECK`: a ticket whose check failed is checked once more after
  the base moved on.
- `FLAKY`: a test failed, then passed on its rerun; not a failure.
- `FULL_CHECK_FAILED`: after the run, `scripts/check-full.sh` failed on the branch's head in a
  worktree of its own; the output is in `.tutti/run/check-full.log`, and a P2 bug `Full check fails:
  <suite>` (label `check-full`) is filed, or noted on the one already open.
- `LIKELY_CONFLICT`, `<id> footprint …`: two running tickets touch the same file, or the predictor
  guessed a ticket's files. Normal.
- `LONG_RUNNING`: a worker still going after 2 hours with no ticket limit set; the run keeps
  waiting. Read its transcript for a hung command.
- `CLEANUP_FAILED`, `LABEL_FAILED`, `DEFER_FAILED`, `REOPEN_FAILED`: merged or set aside, but a
  worktree, branch, label or bd change failed; the line names the command to run.
- `PERMISSION`, `QUESTION`, `ALLOWED` (a request allowed by a rule allowed for this run), `DENIED`:
  attention requests and denials, above.

## Where to look

| What | Where |
|---|---|
| every event, as JSON with its kind and ticket | `.tutti/run/events.jsonl` in the main checkout |
| every event, as lines for people | `.tutti/tutti.log`, or a plain run's stdout |
| what finished, what was set aside and why, what needs the user | the latest `.tutti/reports/*.md` |
| what waits on a person now | `tutti answer` (`--json`); `bd human list` for question tickets |
| why a ticket was deferred | `bd show <id>`: the worker's notes, tutti's notes, the triage verdict |
| what a worker did and said | `.tutti/run/workers/<id>/messages.jsonl` (its SDK messages); `stderr.log` beside it |
| a ticket's work | worktree `<repo>-tutti/<id>`, branch `tutti/<id>`: `git log --oneline <base>..tutti/<id>` |
| the sessions the last run saved, for the next to resume | `.tutti/run/state.json` in the main checkout |
| the whole output of the last full check that failed | `.tutti/run/check-full.log` |

## Finishing a ticket by hand

A worker that a run stopped or quit is resumed by the next run, which merges its ticket. Finish a
ticket by hand only when no run will (a `WORKER_GONE` line, a merge set aside) or when the user
wants it merged before the next run. Quote `<worktree>` when its path holds a space:

1. Check it: `bd show <id>` is closed, `git log --oneline <base>..tutti/<id>` has a commit naming
   it, and `git -C <worktree> status --porcelain` is empty.
2. If the base branch has moved since, rebase it in the worktree: `git -C <worktree> rebase <base>`.
3. Run the project's check (`scripts/check-fast.sh`) in the worktree.
4. From the main checkout, on the base branch, with no run going: `git merge --ff-only tutti/<id>`,
   `git worktree remove <worktree>`, `git branch -d tutti/<id>`, and `bd label remove <id>
   unmerged` if it has the label.

A set-aside ticket whose worktree has no commits and no changes can be cleaned up the same way,
without the merge. A worktree with work in it is the user's call.

## Leave to the user

- `git push` and anything else that leaves the machine, such as opening or merging pull requests,
  unless they asked for it.
- Answers: attention requests unless they told you which to answer, every `--confirm`, and `human`
  question tickets.
- Logging in (`tutti login`), trusting the main checkout, `--billing api`, `tutti init --force`,
  raising `concurrent` above 1, installing Beads or tutti, and `tutti update`.
- Stopping a run they started, and a second or third quit signal.
