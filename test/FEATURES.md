# tutti's features and their tests

The map the test tickets work from (epic tutti-8iz): each area a user touches, the test files that
cover it, and what has no test yet. Each untested area has a P3 ticket under tutti-8iz, named in
its section.

## The suites

| Suite | Runner | Command | Where it is defined |
|---|---|---|---|
| tsc | both | `bunx tsc --noEmit` | `scripts/check.sh` |
| biome | both | `bunx biome check .` | `scripts/check.sh`, `biome.json` |
| test (unit, UI and whole-run scenarios) | `scripts/check-fast.sh` | `scripts/test.sh` | `scripts/test.ts`; `bun:test`, files `test/**/*.test.ts(x)` |
| test, slow (real git, real builds) | `scripts/check-full.sh` | `TUTTI_SLOW=1 scripts/test.sh` | `slow.test` / `slow.describe` from `test/gates.ts` |
| shellcheck | both | the pinned shellcheck on `git ls-files '*.sh' bin/tutti` | `scripts/check.sh`, `scripts/fetch-shellcheck.sh` |
| contract (the real Agent SDK) | neither | `TUTTI_LIVE=1 scripts/test.sh test/contract/` | `live.test` / `live.describe`; run on every SDK bump (spec § 13) |

`scripts/check-fast.sh` runs `scripts/check.sh`; `scripts/check-full.sh` runs it with
`TUTTI_SLOW=1`, so the slow tests too. CI (`.github/workflows/ci.yml`) runs `scripts/check-full.sh`
on Linux and macOS, and builds the host binary with `scripts/build.sh` and checks its `--version`.

How long each takes, at 368899e (2026-10-22, `ORCHESTRA_CORES=2`, other workers' checks running
beside it):

- `scripts/check-fast.sh`: 117 s, exit 0; 3452 tests in 276 files, 3360 pass, 92 skipped (slow and
  live). tutti-8iz.1 measured 146 s, 155 s and 151 s at de6dd56.
- `scripts/check-full.sh`: 260 s, exit 0; 3426 pass, 26 skipped (the live contract tests).
- `TUTTI_SLOW=1 scripts/test.sh --coverage`: 206 s; 95.0 % of functions, 96.9 % of lines in the
  files the tests load. Bun's coverage counts only code run in the test processes, not in the
  processes they start (`bun src/main.ts`, scripts), so `src/main.ts`, `src/npm.ts`,
  `src/entries/` and `src/native/detectMusl.ts` show as never loaded.

