# Organs

tutti's one-shot advisers: triage, the predictor, the reviewer and the scout.
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
| predictor | a ready ticket naming nothing, with footprints on and more than one slot | `low` | 2 min |
| reviewer | the end of a run | `medium` | 5 min |
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

## The predictor

The predictor guesses which files a ticket will change when the ticket names none its
[footprint](running.md#footprints) can use, and keeps the guess on the ticket as `predicted_files`
metadata, which footprints read as the ticket's own files, marked `(predicted)` in the log.

A run starts it when the queue's `footprint` is on and `concurrent` is more than 1. Each ready
ticket naming nothing, unless it is `solo`, is guessed once a run, one ticket at a time in the
background: the run never waits for a guess, so until one is in, the ticket keeps its
empty footprint and may run beside anything. The log says `<id> footprint predicted: a.ts, b.ts`,
or `<id> footprint not predicted: <why>`; a fault in tutti while it guesses one ticket's files is
`PREDICT_FAILED for <id>: <why>`, and the predictor goes on to the next. Footprints also read
`predicted_files` a ticket already has, such as those orchestra's predictor left.

## The reviewer and the run report

At the end of a run, once the dashboard has closed and the summary is printed, the reviewer writes
the run report. The evidence: how the run ended, the run's whole log, the commits merged into the
base, the tickets closed (with their close reasons), set aside (with their notes, triage's
included) and still in progress, each ticket's tallies (attention requests, answers, denials,
compactions, your messages), what the check said of each ticket set aside after its check failed,
the full check, the follow-ups filed outside a `--ticket` run's scope, the feature request, and what
the organs have cost so far.

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
