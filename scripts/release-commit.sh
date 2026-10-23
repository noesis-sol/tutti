#!/bin/sh
# scripts/release-commit.sh: whether HEAD is a release commit pushed alone, which CI
# (.github/workflows/ci.yml) leaves to the Release workflow's check at its tag (release.yml) rather
# than checking the same tree twice. A release commit (release.yml's Releasing) has the subject
# 'Release X.Y.Z', or a pre-release's ('Release X.Y.Z-rc.1'), and changes only CHANGELOG.md and
# package.json, and of package.json only its version, to the subject's. Pushed alone, its parent is
# the push's `before`, which CI checked when it was pushed.
#
# Exits 0 for one; 1 for any other commit, saying why; 2 when it can't tell. Run it at the top of a
# checkout that holds HEAD's parent (actions/checkout's fetch-depth: 2).
#
#   scripts/release-commit.sh <before>
set -u
if [ $# -ne 1 ]; then
  echo "usage: $0 <before>" >&2
  exit 2
fi
before="$1"

not() {
  echo "not a release commit pushed alone: $*"
  exit 1
}

subject=$(git log -1 --format=%s HEAD) || exit 2
version=$(printf '%s\n' "$subject" |
  sed -n -E 's/^Release ([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)$/\1/p')
[ -n "$version" ] || not "its subject is '$subject', not 'Release X.Y.Z'"

parent=$(git rev-parse -q --verify 'HEAD^') || not "it has no parent here"
[ "$parent" = "$before" ] ||
  not "the push went on '$before', not its parent $parent, so it holds more than this commit"

others=$(git diff --name-only "$parent" HEAD -- . ':(exclude)CHANGELOG.md' ':(exclude)package.json') ||
  exit 2
[ -z "$others" ] || not "it changes $(printf '%s' "$others" | tr '\n' ' ')"

# package.json's lines changed, without the diff's own: its version's, and only that.
changed=$(git diff -U0 "$parent" HEAD -- package.json | grep -E '^[-+]' | grep -vE '^(---|\+\+\+) ')
removed=$(printf '%s\n' "$changed" | sed -n 's/^-[[:space:]]*//p')
added=$(printf '%s\n' "$changed" | sed -n 's/^+[[:space:]]*//p')
other="it changes package.json other than setting its version to $version"
[ "$(printf '%s\n' "$changed" | grep -c .)" -eq 2 ] || not "$other"
case "$removed" in '"version": "'*) ;; *) not "$other" ;; esac
case "$added" in "\"version\": \"$version\"," | "\"version\": \"$version\"") ;; *) not "$other" ;; esac

echo "a release commit pushed alone: $version"
