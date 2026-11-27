#!/bin/sh
# check.sh: model-checks Scheduler.tla with TLC, each case of `cases` below against what it is
# expected to give, then says whether the code the model describes changed since the model was
# last confirmed against it (`covered`). SKILL.md says how to read a result.
#
#   check.sh                 every case but the deep-* ones, then the covered code
#   check.sh <case>...       those cases only, then the covered code
#   check.sh --covered       the covered code only
#   check.sh --confirm       records the covered code as it is now: only once the model has been
#                            read against it and describes it
#   check.sh --trace <case>  the steps of the case's counterexample, one a line
#
# Exit: 0 every case gave what is expected and the covered code is as confirmed; 1 a case gave
# something else; 2 the covered code changed since it was confirmed; 3 TLC could not run.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here" && git rev-parse --show-toplevel)

# TLC: a pinned release, fetched once into .cache/tla (git-ignored) and checked against its sha256.
version=1.7.4
sha=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
jar=${TLA2TOOLS:-$root/.cache/tla/tla2tools-$version.jar}

# name | expected | N Concurrent Limit MaxRequeues AnyYield | Assume | Variant
# expected: holds, or the invariant a finding or a deliberate break violates.
all=''
cases="
await|holds|2 2 3 1 FALSE||asCode
await-one-slot|holds|2 1 3 1 FALSE||asCode
await-limit|holds|2 2 1 1 FALSE||asCode
any-step|holds|2 2 3 1 TRUE|$all|asCode
any-step-one-slot|holds|2 1 3 1 TRUE|$all|asCode
any-step-limit|holds|2 2 1 1 TRUE|$all|asCode
break-no-ended-since-fill|NoEndWhileReady|2 2 3 1 FALSE||noEndedSinceFill
break-filled-at-after|NoEndWhileReady|2 2 3 1 FALSE||filledAtAfter
break-no-running-check|NeverStartedTwice|2 2 3 1 FALSE||noRunningCheck
break-no-refill|NoEndWhileReady|2 2 3 1 FALSE||noRefill
break-unlocked-lift|HeldWhileNotRun|2 2 3 1 FALSE||unlockedLift
break-no-lifted-look|NoEndWhileReady|2 2 3 1 FALSE||noLiftedLook
deep-three-tickets|holds|3 2 3 0 FALSE||asCode
"

# The covered code as it is now: a line for each entry of `covered.list`, with the hash of the
# file, or of the part of it from the first line matching <from> to the line before the next one
# matching <to>.
covered_now() {
  while IFS='|' read -r path from to; do
    case "$path" in '' | '#'*) continue ;; esac
    if [ ! -f "$root/$path" ]; then
      echo "$path|$from|missing"
    elif [ -z "$from" ]; then
      echo "$path||$(git -C "$root" hash-object "$root/$path")"
    else
      part=$(awk -v from="$from" -v to="$to" '
        !on && $0 ~ from { on = 1; print; next }
        on && to != "" && $0 ~ to { exit }
        on { print }' "$root/$path")
      if [ -z "$part" ]; then
        echo "$path|$from|missing"
      else
        echo "$path|$from|$(printf '%s\n' "$part" | git -C "$root" hash-object --stdin)"
      fi
    fi
  done <"$here/covered.list"
}

covered() {
  now=$(covered_now)
  if [ "$now" = "$(sed -n '2,$p' "$here/covered.confirmed" 2>/dev/null)" ]; then
    echo "covered code: as confirmed at $(sed -n '1p' "$here/covered.confirmed")"
    return 0
  fi
  echo "covered code: CHANGED since the model was confirmed at $(sed -n '1p' "$here/covered.confirmed" 2>/dev/null):"
  printf '%s\n' "$now" | while IFS='|' read -r path from hash; do
    if ! grep -qxF "$path|$from|$hash" "$here/covered.confirmed" 2>/dev/null; then
      echo "  $path${from:+ ($from)}"
    fi
  done
  echo "Read the change against Scheduler.tla (SKILL.md, 'When the covered code changed'), then: $0 --confirm"
  return 2
}

fetch() {
  [ -f "$jar" ] && return 0
  command -v curl >/dev/null || { echo "check.sh: no curl to fetch TLC with" >&2; exit 3; }
  mkdir -p "$(dirname "$jar")"
  echo "check.sh: fetching TLC $version into $jar"
  curl -sSfL -o "$jar.part" \
    "https://github.com/tlaplus/tlaplus/releases/download/v$version/tla2tools.jar" ||
    { echo "check.sh: could not fetch TLC (offline?); or set TLA2TOOLS to a tla2tools.jar" >&2; exit 3; }
  echo "$sha  $jar.part" | shasum -a 256 -c - >/dev/null ||
    { echo "check.sh: the TLC fetched has another sha256 than $sha" >&2; rm -f "$jar.part"; exit 3; }
  mv "$jar.part" "$jar"
}

