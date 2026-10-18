// The embedded Claude Code's extracted copies (§ 12, docs/spikes/07-compile.md § 2). The SDK's
// `extractFromBunfs` writes the embedded file to `<tmp>/claude-<uid>/claude-agent-sdk-<hash>/<name>`,
// `<hash>` being the first 16 hex digits of its content's sha256, and to learn the hash it reads and
// hashes all 250-268 MB of it on every call: 130-160 ms a start on macOS arm64, about 1 s under
// Rosetta, even when the copy is there already. Two things here spare that and the disk:
//
// - **The copy already there**, found without reading the embedded file: the SDK's manifest.json
//   names each platform's checksum and size, so a compiled build's entry, which names its target,
//   knows the folder's name. The copy is used only if it is a regular file of the manifest's size,
//   owned by the user, in a `claude-<uid>` folder the user owns with mode 0700, as the SDK checks
//   it. Otherwise `extractFromBunfs` runs as before.
// - **Other versions' copies,** removed once the run has started. Nothing else removes them: each
//   Claude Code version leaves 250-268 MB, and a Linux /tmp that isn't a tmpfs is never cleaned.
//   A `claude-agent-sdk-<hash>` folder there that holds a `claude-*` file and is untouched for a
//   day goes: another tutti, of another version, may still be running its own, so a run touches
//   its folder as it starts and every hour while it runs.
import { lstatSync, readdirSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
// The SDK's package doesn't export its manifest.json, so it is imported by its path; a compiled
// build bundles it.
import manifest from "../../node_modules/@anthropic-ai/claude-agent-sdk/manifest.json" with {
  type: "json",
}

/** The embedded Claude Code's checksum (sha256, hex) and size in bytes, as the manifest has them. */
export interface Known {
  readonly checksum: string
  readonly size: number
}

/** What the SDK's manifest says of `target`'s Claude Code (`darwin-arm64`, …), or null. */
export const knownFor = (target: string): Known | null => {
  const platforms: Record<string, Known | undefined> = manifest.platforms
  const platform = platforms[target]
  return platform === undefined ? null : { checksum: platform.checksum, size: platform.size }
}

/**
 * The folder `extractFromBunfs` extracts into, `<tmp>/claude-<uid>`, `<tmp>` being
 * CLAUDE_CODE_TMPDIR, else /tmp on macOS, else the system's; null with no user ID (Windows).
 */
export const extractionBase = (
  env: Record<string, string | undefined>,
  platform: string,
  uid: number | undefined,
): string | null => {
  if (uid === undefined) return null
  const tmp = env.CLAUDE_CODE_TMPDIR || (platform === "darwin" ? "/tmp" : tmpdir())
  return join(tmp, `claude-${uid}`)
}

/** A version's folder in the extraction base: `claude-agent-sdk-` and 16 hex digits. */
const versionFolder = /^claude-agent-sdk-[0-9a-f]{16}$/

const lstat = (path: string) => {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

/**
 * The copy `extractFromBunfs` made of the embedded `file` in `base`, by its `known` checksum and
 * size, without reading `file`; null when it isn't there or isn't one to trust.
 */
export const extractedCopy = (
  file: string,
  known: Known,
  base: string,
  uid: number,
): string | null => {
  const folder = lstat(base)
  if (folder === null || !folder.isDirectory() || folder.uid !== uid) return null
  if ((folder.mode & 0o777) !== 0o700) return null
  const path = join(base, `claude-agent-sdk-${known.checksum.slice(0, 16)}`, basename(file))
  const copy = lstat(path)
  if (copy === null || !copy.isFile() || copy.uid !== uid || copy.size !== known.size) return null
  return path
}

/** How long another version's copy stays untouched before it is removed. */
export const staleAfterMs = 24 * 60 * 60 * 1000

/** How often a run touches its own copy's folder, so that no other tutti removes it. */
export const touchEveryMs = 60 * 60 * 1000

/**
 * The other versions' folders in `base` to remove: each named as a version's, the user's own,
 * holding a `claude-*` file, and untouched for `staleAfter` ms at `now`. `keep`'s is never one.
 */
export const staleCopies = (
  base: string,
  keep: string,
  uid: number,
  now: number,
  staleAfter: number = staleAfterMs,
): Array<string> => {
  let names: Array<string>
  try {
    names = readdirSync(base)
  } catch {
    return []
  }
  return names.flatMap((name) => {
    const folder = join(base, name)
    if (!versionFolder.test(name) || folder === dirname(keep)) return []
    const stat = lstat(folder)
    if (stat === null || !stat.isDirectory() || stat.uid !== uid) return []
    if (now - stat.mtimeMs < staleAfter) return []
    try {
      return readdirSync(folder).some((entry) => entry.startsWith("claude-")) ? [folder] : []
    } catch {
      return []
    }
  })
}

/** Marks `path`'s folder as in use: its modification time, now. */
const touch = (path: string): void => {
  try {
    const now = new Date()
    utimesSync(dirname(path), now, now)
  } catch {
    // Gone, or not the user's: nothing to keep.
  }
}

/**
 * Keeps the extracted copy at `path` from other tuttis' cleanup, now and every hour while tutti
 * runs, and removes other versions' stale copies, off the startup path. Neither timer keeps tutti
 * running.
 */
export const tidyExtracted = (path: string, base: string, uid: number): void => {
  touch(path)
  setInterval(() => touch(path), touchEveryMs).unref()
  setTimeout(() => {
    for (const folder of staleCopies(base, path, uid, Date.now())) {
      try {
        rmSync(folder, { recursive: true, force: true })
      } catch {
        // Another tutti's cleanup got there first, or it can't go: it is tried again next run.
      }
    }
  }, 0).unref()
}
