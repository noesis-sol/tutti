#!/bin/sh
# scripts/test.sh: runs the test suites with bun test, rerunning each failed test once by name and
# printing FLAKY: <file> <test> for a test that passed only on its rerun (§ 13; scripts/test.ts).
# Slow suites (real git) run only when TUTTI_SLOW=1, live Agent SDK tests only when TUTTI_LIVE=1:
# see test/gates.ts. Arguments are passed on to bun test.
set -eu
cd "$(dirname "$0")/.."
exec bun scripts/test.ts "$@"
