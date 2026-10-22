# Setting up

Installing and updating tutti, logging in, setting a project up with `tutti init`, the checks, the
settings and your own config. Back to the [README](../README.md).

## Installing

```
curl -fsSL https://raw.githubusercontent.com/noesis-sol/tutti/main/scripts/install.sh | sh
```

[The install script](../scripts/install.sh) installs the latest release: one binary with its own
Claude Code embedded, for macOS or Linux, arm64 or x64. It needs `curl` or `wget`, and `tar`.

- **Where.** In `/usr/local/bin` where it can write there, else in `~/.local/bin`. It never calls
  `sudo`; to install where only root can write:
  `curl -fsSL https://raw.githubusercontent.com/noesis-sol/tutti/main/scripts/install.sh | sudo TUTTI_INSTALL_DIR=/usr/local/bin sh`.
  It says so when the folder isn't on your `PATH`, with the line that adds it for your shell, or
  when another `tutti` comes before it there.
- **What it checks.** It downloads the release's `checksums.txt` and its signature,
  `checksums.txt.sig`, and verifies the signature with the release key built into the script, where
  an OpenSSL 3 is installed. macOS's own `openssl` is LibreSSL, which can't verify the signature:
  the script then says so and goes on (`brew install openssl@3` provides one). Either way it checks
  the archive's SHA-256 against `checksums.txt`, and checks that the new binary runs and names the
  release (`tutti --version`) before it puts it in place. Nothing is installed when a check fails.
- **musl.** On Linux it installs the musl build on a musl system, such as Alpine, and the glibc
  build otherwise, as `ldd --version` (or else the musl loader) tells. A musl build needs
  `libstdc++` and `libgcc`: `apk add libstdc++ libgcc` on a bare Alpine.
- **AVX2.** On x64 it needs a CPU with AVX2 (Intel Haswell, 2013, or AMD Excavator, 2015, or
  later), as the Claude Code tutti embeds does: without it the script stops before downloading
  anything. It reads `/proc/cpuinfo` on Linux and `sysctl hw.optional.avx2_0` on macOS; where it
  can't tell, it says so and installs all the same.
- **Rosetta.** In a shell under Rosetta on Apple Silicon (an x64 Terminal or shell, whose
  `uname -m` says `x86_64`), it installs the arm64 build, which runs natively, and says so.

| Variable | |
|---|---|
| `TUTTI_VERSION` | the release to install, such as `v0.9.0`; the latest when unset |
| `TUTTI_INSTALL_DIR` | the folder to install in |
| `TUTTI_LIBC` | `musl` or `glibc`: the Linux build to install, whatever the system says |

The releases are archives on GitHub Releases, `tutti_<version>_<os>_<arch>.tar.gz` for `darwin` or
`linux` and `arm64` or `x64`, plus `tutti_<version>_linux_<arch>_musl.tar.gz`, each with the
README, the licence, the changelog and the third-party notices. Their build provenance is attested.

