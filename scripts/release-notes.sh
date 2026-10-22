#!/bin/sh
# scripts/release-notes.sh: prints a version's release notes, its section of CHANGELOG.md without
# the heading: from the line after '## [X.Y.Z] - <date>' to the next version's heading. The release
# workflow (.github/workflows/release.yml) makes them the Release's notes. It fails when the
# changelog has no section, or an empty one, for the version.
#
# GitHub refuses a Release's notes over 125,000 characters (HTTP 422: tutti 0.1.1's section, every
# change since tutti began, was 253,019). So a longer section is cut after the last whole entry (a
# line starting '- ' or '#', with the lines after it) that fits in RELEASE_NOTES_LIMIT characters,
# 120,000 by default, and a last line says how many more there are and links to CHANGELOG.md at the
# version's tag, in GITHUB_REPOSITORY (noesis-sol/tutti outside GitHub Actions).
#
#   scripts/release-notes.sh v0.9.0 [CHANGELOG.md]
set -e
if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "usage: $0 <version> [changelog]" >&2
  exit 2
fi
version="${1#v}"
changelog="${2:-CHANGELOG.md}"
limit="${RELEASE_NOTES_LIMIT:-120000}"
link="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-noesis-sol/tutti}/blob/v$version/CHANGELOG.md"
# The section ends at the next '## ' heading, or at the links under the last section
# ('[0.1.0]: https://…'). Blank lines at its start and end are dropped.
section=$(awk -v heading="## [$version]" '
  index($0, "## ") == 1 && found { exit }
  /^\[[^]]*\]: / && found { exit }
  found {
    if ($0 == "") { blank++; next }
    if (printed) for (; blank > 0; blank--) print ""
    blank = 0; printed = 1; print
  }
  $0 == heading || index($0, heading " ") == 1 { found = 1 }
  END { if (!printed) exit 1 }' "$changelog") ||
  { echo "$changelog has no notes for $version under '## [$version]'" >&2; exit 1; }
# Whole entries while they fit, counted in awk's length (bytes where awk counts them, never fewer
# than GitHub's characters).
printf '%s\n' "$section" | awk -v limit="$limit" -v link="$link" '
  function keep() { if (open) { entry[++count] = text; open = 0 } }
  /^- / || /^#/ { keep(); text = $0; open = 1; next }
  { if (open) text = text "\n" $0; else { text = $0; open = 1 } }
  END {
    keep()
    for (i = 1; i <= count; i++) {
      size = length(entry[i]) + 1
      if (total + size > limit) break
      total += size; shown = i
    }
    if (shown == count) { for (i = 1; i <= count; i++) print entry[i]; exit }
    for (i = 1; i <= shown; i++) {
      if (i == shown) sub(/\n+$/, "", entry[i])
      print entry[i]
    }
    if (shown > 0) print ""
    printf "…and %d more, too many for a Release: every change is in %s\n", count - shown, link
  }'
