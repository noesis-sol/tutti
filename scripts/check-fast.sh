#!/bin/sh
# scripts/check-fast.sh: orchestra's merge check, run on every ticket rebased onto work merged while it ran.
# orchestra init wrote it; it is the project's to edit. Each suite is one command, run from the
# repository's root, and finds its own test files: a new test in an existing suite needs no edit here.
# Each runs in a subshell, ( ), so that a command failing anywhere in it (cd web && npm test) fails
# the script, and its cd leaves the next suite at the root.
set -e
cd "$(dirname "$0")/.."

# check: tsc, biome, the tests and shellcheck, defined in scripts/check.sh
echo "SUITE: check"
(scripts/check.sh)
