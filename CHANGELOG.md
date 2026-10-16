# Changelog

## Unreleased

- The project scaffold: Bun, Effect and OpenTUI, with `scripts/check.sh` (tsc, Biome, the tests and shellcheck) and `bun src/main.ts` printing the version.
- `test/test-script.test.ts` runs `scripts/test.sh` on flaky and broken fixtures; `docs/spikes/08-bun-test-retry.md` reports why the script reruns failed tests by name rather than reading `--retry`.
- `src/services/exec.ts` runs every external command in a process group of its own, with a time limit that kills the whole group (`CommandTimedOut`), interruption that does too, bounded output with an optional output file, and `CommandFailed { command, exitCode, stderr }`; `TimeLimit.read` (30 s) and `TimeLimit.write` (2 min) are orchestra's presets.
- `src/ui/sanitize.ts` makes untrusted text safe to show (§ 7.10): `sanitize` and `sanitizeLine` drop control characters, whole ESC sequences and bidi controls, and `escapeMarkdown` escapes text for Markdown; `test/sanitize.test.ts` proves it with fast-check.
