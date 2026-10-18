#!/bin/sh
# scripts/fetch-shellcheck.sh: prints the path of the pinned shellcheck, downloading it into
# .cache/shellcheck/ (git-ignored) first if needed, and verifying the archive by its sha256.
# scripts/check.sh runs it. Exits 2 when it can't be downloaded, 1 when it can't be trusted, isn't
# built for this machine or can't be extracted.
#
# The binary is extracted to a temporary name and renamed into place only once tar succeeds, so a
# failed extraction (a full disk) never leaves a truncated binary that later checks would run. A
# cached binary that doesn't run (one left by an older version of this script) is fetched again.
set -e
cd "$(dirname "$0")/.."

SHELLCHECK_VERSION=v0.11.0

# pinned_sha256 ARCHIVE: the sha256 of a release archive, from the release's assets.
pinned_sha256() {
  case "$1" in
  shellcheck-v0.11.0.darwin.aarch64.tar.gz) echo 339b930feb1ea764467013cc1f72d09cd6b869ebf1013296ba9055ab2ffbd26f ;;
  shellcheck-v0.11.0.darwin.x86_64.tar.gz) echo c2c15e08df0e8fbc374c335b230a7ee958c313fa5714817a59aa59f1aa594f51 ;;
  shellcheck-v0.11.0.linux.aarch64.tar.gz) echo 68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc ;;
  shellcheck-v0.11.0.linux.x86_64.tar.gz) echo b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6 ;;
  *) return 1 ;;
  esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

cache=.cache/shellcheck/$SHELLCHECK_VERSION
if [ -x "$cache/shellcheck" ] && { "$cache/shellcheck" --version >/dev/null 2>&1; } 2>/dev/null; then
  echo "$cache/shellcheck"
  exit 0
fi
os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$arch" in
arm64) arch=aarch64 ;;
amd64) arch=x86_64 ;;
esac
archive=shellcheck-$SHELLCHECK_VERSION.$os.$arch.tar.gz
if ! want=$(pinned_sha256 "$archive"); then
  echo "shellcheck $SHELLCHECK_VERSION has no pinned build for $os $arch" >&2
  exit 1
fi
mkdir -p "$cache"
url=https://github.com/koalaman/shellcheck/releases/download/$SHELLCHECK_VERSION/$archive
if ! curl -fsSL --retry 2 -o "$cache/$archive.part" "$url"; then
  echo "could not download $url" >&2
  exit 2
fi
got=$(sha256_of "$cache/$archive.part")
if [ "$got" != "$want" ]; then
  echo "$archive has sha256 $got, but $want is pinned: not using it" >&2
  rm -f "$cache/$archive.part"
  exit 1
fi
if ! tar -xzOf "$cache/$archive.part" "shellcheck-$SHELLCHECK_VERSION/shellcheck" >"$cache/shellcheck.part"; then
  echo "could not extract shellcheck from $archive" >&2
  rm -f "$cache/$archive.part" "$cache/shellcheck.part"
  exit 1
fi
chmod 755 "$cache/shellcheck.part"
mv -f "$cache/shellcheck.part" "$cache/shellcheck"
rm -f "$cache/$archive.part"
echo "$cache/shellcheck"
