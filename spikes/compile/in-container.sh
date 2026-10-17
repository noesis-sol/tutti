#!/bin/sh
# M0 spike (tutti-nrg.1.7): cross-compiles in a Linux container, everything in a tmpfs at /w.
#
#   docker run --rm --tmpfs /w:rw,exec,size=3g --tmpfs /tmp:rw,exec,size=1g \
#     -v "$PWD":/src:ro -v <out>:/out oven/bun:1.4.3 sh /src/spikes/compile/in-container.sh \
#     <os> <cpu> <target> [run|run-musl|copy]
#
# Installs the project's packages for <os>/<cpu> (`bun install --os --cpu`, from bun.lock), builds
# <target> with build.ts, then `run` runs it here (`all`), and `copy` copies it to /out for the
# host to run. Throwaway code: not part of tutti.
set -eu
os=$1 cpu=$2 target=$3 then=${4:-run}
export HOME=/w/home TMPDIR=/w/tmp BUN_INSTALL_CACHE_DIR=/w/cache
mkdir -p /w/app/spikes "$HOME" "$TMPDIR"
cp /src/package.json /src/bun.lock /src/bunfig.toml /src/tsconfig.json /w/app/
cp -R /src/spikes/compile /w/app/spikes/
cd /w/app
start=$(date +%s)
bun install --frozen-lockfile --os="$os" --cpu="$cpu" >/w/install.log 2>&1 || { cat /w/install.log; exit 1; }
echo "RESULT install {\"os\":\"$os\",\"cpu\":\"$cpu\",\"seconds\":$(($(date +%s) - start)),\"packages\":\"$(printf '%s ' node_modules/@anthropic-ai/* node_modules/@opentui/*)\"}"
bun spikes/compile/build.ts --out /w/out "$target"
case $then in
  run) TMPDIR=/tmp /w/out/tutti-spike-"$target" all ;;
  # OpenTUI loads its musl library only when OPENTUI_LIBC=musl; the frame without it, then with.
  run-musl)
    TMPDIR=/tmp /w/out/tutti-spike-"$target" all || true
    TMPDIR=/tmp OPENTUI_LIBC=musl /w/out/tutti-spike-"$target" frame
    ;;
  copy) cp /w/out/tutti-spike-"$target" /out/ ;;
esac
