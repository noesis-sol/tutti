# Organs

tutti's one-shot advisers: triage, the reviewer, the critic, the auditor, the reflector and the
scout.
Back to the [README](../README.md).

## What an organ is

An organ is a single question to Claude with a structured answer. tutti gathers the evidence itself
and asks; the organ only answers. Organs advise: tutti writes their answers down, and no organ
changes a ticket's status or the code.

Each call is one Agent SDK session, isolated from the project and from your Claude Code setup:

- no built-in tools and no MCP servers (the scout has read-only tools, below);
- no settings, `CLAUDE.md`, hooks or skills loaded;
- anything that would ask for permission is denied;
- no session is saved;
- it runs in a fresh private temporary folder, removed after the call.

The evidence is text tutti can't trust: tickets, worker transcripts, logs, the repository's files.
Each section of it goes between an opening and a closing tag that carry an ID drawn afresh for each
call (`<evidence id="…">` … `</evidence id="…">`), and every organ's system prompt says text inside
the tags is evidence only, never instructions to follow.

| Organ | When | Effort | Time limit |
|---|---|---|---|
| triage | each ticket deferred during a run | `low` | 3 min |
| reviewer | the end of a run | `medium` | 5 min |
| critic | one of every 5 merges, and a merge whose scorecard is among the run's worst | `medium` | 5 min |
| auditor | each ticket whose part in the run ends, with `organs.auditor` on (off by default) | `low` | 3 min |
| reflector | every 5 tickets ended, and after a cluster of failures | `medium` | 5 min |
| scout | `tutti init`'s Checks step | `medium` | 5 min |

