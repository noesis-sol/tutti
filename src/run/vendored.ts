// Vendored paths (§ 5 item 5, § 8.4): the copies of other projects a repository keeps, as git
// subtrees, which are no part of its own files. A path is vendored where .gitattributes gives it
// linguist-vendored (as git check-attr reads it, so `repos/** linguist-vendored` holds every file
// under repos/), or where the settings' `vendored` globs match it, for a project that doesn't want
// the attribute. The predictor doesn't list them (predict.ts), and a footprint drops those a ticket
// names or the predictor answers (footprint.ts), so they make no overlap.
import { join } from "node:path"
import { Effect, FileSystem } from "effect"
import { settingsFile } from "../project/settings.ts"
import { Git } from "../services/Git.ts"
import { nfc, settingsGlobMatch } from "./glob.ts"

/** The repository's vendored paths: the files git tracks that are, and the settings' globs. */
export interface Vendored {
  /** The tracked files .gitattributes or the settings' globs mark vendored, as git lists them. */
  readonly files: ReadonlySet<string>
  /** The settings' `vendored`: globs, a name without a slash matching in any folder. */
  readonly globs: ReadonlyArray<string>
}

/** A repository with nothing vendored. */
export const noneVendored: Vendored = { files: new Set(), globs: [] }

/** Whether one of the settings' globs matches the path, a folder's without its trailing /. */
const globbed = (globs: ReadonlyArray<string>, path: string): boolean => {
  const p = nfc(path.endsWith("/") ? path.slice(0, -1) : path)
  return globs.some((glob) => settingsGlobMatch(nfc(glob), p))
}

/**
 * Of `files`, those git tracks in the repository at `repo`, the ones that are vendored: as git
 * check-attr reads linguist-vendored (none when git can't say), and as `globs` match them.
 */
export const readVendored = (
  repo: string,
  files: ReadonlyArray<string>,
  globs: ReadonlyArray<string>,
): Effect.Effect<Vendored, never, Git> =>
  Effect.gen(function* () {
    const marked = yield* (yield* Git)
      .vendoredFiles(repo, files)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
    return {
      files: new Set([...marked, ...files.filter((f) => globbed(globs, f))]),
      globs,
    }
  })

const dirname = (name: string): string => {
  const end = name.lastIndexOf("/")
  return end === -1 ? "." : name.slice(0, end)
}

/**
 * Whether a path is vendored, given `tracked`, the files git tracks in NFC: a tracked file that is
 * one of `vendored.files`, a path the settings' globs match, and any other path (a folder, ending
 * in /, or a file git doesn't track) in a folder whose tracked files are all vendored, the nearest
 * folder git tracks files in, below the root, deciding.
 */
export const vendoredTest = (
  tracked: ReadonlyArray<string>,
  vendored: Vendored,
): ((path: string) => boolean) => {
  if (vendored.files.size === 0 && vendored.globs.length === 0) return () => false
  const files = new Set(tracked)
  const marked = new Set([...vendored.files].map(nfc))
  // The folders holding a tracked file, and those holding one that isn't vendored.
  const dirs = new Set<string>()
  const own = new Set<string>()
  for (const f of files) {
    const isOwn = !marked.has(f)
    for (let d = dirname(f); d !== "."; d = dirname(d)) {
      if (dirs.has(d) && (!isOwn || own.has(d))) break
      dirs.add(d)
      if (isOwn) own.add(d)
    }
  }
  return (path) => {
    if (globbed(vendored.globs, path)) return true
    const p = nfc(path.endsWith("/") ? path.slice(0, -1) : path)
    if (files.has(p)) return marked.has(p)
    let d = p
    while (d !== "." && !dirs.has(d)) d = dirname(d)
    return d !== "." && !own.has(d)
  }
}

/**
 * The patterns of a .gitattributes that mark paths vendored (`linguist-vendored`, or
 * `linguist-vendored=true`), in the order it gives them.
 */
export const vendoredPatterns = (attributes: string): ReadonlyArray<string> =>
  attributes.split("\n").flatMap((line) => {
    const [pattern, ...attrs] = line.trim().split(/\s+/)
    if (pattern === undefined || pattern === "" || pattern.startsWith("#")) return []
    let set = false
    for (const attr of attrs) {
      if (attr === "linguist-vendored" || attr === "linguist-vendored=true") set = true
      else if (attr.startsWith("linguist-vendored=") || /^[-!]linguist-vendored$/.test(attr)) {
        set = false
      }
    }
    return set ? [pattern] : []
  })

/**
 * The START block's note on the vendored paths: `vendored: repos/** (from .gitattributes)`, the
 * settings' globs after the attribute's patterns; null when neither marks any.
 */
export const vendoredNote = (
  attributes: ReadonlyArray<string>,
  settings: ReadonlyArray<string>,
): string | null => {
  const parts = [
    ...(attributes.length === 0 ? [] : [`${attributes.join(", ")} (from .gitattributes)`]),
    ...(settings.length === 0 ? [] : [`${settings.join(", ")} (from ${settingsFile})`]),
  ]
  return parts.length === 0 ? null : `vendored: ${parts.join(", ")}`
}

/**
 * The START block's note on the vendored paths of the project at `repo`, from its root
 * .gitattributes and the settings' `globs`; null when neither marks any, or the file can't be read.
 */
export const readVendoredNote = (
  repo: string,
  globs: ReadonlyArray<string>,
): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const attributes = yield* fs
      .readFileString(join(repo, ".gitattributes"))
      .pipe(Effect.orElseSucceed(() => ""))
    return vendoredNote(vendoredPatterns(attributes), globs)
  })
