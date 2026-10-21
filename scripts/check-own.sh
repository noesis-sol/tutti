#!/bin/sh
# scripts/check-own.sh: a worker's check of its own change, check_own in .orchestra/settings.json.
# It runs scripts/check.sh's steps on what the branch changed since it left main (its commits and
# what isn't committed yet, new files included), each step printing a SUITE: line:
#   tsc:        bunx tsc --noEmit, on the whole project (tsc has no partial check), when a TypeScript
#               or JSON file changed, deleted ones included
#   biome:      bunx biome check on the changed files
#   test:       scripts/test.sh on the test files the change touches (scripts/check-own.ts): those
#               that changed, and those that import a changed module at any depth or name a changed
#               file; the slow suites too when TUTTI_SLOW=1
#   lint:       shellcheck on the changed shell scripts (and bin/tutti, which has no .sh)
# A change to the project's setup (package.json, bun.lock, tsconfig.json, bunfig.toml, biome.json,
# scripts/check.sh) runs scripts/check.sh whole instead, and so does a branch without main to start
# from. TUTTI_OWN_BASE names another commit to start from. orchestra's merge check,
# scripts/check-fast.sh, still runs the whole check on each ticket before it merges it.
# The last line is the verdict, its exit status unchanged, as scripts/check.sh's.
set -e
cd "$(dirname "$0")/.."

name=scripts/check-own.sh
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
# shellcheck disable=SC2086 # the changed files are repository paths, one a line
tests=$(bun scripts/check-own.ts $changed)
if [ "$tests" = ALL ]; then
  (scripts/test.sh)
elif [ -n "$tests" ]; then
  set --
  for test in $tests; do set -- "$@" "./$test"; done
  (scripts/test.sh "$@")
else
  echo "test: no test file covers the change"
fi
step="shellcheck"
echo "SUITE: shellcheck"
(run_shellcheck)
