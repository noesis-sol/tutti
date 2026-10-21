# Dashboard

What the terminal shows while a run goes and after it ends, the worker view, the keys and the mouse,
terminals, and notifications. Back to the [README](../README.md).

## What you see

On a terminal, a run draws one dashboard on the terminal's alternate screen, as a full-screen
program such as `less` does: nothing is printed above it while the run goes, and once it closes the
terminal shows what it showed before, followed by the run's summary.

```
 tutti  0.1.0   batch/2026-10-20 · 18m40s · ticket tut-8f2    usage 85% of the five-hour limit · resets 14:05
╭────────────┬───────────┬───────────┬───────────┬───────────────────────╮
│ Completed  │ Set aside │ Needs you │ Workers   │ In queue              │
│ ✓ 2        │ ↷ 1 ◆ 1   │ 1         │ 3 of 3    │ 9 of 16 · 2 held back │
╰────────────┴───────────┴───────────┴───────────┴───────────────────────╯
  Tickets
╭────────────┬─────────────┬─────────────────────────────────────────────╮
│ ✓ done     │ tut-dwv     │ ffd6ce4 merged into batch/2026-10-20        │
│ ◆ merging  │ tut-kco     │ Open the property model: Interpolatable p…  │
│ ▶ testing  │ tut-zq4     │ Add an undo stack for property edits        │
│ ■ allow?   │ tut-9a1     │ Remove the build cache                      │
╰────────────┴─────────────┴─────────────────────────────────────────────╯
  Current
╭──────────────────────────────────╮╭──────────────────────────────────╮
│ 1 ◆  tut-kco  merging  6m31s     ││ 2 ⣾  tut-zq4  testing  1m07s     │
│   Open the property model: Int…  ││   Add an undo stack for propert… │
│   merging into batch/2026-10-20  ││   ▸ Bash(scripts/check-fast.sh)  │
╰──────────────────────────────────╯╰──────────────────────────────────╯
╭──────────────────────────────────────────────────────────────────────╮
│ 3 •  tut-9a1  permission — waiting for you  2m10s                    │
│   Bash: Remove the build cache                                       │
│   rm -rf build                                                       │
│   [ Deny ]  [ Allow ]                                                │
╰──────────────────────────────────────────────────────────────────────╯
  Tab select · 1–3 open · d deny · s stop after current · ? keys
```

### The title line

The ` tutti ` pill, the version, then, faint, the branch finished tickets land on, how long the run
has gone, and the scope of a `--ticket` or feature run (`· ticket tut-8f2`). It also says
`· stopping` while something holds the run, `Quitting…` while it quits, and
`· solo <id> running` or `· solo <id> next` around a ticket labelled `solo`.

On the right, the banners:

- **Usage**, once the account's usage passes its warning level:
  `usage 85% of the five-hour limit · resets 14:05`, with `· overage` while overage is in use. It
  turns bold at 100%.
