#!/bin/sh
# scripts/release-notes.sh: prints a version's release notes, its section of CHANGELOG.md without
# the heading: from the line after '## [X.Y.Z] - <date>' to the next version's heading. The release
# workflow (.github/workflows/release.yml) makes them the Release's notes. It fails when the
# changelog has no section, or an empty one, for the version.
#
#   scripts/release-notes.sh v0.9.0 [CHANGELOG.md]
set -e
if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "usage: $0 <version> [changelog]" >&2
  exit 2
fi
version="${1#v}"
changelog="${2:-CHANGELOG.md}"
# The section ends at the next '## ' heading, or at the links under the last section
# ('[0.1.0]: https://…'). Blank lines at its start and end are dropped.
awk -v heading="## [$version]" '
  index($0, "## ") == 1 && found { exit }
  /^\[[^]]*\]: / && found { exit }
  found {
    if ($0 == "") { blank++; next }
    if (printed) for (; blank > 0; blank--) print ""
    blank = 0; printed = 1; print
  }
  $0 == heading || index($0, heading " ") == 1 { found = 1 }
  END { if (!printed) exit 1 }' "$changelog" ||
  { echo "$changelog has no notes for $version under '## [$version]'" >&2; exit 1; }
