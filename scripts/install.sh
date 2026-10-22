#!/bin/sh
# scripts/install.sh: installs tutti from its latest GitHub Release, or the one TUTTI_VERSION names
# (§ 12 Install):
#
#   curl -fsSL https://raw.githubusercontent.com/noesis-sol/tutti/main/scripts/install.sh | sh
#
# It downloads the release's archive for this platform (darwin or linux, arm64 or x64, and on Linux
# glibc or musl), checksums.txt and its signature, checksums.txt.sig; verifies the signature with the
# release keys below when an OpenSSL 3 is there to do it (macOS's own openssl, LibreSSL, can't verify
# ed25519: it then says so and goes on), and the archive's SHA-256 against checksums.txt; and puts the
# tutti in it in place. It never calls sudo.
#
#   TUTTI_VERSION      the release to install, such as v0.9.0; the latest when unset
#   TUTTI_INSTALL_DIR  the folder to install in; else /usr/local/bin where it can write, or ~/.local/bin
#   TUTTI_LIBC         musl or glibc, the Linux archive to install; else the system's, as ldd or the
#                      musl loader tells
#
# On x64 it stops, before downloading anything, where the CPU lacks AVX2: tutti embeds Claude Code,
# which ships only Bun's standard x64 builds, and those need it. In a shell under Rosetta on Apple
# Silicon it installs the darwin arm64 archive, which runs natively.
#
# For the tests only (test/install-script.test.ts): TUTTI_DOWNLOAD_URL replaces the releases' address,
# https://github.com/noesis-sol/tutti/releases. It may be a file:// URL of a folder laid out as GitHub
# serves a release's files, download/<tag>/<name>, with a file `latest` holding the latest tag. In that
# mode alone TUTTI_TEST_RELEASE_KEY (a PEM public key) replaces the release keys, TUTTI_TEST_SYSTEM_DIR
# replaces /usr/local/bin, TUTTI_TEST_LIB_DIR replaces /lib, where the musl loader is looked for,
# TUTTI_TEST_CPUINFO replaces /proc/cpuinfo, where Linux's CPU flags are read, and TUTTI_TEST_OPENSSL
# (paths, separated by spaces) replaces the openssl commands tried. macOS's sysctl is found on the
# PATH (then in /usr/sbin), so a test puts a fake one first.
#
# Everything runs from main, at the end, so that a download cut short runs nothing. POSIX sh: it runs
# under sh, dash and bash.
set -eu

# The public keys a release's checksums.txt may be signed with (PKIX PEM, as
# `openssl pkey -in release-key.pem -pubout` prints the release key's): a new key is added here, and
# an old one leaves; src/update/keys.ts holds the same (test/install-script.test.ts checks it).
# 2026-10:
release_keys='-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAtoGlzKgru416pWobucm9ICq3LtFfTEFkOaRy0Yx2Je4=
-----END PUBLIC KEY-----'

releases=https://github.com/noesis-sol/tutti/releases
system_dir=/usr/local/bin
lib_dir=/lib
cpuinfo=/proc/cpuinfo
openssl_candidates='openssl /opt/homebrew/bin/openssl /usr/local/opt/openssl@3/bin/openssl'

say() { printf '%s\n' "$*"; }
fail() {
  printf 'tutti install: %s\n' "$*" >&2
  exit 1
}

# platform sets os and arch, as Bun names them, from uname, or stops on a platform without a release
# binary. It also sets machine, uname -m's.
platform() {
  kernel="$(uname -s)"
  machine="$(uname -m)"
  case "$kernel" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) os= ;;
  esac
  case "$machine" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) arch= ;;
  esac
  if [ -z "$os" ] || [ -z "$arch" ]; then
    fail "there is no release binary for $kernel $machine: releases have darwin and linux, arm64 and x64.
Build it from a clone with Bun instead: scripts/build.sh host"
  fi
}

# sysctl_value prints macOS's sysctl -n $1, or nothing where it has no such name (sysctl.proc_translated
# on an Intel Mac, hw.optional.avx2_0 on Apple Silicon) or no sysctl is found.
sysctl_value() {
  if command -v sysctl >/dev/null 2>&1; then
    sysctl -n "$1" 2>/dev/null </dev/null || true
  elif [ -x /usr/sbin/sysctl ]; then
    /usr/sbin/sysctl -n "$1" 2>/dev/null </dev/null || true
  fi
}

