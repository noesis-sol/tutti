#!/bin/sh
# scripts/check-own.sh: a worker's check of its own change, check_own in .orchestra/settings.json.
# It runs scripts/check.sh's steps on what the branch changed since it left main (its commits and
# what isn't committed yet, new files included), each step printing a SUITE: line:
#   tsc:        bunx tsc --noEmit, on the whole project (tsc has no partial check), when a TypeScript
#               or JSON file changed, deleted ones included
#   biome:      bunx biome check on the changed files
#   test:       scripts/test.sh on the test files the change touches (scripts/check-own.ts): those
#               that changed, and those that import a changed module at any depth or name a changed
#               file; the slow suites too when TUTTI_SLOW=1. Those that passed in an earlier run in
#               this worktree, and that nothing changed since touches, are left out: see below
#   lint:       shellcheck on the changed shell scripts (and bin/tutti, which has no .sh)
# A change to the project's setup (package.json, bun.lock, tsconfig.json, bunfig.toml, biome.json,
# scripts/check.sh) runs scripts/check.sh whole instead, and so does a branch without main to start
# from. TUTTI_OWN_BASE names another commit to start from. orchestra's merge check,
# scripts/check-fast.sh, still runs the whole check on each ticket before it merges it.
# A pass is kept under the worktree's own git dir (git rev-parse --git-dir), never tracked: the tree
# it ran on (HEAD's with what isn't committed yet, untracked files included), its mode and the test
# files that passed. The next run picks tests from what changed since that tree too, and leaves out
# the earlier pass's tests that this smaller change doesn't touch (scripts/check-own.ts' standOn),
# saying how many. A TUTTI_SLOW=1 pass stands for a plain run as well; a plain pass stands for a
# TUTTI_SLOW=1 run only for the test files with no slow gate (check-own.ts' slowGated), which run
# the same in both modes. A run whose tests failed keeps, at its tree, the test files whose tests all
# passed in it, which scripts/test.ts writes down (TUTTI_CHECK_OWN_PASSED), and the earlier pass's
# that it left out (check-own.ts' afterFailure): the next run runs the files that failed again. Any
# other failure (tsc, biome, shellcheck, or the tests without that list) keeps nothing and forgets
# the passes kept: the next run starts from main. tsc, biome and shellcheck run whatever passed
# before.
# The last line is the verdict, its exit status unchanged, as scripts/check.sh's.
set -e
cd "$(dirname "$0")/.."

name=scripts/check-own.sh
mode=plain
if [ "${TUTTI_SLOW-}" = 1 ]; then name="TUTTI_SLOW=1 $name" mode=slow; fi
gitdir=$(git rev-parse --absolute-git-dir 2>/dev/null || true)
passed=${gitdir:+$gitdir/tutti-check-own-passed}
# Keeps the pass check-own.ts wrote down for this run, a slow one for plain runs too, or what passed
# in a run whose tests failed, or forgets every pass on any other failure.
keep() {
  [ -n "$gitdir" ] || return 0
  next=$gitdir/tutti-check-own-next.json
  if [ "$1" -ne 0 ]; then
    if [ "$step" != test ] || [ ! -f "$passed" ] || ! bun scripts/check-own.ts --failed "$passed"; then
      rm -f "$gitdir/tutti-check-own-plain.json" "$gitdir/tutti-check-own-slow.json"
    fi
  elif [ -f "$next" ]; then
    if [ "$mode" = slow ]; then cp "$next" "$gitdir/tutti-check-own-plain.json"; fi
    mv "$next" "$gitdir/tutti-check-own-$mode.json"
  fi
  rm -f "$next" "$gitdir/tutti-check-own-unrun.json" "$passed"
}
step=
finish() {
  status=$?
  keep "$status" || true
  if [ "$status" -eq 0 ]; then
    echo "$name: PASS"
  else
    echo "$name: FAIL in ${step:-setup} (exit $status)"
  fi
  exit "$status"
}
trap finish EXIT

base=${TUTTI_OWN_BASE:-$(git merge-base HEAD main 2>/dev/null || true)}
if [ -z "$base" ]; then
  echo "check-own: no main to start from: running scripts/check.sh whole"
  exec scripts/check.sh
fi
changed=$(
  {
    git diff --name-only --no-renames "$base" --
    git ls-files --others --exclude-standard
  } | sort -u
)
# The project's setup, as check-own.ts' setupFiles.
for file in package.json bun.lock tsconfig.json bunfig.toml biome.json scripts/check.sh; do
  if printf '%s\n' "$changed" | grep -qxF "$file"; then
    echo "check-own: $file changed: running scripts/check.sh whole"
    exec scripts/check.sh
  fi
done

echo "check-own: changed since $(git rev-parse --short "$base"):"
# shellcheck disable=SC2086 # the changed files are repository paths, one a line
if [ -z "$changed" ]; then echo "  nothing"; else printf '  %s\n' $changed; fi
# The changed files still there, one a line, matching a grep -E pattern.
present() {
  printf '%s\n' "$changed" | grep -E "$1" | while IFS= read -r file; do
    if [ -f "$file" ]; then echo "$file"; fi
  done
}

run_shellcheck() {
  scripts=$(present '(\.sh|^bin/tutti)$')
  if [ -z "$scripts" ]; then
    echo "shellcheck: no shell script changed"
    return 0
  fi
  status=0
  shellcheck=$(scripts/fetch-shellcheck.sh) || status=$?
  if [ "$status" -eq 2 ]; then
    echo "shellcheck: skipped, since the pinned shellcheck could not be downloaded (offline?)"
    return 0
  fi
  [ "$status" -eq 0 ] || return "$status"
  printf '%s\n' "$scripts" | tr '\n' '\0' | xargs -0 "$shellcheck"
}

step="tsc"
echo "SUITE: tsc"
# Deleted files count here: a module gone breaks the modules that import it.
if printf '%s\n' "$changed" | grep -qE '\.(ts|tsx|json)$'; then
  (bunx tsc --noEmit)
else
  echo "tsc: no TypeScript or JSON file changed"
fi
step="biome"
echo "SUITE: biome"
files=$(present '.')
if [ -n "$files" ]; then
  (printf '%s\n' "$files" | tr '\n' '\0' |
    xargs -0 bunx biome check --files-ignore-unknown=true --no-errors-on-unmatched)
else
  echo "biome: no file changed"
fi
step="test"
echo "SUITE: test"
if [ -n "$passed" ]; then rm -f "$passed"; fi
# shellcheck disable=SC2086 # the changed files are repository paths, one a line
picked=$(bun scripts/check-own.ts $changed)
# Its lines that say what it left out, then the test files or ALL.
printf '%s\n' "$picked" | grep -E '^(check-own|test):' || true
tests=$(printf '%s\n' "$picked" | grep -vE '^(check-own|test):' || true)
if [ "$tests" = ALL ]; then
  (TUTTI_CHECK_OWN_PASSED=$passed scripts/test.sh)
elif [ -n "$tests" ]; then
  set --
  for test in $tests; do set -- "$@" "./$test"; done
  (TUTTI_CHECK_OWN_PASSED=$passed scripts/test.sh "$@")
fi
step="shellcheck"
echo "SUITE: shellcheck"
(run_shellcheck)
