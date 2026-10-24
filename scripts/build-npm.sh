#!/bin/sh
# scripts/build-npm.sh: builds the npm package's bundle (§ 12 npm) into bin/bundle/ (git-ignored),
# beside the package's bin, the launcher bin/tutti. package.json's prepack runs it, so bun pm pack
# and bun publish pack a fresh bundle; the npm workflow (.github/workflows/npm.yml) runs it with
# --release and publishes without running it again.
#
#   scripts/build-npm.sh [--out <dir>] [--release]
#
#   --out      the folder for the bundle, emptied first: bin/bundle by default, and a relative one is
#              the checkout's. The bundle's entry is <dir>/tutti.js. test/npm-package.test.ts
#              builds one elsewhere.
#   --release  a release build, from a clean tree: tutti --version shows the bare version
#              (TUTTI_BUILD_COMMIT ""). Without it, the version carries the commit, as
#              scripts/build.sh's does.
#
# The bundle is bun build --target=bun of src/npm.ts, which detects musl before anything
# loads OpenTUI (OPENTUI_LIBC, § 12 npm) and runs src/main.ts's main, with process.env.NODE_ENV
# defined as "production", for React's production build (§ 3.1): a bin run from the user's project
# never reads tutti's bunfig.toml. React is bundled, so the define reaches it. The platform packages, OpenTUI's
# native library (@opentui/core-<platform>) and the SDK's Claude Code
# (@anthropic-ai/claude-agent-sdk-<platform>), stay external: each is an optional dependency that an
# install picks for its machine, and the code that loads them asks for every platform's by name.
# OpenTUI's tree-sitter assets are written beside the bundle.
set -e
cd "$(dirname "$0")/.."

usage() {
  echo "usage: scripts/build-npm.sh [--out <dir>] [--release]" >&2
  exit 2
}

out=bin/bundle
release=false
while [ $# -gt 0 ]; do
  case $1 in
  --out)
    [ $# -ge 2 ] || usage
    out=$2
    shift 2
    ;;
  --release) release=true && shift ;;
  *) usage ;;
  esac
done

# The TUTTI_BUILD_COMMIT define: "" for a release, else the commit, or none outside a git checkout,
# where the bundle defines none and shows the bare version, as scripts/build.sh's builds do.
if [ "$release" = true ]; then
  if [ -n "$(git status --porcelain)" ]; then
    echo "scripts/build-npm.sh: --release needs a clean tree; git status lists changes:" >&2
    git status --short >&2
    exit 1
  fi
  commit=
elif hash=$(git rev-parse HEAD 2>/dev/null); then
  commit=$(echo "$hash" | cut -c 1-12)
  if [ -n "$(git status --porcelain)" ]; then commit="$commit+dirty"; fi
else
  commit=none
fi

rm -rf -- "$out"
set -- --define 'process.env.NODE_ENV:"production"'
if [ "$commit" != none ]; then set -- "$@" --define "TUTTI_BUILD_COMMIT:\"$commit\""; fi
bun build --target=bun src/npm.ts --outdir "$out" --entry-naming tutti.js "$@" \
  --external '@opentui/core-*' --external '@anthropic-ai/claude-agent-sdk-*'
