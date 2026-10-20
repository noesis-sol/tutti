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
set -e
cd "$(dirname "$0")/.."

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

echo "SUITE: tsc"
(bunx tsc --noEmit)
echo "SUITE: biome"
(bunx biome check .)
echo "SUITE: test"
(scripts/test.sh)
echo "SUITE: shellcheck"
(run_shellcheck)
