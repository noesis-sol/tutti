#!/bin/sh
# scripts/check-fast.sh: tutti's merge check, run on every ticket before it merges, on its branch
# rebased onto main: in the ticket's worktree, or in an early check's checkout on no branch. tutti
# init wrote it; it is the project's to edit. It runs the worker's own check, scripts/check-own.sh,
# on the change since main (git merge-base HEAD main): tsc on the whole project when a TypeScript or
# JSON file changed, biome on the changed files, shellcheck on the changed scripts, and the test
# files the change touches, picked by scripts/check-own.ts (those that changed, those that import a
# changed module at any depth or name a changed file, and, for a change under src/, those that read
# the whole of src/), saying how many; scripts/check.sh whole, every test, when the project's setup
# changed or there is no main to start from. TUTTI_OWN_SAME_TREE=1 has it stand on no pass kept in
# the worktree (the worker's own check's, of another tree) but one at the very tree it checks.
# The gate is weaker than the whole suite's between full checks: a break only a test the selection
# leaves out would catch reaches main, and the full check, scripts/check-full.sh, which runs every
# test once at the end of a run, and CI's and the release's runs of it, find it.
# Each suite prints SUITE: <name> as it starts; check-own.sh's steps print their own. A suite that
# reruns a failed test, and passes when the rerun does, prints FLAKY: <test> for it: the ticket
# merges, and tutti warns of it. The last line is check-own.sh's verdict, or check.sh's.
set -e
cd "$(dirname "$0")/.."

# the change's check, from scripts/check-own.sh
printf '%s\n' 'SUITE: check'
(
TUTTI_OWN_SAME_TREE=1 scripts/check-own.sh
)
