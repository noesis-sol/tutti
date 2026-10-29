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

**While it starts**, before its first screen, `tutti` says what it is doing on one line that
updates in place:

```
⣾ Getting ready  checking the setup and your Claude login · 0:03
⣾ Getting ready  reading the backlog · 0:06
```

Its steps are `unpacking Claude Code` (a release build, the first run after an update), `checking the
setup and your Claude login`, `reading the backlog` and `starting the run`. The line goes once the
first thing appears, the start question, the dashboard, the Nothing to run box or why the run can't
start, leaving nothing behind. A start under a tenth of a second shows none, and neither does
output that isn't a terminal or `TERM=dumb`: `tutti --plain | …` and scripts see what they did.

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
branch, the scope, the limits, the cap on the machine's workers and the worktrees folder, then the
billing, the permission mode in effect, the MCP servers, the memory the workers take, and any warning (`README_STALE` where the
README's section on what to install differs from the requires list); then the check of the
project's [requires list](setup.md#the-requires-list) (`REQUIRES: jq met`), the tickets left unmerged
and the workers carried over, and the deferred tickets free to run
([`DEFERRED_FREE`](#nothing-to-run)).

**What the machine must have.** Before its first ticket, and before any worker it carries over, the
run checks the project's requires list, installing what it can. For what is still missing it stops
at once, exit 2, nothing started: `REQUIREMENTS_MISSING: docker (start Docker Desktop); meet it (each
entry of 'requires' in .tutti/settings.json says how), then run again`. A ticket that changes the
list checks it again once it merges, before the next ticket starts; what is missing then stops the
run the same way, the running tickets finishing first.

**The start question.** In a terminal (its input and output both), `tutti` asks what the run should
work on:

- **Current tickets**, the default, runs the backlog as this page describes. It reads
  `Current tickets: N ready`, or with nothing to run `Current tickets: none, all done` or
  `Current tickets: none ready (N open)`.
- **Spec: build what a spec file describes** asks for the **Spec file**: a path typed or pasted, a
  relative one from the repository, `~` or `~/` for your home folder; a path in quotes, or a file
  dropped on the terminal with its spaces escaped by backslashes, works too; or an `https://` URL
  ([from a web URL](#a-whole-app-from-a-spec)). `Tab` completes folders and `.md`, `.markdown` and
  `.txt` files in the folder typed so far (hidden ones once a `.` is typed), filling in the part the
  completions share and listing them under the field; `↓` or `Ctrl+N` goes to the next completion,
  `↑` or `Ctrl+P` to the one before. Nothing completes a URL. `Ctrl+O` opens a file browser over
  the question instead, drawn in tutti, so it works the same over SSH, in tmux and on Linux: at the
  folder typed so far, or else the repository, its folder in its top border, `..` first, then
  folders, then files, ten rows at a time, dotfiles hidden and other files greyed
  (`.md, .markdown and .txt files only`). `↑` and `↓` (`k`, `j`) move, `←` (`h`, `Backspace`) goes up
  a folder, `Enter` or `→` opens a folder or chooses a file, putting its path in the field, and `Esc`
  closes the browser without leaving the question; a click on a row does what `Enter` on it does,
  and the wheel scrolls. It won't go into a folder it can't read, and says
  `cannot open <folder>: <cause>` (on macOS, `~/Documents` or `~/Desktop` until the terminal has
  access to them). `Enter` goes on only once the path names a file of text with something in it,
  else says why under the field: `no such file: <path>`, `<path> is a folder`, `<path> isn't a file`
  (a device or a pipe), `<path> is empty`, `<path> doesn't look like text`,
  `cannot read <path>: <cause>`. A URL is fetched on `Enter`, `Fetching <host>…` with a spinner in
  the field's place; a fetch that fails says why under the field, the URL kept for fixing, and `Esc`
  during it stops it. Then **Refine it with Claude first?**: **Run it as it is**, selected, runs the
  spec as `tutti --spec <file>` does, its breakdown's spinner drawn in tutti's screen (`Ctrl+C`
  stops it, exit 130), and **Refine it with Claude first** as `tutti --spec <file> --refine` does.
  `Shift+Tab` goes back a step, keeping what was typed. Once tutti's screen has gone, tutti prints
  `Spec: <absolute path or URL>, run as it is` (or `, refined with Claude first`), and the run went
  on as a [spec run](#a-whole-app-from-a-spec): the lock, the log and the start record naming the
  spec. A spec git ignores, or one inside `.git`, ends the run there with exit code 2:
  `tutti cannot run that spec:`, then the problem, which says `(chosen at the start)` where
  `--spec`'s say `(--spec)`.
- **New feature** asks you to describe a feature, then talks it through with you
  ([below](#talked-through)).

`Esc` or `Ctrl+C` at any step exits with code 130, nothing changed. Asked as lines (`TERM=dumb`, or
fewer than 256 colours), the question reads the spec's path or URL as a line, with the same checks,
no completion or browser, and runs it as it is: refining it needs tutti's full screen; `Ctrl+D`
cancels. `--tickets` skips the question and runs the current tickets, as scripts and agents should;
`--ticket`, `--feature`, `--spec` and `--plain` skip it too, and a run without a terminal never asks.

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
| `--machine-workers N` | start no ticket while this many workers run across the machine's tutti and orchestra runs, this one's included ([below](#runs-that-share-a-machine)); `0` for no cap (default: `ORCHESTRA_MACHINE_WORKERS`, else half the cores, at least 2) |
| `--auto-answer`, `--auto-answer=10m` | answer the workers' questions with the option they recommend, at once, or once one has waited that long for you; never one only you can answer, nor a permission ([below](#answering-for-you-while-youre-away); default: off) |
| `--overnight` | run the current tickets through the night, once a pre-flight has cleared the run; keeps the machine awake whatever `keep_awake` says, and turns on `--auto-answer` ([below](#overnight)) |
| `--force-overnight` | with `--overnight`, start though a pre-flight check failed |
| `--overnight-free-disk <GB>` | the free disk `--overnight` wants where the worktrees go; `0` doesn't check (default: 20) |
| `--tickets` | run the current tickets without asking first |
| `--ticket <id>` | run only this ticket and its subtickets ([below](#one-ticket-and-its-subtickets)) |
| `--feature "<request>"` | plan a request as an epic and its tickets, then run them ([below](#planned-by-the-organs)) |
| `--yes` | with `--feature`, file the plan without asking |
| `--spec <file\|url>` | build what a spec describes, a file or one at an `https://` URL: commit it, break it down into tickets under a root epic, and run them; run again, carry on or update them ([below](#a-whole-app-from-a-spec)) |
| `--refine` | with `--spec`, break the spec down with you ([below](#refined-with-you)) |
| `--spec-timeout 90m`, `--spec-effort <level>` | how long a spec's breakdown may take, and its effort (default: the settings', else 60m and `high`) |
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

### Keeping the machine awake

A run keeps the machine from sleeping when idle while it goes, its report included: `caffeinate`
on macOS, `systemd-inhibit` on Linux, which the title line's ` keep awake ` badge shows while it
holds. Where the machine has none, or it isn't on the `PATH`, the `START` block warns, and the run
goes on. A closed lid still sleeps a laptop ([below](#when-the-machine-sleeps)).

It is on unless `keep_awake` is `false`: in the project's [settings](setup.md#the-settings), the
repository's default, or in your [user config](setup.md#the-user-config), which wins over the
project's for you. The `START` block says when it is off and which file says so:

```
keep awake: off, keep_awake in ~/.config/tutti/config.json
```

`--overnight` keeps the machine awake whatever they say. There is no flag for it: `--keep-awake`
and `TUTTI_KEEP_AWAKE`, which turned it on before it was the default, are still taken, with any
value, and not read; the `START` block says so once.

### When the machine sleeps

tutti's time limits count the time the machine is awake: those of the
commands and checks, `--ticket-limit` and `LONG_RUNNING`, the 10 minutes idle before `PAUSED`, a
hand-back's and an organ's. A check that started a minute before the machine slept for half an hour
isn't failed at the wake for not finishing within 30 minutes. The usage limit's reset times are the
clock's, and stay so. Each time tutti notices the machine slept, the log says so, with a `slept`
record ([Event records](events.md)):

```
SLEPT: the machine slept 34m (14:03-14:37); checks and limits don't count it
  keep_awake is false for this run, as the START block said: set it true to keep the machine awake
```

The second line comes once, in a run that doesn't keep the machine awake. tutti takes a gap of more than 15
seconds in its own once-a-second look at the clock for a sleep, so tutti stopped as long (`kill
-STOP`) reads as one too.

On macOS the line also says why the Mac slept, as `pmset -g log` gives it for the sleep that began
as tutti last saw it awake: `lid closed`, `battery low`, `idle` or `asked to sleep`. It says
nothing more when the log has no such sleep within a minute, or can't be read within 15 seconds,
and on Linux.

```
SLEPT: the machine slept 4m (09:41-09:45, lid closed); checks and limits don't count it
  keeping the machine awake can't prevent a closed lid's sleep: keep the Mac on power with an external display, or run sudo pmset -a disablesleep 1 (and 0 after)
```

Keeping the machine awake prevents idle sleep only. Closing a laptop's lid sleeps it all the same: a Mac
unless it runs on power with an external display (clamshell mode), a Linux laptop unless it is
docked or has an external display, as logind ignores the inhibitor lock for the lid
(`LidSwitchIgnoreInhibited` is `yes` by default). A run kept awake on a machine with a battery says
so in its `START` block, and a closed lid's sleep in such a run adds the second line above; in a
run that doesn't keep the machine awake, a closed lid's sleep doesn't say to. To keep a closed Mac awake,
`sudo pmset -a disablesleep 1`, and `sudo pmset -a disablesleep 0` afterwards; on Linux,
`HandleLidSwitch=ignore` in `/etc/systemd/logind.conf`. Both are the whole machine's settings,
which tutti never changes itself.

### On battery

A run on a laptop's battery goes only as long as the battery does: a Mac that runs it flat sleeps
or shuts down, and a shut-down Mac ends the run, its workers resumed only by the next tutti. A
run that starts on battery says so in its START block:

```
  on battery (62%): plug in to keep the run going
```

While the run goes, tutti reads the battery once a minute (`pmset -g batt` on macOS,
`/sys/class/power_supply/BAT*` on Linux). On battery, as it falls to 20% and again to 10%, the
log says so once each, with a `battery` record ([Event records](events.md)), and the dashboard's
warning line keeps saying it while the battery stays low:

```
BATTERY: 10% left, not charging: plug in or the Mac will sleep
```

At 10% it also notifies. Plugged in, the notice goes; should the battery run down again, it says
both again. A machine without a battery says nothing.

### Answering for you while you're away

A run you leave going overnight or while you are out stops each ticket that asks you something
until you come back. With `--auto-answer`, tutti answers for you with the option the worker
recommends, and the ticket carries on:

```bash
tutti --auto-answer        # answer at once
tutti --auto-answer=10m    # give me 10 minutes to answer first
```

It answers a question ticket a worker files during the run, when its metadata gives 2 to 4 options
with one recommended, as the worker prompt asks: `bd human respond` records the option, saying
tutti chose it, not you, which closes the question, and the label `auto-answered` marks it. It
answers an `AskUserQuestion` in a worker's session too, with the option marked `(Recommended)`, else
the first. With a time, the time counts only while the machine is awake, a question you answer
first is yours, and the run doesn't end while one it will answer waits.

It leaves to you, and the question's `ASKED` line says why: a question that asks you to do
something only you can (`maintainer_only` in its metadata), one without options, and one already
open when the run started, which may have been left open on purpose. It never answers a permission
request.

You see it everywhere: the `START` line ends ` · auto-answer` (` · auto-answer after 10m`), the
dashboard's title line has an ` auto-answer ` pill, each answer has its `AUTO_ANSWERED` or
`QUESTION` line, and the run's summary lists what it answered, with each choice. Later, find the
questions with:

```bash
bd list --all --label auto-answered
```

It is chosen for each run, as it depends on whether you are there;
`TUTTI_AUTO_ANSWER=10m` in your shell's profile sets it for every run on that machine.

### Overnight

`tutti --overnight` (or `TUTTI_OVERNIGHT=1`) runs the current tickets as `--tickets` does, or
`--ticket <id>` and its subtickets, once a pre-flight has cleared the run to work through the
night, so that it doesn't stop at 1am on something you could have settled at 11pm. It keeps the
machine awake, whatever `keep_awake` says ([above](#keeping-the-machine-awake)), and turns on
`--auto-answer` ([above](#answering-for-you-while-youre-away)), as nobody is there to answer in the
night; `--auto-answer=false`, or a time, given with it overrides that. With
`--feature` it is a setup problem, as is `--force-overnight` without it.

The pre-flight runs once tutti holds the run lock, before the run starts. Each check passes, warns
or fails: a failure is what would stop the run, or every merge, in the night; a warning what would
slow the night, cost it tickets or leave something for the morning.

```
◆ Overnight pre-flight: 1 failed, 2 warnings, 13 passed
  ✓ no ticket limit
  ✗ 1 ticket at a time (concurrent in .tutti/settings.json, --concurrent): one slow ticket would hold up the night
  ! on battery (62%): plug it in, or the run goes only as long as the battery; …
  …
```

What fails, refusing the run until it is fixed:

- **A ticket limit** (`--limit`): the run would stop early. Fix: run without one.
- **One ticket at a time** (`concurrent` 1): one slow ticket holds up the night. Fix: one for each
  4 cores, 2 to 4, within `--machine-workers` (none under a cap of 2).
- **A permission mode that asks** (`workers.permission_mode` `default`): a worker would wait on a
  prompt all night. `auto` and `acceptEdits` pass. Fix: start workers in `auto`, once Claude Code
  says it puts auto in effect for your account.
- **Too little free disk** where the worktrees go: under `--overnight-free-disk` GB, 20 by
  default, `0` not checking. Free space tutti can't read warns.
- **The merge check failing on the base**: run once on its head in a worktree of its own, the
  setup first, within the merge check's time limit, `Running the merge check on main…` meanwhile.
  Where it fails there, every merge would fail; the checklist says what failed, and the whole
  output is in `.tutti/run/check-base.log`. It comes last, being slow.

Claude Code logged in is listed too, passed, with the account: tutti doesn't start without it.

What warns:

- **The account at its usage limit now**, from one turn of the smallest call at the workers' model,
  saying when it resets, and that the run would stop where `--usage-limit-wait` runs out first.
- **`--usage-limit-wait` under 5h**. Fix: wait up to 6h.
- **No ticket time limit** (`--ticket-limit`, `workers.ticket_limit`). Fix: give each ticket's
  worker 2h.
- **Another run on the machine**, named by its repository, PID and workers.
- **A busy machine**: a 1-minute load over 1.5 per core, or memory pressure at warn or worse, naming
  the 3 processes using the most; and a virtual machine holding over 4 GB (Docker Desktop's,
  OrbStack's, …).
- **No way to keep the machine awake** (no `caffeinate` or `systemd-inhibit` on the `PATH`), as the
  merge checks would time out while it sleeps: set the machine not to sleep. `--overnight` keeps
  it awake whatever `keep_awake` says, so this is the only thing the check asks.
- **On battery**, with its level and what a closed lid does.
- **A worker prompt or verifier older than tutti's templates**. Fix: bring them up to date as
  `tutti init --update` does and commit that on the base; the run's workers then follow the prompt
  committed (`git show` reads the change).
- **How many tickets are ready**, and how many more wait only on open questions. With none ready
  the run would end at once, unless some wait on questions put to you first (below).

In a terminal tutti then offers, one by one, each fix it can make (`Run without a limit?`, yes to
start with), and while a failed check is left without its fix, `Start the run anyway, with 1 check
failed?`, no to start with. The questions are lines below the checklist, so that you see what they
are about. Once every answer is in, it makes the fixes you took, for this run only (`◆ Fixed: the
run has no ticket limit`); Ctrl+D or Ctrl+C at a question exits with code 130, nothing changed. A
failed check left refuses the run with code 2:

```
tutti --overnight cannot start: 1 check failed. Fix what the checklist says, or start anyway with --force-overnight.
```

`--force-overnight` starts the run anyway, without asking, and says so. Without a terminal
(`--plain`, or stdin or stdout not one), nothing is asked or fixed: the checklist is printed plain,
and a failed check refuses the run unless `--force-overnight` is given. The log keeps the checklist
and the fixes made, for the morning.

Once the pre-flight has cleared the run, before the first ticket, tutti puts to you the open
questions in the run's scope: every open question ticket (labelled `human`), or with `--ticket`
those that block it or a ticket under it, or are under it. `--auto-answer` leaves a question open
before the run to you, and a `maintainer_only` one always, so without this the tickets they block
would wait all night. They come one by one, in the dashboard's screen (as lines with `--plain`):
the question's title and description, its options from its metadata, the recommended one first and
marked `(recommended)`, then Other, to type your own, and Leave open. A question without options
has Other and Leave open alone. ↑ and ↓ choose, Enter confirms, PgUp and PgDn scroll a long
description. An answer is recorded with `bd human respond`, which closes the question and frees
what it blocked for the run (`◆ Answered 2 questions`); those left open are listed with the tickets
they keep waiting and how to answer them later:

```
◆ Overnight pre-flight: 1 question left open
  ! tutti-9x (Which flag name?): tutti-5k waits on it. Answer it with bd human respond tutti-9x "<answer>"
```

Without a terminal every one is listed so, nothing asked. Esc or Ctrl+C at a question (Ctrl+D as
lines) exits with code 130 before the run starts, the answers already given kept. The log says each
question answered, with its answer, and each left open. In the dashboard what it says is printed
once the screen is gone, before the run's report.

The `START` line says ` · overnight` after the scope, and the start record has `"overnight": true`.
There is no overnight badge: the title line's ` keep awake ` and ` auto-answer ` pills say what it
turned on. Unlike orchestra's, the pre-flight doesn't fetch the base from its upstream: tutti's runs
never fetch.

An overnight run has nobody to answer it until the morning, so a ticket that needs you doesn't hold
the run ([Holds and stops](#holds-and-stops)): a worker idle with its ticket in progress
(`PAUSED`), one blocked on a request for 4 minutes (`BLOCKED`), and one still going after the
ticket limit (`TICKET_LIMIT`) each have their ticket set aside instead, and the run goes on with the
rest:

```
  tut-3: its worker was blocked on a permission request for over 4m -> noted and deferred, the run being an overnight one (BLOCKED); worktree ../tutti-worktrees/tut-3 kept for review
```

The ticket is deferred with a note saying what its worker did and what it waited on. Its open
requests are denied by tutti, in nobody's name, so that nothing answers them later; its worker is
stopped, which frees its slot for the next ticket. Its worktree and branch are kept, and the note
names its session, for the morning. `bd undefer <id>` brings it back, in this run or a later one:
its worker's session is resumed in that worktree, told why it was stopped and to carry on, so it
goes on with what it knew (a session that can't be resumed is said so, and a new one starts there
instead). Closed or deleted rather than undeferred, its kept session is forgotten as the next run starts,
its worktree left as it is. Its row reads `↷ deferred` with
`(set aside overnight: BLOCKED)` before its title, the summary counts it set aside, and the report
lists it with the others. A worker handed back a conflict or a failed check
([Hand-backs](workers.md#hand-backs)) and blocked on a request for 4 minutes has its hand-back
ended instead: its request is denied, its worker stopped and told why, and its ticket set aside as
a hand-back not done in time is (`MERGE_CONFLICT`, `CHECKS_FAILED`), its notes saying so; what it
had done already, the rebase finished or a fix committed, is taken and checked. A question that is `maintainer_only`, or has no options, waits for you as
in any run, and the run goes on without its ticket. What makes carrying on unsafe, or would only
fail again, still stops an overnight run: `DIRTY_TREE`, `GIT_FAILED`, `MERGE_FAILED`,
`ENVIRONMENT`, `REQUIREMENTS_MISSING`, `BEADS_FAILED`, `SETUP_PROBLEM`, `LOGIN`, `PANIC`, and the
usage limit held past `--usage-limit-wait`.

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

### A whole app from a spec

```
tutti --spec ~/specs/shop.md
```

`--spec <file>` (or `TUTTI_SPEC`) builds what a spec describes, a feature or a whole app written
down in a Markdown or plain-text file, with nobody there: tutti commits the spec, has Claude break it
down into Beads tickets under a root epic, and runs them as `--ticket <root epic>` would, asking
nothing on the way. The `START` line says `· spec <path>`, with `spec: epic <root>, broken down
from: <path>` under it; so do the dashboard's title line and the summary. `--refine` breaks it down
with you instead ([below](#refined-with-you)).

The spec must be text, in UTF-8, and not empty; one where git ignores it is refused, as workers only
see committed files. `--spec` can't be combined with `--feature`, `--ticket`, `--tickets` or
`--overnight`, nor with `--limit 0`. Problems with it are setup problems (exit 2), listed with the
others before anything is changed.

**Committed.** Once the run holds its lock, tutti commits the spec alone, on the branch checked out:
a file in the repository where it is (it may be left uncommitted), one outside it as a copy in
`.tutti/specs/<its name>`, whose commits record where it came from (`Spec-Source: ~/specs/shop.md`).
That path in the repository names the spec from one run to the next. A spec from another folder with
the same file name is refused, as it would take the other's tickets: give it another name. The
message is `tutti: add spec <name>`, or `tutti: update spec <name>` once it has changed, with its
SHA-256; a spec committed already as it is stays as it is.

**From a web URL.** `--spec https://…` fetches the spec, once a run, with the startup checks, and
commits it as a copy in `.tutti/specs/`, named after the URL's last path segment (`.md` added unless
it ends in `.md`, `.markdown` or `.txt`); its commits record the URL as `Spec-Source:`, without its
query and fragment, which may hold a token. Each run fetches it again: the same text is committed
already, and changed text is an update, as for a file. orchestra's `--spec` takes a file only.

```
tutti --spec https://github.com/me/shop/blob/main/docs/shop.md
```

- Over `https://` only, an `http://` URL refused; redirects are followed up to 5, and only over
  https. The fetch may take 30 s and 5 MB, and sends no credentials or cookies; a URL with a user
  name or password in it is refused.
- A GitHub file page (`github.com/<owner>/<repo>/blob/<ref>/<path>`) is fetched as its raw file, and
  a gist page (`gist.github.com/<user>/<id>`) as its file when it holds one. Any other URL is fetched
  as it is.
- A private GitHub file, whose raw file answers 404, is read through your own `gh` login (`gh api`);
  its token stays with gh. Without gh, or with gh logged out: `<url> is private or missing; if it is
  private, log gh in (gh auth login) and run again.`
- What it gives is checked as a file is (empty, not text), and a web page is refused: `<url> gave a
  web page, not a spec: give the URL of the raw file.` A fetch that fails is a setup problem (exit
  2), saying why: `Cannot fetch the spec <url> (--spec): HTTP 404 Not Found.`, `took more than
  30s`, `is more than 5 MB`, `redirected to <host> over http`, or the DNS or TLS error.
- A copy of the same name that records another source, a file or another URL, is refused as for a
  file, naming both.
- The `START` line says `· spec .tutti/specs/shop.md from https://…`, and the start record has
  `spec_source`.

#### The breakdown

Without `--refine` the spec is taken as complete and final. A Claude session in the main checkout
reads the spec, the README, `CLAUDE.md` or `AGENTS.md` and the code there is, and breaks it down
into:

- a **root epic** for the spec, summing it up;
- **child epics** where the spec has separable parts;
- **tickets**, each one worker's session of work, citing the spec's sections by heading, with
  acceptance criteria, a type, a priority, the files it changes (new ones included), the tickets it
  builds on, and `solo` where it restructures code most tickets touch;
- an **environment setup ticket** first, P0 and `solo`, when the spec needs a tool the repository
  doesn't have or the repository has no code yet, which every other ticket waits for: its worker
  writes the project's [requires list](setup.md), scaffolds the project, wires up its checks and
  sets the setup command;
- **spikes** for the facts the spec marks unverified that tickets rest on.

Where the spec leaves a choice open, it takes the most conservative reading and writes it down
(`Assumed: …` in the tickets that rest on it); tutti prints them at the end and keeps them under
`Assumptions` in the root epic's notes, for you to read in the morning.

The session can only read: its tools are Read, Grep, Glob and Agent, and tutti's own, which file the
tickets. It files the root epic and the environment ticket first, then hands the rest of the tree to
tutti in one answer, which tutti checks (a key used twice, a ticket naming one that isn't there, an
epic waiting for a ticket under it) and files: a refused answer goes back to the session with every
reason, and nothing of it is filed. It may take an hour (`spec.timeout` in the
[settings](setup.md#the-settings), or `--spec-timeout 90m`), at effort `high` (`spec.effort`, or
`--spec-effort`). On a terminal a spinner counts what it files; plain output and the log get `SPEC:`
lines, among them what the breakdown's session cost as it ends (`SPEC: breakdown $4.1234 in 212
turns, 14m02s, session <id>`), which the run's `end` record counts too. At the account's usage
limit it waits for the reset, as workers do, its time limit paused, then carries on where it left
off; a reset later than `--usage-limit-wait`, or one the account doesn't give, ends the run with
exit 8, to run again once it resets.

**The run starts early.** The environment ticket doesn't wait for the rest of the tree: once the
root epic and it are filed, the run starts on it (`◆ Starting on <id>, the environment ticket, while
the breakdown files the rest`), the title line saying what the breakdown has filed meanwhile, and the
run waits for the rest rather than end. A breakdown that fails after that stops the run as `Ctrl+C`
does, exit 2.

Then tutti checks the tree, warns of open tickets without files or acceptance criteria, marks the root
epic as filed for this version of the spec, and the run goes on without asking. A breakdown that
fails, runs out of time or gives no tree ends the run with exit 2, saying what it filed and
`Run it again to carry on: tutti --spec <file>`; `Ctrl+C` stops it, exit 130. What was filed stays
filed.

#### Refined with you

`--refine` (or `TUTTI_REFINE=1`) is for a spec with decisions still open. The same session talks it
through with you in tutti's [interview](#talked-through) view: it takes the spec as mostly settled,
asks only where it leaves a decision open that changes what gets built, sums up what it will file and
files nothing until you agree, with the decisions under `Decisions` in the root epic. Once it has
filed the tree, the view goes and the run starts. `Esc` asks `End the breakdown? Nothing has been
filed.` while nothing is filed. It needs tutti's screen: with `--plain`, or no terminal, it stops
with exit 2 once the spec is committed.

#### Carrying on across nights

Run again, the same command carries on. tutti finds the root epic an earlier run filed (the epic
whose `spec` metadata is the spec's path; `bd list --metadata-field spec=<path> --all` lists the
spec's issues) and its `spec_sha256`:

- **The spec unchanged** and the root epic open: no breakdown; the run carries on with what is left.
- **Unchanged and the root epic closed**: `✓ <path> is built (<root>)`, exit 0.
- **The spec changed**: the new version is committed, and the breakdown updates the tree for the
  change alone, reading the spec's diff and the tree from `.tutti/run/spec-update.md`: it files what
  the change adds under the same root epic, updates the open tickets it alters, defers those it makes
  obsolete, never changes a closed one, and leaves one in progress alone.
- **No `spec_sha256`**: the breakdown that filed the root epic didn't finish; it is carried on.

So a nightly job's command stays the same; to change what gets built, change the spec by day. Two
root epics for one spec are a setup problem, saying how to keep one.

#### From an empty repository

```
mkdir shop && cd shop && git init && tutti --spec ~/specs/shop.md
```

In a repository `tutti init` hasn't set up, even one with no commit yet, a spec run sets it up first,
as `tutti init` does without a terminal: Beads, the worker prompt, the settings (`-c`'s concurrency,
no MCP servers) and runners that check nothing yet, the verifier and the rest it offers declined. It
commits that with the spec, as `tutti: set up for spec <name>`; the breakdown's environment ticket
then sets up the toolchain, the scaffold and the checks.

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
  overlapping its footprint (`skipping <id>: after <other>: both touch src/a.ts`) and a solo
  ticket. Up to `concurrent` tickets merge or wait to merge without a slot; beyond that a finished
  ticket keeps its slot until a merge ends.
- **Parents run last.** A ticket with subtickets not all closed and merged waits for them:
  `<id> waits: after its subtickets: <sub>, <sub>, then +N`, again as each merges. tutti closes an epic itself once a run
  merges the last of its subtickets: `closed epic <id>: all 3 subtickets are merged`.
- **Blockers must merge, not only close.** `bd ready` counts a closed blocker as done, but its code
  isn't on the base until it merges, so a ticket waits for that:
  `<id> waits: after <blocker> merges` while its worker is at it, and
  `<id> waits: after <blocker> merges: closed but not merged (…)` once it is closed. A blocker closed where the run didn't see it
  close (by hand, by another tool, under an earlier tutti) hasn't merged while `tutti/<blocker>` has
  commits the base lacks and the base doesn't hold its changes:
  `<id> waits: after <blocker> merges: closed but not merged (tutti/<blocker> is not on <base>)`, warned of once
  with `CLOSED_UNMERGED`, which says how to clear it. Merge the branch, or delete it if its work isn't
  wanted, and the tickets it blocks start at the next poll. Where git can't tell, they wait, saying
  so (`git can't tell whether tutti/<blocker> is on <base>: …`), until git answers. Such a blocker
  counts as not merged everywhere else too: a worker that links it and stops with nothing done goes
  back in the queue (`WAITS_FOR_MERGE`), it frees no deferred ticket (`DEFERRED_FREE`), and the
  Nothing to run box counts the tickets it blocks among those waiting for their blockers to merge.
- **A follow-up waits for the ticket it was filed from.** A ticket filed `discovered-from` another
  was written against that ticket's code, so it waits until that one merges too:
  `<id> waits: after <source> merges: filed by its worker`.
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
- **A ticket set aside can come back in the same run.** One deferred, by its worker or by tutti,
  that you bring back with `bd undefer <id>` while the run goes is queued again at the next ready
  poll once `bd ready` lists it and the run isn't holding, `<id>: undeferred; back in the queue`, and starts as a new
  dispatch, counting toward `--limit` again. One bd couldn't defer (`DEFER_FAILED`) stays out of the
  run.

### Runs that share a machine

Runs on one machine slow each other's checks down. Each tutti run registers itself, a small file in
the folder orchestra's runs register in (`runs/` in orchestra's cache folder:
`~/Library/Caches/orchestra/runs` on macOS, `~/.cache/orchestra/runs` elsewhere; `ORCHESTRA_RUNS_DIR`
names another, `off` none), for as long as it runs, so tutti and orchestra see each other's runs.
Once for each other run, the log says
`SHARED_MACHINE: another orchestra run is going in <repository> with 3 workers; their checks slow
each other down` (`another tutti run` for tutti's), and `the other … run in <repository> has ended`
as it ends. Meanwhile the dashboard's title line says `· shared with 1 run`, counting the other runs
going as the run last read them.

`--machine-workers N` (or `TUTTI_MACHINE_WORKERS`, else orchestra's `ORCHESTRA_MACHINE_WORKERS`)
caps the workers across the machine's runs, this one's included: by
default at half the machine's cores, at least 2 (5 on 10 cores), as workers mostly wait on the model
but their checks are CPU-heavy, and runs slowed sharply past about 4 checks at once on 10 cores; `0`
for no cap. As the cap is about the machine rather than a project, set it in your shell's profile,
and `ORCHESTRA_MACHINE_WORKERS` keeps orchestra's runs to it too. The `START` line says the cap and
what gave it, `machine workers: 5 (default: half of 10 cores)` (or `--machine-workers`,
`TUTTI_MACHINE_WORKERS`, `ORCHESTRA_MACHINE_WORKERS`; `none` for no cap), and a run whose own
`concurrent` is above the cap says so once under it. A free slot waits at the cap, saying once
`HOLD: MACHINE: the machine's tutti and orchestra runs have 4 workers running, 2 of them this run's,
at the cap of 4 (--machine-workers); the next ticket starts once one of them finishes`, with
`MACHINE` on the dashboard's title line while it holds. The run reads the other runs every 2 seconds
while it holds, so the slot is filled within seconds of a worker finishing. A run with none of its
own workers running never waits. A registration whose run is gone (its process ended, or its PID
taken by a process started since, after a reboot or a run killed) counts nothing and is removed.
A run's workers, for the cap and for the other runs, are the slots it has taken: its tickets
working and its checks run once more, and a ticket waiting to merge or merging only beyond
`concurrent` of them, as such tickets take no slot up to that many.

The other runs' workers count in each worker's share of the cores (`TUTTI_CORES`, see
[the worker prompt](workers.md)): the cores divided among this run's `concurrent` workers and theirs,
as the run last read them, no more than `--machine-workers` unless it is `0`. A worker takes its
share as it starts and keeps it.

### Footprints

Tickets that touch the same code don't run side by side. Each ticket has a **footprint**:

- the files and functions its title, description, design and acceptance criteria name
  (`src/run/merge.ts:120`, `merge.ts`, `src/routes/[slug]/+page.svelte`, `Loop.merge`,
  `refreshBranch()`, a camel-case name in backticks), checked against `git ls-files`; not its notes,
  which say what happened to it;
- its `area:<name>` labels;
- the files its `files` metadata lists (`bd update <id> --set-metadata files=a.ts,b.ts`), where a folder
  (`src/run/`) means every file under it and a glob (`src/**/*.test.ts`) every file it matches,
  as well as the files another ticket adds where it matches (`src/run/*.ts` holds a new
  `src/run/cart.ts`) and, matching none yet, those it would match from the repository's root
  (`web/src/*.ts` before there is a `web/`); a name with a `[` (`pages/[id].tsx`) is that file or
  folder as well as the glob;
- for a ticket naming none of these, the `predicted_files` metadata, if it has one;
- once it runs, the files its worktree has changed, read every 30 seconds.

A ticket with commits on its branch (`tutti/<id>`: reopened, or carried over) is footprinted from the
files its branch changes on top of the base, its `files` metadata and its area labels instead, not
from its text, which names what it read and was told as well.

The files the checks' commands name are left out, unless the `files` metadata lists them: nearly every
ticket says "`scripts/check-fast.sh` passes" without changing it. So are the files the merge check's
and the full check's scripts run, named on their lines that aren't comments (`scripts/check.sh`,
which `scripts/check-fast.sh` runs), one level deep; not those the worker's own check's script runs
(`scripts/check-own.ts`), which tickets change. A ticket that does change such a file isn't held
back for it, but two running tickets changing it still warn `LIKELY_CONFLICT`. The files git merges by union
(`CHANGELOG.md merge=union` in `.gitattributes`) are always left out: git keeps both tickets' lines.
A file nearly every ticket edits in place, whose conflicts are cheap to resolve, goes in the
settings' `queue.shared_files` instead (`["test/FEATURES.md"]`, paths or globs, a name without a
slash matching in any folder): it stays in the footprints, but holds no two tickets apart, so two
that share only it run side by side, and the second to merge has its rebase's conflict there handed
back to its worker (`merge.resolve_conflicts`). Union merging wouldn't fit such a file: it keeps both
the old and the new version of a line changed in place. `tutti init` lists the features map the
create-check-suite skill writes as it files the test work.
The log shows each ticket's footprint as it is dispatched: `<id> footprint: Loop.merge,
src/run/merge.ts, area:run`, the predicted files marked `(predicted)`, a branch's `(from its
branch)`, or `nothing named`. Two tickets overlap when they share an area label, a function or a file;
in a file both name functions in, they are compared by function. A file both name holds them apart
only when one of them is to change it: its `files` metadata lists it, or, without `files` metadata,
its text names it, a document (`.md`, `.txt`) only in a sentence asking to change it ("Update
docs/guide.md", not "per CLAUDE.md"); or its worktree has changed it.
A ticket that overlaps a running one is skipped, not waited for:
`skipping <id>: after <other>: both touch merge.ts`. When two running workers change the same
file anyway, a shared file among them, the log warns: `LIKELY_CONFLICT: <a> and <b> both edit <file>; the second to merge may
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
its turn (`◼ to merge`). Tickets merge one at a time, in the order they finish (`◆ merging`):

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
   The worktree's folder is moved into `.trash/` in the worktrees' folder and its files, a
   `node_modules` among them, are deleted in the background, so the next merge doesn't wait for
   them; one that can't be deleted is a `CLEANUP_FAILED` warning naming the folder, and what a run
   left in `.trash/` (tutti quit or killed meanwhile) is deleted as the next run starts.

A ticket closed with nothing of its own to merge, or whose commits together change nothing, or whose
rebase leaves nothing because the base has its changes already, is done with `no change to merge`.

**The next merge is checked while the one before it is.** Each merge holds the queue through its
check, which would bound how many tickets an hour merge. So while a ticket is checked in its turn,
the next one waiting is rebased onto that ticket's branch as it is checked, in its own worktree, and
checked there beside it (the setup first if a dependency file changed):
`checking tutti/<next> ahead of its turn to merge, rebased onto tutti/<id> as it is checked`, then
`'<check>' passes on tutti/<next> ahead of its turn, on top of tutti/<id>`. When the ticket ahead
merges as it was checked, the next one's branch is on top of the base exactly as it was checked, and
it merges in its turn with no second check (`tutti/<next> was checked ahead of its turn on top of
tutti/<id>, which merged as it was checked: merging it with no further check`). When it doesn't (its
check failed, it went back to its worker, or the base moved another way), the next one's branch is
put back as its worker left it (`… which did not merge as it was checked: put back as its worker left
it`), and rebased and checked in its turn as any merge is. So is one whose own check failed ahead of
its turn (`… which merged as it was checked, but '<check>' fails on tutti/<next> on top of it (output
is in <file>): put back as its worker left it`): a failure ahead of its turn says nothing of the
ticket, and is neither handed back to its worker nor sets it aside. A branch that doesn't rebase
cleanly onto the one ahead isn't checked ahead (`tutti/<next> is not checked ahead of its turn: it
does not rebase cleanly onto tutti/<id>`): its turn rebases it onto the base, handing back a conflict
if it has one. Each check ahead competes with the workers' for the CPU, so only the first ticket in
line is checked ahead by default (`"merge": { "train": 1 }` in `.tutti/settings.json`: how many, each
on the branch of the one before it; `0` checks each in its turn alone), none is while the run holds
at the machine's cap on workers (`HOLD: MACHINE`), and a ticket queued again after a hand-back to its
worker, or checked once more, is checked in its turn. Quitting, or the merges stopping, puts back the
branches rebased ahead of their turn.

What can go wrong, and what becomes of the ticket:

| | |
|---|---|
| `OFF_BRANCH` | its worktree has another branch, or a detached HEAD, checked out: left for review |
| `DIRTY_WORKTREE` | uncommitted changes in its worktree stop the rebase, or the check of a branch on top of the base: left for review |
| `REBASE_FAILED` | git refuses the rebase for another reason: left for review |
| `MERGE_CONFLICT` | the rebase stops on conflicts: handed back to its worker, else blocked |
| `CHECKS_FAILED` | the check fails or doesn't finish within its time limit: handed back, else left for review |
| `FLAKY` | the check passed, but a test failed and passed on a rerun: merged, with a warning |
| `DIRTY_TREE` | the main checkout has uncommitted changes, or left its branch: the merges stop, and the run holds |
| `GIT_FAILED`, `MERGE_FAILED` | git fails, or the branch doesn't fast-forward: the merges stop, and the run holds |

A git read that steers the merge (what the worktree has checked out, its status, where its branch
left the base, the main checkout's state) is asked again 3 seconds after it fails or times out, up
to 3 reads, so one slow read on a loaded machine changes nothing. One that still fails is never
taken for an answer: when it is the ticket's worktree git can't read, the ticket is left for review,
`GIT_FAILED`, and the other merges go on; when it is the main repository, the merges stop.

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

An [overnight run](#overnight) sets the ticket aside for these three instead, and goes on.
- **`DIRTY_TREE`**, **`GIT_FAILED`**, **`MERGE_FAILED`**: the merges stop.
- **`BEADS_FAILED`**: `bd` failing. A worker's session that won't start isn't a stop of its own:
  a row of them holds the run as `ENVIRONMENT`.
- **`ENVIRONMENT`** and **`USAGE_LIMIT`**, below.
- **`SETUP_PROBLEM`**: a worker's session showed a setup problem as it started, or in its first
  `system/init`: MCP servers it wasn't given, or an API key it would bill beside your subscription. The worker is stopped before
  it does anything and its ticket reopened for the next run; exit 2.
- **`REQUIREMENTS_MISSING`**: what the project's requires list names is missing as the run starts,
  or once a merge has changed the list; the run ends at once, or once the running tickets finish,
  exit 2 ([above](#starting-a-run)).
- **`LOGIN`**: a worker's turn was refused for Claude's login (an OAuth session that expired and
  couldn't be refreshed), which the startup check can't see, as the account still reads. The run
  stops as a quit does, without waiting for the running tickets: their workers are interrupted and
  their sessions kept, no ticket is deferred or triaged, and there is no report; exit 2. Log in again
  (`claude /login`, or `tutti login`) and start tutti again: it resumes them, telling the refused one
  again what its turn was to tell it.

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

- **All the time**, the dashboard's title line shows the account's windows,
  `Current usage ━───────  17% · This week 41%`,
  from what every worker's session reports, and each figure is a `usage_window` record in the event
  stream.
- **Nearing it**, the dashboard's title line shows `usage 85% of the five-hour limit · resets 14:05`,
  and the log says it once. Nothing else changes.
- **Reaching it** holds the run: `USAGE_LIMIT: the five-hour limit is reached; no new tickets until it
  resets at 14:05`. Workers whose turn ended on the limit wait (`usage limit · resets 14:05`); they
  aren't nudged, triaged or counted toward the environment hold. Organ calls are skipped meanwhile. A
  notification says so once.
- **A worker's rules** tell it to commit what it has and stop at the limit, without deferring or
  closing its ticket for it. One that defers it all the same as it stops has the ticket put back in
  progress (`<id>: its worker deferred it as it stopped at the usage limit; back in progress, it waits
  for the reset`), so it waits with the others rather than being set aside.
- **A minute after the reset**, or sooner once a running worker's session says the account is under
  the limit again, the hold lifts (`USAGE_LIMIT lifted`). A reset that has already passed, or none
  given, is tried again 15 minutes on, and lifts are at least 15 minutes apart, so a limit that keeps
  refusing never sets the workers going at request speed. Before a lift on the clock, tutti asks
  the account with one haiku turn of a few tokens (about $0.0001, its `ORGAN usage-probe` line in
  the log): refused, the hold stays, at the reset that refusal gives or 15 minutes on
  (`USAGE_LIMIT: a probe is refused for the five-hour limit still; it resets at 15:05, in 59m`), and
  no worker is woken into a refusal. Each waiting worker is told
  to carry on: with its ticket, or with its hand-back, whose 20 minutes don't count the wait
  ([Hand-backs](workers.md#hand-backs)). A worker handed back its ticket while at the limit is sent
  the hand-back then.
- **With nothing else to do**, the run waits for the reset, dashboard or not, counting down:
  `USAGE_LIMIT: nothing else runs; waiting for the five-hour limit to reset at 14:05, in 2h10m`. It
  waits likewise for the next try of a reset that has passed. It ends `USAGE_LIMIT`, exit 8, only
  when no reset was given or it is further off than `--usage-limit-wait`
  (6 hours by default), suspending the waiting workers for the next run. `Ctrl+C` quits meanwhile.
  A hand-back still waiting to be sent then never is: a conflict's rebase is aborted, so that the
  next run merges the ticket again and hands the conflicts back, and the closing line says so
  (`b's worker, at the usage limit, was never handed its conflicts to resolve: its rebase is aborted,
  for the next run to merge b again`).

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

## The run's figures

Under the summary's totals, a run that took tickets up says where their time and the tokens went and
how the checks did, without opening [DuckDB](analytics.md):

```
  Time    63% queued · 19% held back (overlap 15%) · 14% working · 2% merging
  Checks  merge 31 of 32 passed, 1 timed out (mnemos-gts.16, 34m32s) · setup 32 of 32 · full passed
  Spent   53M tokens (94% from the cache) · $44.75 (estimate) · $1.24 a ticket (median)
  Usage   Current usage 11% → 17% · This week 40% → 41%
```

tutti adds them up from the run's own [event records](events.md) as it writes them, so they are what
the [analytics queries](analytics.md) give over the same run:

- **Time**: each phase's share of the tickets' time, largest first, those under 1% left out; held
  back with its largest reason (`overlap`, `parent`, `merge`, `solo`). A ticket's last phase counts
  no time, as in "Time per phase". If the machine slept while the run went, the line ends with how
  long: `machine asleep 34m19s`.
- **Checks**: each suite's checks passed of those run, then those that failed, timed out or couldn't
  run, with their tickets (up to three, then `+N more`) and the longest one's time. The full check is
  counted on the summary the dashboard leaves; a plain run's summary comes before it, and its
  `FULL_CHECK` line after the closing line.
- **Spent**: the workers' tokens, the share read from the prompt cache, the dollars, and the median
  of a ticket's dollars. The organs' calls aren't counted here. On a subscription login the dollars
  are what the turns would cost at API prices, an estimate, so they say `(estimate)` and are drawn in
  the `estimate` colour, sand, in italics ([Colour schemes](colour-schemes.md)); on an API key,
  plain.
- **Usage**: the account's usage windows as the run started and as it ended, named as on the
  dashboard's title line; none on an API key.

A line with nothing to say is left out. Each is cut to the terminal's width; `--plain` writes the
same lines, without colour, in the summary at the end of its log.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | the run ended by itself: nothing left (`READY_EMPTY`), the limit reached (`LIMIT_REACHED`), or wound down as asked (`DRAINED`); also nothing to run, a feature plan declined, or an interview that filed nothing or wasn't run |
| 2 | a setup problem (all are listed), one a worker's first `system/init` showed (`SETUP_PROBLEM`), a requirement missing as the run starts (`REQUIREMENTS_MISSING`), a spec run's checks gate holding its tree (`CHECKS_HELD`), Claude's login refused in a worker's turn (`LOGIN`), or another run in the repository; with `--feature`, a request the screen turned down, a plan that failed or has questions, or no terminal to confirm on |
| 3 | a worker idle with its ticket in progress (`PAUSED`), a request unanswered (`BLOCKED`), or a worker past its ticket limit (`TICKET_LIMIT`) |
| 4 | Beads or git failing (`BEADS_FAILED`, `GIT_FAILED`, …), or tutti failing itself (`PANIC`) |
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
.tutti/run/requires-<name>.log   the output of a requirement's last install
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