# Runs one case in $work, leaving <name>.out; prints what it gave: holds, an invariant, or error.
run_case() {
  name=$1 numbers=$2 assume=$3 variant=$4
  # shellcheck disable=SC2086 # the five numbers, one word each
  set -- $numbers
  cat >"$work/$name.cfg" <<EOF
SPECIFICATION Spec
CONSTANTS
  N = $1
  Concurrent = $2
  Limit = $3
  MaxRequeues = $4
  AnyYield = $5
  Assume = {$assume}
  Variant = "$variant"
INVARIANTS
  TypeOK
  NoEndWhileReady
  NeverStartedTwice
  HeldWhileNotRun
EOF
  status=0
  (cd "$work" && java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -config "$name.cfg" \
    -workers auto -deadlock -metadir "$work/meta-$name" Scheduler.tla >"$name.out" 2>&1) || status=$?
  if [ "$status" -eq 0 ]; then
    echo holds
  elif [ "$status" -eq 12 ]; then
    sed -n 's/^Error: Invariant \([A-Za-z]*\) is violated.*/\1/p' "$work/$name.out" | head -1
  else
    echo error
  fi
}

# The counterexample of <name>.out, a step a line: what took it, and what it changed.
trace() {
  awk '
    /^State [0-9]+: / {
      n = $2; sub(":", "", n); who = $3; sub("<", "", who)
      if (n > 1) line = n " " who ":"; else line = "1 start:"
      next
    }
    /^\/\\ / {
      name = $2; value = $0; sub(/^\/\\ [A-Za-z]+ = /, "", value)
      if (name != "hot" && (n == 1 ? name ~ /^(solo|overlap|blocks)$/ : last[name] != value)) {
        line = line " " name "=" value
      }
      last[name] = value
      next
    }
    /^$/ && line != "" { print line; line = "" }
    END { if (line != "") print line }' "$1"
}

case "${1:-}" in
--covered)
  covered
  exit $?
  ;;
--confirm)
  {
    git -C "$root" rev-parse HEAD
    covered_now
  } >"$here/covered.confirmed"
  echo "covered code: recorded as it is now, at $(sed -n '1p' "$here/covered.confirmed")"
  exit 0
  ;;
esac

command -v java >/dev/null ||
  { echo "check.sh: no java (11 or later) to run TLC with: brew install openjdk" >&2; exit 3; }
fetch
work=${TMPDIR:-/tmp}/verify-scheduler.$$
mkdir -p "$work"
cp "$here/Scheduler.tla" "$work/"

if [ "${1:-}" = "--trace" ]; then
  line=$(printf '%s\n' "$cases" | grep "^$2|") || { echo "check.sh: no case $2" >&2; exit 1; }
  IFS='|' read -r name _ numbers assume variant <<EOF
$line
EOF
  run_case "$name" "$numbers" "$assume" "$variant" >/dev/null
  trace "$work/$name.out"
  rm -rf "$work"
  exit 0
fi

failed=0
printf '%s\n' "$cases" | {
  while IFS='|' read -r name expected numbers assume variant; do
    [ -n "$name" ] || continue
    if [ $# -gt 0 ]; then
      wanted=0
      for each in "$@"; do [ "$each" = "$name" ] && wanted=1; done
      [ "$wanted" -eq 1 ] || continue
    else
      # A deep case runs only when named: minutes, not seconds.
      case "$name" in deep-*) continue ;; esac
    fi
    gave=$(run_case "$name" "$numbers" "$assume" "$variant")
    if [ "$gave" = "$expected" ]; then
      case "$name" in
      finding-*) echo "ok    $name: still violates $expected, as SKILL.md's findings say" ;;
      break-*) echo "ok    $name: the break is caught ($expected)" ;;
      *) echo "ok    $name: both properties hold" ;;
      esac
    else
      failed=1
      echo "FAIL  $name: expected $expected, got $gave"
      if [ "$gave" = error ]; then
        tail -15 "$work/$name.out"
      elif [ "$gave" != holds ]; then
        trace "$work/$name.out"
      fi
    fi
  done
  exit "$failed"
} || failed=1
rm -rf "$work"

status=0
covered || status=$?
if [ "$failed" -ne 0 ]; then
  echo "check.sh: FAIL"
  exit 1
fi
[ "$status" -eq 0 ] && echo "check.sh: PASS"
exit "$status"