# cpu sets arch to arm64 in a shell under Rosetta on Apple Silicon, saying so, and stops on an x64 CPU
# without AVX2 (§ 12 Install). tutti embeds Claude Code, which ships only Bun's standard x64 builds,
# and those need AVX2: a tutti without it would crash with "illegal instruction", without a word why.
# Where the CPU's flags can't be read, it says so and goes on.
cpu() {
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl_value sysctl.proc_translated)" = 1 ]; then
    arch=arm64
    say "This shell runs under Rosetta on Apple Silicon: installing the darwin arm64 build, which runs natively."
    return
  fi
  [ "$arch" = x64 ] || return 0
  if [ "$os" = darwin ]; then
    avx2="$(sysctl_value hw.optional.avx2_0)"
    flags_from="sysctl hw.optional.avx2_0"
  else
    # Each CPU's line of flags, "flags : fpu vme … avx2 …": 1 where one names avx2, 0 where none
    # does, nothing where there is no such line or no file to read.
    avx2="$(awk '/^flags[ \t]*:/ { flags = 1; for (i = 1; i <= NF; i++) if ($i == "avx2") found = 1 }
      END { if (found) print 1; else if (flags) print 0 }' "$cpuinfo" 2>/dev/null </dev/null || true)"
    flags_from="$cpuinfo"
  fi
  case "$avx2" in
  1) ;;
  0) fail "tutti and Claude Code need a CPU with AVX2 (Intel Haswell, 2013, or AMD Excavator, 2015, or
later), and this one has none. Nothing was installed." ;;
  *) say "Couldn't tell from $flags_from whether this CPU has AVX2, which tutti and Claude Code need on x64; installing all the same." ;;
  esac
}

# pick_libc sets libc to musl or glibc, for Linux (§ 12 Install), first match wins: TUTTI_LIBC; what
# ldd --version names (musl's prints "musl libc (<machine>)" and exits 1); else musl where the musl
# loader is. ldd comes first since Debian's and Ubuntu's musl package installs the loader beside glibc.
pick_libc() {
  case "${TUTTI_LIBC:-}" in
  musl | glibc)
    libc="$TUTTI_LIBC"
    return
    ;;
  "") ;;
  *) fail "TUTTI_LIBC is '$TUTTI_LIBC', not musl or glibc" ;;
  esac
  if command -v ldd >/dev/null 2>&1; then
    case "$(ldd --version 2>&1 </dev/null || true)" in
    *musl*)
      libc=musl
      return
      ;;
    *"GNU libc"* | *GLIBC*)
      libc=glibc
      return
      ;;
    esac
  fi
  if [ -e "$lib_dir/ld-musl-$machine.so.1" ]; then
    libc=musl
  else
    libc=glibc
  fi
}

# fetch downloads the address $1 into the file $2, with curl or else wget.
fetch() {
  if [ "$downloader" = curl ]; then
    curl -fsSL -o "$2" "$1" </dev/null
  else
    wget -q -O "$2" "$1" </dev/null
  fi || fail "cannot download $1"
}

# latest prints the latest release's tag, read from where $releases/latest redirects
# (…/releases/tag/v0.9.0): the GitHub API limits the requests of callers without a token. A test's
# folder of releases holds the tag in its file `latest`.
latest() {
  case "$releases" in
  file://*)
    fetch "$releases/latest" "$tmp/latest"
    where="tag/$(cat "$tmp/latest")"
    ;;
  *)
    if [ "$downloader" = curl ]; then
      where="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$releases/latest" </dev/null)" ||
        fail "cannot read the latest release from $releases/latest"
    else
      # wget prints each redirect's Location; the last is the release's page.
      where="$(wget -q -S --spider "$releases/latest" </dev/null 2>&1 |
        sed -n 's/^ *[Ll]ocation: *//p' | tail -n 1 | tr -d '\r')"
    fi
    ;;
  esac
  case "$where" in
  */tag/v* | tag/v*) printf '%s\n' "${where##*tag/}" ;;
  *) fail "cannot read the latest release from $releases/latest (it led to '$where')" ;;
  esac
}

