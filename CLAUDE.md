# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:1105d646 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


## Build & Test

tutti runs on Bun (>= 1.3.14). The spec is `.orchestra/specs/tutti-spec.md`.

```bash
bun install                 # dependencies, pinned exactly in package.json; bun.lock is committed
bun src/main.ts             # run tutti from the checkout
scripts/check.sh            # the project's check: tsc, biome, the tests, shellcheck
scripts/test.sh             # the tests only (bun test; arguments go to bun test)
scripts/test.sh test/<part>.test.ts   # one test file, while iterating (React's development build)
TUTTI_SLOW=1 scripts/check.sh  # also the slow suites (real git); scripts/check-full.sh does this
scripts/check-own.sh           # check.sh's steps on what the branch changed, and the tests it touches
TUTTI_LIVE=1 scripts/test.sh   # also the contract tests against the real Agent SDK
```

- `scripts/check-fast.sh` (orchestra's merge check) runs `scripts/check.sh`; `scripts/check-full.sh`
  runs it with `TUTTI_SLOW=1`.
- `scripts/check-own.sh` is `check_own` in `.orchestra/settings.json`, the check orchestra's workers
  run on their own change: tsc, biome and shellcheck on the files changed since main, and the tests
  that changed, import a changed module or name a changed file outside their imports
  (`scripts/check-own.ts`; an `import type` or `export type … from` doesn't count, as Bun erases it
  and tsc checks the types); a change to the project's setup runs `scripts/check.sh` whole.
  `TUTTI_SLOW=1` adds the slow tests, and does all the plain one does: when you want the slow
  suites, run `TUTTI_SLOW=1 scripts/check-own.sh` alone, not after the plain one.
- Run tests through `scripts/test.sh`, not a bare `bun test`: `bunfig.toml` defines `NODE_ENV` as
  `"production"` for React's production build (spec § 3.1), and `scripts/test.sh` defines `"test"`
  over it, which `@opentui/react/test-utils` needs.
- `scripts/test.sh` reruns each failed test once by name and prints `FLAKY: <file> <test>` for one
  that passes on its rerun; a flaky test doesn't fail the check.
- `scripts/test.sh` runs the test files in parallel (`bun test --parallel`), in as many worker
  processes as the run's share of the cores (`TUTTI_CORES`), or half the machine's cores; no more
  than the files named. Each file runs in a fresh global, so a test can't rely on another file's
  leftovers. `TUTTI_TEST_PARALLEL=1` runs them in one process. A test's time limit is 15 s where
  its file sets none, as the files running side by side load the machine.
- A run killed outright can leave `bun test --parallel`'s workers spinning, each in a process group
  of its own: `scripts/test.sh` kills, as it starts, the test workers of runs whose process has gone
  (their `TMPDIR` names the run's folder), and prints `scripts/test.sh: killed N test workers left
  by an earlier run (pid P)`.
- The contract tests against the real Agent SDK, `test/contract/sdk.test.ts`, run only with
  `TUTTI_LIVE=1` (`TUTTI_LIVE=1 scripts/test.sh test/contract/sdk.test.ts`), with the SDK's embedded
  Claude Code and this machine's Claude login. They spend a few cents of real model turns. Run them
  on every SDK bump (§ 13). Usage limits can't be reached on demand: `test/fixtures/usage-limit/`
  holds their messages.
- shellcheck is a pinned release fetched into `.cache/shellcheck/` (git-ignored) and checked against
  its sha256. Offline, the check says so and skips it.

## Architecture Overview

_Add a brief overview of your project architecture_

## Conventions & Patterns

- **Layout** follows the spec's Appendix B: `src/cli`, `src/project`, `src/services`, `src/agent`,
  `src/run`, `src/organs`, `src/ui`, `src/print`, `src/update`; `src/main.ts` is the entry point,
  run with `BunRuntime.runMain`.
- **Effect services.** Each service is a `Context.Service` with a live layer next to it and a test
  layer under `src/testing/`, one file per service. Tests and whole-run scenarios use the test layers.
- **Errors** are tagged errors defined with `Schema.TaggedError`, not thrown exceptions.
- **External commands** go through `effect/process` (`ChildProcess`), never `Bun.spawn` directly in
  `src/`.
- **Tests** are in `test/<part>.test.ts`, one file per part, with `bun:test`. Mark slow tests (real
  git) with `slow.test` / `slow.describe` from `test/gates.ts`, and contract tests against the real
  Agent SDK with `live.test` / `live.describe`.
- **Tests' environment.** `scripts/test.sh` gives the suites a PATH without claude, bd, brew, tmux,
  herdr or cmux, and none of the terminal's or a Claude Code session's variables. Tests read it
  through `test/env.ts` (`testEnv`, `which`, `machineWhich` for a real tool on purpose,
  `withVariable`); Biome fails `process.env` and `Bun.which` elsewhere in `test/` but the live
  tests in `test/contract/` and the fixtures.
- **Property tests** use `fast-check`, for every function that reads text a model, worker or ticket
  author wrote.
- **Style** is Biome's (`bunx biome check --write .`): no semicolons, double quotes, 100 columns.
  TypeScript is `strict` with `exactOptionalPropertyTypes`.
- **Changelog.** Add entries to `CHANGELOG.md` under Unreleased as new lines; don't reword or move
  others (`CHANGELOG.md merge=union`).

## Effect

Effect's guide and source for the installed version are in `node_modules/effect`: `AGENTS.md`
(its links are relative to that folder), `ai-docs/` and `src/`. `node_modules/@effect/platform-bun`
and `node_modules/@effect/ai-anthropic` have the same. Read them before using an Effect API this
code doesn't use yet, not the web or another copy of Effect, whose version may differ. Where the
guide and this project differ, the project wins: tests use `bun:test`, not `@effect/vitest`, and
code reads like the code around it.