Most of the code is covered at the unit and scenario level (the test layers in `src/testing/`
under `test/harness.ts`). What isn't falls into three kinds: the command line run end to end
through `bun src/main.ts`, the live layers that talk to the machine (a terminal, `ps`, the
notifier, the SDK's probe), and failure branches where git or bd fails part-way. The line numbers
below are the coverage report's uncovered lines at 368899e.

## The command line: `--version`, `--help`, flags and variables

- **Reached by**: `tutti --version`, `tutti <command> --help`, the run flags of spec § 8.2 and their
  `TUTTI_*` variables, the user config.
- **Tests**: `smoke.test.ts` (e2e: `bun src/main.ts --version`; a bare `tutti` outside a git
  repository exits 2), `tutti-skill.test.ts` (e2e: each command's `--help` lists the flags the
  skill names), `version.test.ts`, `app-config.test.ts`, `settings.test.ts`, `schemas.test.ts`,
  `airtight-env.test.ts`, `session-env.test.ts` (unit).
- **Untested**: nothing found.

## `tutti init`

- **Reached by**: `tutti init [flags]`, in a terminal (the renderer's form), with `TERM=dumb` (line
  forms) or without a terminal (flags only); `tutti init --update`.
- **Tests**: `init.test.ts`, `init-checks.test.ts`, `init-beads-install.test.ts`,
  `init-workers-steps.test.ts`, `init-chrome-offer.test.ts`, `init-skill-copy.test.ts`,
  `init-stop.test.ts` (unit, and e2e slow: SIGINT while it writes), `import.test.ts`,
  `checks-runners.test.ts`, `checks-typescript.test.ts`, `template-versions.test.ts`,
  `scout.test.ts`, `line-forms.test.ts`, `ui-init-form.test.tsx`, `ui-init-stop.test.tsx`,
  `form-hint.test.tsx`, `run-lock-init-refusal.test.ts`, `init-form-questions.test.ts`,
  `init-command.test.ts` (e2e slow: `bun src/main.ts init` without a terminal, its refusals,
  `--update`, a whole init's summary and `liveMachine` running a fake bd).
- **Untested**: `runInit`'s terminal branches (`src/cli/commands.ts`), which need stdin and stdout a
  terminal: opening the renderer's form or the line forms under `TERM=dumb`, the scout, and the
  summary in the theme's styles, are tested only below the command, not through `bun src/main.ts`.

## `tutti answer`

- **Reached by**: `tutti answer` (lists the open attention requests), `tutti answer --json`,
  `tutti answer <request-id> allow|allow-run|deny [--reason] [--choice] [--confirm]`.
- **Tests**: `attention-files.test.ts` (the request and answer files, `answer`, `show`),
  `attention-poll.test.ts`, `run-answers.test.ts`, `tutti-skill.test.ts` (the `--json` fields),
  `cli-commands.test.ts` (slow: the command through `bun src/main.ts`, its listing, `--json`, an
  answer the run takes or refuses, and each error as the command prints it).
- **Untested**: nothing found.

## `tutti plan`

- **Reached by**: `tutti plan`, `tutti plan --apply`.
- **Tests**: `plan-command.test.ts`, `plan-lock-warning.test.ts`, `plan-stop.test.ts`,
  `footprint.test.ts`, `footprint-globs.test.ts`, `footprint-leave-out.test.ts`,
  `cli-commands.test.ts` (slow: the command through `bun src/main.ts` with a fake bd, the
  proposal, `--apply`, and settings or bd that can't be read).
- **Untested**: nothing found.

## `tutti login`

- **Reached by**: `tutti login [--claude <path>]`.
- **Tests**: `login.test.ts`, `account.test.ts` (unit; a live test of the probe),
  `probe-options.test.ts`, `probe-settings-contract.test.ts` (live).
- **Untested**: `runInTerminal`, which runs `claude auth login` on the terminal
  (`src/cli/login.ts` 89–103), the embedded Claude Code's lookup (54–63), and the command's
  failure lines (`src/cli/commands.ts` 221–235) (tutti-8iz.7).

## `tutti colours`

- **Reached by**: `tutti colours [<name>]`; `--colour-scheme`, the scheme files.
- **Tests**: `colours-command.test.ts`, `theme.test.ts`, `theme-appearance.test.ts` (unit:
  `queryAppearance` on fake TTY streams under TestClock, and a scheme file that can't be read),
  `ui-roles.test.tsx`, `start-scheme-notices.test.ts`, `plain-report-unstyled.test.ts`,
  `tty.test.ts`.
- **Untested**: nothing found.

## `tutti requires`

- **Reached by**: `tutti requires [--no-install] [--markdown|--readme]`; a run's start.
- **Tests**: `requires.test.ts`, `requires-run.test.ts`, `requires-recheck.test.ts`,
  `requires-worktree.test.ts`, `cli-commands.test.ts` (slow: the command through
  `bun src/main.ts`, its exit codes, and outside a repository).
- **Untested**: nothing found.

## `tutti update` and the daily release check

- **Reached by**: `tutti update [--check] [--force]`; the notice a run ends with when a newer
  release is out.
- **Tests**: `update.test.ts` (with fake releases and keys), `sign-checksums.test.ts`,
  `release-notes.test.ts`, `release-run.test.ts`, `release-workflow.test.ts`.
- **Untested** (`src/update/update.ts`): a download over its size limit (`readLimited`, 201–202;
  268, 278), the latest release's JSON unreadable or its tag not a version (248–251), an archive
  with no `tutti` in it (391–394), the cache that can't be written (`writeCache`, 687), and the
  background check a run starts (`startCheck`, 725–736); the command's action
  (`src/cli/commands.ts` 355–364) (tutti-8iz.9).

## A run's start: startup checks, the lock, the start question

- **Reached by**: a bare `tutti` (and `--ticket`, `--feature`, `--yes`, `--plain`).
- **Tests**: `startup.test.ts`, `startup-ticket-scope.test.ts`, `run-lock.test.ts`,
  `untrusted-checkout.test.ts`, `start.test.ts`, `run-start-question.test.ts`,
  `run-start-ending.test.ts`, `start-question.test.tsx`, `start-deferred-free.test.ts`,
  `shared-machine.test.ts`, `shared-runs-title.test.ts`, `smoke.test.ts` (e2e: outside a repository),
  `run-binary.test.ts` (e2e slow: `bun src/main.ts` inside a repository with a fake bd and Claude
  Code, refused with exit 2 for no `.tutti/`, a dirty main checkout, a detached HEAD, and while
  another run holds the lock), `startup-git-failures.test.ts` (git not found, its worktrees, branch
  or status unreadable or too slow).
- **Untested**: nothing found.

## The run loop: scheduling, footprints, holds

- **Reached by**: a run (`-c`, `--limit`, `--machine-workers`, `--ticket-limit`); the dashboard's
  tickets table and title line.
- **Tests**: `run.test.ts`, `harness.test.ts`, `scenarios-scheduling.test.ts`,
  `scenarios-sessions.test.ts`, `schedule.test.ts`, `schedule-overlap-ended.test.ts`,
  `schedule-waiting-window.test.ts`, `phase.test.ts`, `held-back.test.ts`, `unready.test.ts`,
  `live-status.test.ts`, `no-ticket-limit.test.ts`, `machine-workers.test.ts`,
  `machine-workers-default.test.ts`, `machine-core-share.test.ts`, `core-share.test.ts`,
  `holds-time.test.ts`, `run-footprints.test.ts`, `run-footprints-worktree.test.ts`,
  `dispatch-footprint-line.test.ts`, `carry-footprint-line.test.ts`, `scope-open-followup.test.ts`,
  `run-predictor.test.ts`, `state-records.test.ts`, `store.test.ts`, `run-finish.test.ts`,
  `end-of-run.test.ts`, `epic-close.test.ts`, `epic-close-failures.test.ts`, `asked.test.ts`,
  `run-end.test.ts`.
- **Untested**: bd failing part-way through a run: the deferred tickets whose blockers merged
  can't be listed (`src/run/deferredFree.ts` 183–245), a scope's subtickets can't be read
  (`src/run/scope.ts` 234–278), and the environment hold's reopen refused by bd
  (`src/run/environment.ts` 252). The test `Beads` layer can't be made to fail a call, as the
  test `Git` layer can (`fail(op)`) (tutti-8iz.11).

## The environment probe and its hold

- **Reached by**: tickets failing at once like the ones before them (HOLD: ENVIRONMENT).
- **Tests**: `environment.test.ts`, `environment-second-hold.test.ts`,
  `waits-for-merge-uncounted.test.ts`, `fix-setup.test.ts`.
- **Untested**: the probe's worker ending without running its command, as Idle, Closed, Failed or
  Gone (`src/run/environment.ts` 328–336, 375) (tutti-8iz.11).

## Workers: sessions, state, steering, attention, MCP, transcripts, usage limits

- **Reached by**: every ticket a run starts; the worker view; permission requests and questions;
  Ctrl+C and the next run's carry-over.
- **Tests**: `worker-state.test.ts`, `worker-states.test.ts`, `worker-options.test.ts`,
  `default-effort.test.ts`, `sessions.test.ts`, `agent-host-live.test.ts` (the live host against
  `test/fixtures/fake-claude`), `agent-host-scripted.test.ts`, `folded-sends.test.ts`,
  `queued-cancel.test.ts`, `sent-messages.test.tsx`, `hook-before-init.test.ts`,
  `compactions.test.ts`, `task-report.test.ts`, `bash-timeouts.test.ts`, `spawn-failure.test.ts`,
  `steer.test.ts`, `carry.test.ts`, `attention*.test.ts`, `permission-denied.test.ts`,
  `mcp.test.ts`, `chrome.test.ts`, `unused-tools.test.ts`, `transcripts.test.ts`,
  `usage-limit*.test.ts`, `verifier-foreground.test.ts`, `verifier-rounds.test.ts`,
  `prompt*.test.ts`, `own-check.test.ts`, `worktree-setup.test.ts`, `worktrees.test.ts`,
  `worker-reaper.test.ts`, `process-tree.test.ts`, `account.test.ts`, `organ-billing.test.ts`,
  `contract/*.test.ts` (live).
- **Untested**: the live login probe without the real SDK, `startProbe` in
  `src/agent/Account.ts` (365–423): its answer read from a Claude Code, no answer within
  `probeTimeout`, and a Claude Code that won't exit once closed, whose process group is killed
  after `probeCloseLimit` (336, 350–355). Only the live contract test runs it (tutti-8iz.12).

## Merging: the merge queue, the merge train, checks, hand-backs

- **Reached by**: a ticket's worker closing it: the merge check, the rebase, the fast-forward,
  conflicts handed back, failed checks handed back, the train that checks tickets ahead of their
  turn.
- **Tests**: `merge-queue.test.ts`, `merge-queue-writes.test.ts`, `merge-train.test.ts`,
  `merge-train-dashboard.test.ts`, `train-killed-run.test.ts`, `merge-on-top.test.ts`,
  `merge-unchanged.test.ts`, `merge-git-retry.test.ts`, `merging-slots.test.ts`,
  `scenarios-merge.test.ts`, `settle*.test.ts`, `setup.test.ts`, `resolution-setup.test.ts`,
  `checks.test.ts`, `check-note.test.ts`, `check-hand-back-hold.test.ts`,
  `check-log-guard.test.ts`, `checkback*.test.ts`, `recheck*.test.ts`, `handback*.test.ts`,
  `unmerged*.test.ts`, `closed-unmerged*.test.ts`, `unchecked-rebase.test.ts`,
  `hand-merged.test.ts`, `hand-merged-run.test.ts`, `cleanup-failed.test.ts`, `aside*.test.ts`,
  `flaky.test.ts`, `report-evidence.test.ts`, `merge-train-git-failures.test.ts`.
- **Untested**: nothing found.

## The full check

- **Reached by**: the end of a run (`checks.full.command`), its ticket filed when it fails.
- **Tests**: `fullcheck.test.ts`, `fullcheck-end.test.ts`, `fullcheck-failures.test.ts`,
  `scenarios-merge.test.ts`.
- **Untested**: nothing found.

## Organs: triage, predictor, scout, reviewer, plan, screen

- **Reached by**: `--triage`, `--review`, `--organ-model`, `--organ-effort`,
  `TUTTI_ORGAN_PROVIDER=anthropic`; the scout in `tutti init`.
- **Tests**: `organs.test.ts`, `triage.test.ts`, `predict.test.ts`, `scout.test.ts`,
  `agent-sdk-language-model.test.ts`, `anthropic-provider.test.ts`, `organ-cost-*.test.ts`,
  `organ-usage-limit.test.ts`, `organ-billing.test.ts`.
- **Untested**: the Messages API provider's language model as the organs call it
  (`src/organs/AnthropicProvider.ts` 144–165) (tutti-8iz.16).

## The dashboard and the worker view

- **Reached by**: a run in a terminal that draws one: the tickets table, cards, the worker view,
  the composer, forms, the end-of-run box, keys and mouse.
- **Tests**: `ui-*.test.tsx`, `dashboard-beside-current.test.tsx`, `load-line.test.tsx`,
  `permission-input.test.tsx`, `wind-down-line.test.tsx`, `open-url.test.tsx`,
  `start-question.test.tsx`, `render.test.tsx`, `run-view.test.ts`, `run-commands.test.ts`,
  `commands-after-end.test.ts`, `ui-mode-2027.test.ts`, `sanitize.test.ts`,
  `escape-markdown-links.test.ts`, `harness-terminal.test.ts`.
- **Untested**: nothing found.

## The feature interview

- **Reached by**: `tutti --feature "<request>"`, or New feature at the start question.
- **Tests**: `interview.test.ts`, `feature.test.ts`, `feature-renderer.test.ts`,
  `ui-interview.test.tsx`, `ui-interview-narrow.test.tsx`, `ui-interview-keys.test.tsx` (the
  view's keys and mouse: PgUp/PgDn and loading older items, ↑↓, Tab and the arrows in a request's
  card, Enter, the number keys, g and G, a click on an entry).
- **Untested**: nothing found.

## Plain output, the log, the report, notifications

- **Reached by**: `--plain`, a terminal that can't draw the dashboard, `.tutti/run/log`, the
  report at the end of a run, `--notify`, the event stream.
- **Tests**: `run.test.ts`, `print.test.ts`, `log.test.ts`, `report.test.ts`,
  `report-tallies.test.ts`, `report-out-lazy.test.ts`, `plain-report-unstyled.test.ts`,
  `notices.test.ts`, `notifier.test.ts`, `run-notifications.test.ts`, `eventstream.test.ts`,
  `happening-order.test.ts`, `nothing.test.ts`, `live-layers.test.ts` (unit: the live notifier,
  load, clipboard and URL opener against fake commands on the test's PATH, and a fake `/proc`).
- **Untested**: nothing found.

## Quitting, signals and processes

- **Reached by**: Ctrl+C, SIGTERM, SIGHUP, SIGUSR1/2, SIGTSTP; a `kill -9` of tutti.
- **Tests**: `quit.test.ts`, `suspend-ignored.test.ts`, `usage-limit-quit.test.ts`,
  `exec.test.ts`, `exec-lost-exit.test.ts`, `exec-reaper.test.ts`, `output-cap.test.ts`,
  `keep-awake.test.ts`, `load.test.ts`, `libc.test.ts`, `run-binary.test.ts` (e2e slow: SIGINT
  during the startup checks, exit 130).
- **Untested**: `runMain` in `src/run/quit.ts` routing the signals to a run in `src/main.ts`:
  no test sends a signal to `bun src/main.ts` during a run, only before it starts (tutti-8iz.20).

## Distribution: builds, the install script, npm, releases

- **Reached by**: `scripts/build.sh`, `scripts/install.sh`, the npm package (`bin/tutti`,
  `src/npm.ts`), the release workflow.
- **Tests**: `build-script.test.ts` (slow: it builds the host binary once, runs its `--version`,
  and starts it in a git repository with no login and CLAUDE_CODE_TMPDIR set, whose startup checks
  extract the embedded Claude Code there, reuse the copy on a second start, and remove another
  version's stale copy), `install-script.test.ts`, `install-script-cpu.test.ts`,
  `npm-package.test.ts` (slow), `npm-musl.test.ts` (slow), `npm-license.test.ts`,
  `react-build.test.ts` (slow), `claude-binary.test.ts`, `claude-extract.test.ts`,
  `release-*.test.ts`, `sign-checksums.test.ts`.
- **Untested**: which path a compiled build's second start reuses its copy by: `extract`'s own
  lookup by the manifest's checksum (`src/agent/claudeBinary.ts`) or `extractFromBunfs`, which
  also reuses a copy already there, only slower; from outside the two look the same.
  `claude-extract.test.ts` covers the lookup in-process.

## The project's own scripts and docs

- **Reached by**: `scripts/check*.sh`, `scripts/test.sh`, `scripts/check-own.sh`,
  `scripts/fetch-shellcheck.sh`, `docs/`, `skills/tutti`.
- **Tests**: `check-own.test.ts`, `check-verdict.test.ts`, `test-script.test.ts`,
  `test-tmpdir.test.ts`, `flaky.test.ts`, `gates.test.ts`, `fetch-shellcheck.test.ts`,
  `user-docs.test.ts`, `parity-doc.test.ts`, `parity-since.test.ts`, `skill-install-docs.test.ts`,
  `tutti-skill.test.ts`.
- **Untested**: nothing found.