# openssl3 prints the path of an OpenSSL 3 or later, which can verify ed25519, or nothing.
openssl3() {
  for candidate in $openssl_candidates; do
    if command -v "$candidate" >/dev/null 2>&1; then
      case "$("$candidate" version 2>/dev/null </dev/null)" in
      "OpenSSL "[3-9].* | "OpenSSL "[1-9][0-9]*)
        command -v "$candidate"
        return
        ;;
      esac
    fi
  done
}

# verify_signature checks checksums.txt.sig with the release keys, or says why it can't.
verify_signature() {
  openssl="$(openssl3)"
  if [ -z "$openssl" ]; then
    say "The signature of checksums.txt wasn't checked: that needs OpenSSL 3 or later, and there is none here"
    say "(macOS's own openssl is LibreSSL, which can't verify ed25519; brew install openssl@3 provides one)."
    say "The archive's SHA-256 is still checked against checksums.txt."
    return
  fi
  printf '%s\n' "$keys" | awk -v dir="$tmp" '
    /-----BEGIN PUBLIC KEY-----/ { n++; file = dir "/key" n ".pem" }
    file != "" { print > file }
    /-----END PUBLIC KEY-----/ { close(file); file = "" }'
  for key in "$tmp"/key*.pem; do
    [ -f "$key" ] || break
    if "$openssl" pkeyutl -verify -pubin -inkey "$key" -rawin -in "$tmp/checksums.txt" \
      -sigfile "$tmp/checksums.txt.sig" >/dev/null 2>&1 </dev/null; then
      say "Verified the signature of checksums.txt with the release key."
      return
    fi
  done
  fail "checksums.txt.sig doesn't verify checksums.txt with a release key: the release wasn't made by
tutti's release workflow, or was changed since. Nothing was installed."
}

# sha256 prints the SHA-256 of the file $1.
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    fail "neither sha256sum nor shasum is here to check the archive's SHA-256"
  fi
}

# install_dir sets dir to the folder to install in, making it where it doesn't exist.
install_dir() {
  if [ -n "${TUTTI_INSTALL_DIR:-}" ]; then
    dir="$TUTTI_INSTALL_DIR"
    mkdir -p "$dir" 2>/dev/null || fail "cannot make $dir"
    [ -w "$dir" ] || fail "cannot write in $dir. Where it belongs to root, run the install with sudo:
curl -fsSL https://raw.githubusercontent.com/noesis-sol/tutti/main/scripts/install.sh | sudo TUTTI_INSTALL_DIR=$dir sh"
    return
  fi
  if [ -d "$system_dir" ] && [ -w "$system_dir" ]; then
    dir="$system_dir"
    return
  fi
  dir="$HOME/.local/bin"
  mkdir -p "$dir" || fail "cannot make $dir"
  say "Installing in $dir, as $system_dir isn't writable without sudo. To install there instead:"
  say "  curl -fsSL https://raw.githubusercontent.com/noesis-sol/tutti/main/scripts/install.sh | sudo TUTTI_INSTALL_DIR=$system_dir sh"
}

# after says how to put dir on the PATH when it isn't there, or that another tutti comes first.
after() {
  case ":$PATH:" in
  *":$dir:"*)
    first="$(command -v tutti 2>/dev/null || true)"
    if [ -n "$first" ] && [ "$first" != "$dir/tutti" ]; then
      say ""
      say "$first comes before $dir on your PATH, so 'tutti' still runs that one: remove it, or"
      say "put $dir before its folder."
    fi
    ;;
  *)
    say ""
    say "$dir isn't on your PATH. To add it:"
    case "${SHELL:-}" in
    */zsh) say "  echo 'export PATH=\"$dir:\$PATH\"' >> ~/.zshrc && exec zsh" ;;
    */bash)
      if [ "$os" = darwin ]; then
        say "  echo 'export PATH=\"$dir:\$PATH\"' >> ~/.bash_profile && exec bash -l"
      else
        say "  echo 'export PATH=\"$dir:\$PATH\"' >> ~/.bashrc && exec bash"
      fi
      ;;
    */fish) say "  fish_add_path $dir" ;;
    *) say "  echo 'export PATH=\"$dir:\$PATH\"' >> ~/.profile, then log in again" ;;
    esac
    ;;
  esac
  say ""
  say "Next: run 'tutti init' in a project's repository, and 'tutti update' for later releases."
}

