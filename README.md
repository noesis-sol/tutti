# Tutti for Claude

<img width="1559" height="666" alt="Abstract AI Ensemble Conductor" src="https://github.com/user-attachments/assets/2b1f46a7-7ef3-40d2-b707-7f82f202cf9e" />


Runs Claude Code workers on a Beads backlog, one git worktree per ticket.

tutti works through a [Beads](https://github.com/gastownhall/beads) backlog with several Claude
workers side by side, each in its own git worktree. It rebases, checks and fast-forwards each
finished ticket, one at a time, into the branch you started on. A live terminal dashboard shows the
run, and you can open any worker to read what it is doing or talk to it.

It is a port of [orchestra](https://github.com/noesis-sol/orchestra) that keeps orchestra's concepts
and drops its terminal multiplexers:

- **No tabs.** Workers are Claude Agent SDK sessions held by tutti's own process. A worker's "tab" is
  a view tutti draws, opened by selecting its card.
- **Exact worker state**, from the sessions' own messages, not from reading a screen.
- **Requests answered in tutti.** A worker's permission requests and questions are answered on its
  card, in its view, or with `tutti answer`.
- **Any terminal**, on macOS or Linux, inside tmux or over ssh. Nothing to install beyond `git`
  (2.38 or later), `bd` and a Claude login.

## Install

The recommended install is a release archive: one binary, with its Claude Code embedded, from the
repository's GitHub Releases. The install script picks the archive for your platform (macOS or Linux,
arm64 or x64, glibc or musl), checks its signature and SHA-256, and installs it in `~/.local/bin`
(`TUTTI_INSTALL_DIR` names another folder). Each release carries its own install script:

```sh
curl -fsSL https://github.com/noesis-sol/tutti/releases/latest/download/install.sh | sh
```

`tutti update` updates it to the latest release, and `tutti --version` says which you have.
[Setting up](docs/setup.md#installing) has the rest: the script's variables, musl systems, updating
and versions.

### npm, for development and agents

```sh
bunx @noesis-sol/tutti --version
```

The npm package `@noesis-sol/tutti` is not the recommended install. It is there for development
and for agents that run tutti through `bunx`. It needs Bun 1.3.14 or later on `PATH`, and installs
Claude Code and OpenTUI's native library for its platform from npm. Its `tutti` is a shell launcher
that runs the bundled tutti with Bun, reading neither the `.env` files nor a `bunfig.toml` of the
folder it runs in, so a project's `ANTHROPIC_API_KEY` in `.env` doesn't reach tutti or its workers.

## Log in

```sh
tutti login
```

Workers run on your Claude login, the one `claude` uses: `tutti login` runs Claude Code's own login,
and `claude /login` is the same. With a subscription login, tutti keeps `ANTHROPIC_API_KEY` from
workers, so a key in your environment doesn't bill the API without a word; `--billing api` uses the
key instead. Each run's log says which bills it. See [Login and billing](docs/setup.md#login-and-billing).

## Set up a project

In the project's repository, from its main checkout:

```sh
tutti init
```

`tutti init` installs Beads where it is missing and sets it up in the repository, then writes
`.tutti/` (the worker prompt, `settings.json` and a `.gitignore`) and the project's two checks:
`scripts/check-fast.sh`, run on each ticket before it merges, and `scripts/check-full.sh`, run once
at the end of a run. It asks in two steps, **Workers** (how many at once, their MCP servers) and
**Checks** (the scout looks for the project's test suites, lints and builds; a verifier subagent for
workers), and ends by checking the login. Commit `.tutti/` and `scripts/` afterwards: a ticket's
worktree has only what is committed.

In a project orchestra set up, `init` offers to import orchestra's settings and worker prompt.
[Setting up](docs/setup.md#setting-a-project-up) has every question, its flags, the checks, the
settings and your own config.

## Run

From the main checkout, on the branch finished tickets should land on:

```sh
git switch -c batch/$(date +%F)
tutti
```

In a terminal, `tutti` first asks what to work on: **Current tickets**; **Spec**, a spec file you
type, complete with `Tab` or pick in a file browser (`Ctrl+O`), or its `https://` URL, broken down into
tickets as it is or refined with Claude first, then run; or **New feature**, which talks a feature
through with you in an interview, files it as an epic and its tickets, and runs them. `--tickets`
skips the question, as scripts and agents should.

How a run goes:

- **Dispatch.** Each ready ticket in `bd ready` goes to its own worker, up to `-c N` at a time, the
  highest priority first. Tickets that touch the same files or functions don't run side by side, a
  parent runs after its subtickets, and a ticket labelled `solo` runs alone.
- **Merge.** A finished ticket is rebased onto the branch if it moved on, checked with
  `scripts/check-fast.sh`, and fast-forwarded. A conflict or a failing check goes back to its worker
  first; a ticket that still can't merge is set aside for review.
- **Attention.** A worker that needs your permission, or asks you a quick question, waits on you: its
  card turns red with the request's buttons. `tutti answer` answers from anywhere. A request left for
  4 minutes holds the run until it is answered.
- **Questions.** A decision that can wait is a question ticket labelled `human`, and the run goes on.
  Answer it with `bd human respond <question> --response "…"`, and the worker carries on.
- **Steering.** Open a worker, type a message to it, or interrupt it with `Ctrl+X`. tutti then leaves
  it to you until you release it.
- **Holds.** Something that needs you (a worker stuck with its ticket open, a tool failing, the
  account's usage limit) stops new tickets while the running ones finish. The usage limit is waited
  out, and the workers carry on once it resets.
- **Quitting.** `Ctrl+C` asks: `s` stops after the running tickets, `q` quits now. Quitting saves the
  workers' sessions, and the next run resumes them where they left off.
- **The end.** A run that ends by itself runs `scripts/check-full.sh` once, then the reviewer writes
  a run report, saved in `.tutti/reports/`.

| Option | |
|---|---|
| `-c N` (`--concurrent`) | tickets at the same time, for this run |
| `--tickets` | run the current tickets without asking first |
| `--ticket <id>` | run only this ticket and its subtickets |
| `--feature "<request>"` | plan a request as an epic and its tickets, and run them |
| `--spec <file\|url>` | break a spec, a file or one at an `https://` URL, down into tickets under a root epic, and run them; again, carry on or update them |
| `--ticket-limit 2h` | hold the run if a worker is still going this long after its ticket started |
| `--limit N` | the most tickets this run starts (no limit by default) |
| `--plain` | log lines instead of the dashboard |

`tutti -h` lists every flag; [Running](docs/running.md#options) has them all. Run `tutti plan` after
filing a batch of tickets: it proposes blocks links between tickets that touch the same code, and
`--apply` adds them.

## Commands

| Command | |
|---|---|
| `tutti` | a run |
| `tutti init` | sets the project up |
| `tutti checks` | sets the project's checks again after `tutti init`, in its Checks step |
| `tutti plan [--apply]` | proposes blocks links between open tickets that touch the same code |
| `tutti answer [<request-id> allow\|allow-run\|deny] [--json]` | lists or answers the workers' open requests |
| `tutti answer <question> [--] <answer>` | answers a question ticket a worker filed, by an option's number or label or in your own words (after `--` for a label that starts with `-`); `tutti answer` lists them after the requests |
| `tutti login` | logs in to Claude, then says which account and billing workers get |
| `tutti colours [<name>]` | previews a colour scheme, and checks it |
| `tutti requires [--no-install] [--markdown\|--readme]` | checks what the machine must have for the project, installing what it can, or writes the README's section on it |
| `tutti update [--check] [--force]` | updates tutti to the latest signed release |
| `tutti --version` | the version |

## Terminals

The dashboard runs in any terminal with 256 colours or more. Over ssh, set `COLORTERM=truecolor`
where the terminal has it, since tutti reads the colour depth from the environment alone; in tmux,
`set -g set-clipboard on` lets tutti copy the text you select. A terminal with fewer colours, `TERM=dumb`
or no terminal at all get plain log lines. See [Terminals](docs/dashboard.md#terminals).

## orchestra beside tutti

tutti and orchestra share Beads, its labels (`solo`, `human`, `unmerged`, `area:<name>`) and ticket
metadata, but not their runs: tutti's branches are `tutti/<id>` and its worktrees `<repo>-tutti/`,
it never takes over orchestra's workers, and each refuses to start while the other runs in the
repository. Finish an orchestra run with orchestra. See
[orchestra beside tutti](docs/running.md#orchestra-beside-tutti).

## Running tutti through an agent

[`skills/tutti/SKILL.md`](skills/tutti/SKILL.md) is a skill for a coding agent that runs tutti for
you: setting a project up, launching `tutti --plain --tickets`, answering the workers' requests with
`tutti answer`, quitting and resuming, and finding out why a run stopped. Copy the `skills/tutti/`
folder to `~/.claude/skills/tutti/` (every project) or to `.claude/skills/tutti/` in one project,
then ask the agent to "run tutti". See
[Running through an agent](docs/running.md#running-through-an-agent).

## Documentation

- [docs/setup.md](docs/setup.md): installing and updating, logging in and billing, `tutti init`, the
  checks, the verifier, the settings and your user config
- [docs/running.md](docs/running.md): starting a run and its options, scoped and feature runs,
  several tickets at once, the merge queue, holds, the usage limit, quitting and carrying on, exit
  codes, running through an agent, orchestra beside tutti
- [docs/dashboard.md](docs/dashboard.md): the dashboard, the worker view, the keys and the mouse,
  plain output, terminals, notifications
- [docs/workers.md](docs/workers.md): the worker prompt, permissions, attention requests and
  `tutti answer`, steering, hand-backs, sessions, MCP servers
- [docs/organs.md](docs/organs.md): triage, the predictor, the reviewer and the run report, the
  screen, the plan and the scout
- [docs/events.md](docs/events.md): the event stream for scripts and agents, with `jq` recipes
- [docs/analytics.md](docs/analytics.md): ready-made DuckDB queries over the event stream, the
  workers' transcripts and bd's export: runs, throughput and bottlenecks, tickets, checks and
  quality, waiting on you, how workers work, the backlog, the usage limit, the prompt cache, every
  project, two runs compared, trends
- [docs/colour-schemes.md](docs/colour-schemes.md): colour schemes, writing one, light and dark
- [Changelog](CHANGELOG.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

<!-- orchestra:requires -->
<!-- Generated from "requires" in .orchestra/settings.json: change the list, then run orchestra requires --readme. -->
## What to install

What this project needs of the machine, from `"requires"` in `.orchestra/settings.json`. `orchestra requires` checks each one and installs what it can.

- **duckdb** (only on macOS)
  - check: `command -v duckdb`
  - install: `brew install duckdb`
<!-- /orchestra:requires -->
