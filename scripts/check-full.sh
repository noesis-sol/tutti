#!/bin/sh
# scripts/check-full.sh: every check, scripts/check-fast.sh then the slower suites. orchestra runs it once at
# the end of a run.
# orchestra init wrote it; it is the project's to edit. Each suite is one command, run from the
# repository's root, and finds its own test files: a new test in an existing suite needs no edit here.
# Each runs in a subshell, ( ), so that a command failing anywhere in it (cd web && npm test) fails
# the script, and its cd leaves the next suite at the root.
set -e
cd "$(dirname "$0")/.."

# check with the slow suites (real git, marked with test/gates.ts' slow), defined in scripts/check.sh
echo "SUITE: check-slow"
(TUTTI_SLOW=1 scripts/check.sh)
