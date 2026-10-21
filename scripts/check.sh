#!/bin/sh
# scripts/check.sh: the project's check (§ 13), and the suite scripts/check-fast.sh and
# scripts/check-full.sh run. Each step prints a SUITE: line, then runs in a subshell:
#   tsc:        bunx tsc --noEmit
#   biome:      bunx biome check .
#   test:       scripts/test.sh (slow suites too when TUTTI_SLOW=1)
#   lint:       shellcheck on the tracked shell scripts (and the npm package's launcher, bin/tutti,
#               which has no .sh), with a pinned release that
#               scripts/fetch-shellcheck.sh fetches into .cache/shellcheck/ (git-ignored) and
#               verifies by its sha256. When it can't be downloaded (offline), the step says so
#               and is skipped rather than failed.
# The last line is the verdict, its exit status unchanged: 'scripts/check.sh: PASS', or the step it
# failed in, 'TUTTI_SLOW=1 scripts/check.sh: FAIL in test (exit 1)'. The output's end alone then
# says whether it passed, so a check run once with its output saved needn't run again to tell.
set -e
cd "$(dirname "$0")/.."

name=scripts/check.sh
if [ "${TUTTI_SLOW-}" = 1 ]; then name="TUTTI_SLOW=1 $name"; fi
step=
finish() {
  status=$?
  if [ "$status" -eq 0 ]; then
    echo "$name: PASS"
  else
    echo "$name: FAIL in ${step:-setup} (exit $status)"
  fi
  exit "$status"
}
trap finish EXIT

run_shellcheck() {
  status=0
  shellcheck=$(scripts/fetch-shellcheck.sh) || status=$?
  if [ "$status" -eq 2 ]; then
    echo "shellcheck: skipped, since the pinned shellcheck could not be downloaded (offline?)"
    return 0
  fi
  [ "$status" -eq 0 ] || return "$status"
  git ls-files -z -- '*.sh' bin/tutti | xargs -0 "$shellcheck"
}

step="tsc"
echo "SUITE: tsc"
(bunx tsc --noEmit)
step="biome"
echo "SUITE: biome"
(bunx biome check .)
step="test"
echo "SUITE: test"
(scripts/test.sh)
step="shellcheck"
echo "SUITE: shellcheck"
(run_shellcheck)
