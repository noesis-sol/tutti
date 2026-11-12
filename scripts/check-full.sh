#!/bin/sh
# scripts/check-full.sh: every check in one pass, every test, the slow suites included. tutti runs
# it once at the end of a run that ended by itself and merged, on the base's head, and CI and the
# release run it on every push. The merge check, scripts/check-fast.sh, runs only the tests a
# ticket's change touches, so a break only another test would catch reaches main and is found
# here. It doesn't run scripts/check-fast.sh first: scripts/check.sh with TUTTI_SLOW=1 already runs
# everything check-fast does, so that would run the tests twice.
# It is the project's to edit. Each suite is one command, run from the
# repository's root, and finds its own test files: a new test in an existing suite needs no edit here.
# Each runs in a subshell, ( ), so that a command failing anywhere in it (cd web && npm test) fails
# the script, and its cd leaves the next suite at the root.
# Each suite prints SUITE: <name> as it starts. A suite that reruns a failed test, and passes when
# the rerun does, prints FLAKY: <test> for it: the ticket merges, and tutti warns of it.
set -e
cd "$(dirname "$0")/.."

# check with the slow suites (real git, marked with test/gates.ts' slow), defined in scripts/check.sh
echo "SUITE: check-slow"
(TUTTI_SLOW=1 scripts/check.sh)