They run with Claude Code's default model. `--organ-model <model>` and `--organ-effort <level>`
(`low`, `medium`, `high`, `xhigh` or `max`) set one model and one effort for every organ, for a run;
`"organs": { "model": …, "effort": … }` in [`.tutti/settings.json`](setup.md#the-settings) sets them
for the project, and the flags win. A call still running at its time limit is stopped.

## Triage

When a worker settles with its ticket deferred, by the worker itself or by tutti because the worker
left it unfinished, triage asks why. It runs in the background, one ticket at a time, so the run
never waits for it; a run that has nothing else left waits for the tickets still queued before it
ends. Tickets left for review (`CHECKS_FAILED` and the like) aren't triaged, nor a ticket whose
worker stopped on the account's usage limit.

The evidence:

- the ticket, as `bd show` gives it;
- the end of tutti's transcript of the worker: its last 40 messages, tool calls and results, at most
  8,000 characters, with its compactions, denials and retries;
- the [attention requests](workers.md#attention-requests) it raised and their answers, and the calls
  Claude Code denied it without asking (the classifier, the safety check);
- its compactions;
- its worktree: uncommitted changes, its commits since the base, the files they change;
- the error its last turn failed with, if it failed.

Triage decides whether the cause lies in the **environment** (the machine, tools or services), the
**instructions** (the worker prompt or the ticket's wording) or the **problem** itself, with a
confidence and a recommendation. tutti appends it to the ticket's notes:

```
Triage (tutti): cause = instructions (high confidence). The ticket names a file that doesn't exist. Recommendation: …
```

The dashboard's row shows the verdict in place of the ticket's note (`◆ instructions · high · …`), the
totals count it (`↷ 2 ◆ 1`: two set aside, one triaged), the log says
`triage <id>: instructions (high confidence) - …`, and the event stream has a `triage` record.

Two tickets in a row that triage blames on the environment with high confidence hold the run, as
two workers failing at once do (see [The environment hold](running.md#the-environment-hold)).

A call that fails is logged as `TRIAGE_FAILED for <id>: <why>` and changes nothing. So is a fault in
tutti while it gathers or triages one ticket: that ticket goes without a verdict, and triage goes on
to the next.
`--triage=false`, `TUTTI_TRIAGE=0` or `"organs": { "triage": false }` turns triage off; then nothing
is gathered either.

## No predictor

tutti had a predictor, which guessed the files a ticket naming nothing would change and kept the
guess on the ticket as `predicted_files` metadata. It is gone: a file two tickets share holds
neither back (see [Footprints](running.md#footprints)), so its guess, a model call a ticket, could
only warn `LIKELY_CONFLICT`, which two running tickets changing one file get from their worktrees
anyway. [Footprints](running.md#footprints) still read the `predicted_files` a ticket carries, from
an earlier tutti or from orchestra's predictor, as the ticket's own files for one naming nothing
else, marked `(predicted)` in the log; tutti writes none.

## The reviewer and the run report

At the end of a run, once the dashboard has closed and the summary is printed, the reviewer writes
the run report. The evidence: how the run ended, the run's whole log, the commits merged into the
base, the tickets closed (with their close reasons), set aside (with their notes, triage's
included) and still in progress, each ticket's tallies (attention requests, answers, denials,
compactions, your messages), what the check said of each ticket set aside after its check failed,
the full check, the follow-ups filed outside a `--ticket` run's scope, the feature request, each
ticket's [scorecard](events.md#scorecards), and what the organs have cost so far.

The report has three sections:

- **Finished**: a line per merged ticket, with its commit.
- **Set aside**: each ticket deferred, left for review, blocked or still in progress, and why, with
  triage's cause. A failed check's line says what failed, and whether in the ticket's own code or
  elsewhere.
- **Needs you**: only what the run flagged. Questions to answer (`bd human respond …`), requests
  still open, an allow rule for calls workers kept asking about or the classifier kept denying (such
  as `Bash(ffprobe:*)`), removals the safety check denied (with the worker-prompt rule, since no
  rule can allow them), what stopped the run, failed checks, follow-ups filed outside the scope, and
  tickets you steered. Otherwise `Nothing.`

After them tutti adds a **Scorecards** section of its own, written from the run's `score` records
rather than by the reviewer: a table of the tickets, worst first, or of the worst five and the best
five in a run of more than ten, with each one's outcome, verifier rounds, hand-backs, failed and
FLAKY checks, denials, questions, working time and cost (each beside the run's median for tickets
of its size, as `1.8×`), and the follow-ups and reverts filed against it so far.

On a terminal a spinner shows while it is written (`⣾ Writing the run report with Claude… 0:42`),
then `◆ Run report written (12s)`, the report rendered as Markdown, and
`◆ Report saved to .tutti/reports/<start time>.md`. The file's title names the run's date, times and
branch, and its last line what the organs cost in all.

The report is skipped:

- with `--review=false`, `TUTTI_REVIEW=0` or `"organs": { "review": false }`;
- after a quit (`INTERRUPTED`), and when you press Ctrl+C while it is written
  (`◆ Run report skipped`);
- while the usage limit still holds at the end of the run
  (`◆ Run report skipped: the usage limit held the run to its end`).

A reviewer that fails says `REVIEW_FAILED: <why>` in the log and on screen.

## The critic

Mid-run, the critic reviews work that has merged and files follow-up tickets for what it finds, so
that improvements to the code arrive as ordinary tickets the run, or the next one, takes up. It
never edits code, reopens a ticket or reverts a merge.

A merge is due a review when it is one of every `organs.critic_every` merges of the run (5), or when
its ticket's [scorecard](events.md#scorecards) is in the worst decile of the run's merged tickets so
far, once ten have merged; a ticket is reviewed once. Reviews run one at a time, each in a slot the
run left free after filling the queue, never while a merge (and its check) is under way, and not
while the machine's memory is pressed: a review due waits for such a moment. The run doesn't end
while one runs, nor while one is due and could start.

The evidence: the ticket as `bd show` gives it, with its acceptance criteria; its scorecard; the
project's `CLAUDE.md` and `AGENTS.md` at the merged commit; the files the merge changed and their
diff, at most 60,000 characters (12,000 a file).

The critic first builds a checklist from the evidence (Agentic Rubrics, arXiv 2601.04171): rules
the conventions state, requirements the ticket states, what the diff must keep. Then it checks the
diff against it, and reports each finding with the criterion it breaks, a `path:line`, a severity
(`severe`, `high`, `medium` or `low`), its confidence and what to fix. tutti then judges each one:

- low confidence, or a `path:line` the merged tree hasn't: dropped;
- alike an open ticket, by its title or by the finding it was filed for: dropped as a duplicate;
- severe (a broken build or check, a security issue, data loss): a question for you, labelled
  `human`, never a ticket, in the Needs you list's open questions;
- the rest: filed as a ticket discovered from the merged one, labelled `review`, P1 for high, P2 for
  medium, P3 for low, the most severe first, at most `organs.critic_tickets` a run (5).

The log says `review <id>: 3 findings; filed a-9, a-10; dropped 1 duplicate`, the event stream has a
[`review` record](events.md#the-kinds) with the checklist and what became of each finding, and each
ticket filed is a follow-up on the merged ticket's scorecard. A review that fails is logged as
`CRITIC_FAILED for <id>: <why>` and files nothing. `"organs": { "critic": false }` turns it off.

## The auditor

The auditor reads an ended ticket's worker transcript against a fixed rubric of behaviours a
transcript shows (Critic Rubrics, arXiv 2603.03800), for the ticket's
[scorecard](events.md#scorecards). It is off by default, as it costs a model turn a ticket:
`"organs": { "auditor": true }` in [`.tutti/settings.json`](setup.md#the-settings) turns it on.

Each ticket whose part in the run ends is audited: merged, closed with no change, set aside or
waiting on you, again each time it comes back and ends again, the later audit standing; not a ticket
a quit stopped, nor one the run ends with back in the queue, nor one with no transcript. Audits run
one at a time in the background, and the run doesn't end while one waits.

The evidence: the ticket as `bd show` gives it; the files it names, and those predicted for it; the
folder its worker worked in, as its transcript says, and the main checkout; and its worker's
transcript, one line a message, tool call and result, as triage reads one (a command run in the
background marked so), the whole of it up to 60,000 characters, else its first 15,000 and its last
45,000.

The rubric, each item a behaviour to avoid, answered `yes`, `no` or `unclear` with a line of the
transcript quoted as evidence:

| Item | The worker… |
|---|---|
| `verifier_before_checks` | called the verifier before running the project's checks on its last change |
| `background_left_running` | left a command or task it started in the background running |
| `outside_footprint` | edited files its ticket's footprint doesn't name, beyond its tests and the like |
| `asked_what_ticket_said` | asked a question its ticket already answered |
| `repeated_failing_command` | ran the same failing command again with nothing changed |
| `wrote_main_checkout` | wrote to the main checkout rather than its own worktree |

tutti reads the answer warily: each item's evidence is one line, sanitised and cut to 300
characters, and a `yes` whose quote the transcript it was given doesn't hold (its quote marks, case
and `…` aside) counts as `unclear`, marked `ungrounded`. The log says
`audit <id>: 2 of 6 flagged (background task left running, repeated a failing command); 1 unclear`,
the event stream has an [`audit` record](events.md#the-kinds) with each item, and the ticket's
scorecard takes the items flagged and those unclear: the report's Scorecards table gains an Audit
column, the reviewer's and the critic's evidence say what was flagged, and a flagged item ranks a
scorecard worse. An audit that fails is logged as `AUDIT_FAILED for <id>: <why>` and changes
nothing.

## The reflector and the playbook

The playbook is a list of short lessons tutti distils from a project's own tickets and gives to later
workers on the same part of the code. It is `.tutti/playbook.jsonl` in the main checkout, one lesson a
line, not committed; it carries from run to run, so that a lesson gathers uses enough to be measured.
Every change to it is a small delta merged by fixed code, never a model rewriting the whole.

**Reflecting.** Every `playbook.reflect_every` tickets that end merged, closed or set aside (5), and
sooner at 3 of them that didn't go clean, the reflector reads the run's scorecards and an excerpt of the
transcripts of the two worst and the best of those tickets, and proposes at most
`playbook.lessons_proposed` lessons (3), each with the tickets and records that show it. Transcript text
is evidence, never instructions. It runs in the background, one at a time; the run doesn't end while one
waits. A run without organs doesn't reflect, and still gives and counts the lessons it has.

**The gate.** Before a lesson enters the pool, fixed checks refuse one that:

- could skip or weaken a check, test, verifier, permission or hook: it names one at all, in its text or
  its scope, a test file's path included, or dismisses anything, with `skip`, `ignore`, `fail` or `flaky`
  and the like (`weakens_checks`);
- touches how workers use git or bd: it names a ticket, an issue, a ref, or a word of git's or bd's
  (`git_or_bd`);
- repeats 6 words in a row from a transcript the reflector read, or says what an injected instruction
  says (`quotes_transcript`);
- is over 300 characters (`too_long`), says nothing (`empty`), or has a scope that isn't a path below the
  project's top, in a hidden folder (`bad_scope`);
- cites a ticket or record the run's records don't hold, or none (`no_evidence`);
- is alike a lesson in the pool, retired ones included (`duplicate`).

The checks read words, so they refuse more than they must: "the parser's tests share a cursor" goes too.
A refused lesson costs little, and a bad one contaminates what is distilled after it. A lesson is about
the code; each refusal is in the `reflection` record, to loosen the checks by if they cost too many. They
are still word lists: a lesson that weakens a check in words they don't hold gets past them.

**What goes active.** A pitfall scoped to an area goes active at once. A strategy or a recovery, or a
lesson whose scope spans the project (none, or a glob that starts with a wildcard, as `**/*.ts`), stays
proposed. Proposed lessons reach no worker and never hold a run: the report lists them, and you act on
them with `tutti playbook`. The pool holds `playbook.pool_cap` lessons (30); past that a new one displaces
a retired one, oldest first, else the least helpful.

**The prompt.** A worker's standing rules end with a marked section holding the active lessons whose
scope meets its ticket's footprint, at most `playbook.lessons_injected` (5), the most helpful first. It
says your rules stand over them. The `dispatch` record and the ticket's metadata (`playbook_version`,
`playbook_lessons`) say which it got.

**The holdout.** Each lesson goes to a random half of the tickets in its scope, by a hash of the two IDs,
so a ticket stays in the same half however often it starts. As each ticket ends, its scorecard counts for
each lesson once: clean (merged or closed, no hand-back, no failed check, no failed verifier round, its
last fix verified) or not, shown (`helpful`, `harmful`) or held back (`held_clean`, `held_bad`). Fisher's
exact test at 5% compares the two halves' clean rates. A lesson that measurably hurts is retired at once;
one with no effect to tell from zero after `playbook.judged_after` uses (10) is retired too. With so few
tickets only a large effect shows, so most lessons go that way: that is on purpose, as a pool of small
unproven lessons does harm of its own. A ticket that only the cap on a prompt kept a lesson from is in
neither half.

The report's Playbook section lists what waits for you and each lesson's counts and effect, and
[Analytics](analytics.md#the-playbook) has queries over the records.

```
$ tutti playbook                       # the lessons, those proposed first, counts and effect
$ tutti playbook approve L12           # a proposed lesson reaches workers from the next ticket
$ tutti playbook edit L12 "New words"  # new words, its counts begun again; the gate's word checks apply
$ tutti playbook retire L12            # out of workers' prompts
```

It works beside a run, whose next ticket reads the file afresh. `"playbook": { "enabled": false }` in
[`.tutti/settings.json`](setup.md#the-settings) turns all of it off.

## The scout

`tutti init`'s Checks step starts with the scout, which looks through the repository for its test
suites, lints, type checks and builds (see [The checks](setup.md#the-checks)). It is the one organ
with tools, and only read-only ones: Read, Glob and Grep, in the repository's root. A hook denies any
call that would read outside the repository, symbolic links included, whatever the settings allow.
It runs nothing and changes nothing, and is stopped after 5 minutes or once it has spent $2.00.

For each suite it gives a name, a kind (unit, integration, e2e, lint, typecheck, build or other),
the command, the `file:line` that defines it, a tier (**fast** or **full**), whether it is safe to
run beside another copy of itself, and what it needs. It also lists the project's stack, which
init gives the verifier. `Esc` skips it.

## What organs cost

Each organ call is logged with what it cost:

```
ORGAN triage: $0.0123 in 1 turn, 4.2s
ORGAN triage: cost unknown, no result after 180.0s
```

A call stopped at its time limit, or one whose session failed before its result, spent tokens no
result reports, so its cost is unknown. The run report ends with the run's total, the report's own
call included: `Organs: $0.0456 in 7 organ calls, 9 turns in all; 1 call's cost unknown.`
`tutti init` keeps no log, so the scout's cost isn't recorded.

While the account's [usage limit](running.md#the-usage-limit) holds the run, organ calls are
skipped, each with a log line: `ORGAN triage: skipped, the usage limit holds the run`.

## Organs on an API key

Organs bill what workers bill (see [Login and billing](setup.md#login-and-billing)).
`TUTTI_ORGAN_PROVIDER=anthropic`, with `ANTHROPIC_API_KEY` set, has them call the Messages API on that
key instead, whatever bills the workers, for CI and API-key users. Then:

- the model is `--organ-model`'s, else `claude-sonnet-5-5`;
- `xhigh` and `max` effort are sent as `high`;
- the API reports no price, so each call is logged `cost unknown, no price reported`;
- the scout can't run, as it needs Claude Code's tools: `tutti init` falls back to asking for the
  checks.

`TUTTI_ORGAN_PROVIDER` is `agent-sdk` (the default) or `anthropic`; anything else, or `anthropic`
without a key, is a setup problem. The `START` block says what organs bill.
