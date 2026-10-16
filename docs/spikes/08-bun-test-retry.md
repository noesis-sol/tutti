# Spike 08: `bun test --retry` and `FLAKY:` detection

Ticket tutti-nrg.1.8, M0 spike (9) (spec § 14), for § 13 Flaky tests.

- **Question:** does Bun's JUnit report (`--reporter=junit --reporter-outfile`) say which tests
  passed only on a retry with `--retry=N`? If it does, `scripts/test.sh` turns those into `FLAKY:`
  lines; if not, it runs without `--retry`, reruns each failed test once by name (`-t`), and prints
  `FLAKY:` for those that pass.
- **Versions:** Bun 1.4.3 (c6da4a4d3), macOS arm64, 2026-10-17.
- **Probe:** one test file in a temp folder with three tests: `group > flips`, which fails on its
  first run and passes after (it checks for a marker file, then writes it), `steady`, which always
  passes, and `broken`, which always fails. Run with
  `bun test --retry=2 --reporter=junit --reporter-outfile=r.xml`, then again with a TTY (`script`),
  with `--dots`, and with a per-test `{ retry: 1 }` in place of `--retry`.

## Summary

| Item | Result |
|---|---|
| The JUnit report of a test that passed on its retry | **Says nothing of the retry.** `<testcase name="flips" … assertions="1" />`, the same as `steady`: no attempt count, no `<failure>`, `<rerunFailure>` or `<flakyFailure>`, no `<system-out>`, and the suite's `failures="0"` |
| The JUnit report of a test that failed every attempt | One `<testcase>` with one `<failure>`: the last attempt's. The attempt count isn't in it either |
| The console, piped or on a TTY | Prints the failed first attempt's error and source excerpt, but **with no test name**: no `(fail)` or `(pass)` line for `flips`. Only a test that fails every attempt gets a line, `(fail) broken (attempt 3)` (`✗ broken (attempt 3)` on a TTY). The summary counts `flips` as a pass |
| `--dots` | Only the counts |
| A per-test `{ retry: N }` | The same as `--retry`: the report shows a plain pass |
| `--rerun-each=N` | Not a retry: it runs every test N times and reports each run as its own `<testcase>` (6 cases for 3 tests and N = 2, `flips` failing in the first); a test that fails once fails the run |
| Running one test by name | `bun test ./<file> -t '^<describes> <test>$'` runs only that test. The name is the describe blocks and the test joined by spaces, as `parseJUnit` builds it, with the regex characters escaped |
| A test file not named `*.test.ts` | Not found by `bun test`'s discovery, but run when given as a path (`./test/fixtures/flaky/flaky.fixture.ts`) |

## Decision

**The fallback.** Bun 1.4.3 has no way to say which tests passed only on a retry: not the JUnit
report, not the console, not the dots reporter. So `scripts/test.sh` (through `scripts/test.ts`,
which the scaffold, tutti-nrg.11, wrote from this finding) runs the suites once without `--retry`,
with the JUnit reporter, and reads the failed tests from the report. It reruns each failed test once
by name (`./<file> --test-name-pattern '^<name>$'`), and prints `FLAKY: <file> <test>` for each that
passes on its rerun. A flaky test doesn't fail the script; a test that fails twice does.

The script also fails, as `bun test` did, without rerunning anything, when the run had a failure
that isn't a named test in the report: a file that doesn't load, or an error between tests. It
checks this by comparing bun's `N fail` and `N error` summary counts with the report's failed tests.

Revisit when Bun's JUnit reporter marks retries (an attempt count on `<testcase>`, or JUnit's
`<flakyFailure>`): the script can then run once with `--retry=1` and read the `FLAKY:` lines from the
report.

## Tests

- `test/test-script.test.ts` runs `scripts/test.sh` on the fixtures in `test/fixtures/flaky/`, each
  counting its runs in a counter file in a temp folder (`TUTTI_FIXTURE_COUNTER`):
  `flaky.fixture.ts` fails its first run, and the script prints its `FLAKY:` line and exits 0 after
  two runs; `broken.fixture.ts` fails both runs, and the script exits 1 with no `FLAKY:` line.
- `test/flaky.test.ts` (from the scaffold) covers the report parsing, the name pattern, the summary
  counts, and the runner on a file that doesn't load beside a flaky one.
