# Running

Starting a run and its options, scoped and feature runs, several tickets at once, the merge queue,
holds and stops, the usage limit, quitting and carrying on, exit codes, running through an agent, and
orchestra beside tutti. Back to the [README](../README.md).

## Starting a run

From the main checkout (not a worktree), on the branch finished tickets should land on:

```
git switch -c batch/$(date +%F)
tutti
```

`tutti` checks its setup first and lists every problem at once, with exit code 2:

```
tutti cannot start:
  - The main checkout has uncommitted changes (src/a.ts). Commit or stash them first: finished tickets merge into it. Inspect with: git status
  - Not logged in to Claude: run claude /login, or tutti login
```

It checks the repository and its main checkout (on a branch, its tree clean but for `.tutti/run/`
and `.beads/`), `bd` and the Beads database, the Claude Code it runs, the login and your Claude Code
settings ([Login and billing](setup.md#login-and-billing)), the settings and your user config, the MCP
servers workers get, and the worker prompt. In a repository `tutti init` hasn't set up, it says so
first:

```
tutti isn't set up in this repository yet. Run this first:
  tutti init
It writes .tutti/ (the worker prompt and settings) and sets up Beads if needed.
```

**One run at a time.** Once its checks pass, a run takes the repository's lock, `tutti.lock` in the
git directory (`.git/tutti.lock` in the main checkout), until it exits. A second run, or `tutti init`,
stops with exit code 2: `tutti is already running in <repo> (pid 44497, since 08:31, main)`. The lock
is an `flock`, which the system releases however tutti exits, `kill -9` included, so there is never a
stale lock to remove; the file says which run holds it. tutti also takes orchestra's lock, so neither
runs while the other does ([orchestra beside tutti](#orchestra-beside-tutti)).

The log, `.tutti/tutti.log`, opens with the run's `START` block: the version, the repository, the
branch, the scope, the limits and the worktrees folder, then the billing, the permission mode in
effect, the MCP servers, the memory the workers take, and any warning; then the tickets left
unmerged and the workers carried over, and the deferred tickets free to run
([`DEFERRED_FREE`](#nothing-to-run)).

**The start question.** In a terminal (its input and output both), `tutti` asks what the run should
work on:

- **Current tickets**, the default, runs the backlog as this page describes. It reads
  `Current tickets: N ready`, or with nothing to run `Current tickets: none, all done` or
  `Current tickets: none ready (N open)`.
- **New feature** asks you to describe a feature, then talks it through with you
  ([below](#talked-through)).

`Esc` or `Ctrl+C` there exits with code 130, nothing changed. `--tickets` skips the question and runs
the current tickets, as scripts and agents should; `--ticket`, `--feature` and `--plain` skip it too,
and a run without a terminal never asks.

### Nothing to run

A run with nothing to run says so and exits 0, without opening the dashboard: nothing in its
`bd ready` query the run would start, and no worker the last run left to carry on with. On a terminal
it shows a box; otherwise the same lines.

- `✓ All done`: no ticket is left but epics, and none is closed but not merged.
  `Still open: <ids> (bd close <ids>)` follows while epics are open.
- `○ Nothing ready to run`: tickets are left, but none can start. A line for each of what holds them:
  `2 questions wait for your answer: bd human list`, `3 tickets wait on other tickets: bd blocked`,
  `1 ticket waits for its subtickets to merge`, `2 tickets wait for their blockers to merge`,
  `1 follow-up waits for the ticket it was filed from to merge`, `1 in progress · 1 deferred`,
  `1 closed but not merged: bd list --label unmerged`.

A deferred ticket whose blockers have all merged gets a line of its own:
`Deferred: <id>: its blockers have merged (<blockers>); to run it: bd update <id> --status open`,
and whether its worktree is safe to remove.

A run with something to run lists those in its `START` block instead, a line each:
`DEFERRED_FREE: <id>: its blockers have merged (<blockers>); to run it: bd update <id> --status open`,
and whether its worktree is safe to remove. Neither reopens the ticket: a deferral can have other
reasons, so that is yours to decide.

### Options

`tutti -h` lists them. Each run flag has an environment variable, `TUTTI_` and its name in capitals
(`TUTTI_CONCURRENT`, `TUTTI_TICKET_LIMIT`, `TUTTI_NO_MOUSE`), which counts when the flag isn't given.
On-or-off flags and variables take `1`, `true`, `yes` or `on`, and `0`, `false`, `no` or `off`; a
flag given alone is on (`--plain`). Anything else is a setup problem. orchestra's unprefixed variables
(`LIMIT`, `NOTIFY`, `WT_ROOT`, …) aren't read.

| Flag | |
|---|---|
| `-c N`, `--concurrent N` | tickets at the same time, 1 to 16 (default: the settings', else 1) |
| `--machine-workers N` | start no ticket while this many workers run across the machine's tutti and orchestra runs, this one's included ([below](#runs-that-share-a-machine)); `0`, the default, for no cap |
| `--tickets` | run the current tickets without asking first |
| `--ticket <id>` | run only this ticket and its subtickets ([below](#one-ticket-and-its-subtickets)) |
| `--feature "<request>"` | plan a request as an epic and its tickets, then run them ([below](#planned-by-the-organs)) |
| `--yes` | with `--feature`, file the plan without asking |
| `--limit N` | the most tickets this run starts (default: no limit) |
| `--ticket-limit 2h` | hold the run when a worker is still going this long after dispatch; `0` for none |
| `--worker-effort <level>` | the effort workers and the feature interview start at: `low`, `medium`, `high` (default), `xhigh` or `max` |
| `--worker-model <model>` | the model workers run |
| `--organ-model <model>`, `--organ-effort <level>` | every organ's model and effort ([Organs](organs.md)) |
| `--triage=false`, `--review=false` | no triage; no run report |
| `--notify=false` | no notifications |
| `--check-timeout 30m` | stop the merge check after this long |
| `--check-full-timeout 60m` | stop the full check after this long |
| `--resolve-conflicts=false` | set a ticket whose rebase conflicts aside, rather than hand it back |
| `--plain` | log lines instead of the dashboard ([Plain output](dashboard.md#plain-output)) |
| `--no-mouse` | leave the mouse to the terminal |
| `--prompt <file>` | another worker prompt ([The worker prompt](workers.md#the-worker-prompt)) |
| `--worktrees <dir>` | the folder for the tickets' worktrees, outside the repository (default `<repo>-tutti` beside it) |
| `--billing api` | keep `ANTHROPIC_API_KEY` beside a subscription login ([Login and billing](setup.md#login-and-billing)) |
| `--usage-limit-wait 6h` | the longest a run with nothing else to do waits for the usage limit ([below](#the-usage-limit)) |
| `--claude <path>` | run workers with this Claude Code instead of the embedded one |
| `--colour-scheme <name>` | the colour scheme ([Colour schemes](colour-schemes.md)) |

Most default to [the settings](setup.md#the-settings); the flag wins for its run. A relative
`--prompt` or `--worktrees` is the main checkout's.

Every `git` and `bd` command tutti runs has a time limit: 30 seconds for a read, 2 minutes for a git
write or a `bd` update. A command still running then is stopped with everything it started.

### One ticket and its subtickets

```
tutti --ticket tut-8f2
```

`--ticket <id>` runs that ticket and its descendants and nothing else, each parent after its
children. The `START` line and the dashboard's title show the scope (`· ticket tut-8f2`). Workers are
told to file follow-ups that belong to the work as children of `<id>`, so the run picks them up;
anything filed otherwise waits for a later run, and the run report lists it.
A ticket `bd` can't show, a closed one (reopen it with `bd update <id> --status open`) or a question
for you (answer it with `bd human respond <id>`) is a setup problem, exit 2.

The run ends as any other, followed by whether the scope is finished:

- `SCOPE_DONE: tut-8f2 and its 3 subtickets are merged`, or for an epic, which tutti closes as its last
  subticket merges, `SCOPE_DONE: tut-8f2's 3 subtickets are merged; tutti closed tut-8f2`;
- `SCOPE_OPEN: tut-8f2: 2 of its 5 subtickets not done: tut-8f2.2 (blocked by tut-x7 outside the
  scope), tut-8f2.4 (waiting on your answer to tut-q1)`, naming why each isn't: set aside in this run,
  deferred, closed but not merged, in progress, blocked, waiting for its subtickets, its setup failed
  (with where its output is), not started.

Both exit with 0. With nothing under `<id>` ready, the box says `○ Nothing under <id> is ready to run`,
with each ticket not done and why.

### A feature from one request

A feature goes from a request to a finished run in one of two ways. Either way it is filed in Beads as
an epic and its tickets (each with a description, acceptance criteria, a type, a priority, its `files`
metadata, `blocks` links between them, and `solo` where planned), and run as `--ticket <epic>` would
run it.

#### Talked through

Pick **New feature** at the start question and describe the feature (`Alt+Enter` or `Ctrl+J` for a
new line). tutti opens the **interview**: a chat, in tutti's screen, with a Claude session in the
main checkout that asks you about the feature in rounds, numbered questions each with its recommended
answer, until you share an understanding, then proposes the epic and its tickets. You answer in the
composer (`i`), or pick an option where a question is a choice.

The session reads the repository and the open tickets, and can't change anything: its only tools are
read-only, and it files the feature through a tool of tutti's, which checks the plan before filing.
Once it has filed and its turn is over, tutti shows the epic and its tickets and asks
`Start the run on <epic> (N tickets)? [y/N]`. `y` runs it; otherwise:
`Filed epic <id> with N tickets; nothing was run. Run it with: tutti --ticket <id>`.

`Esc` (outside the composer) or **← Back** asks `End the interview? Nothing has been filed.` The
interview needs tutti's full screen: where the start question is asked as lines (`TERM=dumb`, fewer
than 256 colours), choosing it says so and exits 0, and `tutti --feature` plans the feature instead.

#### Planned by the organs

```
tutti --feature "Add a --json flag to the list command"
```

For scripts and agents. The [screen organ](organs.md#the-screen-and-the-plan) judges the request: one
it rejects or finds unclear stops with its reason (exit 2). The plan organ plans it, or stops with its
questions (exit 2): run it again with the answers in the request. tutti shows the plan, the epic then
each ticket with its type, priority, files and the tickets it waits for, and asks
`File these N tickets and start the run? [y/N]`. `--yes` files it without asking; without a terminal
to ask on and without `--yes`, nothing is filed (exit 2). Nothing is filed before you confirm, and
`Ctrl+C` stops with nothing filed (exit 130).

`--feature` can't be combined with `--ticket` or `--tickets`, nor run with `--limit 0`, which would
file the plan and start none of it.

## Several tickets at once

With `concurrent` above 1, up to that many workers run side by side, each in its own worktree. Start
at 1, and raise it once the checks run cleanly side by side; each worker takes about 1 GiB of memory.

### Scheduling

- **Priority.** A free slot goes to the highest-priority ready ticket that nothing holds back. Ready
  is `bd ready`, without questions (tickets labelled `human`) and the `queue.exclude_types` (epics,
  which never run: their subtickets are the work).
- **Free slots don't wait.** `bd ready` is read every 30 seconds, and at once when a slot frees, so a
  ticket that becomes ready meanwhile (an answered question, a follow-up, a closed blocker) takes a
  free slot then. No ticket runs twice.
- **A finished ticket frees its slot as it goes to merge.** The next ready ticket starts while it waits
  for its turn, is rebased and checked, or has its worker resolve or fix its branch. Until it merges
  it still holds back what it did while it ran: the tickets it blocks, its follow-ups, those
  overlapping its footprint (`skipping <id>: touches src/a.ts, like running <other>`) and a solo
  ticket. Up to `concurrent` tickets merge or wait to merge without a slot; beyond that a finished
  ticket keeps its slot until a merge ends.
- **Parents run last.** A ticket with subtickets not all closed and merged waits for them:
  `<id> waits: its subtickets are not all closed and merged`. tutti closes an epic itself once a run
  merges the last of its subtickets: `closed epic <id>: all 3 subtickets are merged`.
- **Blockers must merge, not only close.** `bd ready` counts a closed blocker as done, but its code
  isn't on the base until it merges, so a ticket waits for that:
  `<id> waits: <blocker> closed but not merged (…)`. A blocker closed where the run didn't see it
  close (by hand, by another tool, under an earlier tutti) hasn't merged while `tutti/<blocker>` has
  commits the base lacks and the base doesn't hold its changes:
  `<id> waits: <blocker> closed but not merged (tutti/<blocker> is not on <base>)`, warned of once
  with `CLOSED_UNMERGED`, which says how to clear it. Merge the branch, or delete it if its work isn't
  wanted, and the tickets it blocks start at the next poll. Where git can't tell, they wait, saying
  so (`git can't tell whether tutti/<blocker> is on <base>: …`), until git answers.
- **A follow-up waits for the ticket it was filed from.** A ticket filed `discovered-from` another
  was written against that ticket's code, so it waits until that one merges too:
  `<id> waits: filed by <source>'s worker; waiting for it to merge`.
- **Workers start set up.** With a setup command (see [The checks](setup.md#the-checks)), it runs in a
  ticket's new worktree before its worker starts. One that fails starts no worker (`SETUP_FAILED`):
  the ticket goes back in the queue until a ticket merges or a probe passes, counted apart in **In
  queue** (`· 1 setup failed`), and setups failing ticket after ticket hold the run for the
  environment. A run that ends with tickets still waiting on their setup names them, each with where
  its output is: `READY_EMPTY after 4 tickets; SETUP_WAITS: tut-3 waits on the setup that failed in
  its worktree (…); fix the setup, then run again`. They count toward no `--limit`.
- **A ticket that started too early goes back in the queue.** A worker that finds its ticket needs
  another ticket's unmerged work links it as a blocker and stops with nothing done; tutti removes its
  worktree and branch, which hold nothing, and puts the ticket back until the blocker merges
  (`WAITS_FOR_MERGE`, `◷ waiting` on the dashboard).
- **Some tickets run alone.** A ticket labelled `solo` (`bd label add <id> solo`), such as one splitting
  a file every other ticket touches, starts only when nothing else runs, and nothing starts beside it.
  When it is next while others run, nothing new starts behind it:
  `solo ticket <id> is next: no new tickets start until the running ones finish, then it runs alone`.
- **`--limit`** counts the tickets this run starts, with no limit unless it is given; workers carried
  over from the last run count toward nothing. Once reached, the run finishes what it has and ends
  `LIMIT_REACHED`. Without one, the dispatch lines say `[n]` rather than `[n/limit]`, and the run ends
  `READY_EMPTY` or `DRAINED`.
- **IDs must be plain names.** A ticket whose ID holds a path character, or can't name a git branch, is
  set aside without a worker: `BAD_TICKET_ID: … rename it (bd rename <id> <new-id>), then bd undefer
  <new-id>`.

### Runs that share a machine

Runs on one machine slow each other's checks down. Each tutti run registers itself, a small file in
the folder orchestra's runs register in (`runs/` in orchestra's cache folder:
`~/Library/Caches/orchestra/runs` on macOS, `~/.cache/orchestra/runs` elsewhere; `ORCHESTRA_RUNS_DIR`
names another, `off` none), for as long as it runs, so tutti and orchestra see each other's runs.
Once for each other run, the log says
`SHARED_MACHINE: another orchestra run is going in <repository> with 3 workers; their checks slow
each other down` (`another tutti run` for tutti's), and `the other … run in <repository> has ended`
as it ends.

`--machine-workers N` (or `TUTTI_MACHINE_WORKERS`) caps the workers across the machine's runs, this
one's included, merges and checks counted: a free slot waits at the cap, saying once
`HOLD: MACHINE: the machine's tutti and orchestra runs have 4 workers running, 2 of them this run's,
at the cap of 4 (--machine-workers); the next ticket starts once one of them finishes`, with
`MACHINE` on the dashboard's title line while it holds. The run reads the other runs every 2 seconds
while it holds, so the slot is filled within seconds of a worker finishing. A run with none of its
own workers running never waits. A registration whose run is gone (its process ended, or its PID
taken by a process started since, after a reboot or a run killed) counts nothing and is removed.

The other runs' workers count in each worker's share of the cores (`TUTTI_CORES`, see
[the worker prompt](workers.md)): the cores divided among this run's `concurrent` workers and theirs,
as the run last read them, no more than `--machine-workers` where it is set. A worker takes its
share as it starts and keeps it.

### Footprints

Tickets that touch the same code don't run side by side. Each ticket has a **footprint**:

- the files and functions its title, description, design and acceptance criteria name
  (`src/run/merge.ts:120`, `merge.ts`, `src/routes/[slug]/+page.svelte`, `Loop.merge`,
  `refreshBranch()`, a camel-case name in backticks), checked against `git ls-files`; not its notes,
  which say what happened to it;
- its `area:<name>` labels;
- the files its `files` metadata lists (`bd update <id> --set-metadata files=a.ts,b.ts`), where a folder
  (`src/run/`) means every file under it and a glob (`src/**/*.test.ts`) every file it matches;
- for a ticket naming none of these, the `predicted_files` metadata, if it has one;
- once it runs, the files its worktree has changed, read every 30 seconds.

A ticket with commits on its branch (`tutti/<id>`: reopened, or carried over) is footprinted from the
files its branch changes on top of the base, its `files` metadata and its area labels instead, not
from its text, which names what it read and was told as well.

The files the checks' commands name are left out, unless the `files` metadata lists them: nearly every
ticket says "`scripts/check-fast.sh` passes" without changing it. The files git merges by union
(`CHANGELOG.md merge=union` in `.gitattributes`) are always left out: git keeps both tickets' lines.
The log shows each ticket's footprint as it is dispatched: `<id> footprint: Loop.merge,
src/run/merge.ts, area:run`, the predicted files marked `(predicted)`, a branch's `(from its
branch)`, or `nothing named`. Two tickets overlap when they share an area label, a function or a file;
in a file both name functions in, they are compared by function. A file both name holds them apart
only when one of them is to change it: its `files` metadata lists it, or, without `files` metadata,
its text names it, a document (`.md`, `.txt`) only in a sentence asking to change it ("Update
docs/guide.md", not "per CLAUDE.md"); or its worktree has changed it.
A ticket that overlaps a running one is skipped, not waited for:
`skipping <id>: touches merge.ts, like running <other>`. When two running workers change the same
file anyway, the log warns: `LIKELY_CONFLICT: <a> and <b> both edit <file>; the second to merge may
conflict`. `"queue": { "footprint": false }` in the settings turns all of this off.

### Ordering tickets ahead of time

Footprints keep overlapping tickets apart, but in either order. `tutti plan` orders them ahead of a
run: it reads the open tickets and proposes a `blocks` link between two that name the same function,
or work on the same small file (200 lines at most), the higher-priority one first:

```
$ tutti plan
Proposed 2 blocks links between the 14 open tickets:
  tut-k2 (P3) waits for tut-k1 (P1): both touch Loop.merge
  tut-k5 (P2) waits for tut-k3 (P2): both touch src/run/scope.ts
Nothing changed. Add them with: tutti plan --apply
```

`tutti plan --apply` adds them with `bd dep add`. Run it after filing a batch of tickets.

### What tutti can't make safe

- **Checks that collide.** Every worker runs the project's checks. Tests that share a port, a database
  or a named simulator can fail when two run at once: put such a suite between `lock` and `unlock` in
  the runner ([The checks](setup.md#the-checks)).
- **Files every ticket touches.** Two tickets that each add at the end of the same file conflict when
  the second is rebased. The worker prompt has workers put new tests in new files and new fields next
  to their code; for the changelog, `tutti init` offers `CHANGELOG.md merge=union` in
  `.gitattributes`.

## The merge queue

A finished ticket (closed, with a commit naming it, its worktree clean and on its branch) waits for
its turn (`◷ to merge`). Tickets merge one at a time, in the order they finish (`◆ merging`):

1. **Rebase.** If the base moved on while the ticket ran, its branch is rebased onto it.
2. **Setup.** If the rebase changed a dependency file, the setup command runs in its worktree
   ([The checks](setup.md#the-checks)). Before the check on a worker's fix of a failed check, or on
   its resolution of a conflict, it also runs if the worker's own commits changed one.
3. **Check.** The merge check, `scripts/check-fast.sh`, runs on the branch, rebased or on top of the
   base already, so no ticket reaches the base unchecked:
   `tutti/<id> is on top of main already: checking it with 'scripts/check-fast.sh' before it merges`.
   A branch the check passed on in this run, as its worker fixed it or resolved its rebase, isn't
   checked again.
4. **Fast-forward** the base to the branch. The worktree and branch are removed:
   `<id> closed (ffd6ce4 Add a --json flag (tut-12)); merged into main, worktree and branch removed`.

A ticket closed with nothing of its own to merge, or whose commits together change nothing, or whose
rebase leaves nothing because the base has its changes already, is done with `no change to merge`.

What can go wrong, and what becomes of the ticket:

| | |
|---|---|
| `OFF_BRANCH` | its worktree has another branch, or a detached HEAD, checked out: left for review |
| `DIRTY_WORKTREE` | uncommitted changes in its worktree stop the rebase: left for review |
| `REBASE_FAILED` | git refuses the rebase for another reason: left for review |
| `MERGE_CONFLICT` | the rebase stops on conflicts: handed back to its worker, else blocked |
| `CHECKS_FAILED` | the check fails or doesn't finish within its time limit: handed back, else left for review |
| `FLAKY` | the check passed, but a test failed and passed on a rerun: merged, with a warning |
| `DIRTY_TREE` | the main checkout has uncommitted changes, or left its branch: the merges stop, and the run holds |
| `GIT_FAILED`, `MERGE_FAILED` | git fails, or the branch doesn't fast-forward: the merges stop, and the run holds |

A failing check's whole output is kept in the worktree, `.tutti/run/check.log` (`setup.log` for the
setup), and its line ends with the lines that say what failed. Each line about a ticket set aside also
goes into the ticket's notes.

**Hand-backs.** A conflict or a failing check often comes where the ticket's change meets what landed
meanwhile, so it goes back to the ticket's worker, which still has the change in mind (see
[Hand-backs](workers.md#hand-backs)):

```
RESOLVING: tutti/tut-12 conflicts with main in src/a.ts; handed back to its worker to resolve (up to 20m)
FIXING: 'scripts/check-fast.sh' fails on tutti/tut-12 rebased onto main; handed back to its worker to fix (1 of 2, up to 20m)
```

The merge queue doesn't wait meanwhile. When the worker is done, tutti checks what it left (the
rebase finished, the worktree clean and on its branch, only the ticket's commits on top of the base,
the check passing) and queues the ticket again. The check runs once, where the ticket merges: when
another ticket merged while the worker worked, what it left goes back in line unchecked
(`<id>'s worker finished the rebase, but main moved on meanwhile: rebasing tutti/<id> onto it before
checking it`, or `<id>'s worker committed 1 commit, but …`), and its merge rebases it and checks it
there. A worker that finds nothing to fix in a failed check
(a test timing out on a loaded machine, say) commits nothing: the check runs a second time, and a
pass queues the ticket (`'<check>' passes on tutti/<id> on a second run; its worker committed
nothing`), while a second failure sets it aside with no further hand-back, its notes saying `not
handed back again: its worker found nothing to fix`. A ticket that can't be handed back (the worker busy
or steered, the attempts used up, a check that timed out, the run winding down) is set aside, its line
saying why. `"merge": { "resolve_conflicts": false }` (or `--resolve-conflicts=false`) and
`"check_hand_backs": 0` turn them off.

**A failed check is tried once more.** A check can fail on something the ticket didn't change, which a
later ticket fixes. Once the base has moved on, a ticket set aside with `CHECKS_FAILED` is rebased and
checked once more, through the merge queue:
`RECHECK: <id>'s check failed on main at 3c4d5e6, which has moved on since; rebasing tutti/<id> and
checking it once more`. Not when it failed in files its own commits change, nor once the ticket has
been taken up since. It takes a slot as a running ticket does, until its merge is over, and none is
checked again while the run holds or winds down, or while a solo ticket runs or is next. Winding down,
or stopped as it ends, the run names each ticket it won't check again (`<id> is not checked again in
this run, as the run winds down; it stays set aside`), and one set aside while it winds down says so.

**A ticket merged by hand during the run.** You may merge a ticket set aside or blocked yourself
while the run goes on. Each time the base moves on, and once more as the run ends, the run asks git
of each ticket closed but not merged, as it does of those left `unmerged` as it starts. One on the
base now is done, merged by hand: `<id>, set aside in this run, is on main now (3c4d5e6 …): merged by
hand, so no longer set aside; worktree and branch removed`. It isn't checked again, the tickets it
blocks start, its `unmerged` label goes, and the end line and the report count it closed. A worktree
with uncommitted changes is left, with its branch, and the line says so.

## Holds and stops

Something that needs you **holds** the run: no new tickets start, the running ones finish and merge,
and then the run ends with that reason. The log says
`HOLD: PAUSED: …; no new tickets while the 2 running finish`, and the dashboard's title line names it.

- **`PAUSED`**: a worker idle with its ticket still in progress, after two continue nudges and
  10 minutes idle (from your last message, for a steered worker).
- **`BLOCKED`**: a request unanswered for 4 minutes. Answering every open request lifts it:
  `HOLD lifted: <id>'s requests were answered`.
- **`TICKET_LIMIT`**: a worker still going after `--ticket-limit`. It isn't interrupted, and the run
  doesn't wait for it; it is suspended as the run ends, and the next run resumes it with its limit
  counted afresh.
- **`DIRTY_TREE`**, **`GIT_FAILED`**, **`MERGE_FAILED`**: the merges stop.
- **`BEADS_FAILED`**, **`AGENT_FAILED`**: `bd` or a worker's session failing.
- **`ENVIRONMENT`** and **`USAGE_LIMIT`**, below.

**Winding down yourself.** `s` in the dashboard, then `y`, or `kill -USR1 <pid>`: no new tickets, the
running ones finish and merge, and the run ends `DRAINED`, exit 0, with the full check and the report
as usual. `s` again takes it back.

### The environment hold

Sometimes the machine fails every worker the same way, whatever its ticket: a classifier that is down
refuses every command, and each worker gives up at once. Two tickets in a row whose workers settled
within 2 minutes without claiming the ticket, committing or changing anything, or that
[triage](organs.md#triage) blamed on the environment with high confidence, hold the run:

```
HOLD: ENVIRONMENT: the last 2 tickets (tut-a, tut-b) each settled within 2m of starting without being claimed or changed; check the machine, then restart
```

A setup that failed in a ticket's worktree before its worker could start counts as a worker failing
at once: `the setup 'npm ci' failed in the worktrees of the last 2 tickets (tut-a, tut-b)`. Tickets
whose workers failed at once did nothing, so they are reopened; those whose setup failed are back in
the queue already, and the probe passing lets them be taken again too. Once nothing runs, the run
waits 10 minutes, then asks one session in the main checkout to run a command. If it does, the run
goes on: `PROBE_OK: a session without a ticket ran a command 10m after the hold; taking tickets
again`. If not within 5 minutes, the run ends `ENVIRONMENT`, exit 7. The machine is probed once per
run. Workers stopped by the usage limit never count. `"environment_hold"` in the settings changes the
thresholds: `"count": 0` turns the hold off, `"probe": "0"` the probe.

### The usage limit

On a subscription login, workers side by side reach the account's usage limits. tutti reads what
Claude Code reports:

- **Nearing it**, the dashboard's title line shows `usage 85% of the five-hour limit · resets 14:05`,
  and the log says it once. Nothing else changes.
- **Reaching it** holds the run: `USAGE_LIMIT: the five-hour limit is reached; no new tickets until it
  resets at 14:05`. Workers whose turn ended on the limit wait (`usage limit · resets 14:05`); they
  aren't nudged, triaged or counted toward the environment hold. Organ calls are skipped meanwhile. A
  notification says so once.
- **A minute after the reset**, the hold lifts (`USAGE_LIMIT lifted`), and each waiting worker is told
  to carry on.
- **With nothing else to do**, the run waits for the reset, dashboard or not, counting down:
  `USAGE_LIMIT: nothing else runs; waiting for the five-hour limit to reset at 14:05, in 2h10m`. It
  ends `USAGE_LIMIT`, exit 8, only when the reset is unknown or further off than `--usage-limit-wait`
  (6 hours by default), suspending the waiting workers for the next run. `Ctrl+C` quits meanwhile.

## The full check

A run that ends by itself (`READY_EMPTY`, `LIMIT_REACHED` or `DRAINED`) having merged at least one
ticket runs the project's full check once, after its last merge: `checks.full.command`, normally
`scripts/check-full.sh` ([The checks](setup.md#the-checks)). It runs on the head of the base, in a
worktree of its own beside the others, removed afterwards; the setup command first, always; within
`checks.full.timeout` (60 minutes).

- `FULL_CHECK passed: 'scripts/check-full.sh' on main at ffd6ce4 (12m3s)`.
- `FULL_CHECK_FAILED: 'scripts/check-full.sh' fails on main at ffd6ce4, in the suite e2e; the whole
  output is in <repo>/.tutti/run/check-full.log; filed tut-q1z`. The suite is the last one its output
  names (`SUITE: <name>`). tutti files a P2 bug titled `Full check fails: <suite>`, labelled
  `check-full`, for a later run, or notes the failure on the one already open for that suite.

A failing full check doesn't change the run's exit code. It doesn't run after a stop, or after a run
that merged nothing.

## Quitting and the next run

**Quitting** is `q` in the quit box (`Ctrl+C` in the dashboard), a second `Ctrl+C`, or SIGINT, SIGTERM
or SIGHUP (closing the terminal) in any mode:

1. No new tickets start. The dashboard shows `Quitting…` and what it waits for.
2. Every worker's turn is interrupted, its open requests withdrawn and its queued messages cancelled.
   tutti waits up to 10 seconds for them all.
3. A merge in its last step (the fast-forward) finishes; one before it is undone, and its ticket waits
   to merge in the next run. A check or setup under way is stopped.
4. Triage and the run report are skipped.
5. Every session is closed, and saved in `.tutti/run/state.json` with why it was suspended.
6. The run ends: `INTERRUPTED: quit with Ctrl+C; the sessions of tut-a, tut-b are saved for the next
   run`, exit 130.

A second signal meanwhile says what it waits for (`tut-a's merge is under way; press Ctrl+C again to
abandon it`); a third exits at once.

**The next run** carries on with what the last one left, before it starts anything new. Its log says
what becomes of each, `<id>, carried over from the last run, …`:

- a worker suspended as the run ended (quit, `PAUSED`, `TICKET_LIMIT`, waiting on you, the usage
  limit) has its session resumed, and is told the last run ended while it worked, to carry on where it
  left off: `RESUMED: tut-a was suspended as the last run ended (quit); resuming its session …`. It
  takes a slot, but counts toward no limit;
- a ticket closed meanwhile waits to merge;
- a ticket waiting on a question is resumed once you answer it, and told so;
- a ticket deferred meanwhile is left deferred; one deleted from Beads, or whose worktree is gone, is
  dropped;
- a ticket merged by hand meanwhile is dropped, its worktree and branch removed as after a merge
  (unless the worktree has uncommitted changes, which the line names);
- a run that crashed (`kill -9`, a power cut) suspended nothing: its tickets still in progress are
  resumed, told the last run crashed.

A session that can't be resumed is warned about (`WORKER_GONE: …`), left for review, and no longer
followed.

**The `unmerged` label.** A ticket that is closed but not merged when a run ends (it waits to merge,
or was set aside) is labelled `unmerged`: the tickets it blocks wait, in later runs too, until its
branch `tutti/<id>` is on the base. The run that merges it removes the label, as does any run that
finds its work merged by hand, as it starts or as the base moves on.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | the run ended by itself: nothing left (`READY_EMPTY`), the limit reached (`LIMIT_REACHED`), or wound down as asked (`DRAINED`); also nothing to run, a feature plan declined, or an interview that filed nothing or wasn't run |
| 2 | a setup problem (all are listed), or another run in the repository; with `--feature`, a request the screen turned down, a plan that failed or has questions, or no terminal to confirm on |
| 3 | a worker idle with its ticket in progress (`PAUSED`), a request unanswered (`BLOCKED`), or a worker past its ticket limit (`TICKET_LIMIT`) |
| 4 | Beads, git or a worker's session failing (`BEADS_FAILED`, `GIT_FAILED`, `AGENT_FAILED`, …), or tutti failing itself (`PANIC`) |
| 5 | uncommitted changes in the main checkout, or it left its branch (`DIRTY_TREE`) |
| 6 | a finished ticket's branch doesn't fast-forward (`MERGE_FAILED`) |
| 7 | workers kept failing at once, whatever their ticket (`ENVIRONMENT`) |
| 8 | the usage limit resets later than `--usage-limit-wait`, or at a time unknown (`USAGE_LIMIT`) |
| 130 | quit (`INTERRUPTED`); its workers' sessions are saved for the next run |

The first stop decides the code; the closing line names every stop, joined by `; also`.

## Running through an agent

A coding agent can run tutti for you with the tutti skill,
[`skills/tutti/SKILL.md`](../skills/tutti/SKILL.md) in tutti's repository. Install it by copying
the `skills/tutti/` folder to `~/.claude/skills/tutti/`, for every project, or to
`.claude/skills/tutti/` in one project:

```
git clone https://github.com/noesis-sol/tutti
mkdir -p ~/.claude/skills
cp -R tutti/skills/tutti ~/.claude/skills/tutti
```

Then ask the agent to "run tutti". The skill has it find out where the project stands first, set
it up with `tutti init`'s flags, launch `tutti --plain --tickets` in the background, answer the
workers' requests with `tutti answer`
([Answering without the dashboard](workers.md#answering-without-the-dashboard)), follow the
[event stream](events.md), and read the stop lines and [exit codes](#exit-codes) when the run ends.

## Files

```
.tutti/tutti.log                 the log, for people (tail -f works)
.tutti/reports/<start>.md        the run reports
.tutti/run/events.jsonl          the event stream, for scripts: see docs/events.md
.tutti/run/state.json            what the last run left: sessions, and why each was suspended
.tutti/run/attention/            open requests, and tutti answer's answers
.tutti/run/workers/<id>/         tutti's transcript of each worker, and its stderr
.tutti/run/check-full.log        the last failing full check's output
.tutti/run/feature-request.md    the interview's description
<worktree>/.tutti/run/           check.log and setup.log, in each ticket's worktree
<git-common-dir>/tutti.lock      the run lock
```

All but `.tutti/settings.json`, `.tutti/worker-prompt.md` and `.tutti/colour-schemes/` are out of git.

## orchestra beside tutti

tutti is a new tool, not a new version of orchestra, and the two can serve one repository, one at a
time:

- **They share Beads.** Labels and metadata mean the same to both: `solo`, `human`, `unmerged` (with
  its `unmerged_fork` metadata), `area:<name>`, `check-full`, `files` and `predicted_files`.
- **Never at once.** tutti takes orchestra's lock too, so orchestra started during a tutti run refuses,
  naming tutti's PID, and tutti refuses while orchestra runs: `orchestra is running in <repo> (pid …)`.
- **Separate branches and worktrees.** tutti's branches are `tutti/<id>`, never orchestra's `wt/<id>`,
  and its worktrees go in `<repo>-tutti/`, not `<repo>-worktrees/`, so neither reuses the other's work.
  A ticket orchestra labelled `unmerged` loses the label once its work is on the base, as orchestra
  would remove it.
- **No adoption.** tutti doesn't read orchestra's run state or take over its workers: finish orchestra's
  runs with orchestra. tutti's startup warns when orchestra left workers:
  `orchestra left workers on <ids>; finish them with orchestra first`.
- **Setting up.** `tutti init` imports orchestra's settings and worker prompt
  ([From orchestra](setup.md#from-orchestra)), and the runners orchestra wrote work as they are.