main() {
  keys="$release_keys"
  if [ -n "${TUTTI_DOWNLOAD_URL:-}" ]; then
    releases="$TUTTI_DOWNLOAD_URL"
    keys="${TUTTI_TEST_RELEASE_KEY:-$keys}"
    system_dir="${TUTTI_TEST_SYSTEM_DIR:-$system_dir}"
    lib_dir="${TUTTI_TEST_LIB_DIR:-$lib_dir}"
    cpuinfo="${TUTTI_TEST_CPUINFO:-$cpuinfo}"
    openssl_candidates="${TUTTI_TEST_OPENSSL:-$openssl_candidates}"
    say "Test mode: downloading from $releases"
  fi
  case "$keys" in
  *"-----BEGIN PUBLIC KEY-----"*) ;;
  *) fail "this install script holds no release key yet, so it can't tell a release made by tutti's
release workflow from another. Nothing was installed." ;;
  esac

  platform
  cpu
  target="$os $arch"
  suffix=
  libc=
  if [ "$os" = linux ]; then
    pick_libc
    target="$target $libc"
    if [ "$libc" = musl ]; then suffix=_musl; fi
  fi
  if command -v curl >/dev/null 2>&1; then
    downloader=curl
  elif command -v wget >/dev/null 2>&1; then
    downloader=wget
  else
    fail "neither curl nor wget is here to download the release"
  fi
  command -v tar >/dev/null 2>&1 || fail "tar is needed to unpack the release"

  tmp="$(mktemp -d 2>/dev/null || mktemp -d -t tutti)"
  new=
  trap 'rm -rf "$tmp"; [ -z "$new" ] || rm -f "$new"' EXIT
  trap 'exit 1' HUP INT TERM

  tag="${TUTTI_VERSION:-}"
  if [ -z "$tag" ]; then
    tag="$(latest)"
  fi
  case "$tag" in
  v*) ;;
  *) tag="v$tag" ;;
  esac
  archive="tutti_${tag#v}_${os}_${arch}${suffix}.tar.gz"

  say "Installing tutti $tag for $target."
  if [ "$libc" = musl ]; then
    say "A musl build needs libstdc++ and libgcc (on Alpine: apk add libstdc++ libgcc)."
  fi
  fetch "$releases/download/$tag/checksums.txt" "$tmp/checksums.txt"
  fetch "$releases/download/$tag/checksums.txt.sig" "$tmp/checksums.txt.sig"
  # Verified before any sum in it is trusted, or the archive downloaded.
  verify_signature
  want="$(awk -v name="$archive" '$2 == name { print $1 }' "$tmp/checksums.txt")"
  [ -n "$want" ] || fail "checksums.txt has no sum for $archive: release $tag has no binary for $target"
  fetch "$releases/download/$tag/$archive" "$tmp/$archive"
  got="$(sha256 "$tmp/$archive")"
  [ "$got" = "$want" ] || fail "$archive's SHA-256 is $got, not checksums.txt's $want. Nothing was installed."
  mkdir "$tmp/x"
  tar -xzf "$tmp/$archive" -C "$tmp/x" tutti </dev/null || fail "cannot unpack tutti from $archive"
  chmod 755 "$tmp/x/tutti"
  if ! version="$("$tmp/x/tutti" --version </dev/null 2>&1)"; then
    if [ "$libc" = musl ]; then
      fail "the new binary doesn't run: $version
A musl build needs libstdc++ and libgcc: install them (apk add libstdc++ libgcc) and run this again."
    fi
    fail "the new binary doesn't run: $version"
  fi
  [ "$version" = "tutti $tag" ] || fail "the new binary's --version says '$version', not tutti $tag"

  install_dir
  # Copied beside the old binary and renamed over it, so that 'tutti' is never half written.
  new="$dir/.tutti-install-$$"
  cp "$tmp/x/tutti" "$new" || fail "cannot write in $dir"
  chmod 755 "$new"
  mv -f "$new" "$dir/tutti" || fail "cannot replace $dir/tutti"
  new=
  say "Installed $("$dir/tutti" --version </dev/null) in $dir/tutti."
  after
}

main "$@"