The npm package is for development and agents, not the recommended install: see the
[README](../README.md#npm-for-development-and-agents).

### Updating

```
tutti update
```

`tutti update` replaces the running binary with the latest release's for its own build: a musl build
with the musl archive, a glibc build with the glibc one (moving from one to the other is a reinstall
with the script). It verifies the signature of `checksums.txt` with the release keys built into tutti
before it trusts a sum, then the archive's SHA-256, then that the new binary runs, and only then
renames it over the old one. A run going meanwhile keeps the old build.

- `tutti update --check` changes nothing: it says whether a newer release is out, and exits 1 when
  one is.
- A build from a clone (`scripts/build.sh`) is replaced only with `--force`, which also replaces a
  build newer than the latest release. tutti run from source (`bun src/main.ts`) is never replaced.
- Where the binary's folder is root's, run `sudo tutti update`.
- Exit codes: 0 updated or nothing to do, 1 a newer release is out (`--check`), 2 refused, 4 the
  update failed, the old binary unchanged.

A release build checks for a newer release once a day as a run starts, and says so after the run:
`tutti v0.2.0 is available (you have v0.1.0): tutti update`. `TUTTI_NO_UPDATE_CHECK=1` turns that
off.

`tutti --version` says which you have: `tutti v0.9.0`, and for a build from a clone its commit's
12-character hash, `tutti v0.9.0 0123456789ab`, with `+dirty` when the tree had changes.

### What tutti needs

`git`, `bd` ([Beads](https://github.com/gastownhall/beads), which `tutti init` can install) and a
Claude login. Claude Code itself is embedded in the binary: tutti copies it out once per version, into
`claude-<uid>/` in the temporary folder (`/tmp` on macOS; `CLAUDE_CODE_TMPDIR` chooses another), and
removes the copies of other versions once they have gone unused for a day.

Workers can run with another Claude Code instead, such as the one you have installed:
`tutti --claude <path>` (or `TUTTI_CLAUDE`). tutti warns when its version is outside the range it
supports, and runs it all the same.

## Login and billing

Workers and organs run on your Claude login, the one `claude` uses:

```
tutti login
```

`tutti login` runs the embedded Claude Code's own login (`claude auth login`, the claude.ai login): it
opens the browser, prints the URL in case it didn't open, and waits for the code to be pasted. Then it
says which account and billing workers get:

```
account: you@example.com, Example Ltd, max
billing: subscription
```

`claude /login`, in a Claude Code session, is the same login.

Every run checks the login first, with a session that costs no model turn. Without one, it stops:
`Not logged in to Claude: run claude /login, or tutti login`. The same check stops a run when:

- a Claude Code settings file doesn't parse, since Claude Code then skips the file and the permission
  rules in it: `Claude Code skips a settings file it can't read, and the permission rules in it: …`;
- Claude Code ignores the project's `permissions.allow` rules because the main checkout was never
  trusted: `Claude Code ignores the permissions.allow rules in <file>: <checkout> isn't trusted. Run
  claude once in <checkout> and accept the trust dialog, or run tutti init to mark it trusted.`

**The API key.** `ANTHROPIC_API_KEY` in the environment outranks the subscription login and would bill
the API without a word, so:

- With a subscription login and the key both there, tutti keeps the key from workers and organs. The
  run's `START` block says
  `billing: subscription (ANTHROPIC_API_KEY is set but not used; --billing api uses it)`.
- `--billing api` (or `TUTTI_BILLING=api`, or `"billing": "api"` in the
  [user config](#the-user-config)) keeps the key, and the API bills workers and organs.
- With the key and no subscription login, the key is used: `billing: API key`.
- A login Claude Code finds elsewhere (an API key helper, a cloud provider) is named as it is:
  `billing: <source>`.
- A worker that would bill an API key Claude Code finds in its own settings, on a subscription run,
  is stopped, saying where the key came from.

`TUTTI_ORGAN_PROVIDER=anthropic` bills organs to the key whatever bills workers (see
[Organs on an API key](organs.md#organs-on-an-api-key)), and `START` says so.

A compiled tutti doesn't read the `.env` file or `bunfig.toml` of the folder it runs in, so a
project's `ANTHROPIC_API_KEY` in `.env` doesn't reach tutti or its workers.

## Setting a project up

In the project's repository, from its main checkout, between runs:

```
tutti init
```

`tutti init` sets up Beads where it isn't, writes `.tutti/` and the project's two checks, and ends by
checking the login. In a terminal it asks in two steps, **Workers** and **Checks**, one screen each,
and writes nothing until the last is answered; the flags below answer its questions in advance.
Without a terminal it asks nothing, using the flags and what is there. Run again, it keeps what is
there unless a flag changes it.

It writes:

```
.tutti/settings.json             committed: the project's settings
.tutti/worker-prompt.md          committed: the worker prompt, from the built-in template
.tutti/.gitignore                committed: ignores the log, the reports and the run's files
scripts/check-fast.sh            committed: the merge check, run on every ticket before it merges
scripts/check-full.sh            committed: every check, run once at the end of a run
.claude/agents/verifier.md       committed, if you choose it: the verifier
.gitattributes                   committed, if you choose it: CHANGELOG.md merge=union
README.md                        committed, where there is one: its section on what to install
```

Commit them afterwards: a ticket's worktree has only what is committed. `init` ends with a summary
of what it did and what is left (`✗` for what is missing), a **Next** box, and
`♪ tutti is ready.` or `♪ Almost ready: fix what's missing above.`

It refuses, with exit code 2 and nothing changed, in a linked worktree (`<path> is a linked worktree.
Run this from the main checkout.`), and while a run holds the repository's lock: what it changes
would stop that run. It holds the lock itself while it writes, so no run starts meanwhile. `Esc` or
`Ctrl+C` cancels: `Cancelled; nothing was changed.`

With `TERM=dumb`, or a terminal with fewer than 256 colours, it asks the same questions as numbered
lines; `Ctrl+D` cancels.

### Workers

- **Install Beads?** Where `bd` isn't found: with Homebrew where `brew` is installed, else with the
  Beads install script. Where Beads isn't set up in the repository, `init` runs `bd init` (refusing
  while you have changes staged, which `bd init` would commit).
- **Tickets to run at the same time**, 1 to 16. Each worker takes about 1 GiB of memory, which
  `init` says for more than one.
- **MCP servers workers get**, from those defined for this project on your machine (see
  [MCP servers](workers.md#mcp-servers)).
- **Merge CHANGELOG.md by union?** Where the project keeps a `CHANGELOG.md`: tickets that each add a
  changelog entry at the same spot conflict, and `CHANGELOG.md merge=union` in `.gitattributes` has
  git keep both sides' lines.

### Checks

- **The project's checks.** The [scout](organs.md#the-scout) looks through the repository for its
  test suites, lints, type checks and builds, for up to 5 minutes (`Esc` skips it). Then:
  - **Use them as they are**: tick the suites that run on every merge (`check-fast`) and those that
    run at the end of a run (`check-full`). `init` can also file tickets for the areas no suite
    tests.
  - **Create from scratch with the create-check-suite skill**: the runners check nothing yet, and
    `init` files tickets, labelled `tutti-tests`, for a worker to set up the project's tests with the
    skill (which it writes to `.claude/skills/create-check-suite/`).
  - **Manual**: the one command `scripts/check-fast.sh` runs.

  A runner already there that differs from the choice is kept unless you say to replace it.
  With the suites found, the worker prompt `init` writes lists each suite with how to run it on part
  of the project, as the scout found it (`go test ./<package>/...`, `bun test <files>`), or whole
  where its tool can't: workers check their own change with those and leave the whole suite to the
  merge check.
- **Setup command**, where the project has a lockfile at its top: the command that installs the
  dependencies in a ticket's worktree before its check, when a rebase changes a dependency file
  (`npm ci`, `bun install --frozen-lockfile`, `uv sync`, …). See [The checks](#the-checks).
- **Ticket prefix**: Beads ticket IDs read `<prefix>-<hash>`. A new Beads takes it; an existing one
  has its tickets renamed to it (`bd rename-prefix`), after asking, and not while tickets have work
  under way.
- **Add a verification step for workers?** See [The verifier](#the-verifier).

### The flags

| Flag | Answers |
|---|---|
| `--check-fast "<command>"` (`--check`) | the command `scripts/check-fast.sh` runs; `""` for a check that passes at once. Skips the scout |
| `--check-full "<command>"` | the slower suites' command, which `scripts/check-full.sh` runs after `check-fast.sh`; `""` for none |
| `--check-fast-timeout 30m` (`--check-timeout`) | how long the merge check may run on a ticket |
| `--check-full-timeout 60m` | how long the full check may run |
| `--setup "<command>"` | the setup command; `""` for none |
| `-c N`, `--concurrent N` | tickets at the same time, 1 to 16 |
| `--mcp a,b` | the MCP servers workers get, by name; `""` for none |
| `--changelog-union[=false]` | add `CHANGELOG.md merge=union` to `.gitattributes`, or not |
| `--install-beads[=false]` | install Beads where it is missing, or not |
| `--verifier[=false]` | write the verifier, or not |
| `--prefix <name>` | the ticket prefix: lowercase letters, digits and hyphens, starting with a letter |
| `--force` | replace `.tutti/worker-prompt.md` with the built-in template |
| `--update` | take the changes to tutti's templates into the worker prompt and the verifier, and nothing else; [Keeping them up to date](#keeping-the-worker-prompt-and-the-verifier-up-to-date) |

### Trusting the main checkout

Claude Code ignores a project's `permissions.allow` rules in a folder you haven't trusted (its
folder-trust dialog, never accepted there), and workers would ask, or leave to auto mode, what the
project allows. When the login check finds that, `init` explains it and asks
`Mark <checkout> trusted?`: yes sets `projects["<checkout>"].hasTrustDialogAccepted: true` in your
`~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`), changing that key alone, then checks again.
Declined, the other fix is to run `claude` once in the main checkout and accept the dialog.

### The login, in the summary

`init` ends with the login check a run does: the account, the billing and the permission mode
workers get, as the run's `START` block says them, or what is missing. Then it checks the project's
[requires list](#the-requires-list) as a run's start does, installing what it can: a line for each
entry, `✗` with what to do for one still missing.

### From orchestra

In a project with `.orchestra/` and no `.tutti/`, `init` first offers to import orchestra's settings
and worker prompt. It imports the checks and their time limits, the setup command and its files,
`concurrent`, `keep_awake`, `ticket_limit`, `mcp_servers`, the worker and organ effort, `exclude_types`,
`footprint`, `resolve_conflicts`, `resolve_timeout`, `check_hand_backs`, `merge_train`,
`environment_hold` and the `requires` list, and
names what it can't import (`terminal`: tutti has no terminals). The worker prompt is copied with your
changes, and the summary lists, line by line, what it still needs for tutti: `.tutti/` for
`.orchestra/`, `tutti/` branches for `wt/`, no tabs, and the like. `.orchestra/` is left as it is.

orchestra gives workers every MCP server Claude Code finds when `mcp_servers` isn't set; tutti gives
them none, and the summary says so.

## The checks

`tutti` runs two checks, both ordinary shell scripts that `init` writes and the project owns:

- **`scripts/check-fast.sh`**, the merge check: run on each finished ticket before it merges,
  rebased onto what merged meanwhile, or on top of the base already. Keep it to what runs in a few minutes, as every merge waits for it.
- **`scripts/check-full.sh`**: `scripts/check-fast.sh`, then the suites too slow or too demanding for
  every merge. tutti runs it once, after a run that ended by itself and merged something (see
  [The full check](running.md#the-full-check)).

Each is one command per suite, run from the repository's root:

```sh
#!/bin/sh
# scripts/check-fast.sh: tutti's merge check, run on every ticket before it merges.
set -e
cd "$(dirname "$0")/.."

# unit, from package.json:12
printf '%s\n' 'SUITE: unit'
(
bun test
)
```

- **`SUITE: <name>`** is printed as each suite starts. When the full check fails, the last such line
  names the suite that failed, and the ticket tutti files is about it.
- **`FLAKY: <test>`**, printed by a suite that reran a failed test and passed when the rerun did,
  lets the ticket merge with a warning naming it.
- **`lock <name>` and `unlock`**, around a suite, have it take turns with the same suite in other
  worktrees, for a suite that can't run twice at once (a fixed port, a shared database).

To add a suite, add its lines to the runner. The runners orchestra wrote work as they are.

**Time limits.** The merge check is stopped after 30 minutes, `"checks": { "fast": { "timeout" } }`,
and the ticket set aside; the full check after 60, `"checks": { "full": { "timeout" } }`.
`--check-timeout` and `--check-full-timeout` change them for a run. Set them to a few times the
check's usual running time.

**The setup command.** With `"checks": { "setup": { "command": "npm ci" } }`, tutti runs it in each
new worktree before its worker starts there, within the merge check's time limit, so workers start
with the dependencies installed, and their first message says how they were installed:
`<id>: running 'npm ci' in its new worktree before its worker starts`. It runs again in a worktree an
earlier attempt left when the last setup there failed or didn't finish (a quit cut it short), and
when the branch has changed a file `"files"` names since it was last set up in the run.

A setup that fails there isn't the ticket's fault: no worker starts (`SETUP_FAILED: 'npm ci' fails in
<worktree> for <id>; the whole output is in <worktree>/.tutti/run/setup.log`), and the ticket goes back
in the queue, open, its worktree kept, until a ticket merges, which may bring what the setup needs, or
a probe ends a hold for the environment. Setups failing ticket after ticket hold the run for the
environment, as workers failing at once do. A run that ends with tickets still waiting on their setup
names them: `SETUP_WAITS: <id> waits on the setup that failed in its worktree (the whole output is in
…); fix the setup, then run again`.

A finished ticket's worktree has the dependencies set up for its code as it closed the ticket. When a
ticket that bumps one merges meanwhile, the rebase brings in the new lockfile, and the check would run
against the old dependencies, so tutti runs the setup before the check whenever the rebase changes a
file `"files"` names (lockfiles and manifests by default). A conflict handed back to its worker after
such a rebase tells it to run the setup once the rebase has finished, before the check. The setup
runs always before the full check, which runs in a fresh worktree. A merge that changes
`checks.setup` in `.tutti/settings.json` has the run use the new one from then on (`SETUP: <id>'s
merge changed .tutti/settings.json on main: the setup is 'npm ci' from now on`).

### A worker's own check

A worker doesn't run the whole merge check before it closes its ticket: tutti runs that on every
ticket before it merges it, and hands the ticket back when it fails. The worker prompt has a worker
check its own change instead: the suites on what it touches, the slower ones where they cover it,
and lint and type checks on the files it changed. A project with a script for that, such as
`scripts/check-own.sh`, names it in `"checks": { "own": { "command" } }`: the note on running a
check once (see [The worker prompt](workers.md#the-worker-prompt)) then gives it as the check to
run, in place of the merge check. tutti never runs it itself, and its files, as the other checks',
count as no ticket's in footprints.

## The requires list

What the project needs of the machine (a tool, a service running, a permission) is its requires list,
`"requires"` in `.tutti/settings.json`, as orchestra's is. Each entry has a `name` (letters, digits and
`. _ + -`), a `check` (a shell command, run in the main checkout, that exits 0 when it is met, such as
`command -v jq`), and either an `install` (a command that meets it, such as `brew install jq`) or a
`manual` step for a person (`start Docker Desktop`); `platforms`, `darwin` or `linux`, limits it to
those systems. An install runs without a terminal, so one that runs `sudo` (or `su`, `doas`,
`pkexec`) is refused as the settings load: give it as a manual step instead.

Each run checks the list as it starts, before its first ticket and before any worker it carries
over: every check, side by side, each within a minute; for one that fails, its install, one at a
time within the merge check's time limit, its whole output in `.tutti/run/requires-<name>.log`, then
the check again. It says what it did under the `START` block (`REQUIRES: jq met`), and for what is
still missing it stops at once with one line, exit 2, rather than leave every ticket to fail on it:

```
REQUIREMENTS_MISSING: docker (start Docker Desktop); meet it (each entry of 'requires' in .tutti/settings.json says how), then run again
```

A ticket that changes the list (the environment ticket a spec's breakdown files first, say) has
the run take the new list once it merges and check it again before the next ticket starts, in the
same way: what is still missing stops the run, the tickets running then finishing first, and the
workers started from then on are told the list as it is now.

`tutti init` checks the list too, installing what it can, a line of its summary for each entry.
`tutti requires` checks it at any time and prints each entry's state (`jq: met`, `docker: missing:
start Docker Desktop`), exit 2 for one missing; `--no-install` only checks.

Workers are told of the list, with the entries it has: a ticket that needs something the list lacks
adds an entry for it and installs it with that entry's own install, never by hand outside the list,
so the next machine has it too; a manual step is asked of you as a question.

**The README's section.** People read the README to set a machine up; written apart from the list, it
drifts. So the README's section on what to install is generated from the list, between
`<!-- tutti:requires -->` and `<!-- /tutti:requires -->`: `tutti requires --markdown` prints it,
`tutti requires --readme` writes it into `README.md`, replacing the section or adding one at its end.
`tutti init` writes it into a README that has none (where the list has entries) and keeps it up to
date; a run's start warns `README_STALE` under its `START` line when it differs from the list; and a
worker that changes the list is told to write it again in the same commit.

## The verifier

The verifier is a subagent, `.claude/agents/verifier.md`, that checks a ticket's change against the
ticket in a fresh context: it reads the ticket and the commits naming it, quotes the worker's own
passing check when the worker's commit is HEAD and nothing is uncommitted (else it runs the suites on
what the change touches, leaving the whole suite to the merge check), checks each acceptance
criterion, and answers `PASS` or `FAIL` with each gap it found. It changes nothing.

`init` writes it when you choose it (or `--verifier`), filled in with the project's stack and checks,
and adds a `## Verify` section to the worker prompt: before closing its ticket, a worker runs it,
fixes the gaps it reports, and asks again with the earlier rounds' findings, three rounds at most;
where a round disagrees with an earlier one (`DISAGREES WITH ROUND <n>:`), the worker asks you which
holds rather than go round again. Each ticket then costs a
subagent's run too. tutti runs the verifier in the foreground, whatever the worker asks for, so the
worker's turn waits for its answer.

## Keeping the worker prompt and the verifier up to date

`init` writes `.tutti/worker-prompt.md` and `.claude/agents/verifier.md` from tutti's templates, and
from then on they are the project's: `init` keeps them as they are. So that a project still hears of
what tutti changes in its templates later, `.tutti/settings.json` records the version of each
template its files came from (`"templates"`), as `init` writes them; a project set up before, or a
prompt imported from orchestra, has its files read for each change's words instead.

A run says under its `START` line when either file is older than tutti's template, naming the
sections changed since and what changed in them:

```
  templates: .tutti/worker-prompt.md is older than tutti's worker prompt template, which has since changed the opening (a worker checks its own change and leaves the whole suite to the merge check) and Close (a ticket closes once the worker's own checks pass): tutti init --update rewrites those sections from the template, keeping the rest of the file, and shows the diff to commit
```

`init` says it too of the files it keeps. `tutti init --update` takes the changes: it rewrites only
those sections from the templates, keeping the rest of each file, your own sections included (the
worker prompt's lines on how to run each suite on part of the project among them), records the
templates' versions in `.tutti/settings.json`, prints the diff, and leaves the commit to you. A
section it rewrote loses your edits in it: read the diff, and carry over what you want to keep.

## The settings

`.tutti/settings.json` holds the project's settings, committed and shared. Every key has a default,
so a key or a section can be left out; an unknown key, or a value of the wrong kind, stops a run, all
problems listed at once. Times are strings: `"30m"`, `"2h"`, `"1h30m"`, `"90s"`. Here is every key,
for a project that sets them all; the table below gives each one's default:

```json
{
  "$schema": "https://raw.githubusercontent.com/noesis-sol/tutti/main/schema/settings.json",
  "version": 1,
  "concurrent": 1,
  "keep_awake": false,
  "checks": {
    "fast": { "command": "scripts/check-fast.sh", "timeout": "30m" },
    "full": { "command": "scripts/check-full.sh", "timeout": "60m" },
    "own": { "command": null },
    "setup": { "command": "bun install --frozen-lockfile", "files": ["bun.lock", "package.json"] }
  },
  "requires": [
    { "name": "jq", "check": "command -v jq", "install": "brew install jq", "platforms": ["darwin"] },
    { "name": "docker", "check": "docker info", "manual": "start Docker Desktop" }
  ],
  "workers": {
    "mcp_servers": ["postgres"],
    "permission_mode": "auto",
    "effort": "high",
    "model": null,
    "ticket_limit": "2h",
    "ask_user_question": true
  },
  "templates": { "worker_prompt": 6, "verifier": 2 },
  "organs": { "effort": null, "model": null, "triage": true, "review": true },
  "queue": { "exclude_types": ["epic"], "footprint": true },
  "merge": {
    "resolve_conflicts": true,
    "resolve_timeout": "20m",
    "check_hand_backs": 2,
    "train": 1
  },
  "environment_hold": { "count": 2, "window": "2m", "probe": "10m" },
  "ui": { "colour_scheme": "orchestra" }
}
```

| Key | Default | |
|---|---|---|
| `$schema` | | the published [JSON Schema](../schema/settings.json), so editors complete and check the file |
| `version` | `1` | the format |
| `concurrent` | `1` | tickets at the same time, 1 to 16; `-c` for a run |
| `keep_awake` | `false` | keep the machine from sleeping while a run goes, its report included: `caffeinate` on macOS, `systemd-inhibit` on Linux; the `START` block warns where there is none |
| `checks.fast.command` | none | the merge check; [The checks](#the-checks) |
| `checks.fast.timeout` | `"30m"` | its time limit; `--check-timeout` for a run |
| `checks.full.command` | none | the full check |
| `checks.full.timeout` | `"60m"` | its time limit; `--check-full-timeout` for a run |
| `checks.own.command` | none | a worker's check of its own change; [A worker's own check](#a-workers-own-check) |
| `checks.setup.command` | none | installs the dependencies in a worktree |
| `checks.setup.files` | lockfiles and manifests | the files (globs) whose change has the setup run |
| `requires` | `[]` | what the project's machine must have, checked as each run starts; [The requires list](#the-requires-list) |
| `workers.mcp_servers` | `[]` | the MCP servers workers get, by name: none by default; [MCP servers](workers.md#mcp-servers) |
| `workers.permission_mode` | `"auto"` | `auto`, `default` or `acceptEdits`; [Permissions](workers.md#permissions) |
| `workers.effort` | `"high"` | `low`, `medium`, `high`, `xhigh` or `max`, or `null` for Claude Code's; `--worker-effort` for a run; the feature interview's too |
| `workers.model` | Claude Code's | `--worker-model` for a run |
| `workers.ticket_limit` | none | how long a worker may go on after dispatch before the run holds; `--ticket-limit` for a run |
| `workers.ask_user_question` | `true` | whether workers may ask you quick questions; [Attention requests](workers.md#attention-requests) |
| `templates.worker_prompt`, `templates.verifier` | `0` | the versions of tutti's templates the worker prompt and the verifier came from, which `init` records; [Keeping them up to date](#keeping-the-worker-prompt-and-the-verifier-up-to-date) |
| `organs.effort`, `organs.model` | each organ's | every organ's effort and model; [Organs](organs.md) |
| `organs.triage` | `true` | the triage organ; `--triage` for a run |
| `organs.review` | `true` | the run report; `--review` for a run |
| `queue.exclude_types` | `["epic"]` | issue types a run never takes; epics never run whatever it says |
| `queue.footprint` | `true` | keep tickets that touch the same code apart; [Footprints](running.md#footprints) |
| `merge.resolve_conflicts` | `true` | hand a rebase's conflicts back to the ticket's worker; `--resolve-conflicts` for a run |
| `merge.resolve_timeout` | `"20m"` | how long the worker has for a hand-back |
| `merge.check_hand_backs` | `2` | how often a check failing on the rebased branch is handed back; `0` for never |
| `merge.train` | `1` | how many tickets waiting to merge are checked ahead of their turn; `0` for none; [The merge queue](running.md#the-merge-queue) |
| `environment_hold.count` | `2` | tickets in a row failing at once that hold the run; `0` turns the hold off |
| `environment_hold.window` | `"2m"` | how soon after dispatch a failure counts as at once |
| `environment_hold.probe` | `"10m"` | how long after the hold the machine is probed; `"0"` for no probe |
| `ui.colour_scheme` | `"orchestra"` | the project's colour scheme; yours wins over it; [Colour schemes](colour-schemes.md) |

A run's flags override the settings for that run; [Running](running.md#options) lists them.

## The user config

`$XDG_CONFIG_HOME/tutti/config.json` (`~/.config/tutti/config.json` by default) holds your own
preferences, for every project. A missing file gives the defaults; an unknown key, or a value of the
wrong kind, stops a run.

```json
{
  "mouse": true,
  "notify": true,
  "billing": "subscription",
  "appearance": "auto",
  "colour_scheme": null
}
```

| Key | Default | |
|---|---|---|
| `mouse` | `true` | `false` leaves the mouse to the terminal; `--no-mouse` for a run |
| `notify` | `true` | desktop notifications; `--notify` for a run |
| `billing` | `"subscription"` | `"api"` keeps `ANTHROPIC_API_KEY` beside a subscription login; `--billing` for a run |
| `appearance` | `"auto"` | `"light"` or `"dark"` fixes the colour scheme's variant; `TUTTI_APPEARANCE` |
| `colour_scheme` | none | your colour scheme, over the project's; `--colour-scheme` for a run |

Your own colour schemes go in `colour-schemes/` beside it (see [Colour schemes](colour-schemes.md)).
