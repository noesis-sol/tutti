# Changelog

## Unreleased

- The project scaffold: Bun, Effect and OpenTUI, with `scripts/check.sh` (tsc, Biome, the tests and shellcheck) and `bun src/main.ts` printing the version.
- `test/test-script.test.ts` runs `scripts/test.sh` on flaky and broken fixtures; `docs/spikes/08-bun-test-retry.md` reports why the script reruns failed tests by name rather than reading `--retry`.