- **Holds**: `BLOCKED`, `PAUSED` and the like while something holds the run, and
  `USAGE_LIMIT · resets 14:05` while the usage limit does, with `· in 1h12m` while the run has
  nothing else to do but wait for it (see [The usage limit](running.md#the-usage-limit)).

### The totals

One strip for the run:

- **Completed**: tickets merged, or closed with no change to merge.
- **Set aside**: tickets deferred or left for review, `↷ n`, and of those how many triage has given a
  verdict on, `◆ n`.
- **Needs you**: each ticket once whose worker waits on you (a permission request or a question),
  that waits on a question ticket for you, or whose work is done but can't merge until you act.
- **Workers**: workers at work out of how many may run (`-c`).
- **In queue**: ready tickets waiting for a slot, out of the tickets not closed (`9 of 16`); then
  `· 2 held back` for ready tickets that wait for something besides a slot (an overlap, their
  subtickets, a blocker not merged, a solo ticket), `· 1 setup failed` for ready tickets whose
  worktree's setup failed, waiting for a ticket to merge or a probe, and `· held` while the run takes
  no new tickets.

A pane too narrow for the strip gets the totals on one line: `✓ 2 · ↷ 1 · ? 1 · ▶ 3/3 · queue 9 of 16`.

### The tickets table

One row per ticket the run has taken up but those Current shows, so that no ticket is shown twice:
the tickets that came to an end, in that order, a ticket's row coming in under the others as its
card leaves Current. With the end-of-run box in Current's place, the running tickets keep their
rows. A row changes as the ticket moves through its phases:

| Row | The ticket |
|---|---|
| `▶ working`, `▶ editing`, `▶ reading`, `▶ testing`, `▶ subagent`, `▶ starting`, `▶ retrying` | is with its worker, and what the worker is doing |
| `■ allow?`, `■ answer?` | its worker waits on you: a permission request, or a question it asked |
| `◷ limit` | its worker stopped on the account's usage limit, until it resets |
| `◼ to merge` | its work is verified, and it waits for its turn to merge |
| `◆ merging` | its merge is under way: the rebase, the setup, the check, the fast-forward |
| `⟳ resolving` | its rebase stopped on conflicts, handed back to its worker |
| `⟳ fixing` | its check failed on its branch before it merged, handed back to its worker |
| `✓ done` | merged (`ffd6ce4 merged into <branch>`), or closed with `no change to merge` |
| `? for you` | waits on a question ticket for you |
| `◷ waiting` | back in the queue until a blocker merges, or reopened by an environment hold |
| `↷ deferred` | set aside, deferred; triage's verdict (`◆ …`) replaces its note once it is in |
| `! review` | left for review: `CHECKS_FAILED`, closed without a commit, … |
| `■ blocked` | its work is done, but it can't merge until you act |
| `■ stopped` | it stopped the run, or its worker was still at it when the run ended |

The table takes about a third of the pane, room for 3 to 10 tickets, and keeps its height: once the
run has more, the oldest give way to a `+N earlier tickets, see the log` row. A pane too short for
it and the cards leaves it out. The summary after the run lists every ticket.

### The cards

Under `Current`, a card per ticket with work under way: its worker's number, a mark, the ticket, the
worker's status, how long it has gone, the title, and the latest action (`▸ Bash(scripts/check-fast.sh)`,
or the last line the worker wrote).

- **Numbers are stable.** A worker keeps its number for its whole session; a new one takes the
  lowest free number. `1` to `9` open workers 1 to 9; those above are reached with `Tab` or a click.
- **The mark** is a spinner while the worker works, `◼` while its ticket waits to merge, `◆` while it
  merges, and `•` once the worker's turn has ended: motion means a worker at work.
- **The status** is the worker's (`working`, `editing`, `reading`, `testing`, `subagent`,
  `starting`, `retrying 3/10 (529)`, `done`, `stopped`, `failed`, `gone`,
  `usage limit · resets 14:05`, `permission — waiting for you`, `question — waiting for you`) or the
  ticket's (`resolving`, `fixing check`, `to merge (2nd)`, `merging`). `steered` follows it for a
  worker you have steered (see [Steering](workers.md#steering)).
- **The action line** of a ticket merging says the step: `rebasing onto <branch>`,
  `running the setup`, `running the check on <branch>`, `merging into <branch>`, or for a ticket
  checked once more, `checking again: <branch> moved on since its check failed`.
- **The frame** is coloured while the worker works, red while it waits for you, and heavy on the
  highlighted card.

Cards go two to a row from 120 columns, all as tall as the tallest. When the pane can't hold a card
each, they take one line each in a single box, their numbers, tickets, statuses and times lined up
as columns, so that the titles start at one column. With nothing running, a box says
`picking the next ticket…`, or `stopping…`. The environment probe has a card of its own, labelled
`probe`. Elapsed times update every 3 seconds.

### Attention cards

A worker waiting on you turns its card red, and the card grows to show the request and its buttons
(see [Attention requests](workers.md#attention-requests)):

- **A permission**: the request's line (`Bash: Remove the build cache`), then, faint, what will run
  and why Claude Code asks; then **Deny**, **Allow** and, when the request offers a rule,
  **Allow for this run**.
- **A question**: the question, then a button per option, `1 <label>` to `4 <label>`. A question
  with several parts, several answers or more options has **Answer in view**.
- **An MCP server's request**: **Decline**, and **Open URL**, **Accept** or **Answer in view**.

Deny has the focus when a card opens; Allow never does. `+2 more` says the worker has more
requests, which follow as each is answered. In the one-line layout, a card waiting on you reads
`■ allow?` or `■ answer?`, and `Enter` opens its request in a box over the dashboard.

### The foot

Above the hint, while the run winds down (**s**, below), a line shows how far it has come: a `■` per
ticket running when it began, amber while it runs, green once merged, red once set aside or waiting
on you: `■ ■ ■ ■  Winding down · 3 running, no new tickets`. Warnings take a line each, ` ! …`, such
as a colour scheme that can't be used or the usage limit's hold
(`usage limit (five-hour) · resets 14:05 · 3 workers wait for it`).

The hint names the keys there are: `Tab select · 1–3 open · d deny · a allow · s stop after current · ? keys`.

### The end-of-run box

A run with nothing left to start or merge, but workers waiting on you, doesn't end. A box takes the
cards' place:

```
Everything else is done. 2 workers wait for you: tut-9a1 (Allow Bash(rm -rf build)?), tut-7k2 (a question)
Answering lets them carry on. q ends the run, suspending them: the next run resumes them.
```

Answer them and the run goes on, merging what they finish; `q` ends it. Workers that stopped the run
(`PAUSED`, `TICKET_LIMIT`) don't keep it open.

### A small pane

The dashboard needs 60 columns and 16 lines. Below that it shows only the totals on one line and the
hint; the keys still work.

### After the dashboard

When the run ends, the dashboard closes and the main screen gets:

- the summary: the title, the totals and every ticket of the run;
- the closing line, `♪ Completed the Run  12 tickets · 1h12m` for a run that ended by itself, or a
  red line saying what stopped it (`■ PAUSED: …`);
- a run scoped with `--ticket` adds `SCOPE_DONE: …` or `SCOPE_OPEN: …`;
- the organ lines and the run report (see [Organs](organs.md#the-reviewer-and-the-run-report));
- the notice of a newer release, if there is one: `tutti v0.2.0 is available (you have v0.1.0): tutti update`.

## The worker view

`Enter` on a card, a click, or `1`–`9` opens the worker's view, full screen:

```
 ← Dashboard   2 ⣾  tut-zq4  testing  1m07s   Add an undo stack for property edits
─────────────────────────────────────────────────────────────────────────────────
  Read  src/history/undo.ts                                                    ✓
  Edit  src/history/undo.ts                                               +42 −3
▸ Bash  scripts/check-fast.sh
  The undo stack now records property edits in groups, so one undo reverts
  a whole drag. Next I'll add the keyboard binding.
─────────────────────────────────────────────────────────────────────────────────
 > i to write to the worker
 Esc dashboard · i write · Ctrl+X interrupt · ↑↓ select · Enter expand · ? keys
```

- **The transcript.** What the worker writes is drawn as Markdown. Each tool call is one line, its
  result at the right: `✓`, an error's first line, or `+N −M` for an edit. Selected with the arrows
  and opened with `Enter` or a click, a call shows an edit's diff, a command's output (400 lines at
  most), or the lines a read covered. A subagent's work is nested under the call that started it,
  collapsed. Messages, yours and tutti's, read `› …`. Thinking is hidden.
- **Earlier items.** The view holds the last 200 items. Scrolling past the top (the wheel, `PgUp`,
  `g`) loads 200 more from tutti's transcript of the worker, up to 600 at once. The transcript
  outlives the session: it is in `.tutti/run/workers/<id>/messages.jsonl`.
- **Requests.** The worker's open requests show above the composer, with the same buttons and keys
  as on its card, plus the whole input. **Answer in view** opens a form: `↑`/`↓` move, `Space`
  picks, `Enter` picks or presses, `Other:` takes your own words.
- **The composer.** `i`, or a click on it, focuses it. `Enter` sends what you typed into the
  worker's session, `Alt+Enter` or `Ctrl+J` starts a new line, `Esc` leaves it. A message sent
  while a turn is under way shows as `queued` until the worker takes it. Sending makes the worker
  **steered**: tutti then sends it nothing by itself until you release it (see
  [Steering](workers.md#steering)). The line under the composer says so, with **Release**.
- **Interrupting.** `Ctrl+X` asks `Interrupt <id>'s turn?`; `y` stops the worker's turn, cancels the
  messages still queued and its background tasks, and steers it.
- **A hand-back waiting.** A steered worker isn't handed a conflict or a failing check. The view
  says `A merge conflict waits for this worker` with **Hand it the conflict now**.

`Esc` leaves the composer, then the view; `1`–`9` switch to another worker.

## Keys

| Key | Dashboard | Worker view |
|---|---|---|
| `Tab`, `Shift+Tab`, `←`, `→` | move the highlight between cards; inside an attention card, between its buttons | move between a request's buttons, else between items |
| `↑`, `↓` | move the highlight between cards | move between items |
| `1`–`9` | open that worker; in a highlighted question, `1`–`4` pick an option | switch to that worker; in a selected question, pick an option |
| `Enter`, a click | press the focused button, or open the card (in the one-line layout, open its request) | expand or collapse the item; press the focused button |
| `d` | deny the request (decline an MCP server's) | the same |
| `Shift+D` | deny, with a reason you type for the worker | the same |
| `a` | allow, when the request has a one-key allow | the same |
| `r` | allow for this run, when the request offers it | the same |
| `s` | stop after the running tickets, or keep taking tickets (asks `y`/`n`) | |
| `q` | end the run, while the end-of-run box shows | |
| `i` | | focus the composer |
| `Ctrl+X` | | interrupt the worker's turn (asks first) |
| `Ctrl+R` | | release a steered worker |
| the wheel, `PgUp`, `PgDn` | | scroll the transcript |
| `g`, `G` | | jump to the top or the end |
| `Esc` | close a box or the key help | leave the composer, then the view |
| `?` | key help | key help |
| `Ctrl+C` | the quit box | the quit box |
| `Ctrl+Z` | a toast: tutti can't be suspended | the same |
| a drag | select text, copied when you let go | the same |

**Answering the request you read.** A key or click answers the request on screen when it was
pressed. For half a second after a request appears or changes, its card ignores input, so a key
meant for something else doesn't answer it. An answer to a request that has gone meanwhile is
dropped, with a toast (`<id>'s request is no longer open`).

**A request held by the safety check** (Claude Code's `defaultToNo`) has no one-key allow: `a` and
`r` do nothing, and the hint leaves `a` out. Move to **Allow** and press `Enter`, or click it.

**Stopping and quitting.**

- `s` asks `Stop after the running tickets?`; `y` winds the run down: no new tickets start, the
  running ones finish and merge, and the run ends `DRAINED`. While it winds down, `s` asks
  `Keep taking tickets?` to take it back. `kill -USR1 <pid>` winds a run down too, without asking.
- `Ctrl+C` opens the quit box: `s` stops after the running tickets as above, `q` quits now, `Esc`
  cancels. A second `Ctrl+C` quits now. Quitting interrupts the workers and saves their sessions,
  and the next run resumes them (see [Quitting](running.md#quitting-and-the-next-run)).
- `Ctrl+Z` doesn't suspend tutti, which would freeze every worker's output: a toast says
  `tutti can't be suspended: s stops after the current tickets, Ctrl+C quits`.

## The mouse and copying

Cards, buttons, `← Dashboard`, **Release** and the composer take single clicks; every click has a
key. The wheel scrolls the transcript under the pointer.

Dragging selects text, which is copied when you let go, with a toast (`copied`, or
`couldn't copy`): with `pbcopy` on macOS, `wl-copy` or `xclip` on Linux where one is installed, and
otherwise, as over ssh, with the terminal's own clipboard sequence (OSC 52). Terminal.app doesn't
support OSC 52, and tmux passes it on only with `set-clipboard on`.

`--no-mouse` (or `TUTTI_NO_MOUSE=1`, or `"mouse": false` in the
[user config](setup.md#the-user-config)) leaves the mouse to the terminal, for its own selection;
every action stays on the keys.

## Plain output

Without a terminal to draw on, a run prints its log lines instead, the same lines it writes to
`.tutti/tutti.log`, each after its time (`2026-10-17 09:05:03 …`). It does so with `--plain` (or
`TUTTI_PLAIN=1`), and when:

- stdin or stdout isn't a terminal: `Plain output: stdin isn't a terminal.`;
- `TERM=dumb`: `Plain output: TERM is dumb.`;
- the terminal reports fewer than 256 colours (below).

A plain run on a terminal still asks the start question, as numbered lines. Attention requests are
answered with [`tutti answer`](workers.md#answering-without-the-dashboard), and each request's line
says how:

```
  PERMISSION: tut-9a1's worker asks: Bash: rm -rf build (held by the safety check); answer with: tutti answer a3f9 allow --confirm | deny
```

A plain run ends when its work is done, as usual, suspending workers that still wait on you.

## Terminals

The dashboard runs in any terminal emulator with 256 colours or more, inside tmux or screen, or over
ssh.

- **Colours over ssh.** tutti reads the terminal's colour depth from `COLORTERM` and `TERM` alone,
  and ssh often passes neither faithfully. Set `COLORTERM=truecolor` (for example in the remote
  shell's profile, or `SendEnv COLORTERM` with the server's `AcceptEnv`) where the terminal has it.
  A terminal that reports fewer than 256 colours gets plain output, saying why:
  `Plain output: the terminal reports fewer than 256 colours (TERM=xterm); the dashboard needs 256 or more. Set COLORTERM=truecolor, or a 256-colour TERM such as xterm-256color, if it has them.`
  See [Colour depth and NO_COLOR](colour-schemes.md#colour-depth-and-no_color).
- **Copying in tmux.** tmux passes the clipboard sequence on only with `set -g set-clipboard on` in
  `~/.tmux.conf`. Terminal notifications from inside tmux need `set -g allow-passthrough on`.
- **New lines in the composer.** Where the terminal can't tell `Alt+Enter` from `Enter`, `Ctrl+J`
  starts a new line.
- **Light or dark.** tutti asks the terminal for its background; see
  [Light or dark](colour-schemes.md#light-or-dark) to fix it instead.
- **Signals.** `kill -USR1 <pid>` (or `-USR2`) winds a run down. SIGINT, SIGTERM and SIGHUP (closing
  the terminal) quit, as `q` in the quit box does; a second one abandons a merge under way; a third
  exits at once. SIGTSTP is ignored.

## Notifications

A notification tells you each outcome that matters, in a few words, titled with the repository's
folder name (`jswallet`), as orchestra's do:

| When | It says |
|---|---|
| a ticket is merged | `Closed jswallet-12 · Add a --json flag to list` |
| a ticket is deferred, or left for review (`CHECKS_FAILED`, `MERGE_CONFLICT`, …) | `Set aside jswallet-12 · checks failed` |
| a ticket waits on a question for you | `jswallet-12 needs your answer · Which name should the flag have?` |
| a worker asks you something (the first request in 30 seconds) | `jswallet-12 needs you · Allow Bash(rm -rf build)?` |
| the account's usage limit holds the run (once per hold) | `The five-hour limit is reached; the run holds until it resets at 14:05` |
| the run stops | `Stopped: PAUSED on jswallet-12`, or `Stopped: INTERRUPTED` when no ticket stopped it |
| the run finishes | `Finished the run · 12 tickets closed · 2 set aside`, counting the tickets still set aside as it ends, those blocked from merging among them |
| the full check after the run fails | `Full check failed · test/e2e`, or `Full check failed · setup` |

A title or reason longer than 60 characters is cut with `…`; the log has the rest. Holds other than
the usage limit's, probes, the warnings that set no ticket aside (`LIKELY_CONFLICT`,
`LONG_RUNNING`, …), triage and the run report don't notify, nor does a run with nothing to run.

- On macOS, with `osascript`, titled with the repository's folder name.
- On Linux, with `notify-send` when it is installed.
- Otherwise, as over ssh, with the terminal's own notification sequence where it has one: OSC 9 in
  iTerm2 and kitty, OSC 777 in Ghostty, WezTerm and foot.

`--notify=false`, `TUTTI_NOTIFY=0` or `"notify": false` in the
[user config](setup.md#the-user-config) turns them off.
