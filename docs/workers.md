# Workers

What a worker is, the worker prompt, permissions and attention requests, `tutti answer`, steering,
hand-backs, sessions and MCP servers. Back to the [README](../README.md).

## A worker

A worker is a Claude Code session working on one ticket, in its own git worktree
(`<repo>-tutti/<id>`, on the branch `tutti/<id>`). tutti's own process holds every session through
the Claude Agent SDK, with no terminal tabs: you see a worker on its card, and read it or talk to it in
its [view](dashboard.md#the-worker-view).

Each worker runs:

- in its worktree, with your Claude Code settings: your user settings, and the project's and local
  settings from the **main checkout**, not from the ticket's branch, so a worker can't change its own
  permissions, or the next worker's, by editing `.claude/settings.json` on its branch. The project's
  hooks, agents (the verifier) and skills come from the main checkout too; `CLAUDE.md` comes from the
  worktree;
- in the [permission mode](#permissions) the settings choose, `auto` by default;
- with the MCP servers the project chose, and no others ([MCP servers](#mcp-servers));
- without the tools workers never use ([Tools left out](#tools-left-out)): Artifact, ListAgents,
  ReportFindings, ScheduleWakeup, SendFeedback and Workflow, and Skill unless the project has skills
  of its own;
- with the model and effort of `workers.model` and `workers.effort` in the settings, or
  `--worker-model` and `--worker-effort` (`low`, `medium`, `high`, `xhigh` or `max`) for a run:
  Claude Code's own model otherwise, and effort `high` unless `workers.effort` is `null`, which
  leaves it to Claude Code. The feature interview starts at the same effort;
- with your environment, less `ANTHROPIC_API_KEY` on a subscription login (see
  [Login and billing](setup.md#login-and-billing)).

What it does comes from the session's own messages, so the card is exact: `starting`, `working`,
`editing`, `reading`, `testing` (the check, or a test runner), `subagent`, `retrying 3/10 (529)`,
`permission — waiting for you`, `usage limit · resets 14:05`, `done` once its turn has ended,
`stopped` once interrupted, `failed` on an error its retries didn't get past, `gone` if its session
ended without tutti closing it. A worker waiting on a background command, a subagent or a Monitor
watch is still working.

Everything a worker's session sends is kept in `.tutti/run/workers/<id>/messages.jsonl` in the main
checkout, with its Claude Code's stderr in `stderr.log` beside it. These outlive the worktree and the
session; the worker view and [triage](organs.md#triage) read them.

## The worker prompt

Each worker gets the worker prompt, `.tutti/worker-prompt.md` (`tutti init` writes it from the
built-in template), with every `TICKET_ID` replaced by its ticket. `--prompt <file>` (or
`TUTTI_PROMPT`) gives another for a run; a relative path is the main checkout's. A prompt that is
empty, or has no `TICKET_ID`, stops the run, and so does a missing `.tutti/worker-prompt.md` beside
`.tutti/settings.json` without `--prompt`: `tutti init` writes it again.

The prompt goes into the session's system prompt, after Claude Code's own, so its rules survive when
a long ticket's conversation is compacted. The session's first message holds what belongs to this
start alone: the ticket's ID, the spec it is part of (its `spec` metadata), how long it has
(`--ticket-limit`), the scope of a `--ticket` run, and what an earlier attempt left on its branch
(`git log <base>..HEAD`, `git status`), to build on or revert deliberately rather than start over.

After the prompt, tutti adds a note to every worker's rules, whatever prompt it was given: run a
check once, its whole output saved to `.tutti/run/worker-check.log` (which git ignores) and its exit
status printed, as in `scripts/check-fast.sh > .tutti/run/worker-check.log 2>&1; echo "exit $?"`
(the project's `checks.own.command` where it names [a worker's own
check](setup.md#a-workers-own-check), else its `checks.fast.command`), then read the file rather
than run the check again. Workers
piped a check through `tail`, which hides its exit status, then ran the whole check again to learn
whether it passed. A check script whose last line says `PASS` or `FAIL` and the step, as tutti's own
`scripts/check.sh` does, lets the file's end alone answer.

The note's last sentence gives the worker its share of the machine's cores: other workers' checks
run beside its own, so tutti sets `TUTTI_CORES` in its environment, and `ORCHESTRA_CORES` for check
scripts written for orchestra, to the cores divided among the run's `concurrent` workers and those
running in the machine's other tutti and orchestra runs ([Runs that share a
machine](running.md#runs-that-share-a-machine)), no more than `--machine-workers` where it is set
(at least one), and adds `-p=<share>` to `GOFLAGS` unless that sets `-p` already. A check script that runs
things side by side (a test runner's workers, a linter's jobs) keeps to it; Go's commands do
already. Left alone, each check runs as many at once as there are cores, and several workers' checks
crowd the machine until tests time out in code no ticket touched.

Each rule of the template prevents a way a run goes wrong:

- **Its own worktree; never push; tutti merges.** Workers can't disturb each other or the branch
  finished tickets land on.
- **Check your own change; leave the whole suite to tutti.** A worker runs the suites on what its
  change touches (each on part of the project, as the prompt `init` writes lists them), the slower
  ones where they cover it, and lint and type checks on the files it changed. The merge check runs
  on every ticket before it merges, and hands it back when the change broke something else: a whole
  suite per ticket on top of that was the slowest part of a worker's time on a loaded machine.
- **Commit with the ticket's ID, and close only when your checks pass.** A ticket merges only if a
  commit names it and its worktree is clean.
- **Checks in the foreground.** A worker waiting on a background command holds its slot doing
  nothing, and its ticket can't merge until the command ends. tutti sets Bash's default timeout
  (`BASH_DEFAULT_TIMEOUT_MS`) to `checks.fast.timeout`, and its maximum to that or 10 minutes,
  whichever is longer, so a worker passes Bash no timeout of its own and a check keeps its time.
- **Tests with behaviour changes,** in the project's own frameworks; a new framework is a ticket of
  its own.
- **Stop only your own processes, by PID.** Workers run the same tests side by side.
- **Never `rm` a target built from a variable or a glob.** Claude Code's safety check refuses such a
  removal unless a person approves it, and in auto mode refuses it outright. Workers overwrite
  instead, write to a new name, or remove a file by its literal absolute path.
- **Don't add where every ticket adds:** new tests in a new file, new fields next to their code,
  changelog entries as new lines.
- **Follow-ups:** filed `--deps blocked-by:<ticket>` when they build on the ticket; linked to an open
  ticket they overlap; labelled `solo` when they restructure shared code.
- **Ask, don't wait.** A decision for you that can wait is a question ticket labelled `human` that
  blocks the ticket, and the worker stops; the run goes on. A quick choice you are likely there to
  make is asked in the session itself ([questions](#attention-requests)).
- **Wait for work not merged yet.** A ticket that needs another ticket's unmerged work links it as a
  blocker, reopens and stops; tutti puts it back in the queue until the other merges.
- **Working unattended.** A turn that ends without a tool call ends the worker's work, so it doesn't
  stop to report or offer; when you send it a message, it follows it, then carries on.

`tutti init --verifier` adds a `## Verify` section, which has workers run the
[verifier](setup.md#the-verifier) before they close a ticket. `init` never replaces a prompt you
changed, unless `--force`; `tutti init --update` takes what tutti has changed in its template since,
section by section ([Keeping them up to date](setup.md#keeping-the-worker-prompt-and-the-verifier-up-to-date)).

## Permissions

Workers start in the permission mode `workers.permission_mode` names in the settings:

- **`auto`**, the default: Claude Code's classifier approves or denies each tool call. You are asked
  only when it can't decide, or when one of your `ask` rules matches. Tools your settings allow never
  ask.
- **`default`**: Claude Code asks for anything your settings don't allow.
- **`acceptEdits`**: edits go through; other calls ask.

`bypassPermissions` and `plan` are refused. Where auto mode isn't available (an account or a model
without it), the mode in effect differs, and the `START` block and the log say so:
`permission mode: default (auto mode isn't available here)`.

**Denials.** A call the classifier, Claude Code's safety check, a rule or the mode denies without
asking is logged, tallied for triage and the run report, and shown on the card's action line for ten
seconds:

```
  DENIED: tut-9a1's worker: Bash(rm -rf $T/*), by the safety check: …
```

The worker's turn goes on with the refusal.

**Held removals.** Claude Code's safety check holds a removal whose target it can't check before it
runs: a variable from the environment (`rm -rf $T/*`), a glob, a home, root or working directory. In
auto mode it is denied outright, and no answer can allow it. In the other modes it reaches you as a
request held by the safety check (below), which opens on **Deny** and has no one-key allow. The run
report names the tickets it happened to, since no rule can allow it.

## Attention requests

A worker waits on you when Claude Code asks permission for a tool call, when the worker asks you a
question (Claude Code's AskUserQuestion: one to four questions, each with two to four options), or
when an MCP server asks for input or a login. tutti shows each as an **attention request**:

- **on its card**, which turns red and shows the request with its buttons (see
  [Attention cards](dashboard.md#attention-cards));
- **in the worker's view**, with its whole input;
- **in `.tutti/run/attention/`**, for [`tutti answer`](#answering-without-the-dashboard);
- **in the log** and the event stream:

```
  PERMISSION: tut-9a1's worker asks: Bash: Remove the build cache; answer with: tutti answer 3f9a0c1e allow | allow-run | deny
  QUESTION: tut-7k2's worker asks: Which flag name? (--json | --format); answer with: tutti answer 5d21b7aa allow --choice <option>
```

A worker can have several requests open, its subagents' among them; its card shows the oldest, and
`+2 more`.

The answers:

- **Allow** lets the call run.
- **Allow for this run** allows it, and adds the rule Claude Code suggests for it (the exact command,
  say) for the rest of the run: a later request from any worker that the rule covers is allowed
  without asking, and logged `ALLOWED: …, by a rule you allowed for this run`. The rule is never
  written to a settings file. It is offered only when Claude Code suggests such a rule and doesn't
  forbid one.
- **Deny** refuses it, with `Denied by the maintainer in tutti`, and your reason if you give one
  (`Shift+D`). The worker's turn goes on with the refusal.
- **A question** is answered with its options, or with your own words in the worker view
  (**Answer in view**); it can be denied too.

**Requests held by the safety check**, and any Claude Code marks as not to be approved by a stray
key, open on **Deny**, have no one-key allow (`a` and `r` do nothing), and need `--confirm` with
`tutti answer`.

A request answered by now, or withdrawn because the worker's turn ended, is gone: an answer to it is
dropped, with a toast. A request withdrawn and asked again (after a resume, say) is a new request.

**Unanswered requests.** After 4 minutes, a request still open holds the run:
`HOLD: BLOCKED >4min: tut-9a1 needs you: Bash: Remove the build cache`. No new tickets start, but the
request stays answerable, and answering every open request lifts the hold:
`HOLD lifted: tut-9a1's requests were answered`. With a dashboard, a run with nothing left but workers
waiting on you stays open ([The end-of-run box](dashboard.md#the-end-of-run-box)).

`"ask_user_question": false` in the settings' `workers` takes the questions away: workers can't ask in
the session, and the worker prompt's paragraphs on it are left out, so a question for you is always a
question ticket.

### Answering without the dashboard

`tutti answer`, from you, a script or an agent, in the main checkout or any of its worktrees, lists
the open requests:

```
$ tutti answer
3f9a0c1e  tut-9a1  permission: Bash(rm -rf build)
    why: …
    allowing it needs --confirm
    answer with: tutti answer 3f9a0c1e allow --confirm | allow-run --confirm | deny

5d21b7aa  tut-7k2  question: Which flag name?
    1. Which flag name?
       - --json - machine-readable output
       - --format - a format name
    answer with: tutti answer 5d21b7aa allow --choice "<option>" | deny
```

and answers one:

```
tutti answer 3f9a0c1e deny --reason "keep the cache; clear build/tmp instead"
tutti answer 3f9a0c1e allow --confirm
tutti answer 5d21b7aa allow --choice "--json"
```

- `allow`, `allow-run` (allow for this run) or `deny`.
- `--reason "…"` goes with `deny`: the worker is told it.
- `--choice "<label>"` answers a question, once per question, in order; for a question with several
  answers, the labels joined with `, `.
- `--confirm` is needed to allow a request held by the safety check.
- `--json` lists the requests as JSON, for scripts and agents: each request's ticket, kind, tool and
  summary or questions, the answers it takes, `default_to_no` and its creation time.

`tutti answer` writes the answer next to the request's file, `.tutti/run/attention/<id>.answer.json`,
and waits up to 10 seconds for the run to take it: `The run took the answer to request 3f9a0c1e:
deny.` Otherwise it says why, and exits 1: no such request open, an answer that doesn't fit it, or no
run taking answers (`… is tutti running in this repository?`). The run checks each answer file before
it takes it: not a symbolic link, yours, its request still open, the answer one the request takes.
The log and the event stream say the answer came `via tutti answer`. It works while the dashboard is
open too, so an agent can answer as you watch.

## Steering

You can talk to a worker from its view: type in the composer and press `Enter`, and the message goes
into its session, joining the turn under way or starting the next. `Ctrl+X` interrupts its turn.

Either makes the worker **steered**: tutti sends it nothing by itself until you release it. No
continue nudge, no hand-back, no "carry on" after the usage limit or a resume. A hand-back due to it
waits in its view, with **Hand it the conflict now**. The card shows `steered` beside its status,
and the 10-minute idle grace before `PAUSED` counts from your last message. **Release** in its view,
or `Ctrl+R`, releases it; leaving the view doesn't.

The log records `STEERED: <id>`, `RELEASED: <id>`, and each message you send as
`MESSAGE: you → <id> (212 characters)`; the text itself is recorded nowhere. The run report says
which tickets you steered.

## When a worker stops

A worker's turn ending isn't its ticket's end. When the worker settles, tutti reads the ticket in
Beads:

- **Closed**, with a commit naming it and a clean worktree: it waits to merge. Closed with nothing of
  its own to merge: done, `no change to merge`.
- **Asked**: it filed a question ticket for you that blocks it. Its session is closed; once you
  answer (`bd human respond <question> --response "…"`), tutti resumes the session and tells it the
  answer is in.
- **Deferred** by the worker: set aside, and [triaged](organs.md#triage). Left in another status
  (open, blocked, …) with nothing to wait for, tutti defers it for review the same way. A worker that
  did nothing (no commits beyond the base, a clean worktree) leaves nothing to review, so once triage
  has its evidence its worktree and branch are removed, as the line says: `<id> deferred by its
  worker; nothing done, so its worktree and branch are removed` (`<id> still open -> noted and
  deferred; nothing done, …`). With work of its own, they are kept: `…; worktree <path> left open`.
- **Back in the queue**: it stopped with nothing done, having linked a blocker that hasn't merged
  (`WAITS_FOR_MERGE`).
- **Still in progress**: tutti tells it to continue, at most twice:
  `tutti: your ticket <id> is still in progress. Continue; if something blocks you, ask or defer as
  your instructions say.` After that, and 10 minutes idle, the run holds with `PAUSED`.

A worker whose session ended unexpectedly is resumed once per run and told to carry on; a second time,
the run holds with `PAUSED`, and the next run resumes it.

A worker still going `--ticket-limit` after dispatch (`"ticket_limit"` in the settings; none by
default) holds the run with `TICKET_LIMIT`, but isn't interrupted: it goes on, and is suspended when
the run ends. Without a limit, one going for 2 hours is logged once, `LONG_RUNNING`.

## Hand-backs

A finished ticket whose rebase stops on conflicts, or whose check fails on the rebased branch, goes
back to its worker, which has the whole change in mind (see
[The merge queue](running.md#the-merge-queue)):

- **Conflicts**: the worker is told which files conflict, to resolve them keeping the intent of both
  sides and finish the rebase, to skip a commit the base has already, and to run the tests of the
  code it changed and of the files that conflicted until they pass, leaving the whole check to tutti,
  doing nothing else. At most twice per ticket, within 20 minutes each (`merge.resolve_timeout`).
- **A failing check**: the worker is told what failed, where the whole output is, and what landed on
  the base since its branch was cut, to run what failed and the tests of the code it changed until
  they pass, leaving the whole check to tutti, and to commit a fix naming the ticket, or nothing when
  what failed passes without a change. At most `merge.check_hand_backs` times (2).

tutti checks what the worker left rather than take its word, then runs the check itself, once: when
another ticket merged meanwhile, on the branch rebased onto the base. A worker
must be idle and not steered to be handed anything; one whose session was closed is resumed for it.

The 20 minutes leave out the time the worker waits at the account's usage limit: after the reset it
is told to carry on with the hand-back, not its ticket. A worker whose turn ended on the limit as it
finished, the rebase done or the fix committed, has given its answer: tutti takes it from git without
waiting for the reset. Past the 20 minutes, a rebase finished or a fix committed is taken as it is;
otherwise the worker is stopped and told the hand-back is over, its branch put back and which commit
its attempt had got to, which git keeps. A worker at the limit already when a check fails on what it
left, or its merge meets conflicts, is handed them once the limit lifts, in place of the reset's
message to carry on, rather than its ticket being set aside; the wait doesn't count either.

## Sessions

tutti keeps a worker's session open only while its ticket needs it: while it runs, waits to merge,
merges or is handed back. A merged ticket's session is closed; so is an asked ticket's, until its
answer is in, and a deferred one's. A closed session keeps its ID, saved in `.tutti/run/state.json`
before the session starts, and is resumed when needed.

When a run ends with workers still at it (you quit, a worker stopped the run, or one still waits on
you), their sessions are **suspended**: interrupted, closed, and saved in `state.json` with why. The
next run resumes each and tells it the last run ended while it worked, to carry on where it left
off. See [Quitting and the next run](running.md#quitting-and-the-next-run).

## Tools left out

Claude Code describes each tool it offers in every request a worker makes. Workers never call
Artifact, ListAgents, ReportFindings, ScheduleWakeup, SendFeedback, Workflow or Skill (none of
orchestra's 484 worker sessions did), and their descriptions, with the listing of your skills that
comes with Skill, came to about 28,000 tokens a call: a worker's first call opened with about 11,900
tokens rather than 39,200 without them. So every worker's session, resumed ones too, is started with
them denied (`disallowedTools`); a denied tool isn't described to the model. The login probe's is
too.

Workers keep the rest, and any tool a later Claude Code adds: Bash, Read, Edit and Write; Agent,
which runs the verifier; ToolSearch, which loads the tools of the project's MCP servers; the task
tools and the other deferred tools such as Monitor; and AskUserQuestion unless
`workers.ask_user_question` is off.

A project with skills of its own keeps Skill, as its workers reach those skills only through it:
anything in `.claude/skills` or `.claude/commands` (which Claude Code runs as skills), or a plugin
enabled in its Claude settings, `enabledPlugins` in `.claude/settings.json` or
`.claude/settings.local.json` with an entry not set to `false`. The listing then names your own skills
too. tutti decides once, from the main checkout, as the run begins: skills or plugins added during
the run count from the next one.

## MCP servers

A worker reads text tutti can't fully trust: tickets filed by someone else, follow-ups other workers
wrote, text pasted from an issue. Give workers only the MCP servers the project's work needs: each one
is something a misled worker could reach, and its tools' descriptions cost tokens in every request.

`workers.mcp_servers` in the settings names them; none by default. `tutti init` asks, offering those
defined for the project on your machine, or `tutti init --mcp postgres,firecrawl`. The settings keep
names only; each machine resolves them the way Claude Code does, the first that defines a name
winning:

1. **local**: `~/.claude.json`, under the repository's path (`claude mcp add <name> …`);
2. **project**: `.mcp.json` in the repository (`claude mcp add --scope project <name> …`);
3. **user**: `~/.claude.json`, for every repository (`claude mcp add --scope user <name> …`).

With `CLAUDE_CONFIG_DIR` set, `.claude.json` is read from there. The definitions are passed to each
session in memory, never written to disk, and no other server loads: not the project's others, not a
plugin's, not a claude.ai connector (Gmail, Drive and the like, which belong to your claude.ai account
and have no definition on the machine to give a worker).

A name that isn't defined on this machine, or names a claude.ai connector, stops the run:
`MCP server "redis" in workers.mcp_servers isn't defined here: …`. A worker that comes up with a
server it wasn't given is stopped before it does anything. The run's `START` line says what workers
get: `MCP servers: postgres` or `workers get no MCP servers: workers.mcp_servers is empty`.

Claude in Chrome, which Claude Code turns on by itself once it is set up on your machine, is
`claude-in-chrome` in `workers.mcp_servers`: it is built into Claude Code, so no config file defines
it. Chosen, workers and the feature interview get it (`--chrome`); left out, they don't
(`--no-chrome`).

Organs never get MCP servers, nor Chrome.
