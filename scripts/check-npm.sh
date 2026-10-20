#!/bin/sh
# scripts/check-npm.sh: checks a packed npm package (bun pm pack's tarball, § 12 npm) as bunx runs
# it, from a project that holds the .env files and the bunfig.toml preload that must not reach
# tutti: run from bunx's cache (bunx -p <tarball>), and installed in the project (node_modules/.bin).
# The npm workflow (.github/workflows/npm.yml) runs it before publishing, on Linux and on Alpine.
#
#   scripts/check-npm.sh <tarball>
#
# Each way, it checks that:
#   - tutti --version prints the package's version;
#   - the arguments pass through as they are: tutti colours 'a b' says the scheme 'a b' isn't used;
#   - none of .env, .env.local and .env.production (with NODE_ENV=production set) is read: each sets
#     TUTTI_COLOUR_SCHEME, which tutti colours would say it can't use;
#   - the project's bunfig.toml preload doesn't run.
# Installed, it also checks that OpenTUI's native library loads, its libc's: on Alpine the musl one.
# bunx installs the package's dependencies from the registry, so this needs the network. The user
# config is an empty one, so its colour scheme can't stand in for the project's.
set -e
[ $# -eq 1 ] || {
  echo "usage: scripts/check-npm.sh <tarball>" >&2
  exit 2
}
tarball=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
[ -f "$tarball" ] || {
  echo "scripts/check-npm.sh: no tarball $1" >&2
  exit 2
}
version=$(tar -xzOf "$tarball" package/package.json | bun --print 'JSON.parse(await Bun.stdin.text()).version')

work=$(mktemp -d "${TMPDIR:-/tmp}/tutti-check-npm-XXXXXX")
trap 'rm -rf -- "$work"' EXIT
project=$work/project
mkdir -p "$project" "$work/config"
XDG_CONFIG_HOME=$work/config
export XDG_CONFIG_HOME
unset TUTTI_COLOUR_SCHEME NO_COLOR
NO_COLOR=1
export NO_COLOR

failed=0
fail() {
  echo "FAIL: $*"
  failed=1
}

# The project's files: a bunfig.toml whose preload leaves a mark, and the .env files, written one at
# a time by check.
printf 'require("node:fs").writeFileSync(%s, "ran")\n' "\"$work/preload-ran\"" >"$project/preload.ts"
printf 'preload = ["./preload.ts"]\n' >"$project/bunfig.toml"

# check <how> <command...>: runs tutti the one way, <command> being how it is started.
check() {
  how=$1
  shift
  # bunx says how its install went on stderr.
  shown=$(cd "$project" && "$@" --version 2>"$work/stderr") ||
    fail "$how: tutti --version exited $?: $(cat "$work/stderr")"
  case $shown in
  "tutti v$version" | "tutti v$version "*) echo "ok: $how: $shown" ;;
  *) fail "$how: tutti --version printed '$shown', not tutti v$version" ;;
  esac

  said=$(cd "$project" && "$@" colours 'a b' 2>&1 | head -n 1) || true
  case $said in
  *"used instead of 'a b'"*) echo "ok: $how: the arguments pass through" ;;
  *) fail "$how: tutti colours 'a b' said '$said'" ;;
  esac

  for file in .env .env.local .env.production; do
    printf 'TUTTI_COLOUR_SCHEME=from%s\n' "$file" >"$project/$file"
    said=$(cd "$project" && NODE_ENV=production "$@" colours 2>&1 | head -n 1) || true
    rm -f -- "${project:?}/$file"
    case $said in
    *"used instead of"*) fail "$how: tutti read $file: $said" ;;
    "Colour scheme "*) echo "ok: $how: $file isn't read" ;;
    *) fail "$how: tutti colours said '$said'" ;;
    esac
  done

  if [ -e "$work/preload-ran" ]; then
    fail "$how: the project's bunfig.toml preload ran"
    rm -f -- "$work/preload-ran"
  else
    echo "ok: $how: the project's bunfig.toml preload didn't run"
  fi
}

check "bunx -p" bunx -p "$tarball" tutti

(cd "$project" && printf '{ "private": true }\n' >package.json && bun add --silent "$tarball")
check "node_modules/.bin" "$project/node_modules/.bin/tutti"

# OpenTUI's native library loads, its libc's (§ 12 npm): on a musl Linux the bundle sets
# OPENTUI_LIBC=musl, else OpenTUI loads the glibc library, which on x64 Alpine fails. --version
# doesn't use the library, so a preload, given on the command line, opens it as the run exits, from
# the platform package OpenTUI picks with the OPENTUI_LIBC the bundle left.
bundle=$project/node_modules/@noesis-sol/tutti/bin/bundle/tutti.js
cat >"$work/native-probe.ts" <<'PROBE'
import { dlopen } from "bun:ffi"
import { dirname, join } from "node:path"
process.on("exit", () => {
  const musl = process.platform === "linux" && process.env.OPENTUI_LIBC === "musl"
  const name = `@opentui/core-${process.platform}-${process.arch}${musl ? "-musl" : ""}`
  const file = `libopentui.${process.platform === "darwin" ? "dylib" : "so"}`
  const lib = join(dirname(Bun.resolveSync(name, dirname(process.argv[1]))), file)
  try {
    dlopen(lib, { setLogCallback: { args: ["ptr"], returns: "void" } }).close()
    console.error(`native: ${name}`)
  } catch (error) {
    console.error(`native failed: ${name}: ${error instanceof Error ? error.message : error}`)
  }
})
PROBE
said=$(cd "$project" &&
  bun --no-env-file --config=/dev/null --preload "$work/native-probe.ts" "$bundle" --version \
    2>&1 >/dev/null) || true
case $said in
"native: "*) echo "ok: OpenTUI's native library loads: ${said#native: }" ;;
*) fail "OpenTUI's native library: $said" ;;
esac

# The control: the bundle run as bun runs a bin, without the launcher, reads both, so the checks
# above would have seen them.
printf 'TUTTI_COLOUR_SCHEME=from.env\n' >"$project/.env"
said=$(cd "$project" && bun "$bundle" colours 2>&1 | head -n 1) || true
case $said in
*"used instead of 'from.env'"*) echo "ok: the control: the bundle run without the launcher reads .env" ;;
*) fail "the control: the bundle run without the launcher didn't read .env: $said" ;;
esac
if [ -e "$work/preload-ran" ]; then
  echo "ok: the control: the bundle run without the launcher runs the preload"
else
  fail "the control: the bundle run without the launcher didn't run the preload"
fi

[ "$failed" -eq 0 ] || exit 1
echo "scripts/check-npm.sh: the package runs as bunx runs it"
