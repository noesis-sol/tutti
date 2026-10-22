#!/bin/sh
# scripts/build.sh: compiles tutti into one binary per target, with that platform's Claude Code and
# OpenTUI's native library embedded (§ 12 Builds), and with --archive packs each into its release
# archive. The release workflow (.github/workflows/release.yml) runs it for each target.
#
#   scripts/build.sh [--out <dir>] [--release] [--archive] <target>... | host
#
# Targets: darwin-arm64, darwin-x64, linux-arm64, linux-x64 (glibc), linux-arm64-musl,
# linux-x64-musl, or host, this machine's. Each is built from src/entries/<target>.ts into
# <out>/<target>/tutti (out defaults to dist, git-ignored).
#
#   --release  a release build, from a clean tree: tutti --version shows the bare version
#              (TUTTI_BUILD_COMMIT ""). Without it, the version carries the commit's 12-character
#              hash, plus +dirty when git status lists changes (src/cli/version.ts).
#   --archive  also writes <out>/tutti_<version>_<os>_<arch>.tar.gz, or ..._<arch>_musl.tar.gz for
#              a musl target, holding tutti and the notices (§ 12 Releases).
#
# Cross-compiling (§ 12): each target first gets its packages with
# `bun install --frozen-lockfile --os=<os> --cpu=<cpu>`, from bun.lock, and only its own: bun build
# --compile embeds every @opentui/core-<platform> installed. That install adds the target's packages
# beside those already there (Bun 1.4.3), the host's among them, so the other platforms' packages
# are removed from node_modules first. For Linux it brings the glibc and the musl ones, and both
# stay: OpenTUI picks one at run time, so a Linux build doesn't resolve without either.
# Once the builds are done the host's packages are installed again, and the others removed, so the
# checkout's own runs and tests keep working.
#
# --bytecode precompiles the JavaScript, which starts tutti --version in about 85 ms rather than
# 218 ms (§ 12 Builds). It needs --format=esm: Bun builds CommonJS without it, where OpenTUI's
# top-level await fails the build.
#
# bun build --compile leaves a copy of Bun (.<hash>-00000000.bun-build) in its working folder
# (tutti-nrg.21; Bun's bug oven-sh/bun#14020, still open with Bun 1.4.3 on macOS), so it runs in a
# temp folder, removed afterwards.
set -e
cd "$(dirname "$0")/.."
root=$(pwd)

TARGETS="darwin-arm64 darwin-x64 linux-arm64 linux-x64 linux-arm64-musl linux-x64-musl"

usage() {
  echo "usage: scripts/build.sh [--out <dir>] [--release] [--archive] <target>... | host" >&2
  echo "targets: $TARGETS" >&2
  exit 2
}

# host_target: this machine's target, as Bun names it, with -musl on a musl Linux.
host_target() {
  case $(uname -s) in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "scripts/build.sh: no target for $(uname -s)" >&2 && exit 1 ;;
  esac
  case $(uname -m) in
  arm64 | aarch64) cpu=arm64 ;;
  x86_64 | amd64) cpu=x64 ;;
  *) echo "scripts/build.sh: no target for $(uname -m)" >&2 && exit 1 ;;
  esac
  libc=
  if [ "$os" = linux ] && ldd --version 2>&1 | grep -q musl; then libc=-musl; fi
  echo "$os-$cpu$libc"
}

out=dist
release=false
archive=false
targets=
while [ $# -gt 0 ]; do
  case $1 in
  --out)
    [ $# -ge 2 ] || usage
    out=$2
    shift 2
    ;;
  --release) release=true && shift ;;
  --archive) archive=true && shift ;;
  -*) usage ;;
  # Not an AND-list: set -e doesn't stop on a failure before its last command, and host would
  # loop with no shift.
  host)
    target=$(host_target) || exit 1
    targets="$targets $target"
    shift
    ;;
  *)
    case " $TARGETS " in
    *" $1 "*) targets="$targets $1" ;;
    *) echo "scripts/build.sh: unknown target $1" >&2 && usage ;;
    esac
    shift
    ;;
  esac
done
[ -n "$targets" ] || usage
mkdir -p "$out"
out=$(cd "$out" && pwd)

version=$(bun --print 'require("./package.json").version')

# The TUTTI_BUILD_COMMIT define: "" for a release, else the commit, or none outside a git checkout,
# where the build shows the bare version too.
if [ "$release" = true ]; then
  if [ -n "$(git status --porcelain)" ]; then
    echo "scripts/build.sh: --release needs a clean tree; git status lists changes:" >&2
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

# prune <os>-<cpu>: removes from node_modules every platform's packages but that one's, glibc and musl.
prune() {
  for dir in node_modules/@opentui/core-* node_modules/@anthropic-ai/claude-agent-sdk-*; do
    [ -d "$dir" ] || continue
    case ${dir##*/} in
    "core-$1" | "core-$1-musl" | "claude-agent-sdk-$1" | "claude-agent-sdk-$1-musl") ;;
    *) rm -rf -- "$dir" ;;
    esac
  done
}

work=$(mktemp -d "${TMPDIR:-/tmp}/tutti-build-XXXXXX")
installed=
restore_host() {
  status=$?
  rm -rf -- "$work"
  if [ -n "$installed" ]; then
    host=$(host_target)
    echo "scripts/build.sh: installing the host's packages again ($host)"
    prune "${host%-musl}"
    bun install --frozen-lockfile || status=1
  fi
  exit "$status"
}
trap restore_host EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for target in $targets; do
  # linux-arm64-musl installs as linux arm64, which brings the glibc and the musl packages.
  platform=${target%-musl}
  os=${platform%-*}
  cpu=${platform#*-}
  if [ "$installed" != "$platform" ]; then
    echo "scripts/build.sh: installing the packages for $os $cpu"
    prune "$platform"
    installed=$platform
    bun install --frozen-lockfile --os="$os" --cpu="$cpu"
  fi

  echo "scripts/build.sh: building $target"
  mkdir -p "$out/$target"
  outfile=$out/$target/tutti
  set -- --define 'process.env.NODE_ENV:"production"'
  if [ "$commit" != none ]; then set -- "$@" --define "TUTTI_BUILD_COMMIT:\"$commit\""; fi
  (cd "$work" && bun build --compile --bytecode --format=esm --target="bun-$target" "$@" \
    --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
    "$root/src/entries/$target.ts" --outfile "$outfile")

  if [ "$archive" = true ]; then
    name=tutti_${version}_${os}_${cpu}
    case $target in *-musl) name=${name}_musl ;; esac
    stage=$work/$name
    mkdir -p "$stage"
    cp "$outfile" "$stage/tutti"
    for file in README.md LICENSE CHANGELOG.md THIRD_PARTY_NOTICES.md; do
      if [ -f "$file" ]; then cp "$file" "$stage/"; fi
    done
    (cd "$stage" && COPYFILE_DISABLE=1 tar -czf "$out/$name.tar.gz" -- *)
    echo "scripts/build.sh: wrote $out/$name.tar.gz"
  fi
done
