// The repository's files as a footprint sees them (footprint.ts): the names git tracks, indexed to
// tell a path a ticket names from other words, to find the files a bare name, a partial path, a
// folder or a glob means, and the files the check commands name and git merges by union.
import { posix } from "node:path"
import { collapseAny, globMatch, isGlob, nfc, settingsGlobMatch } from "./glob.ts"
import { eachPathToken, setOf, sourceExtensions } from "./text.ts"

// A name whose brackets, single or double, each close around a name within a part of its path, as
// in a route of a Next.js or SvelteKit project: pages/[id].tsx, app/[[...slug]]/page.tsx.
const bracketed = /^(?:[^[\]]|\[[^[\]/]+\]|\[\[[^[\]/]+\]\])*$/

// The extensions of documents, files of prose that tickets cite for conventions and findings more
// often than they change them.
const docExtensions = setOf("md markdown mdx txt rst adoc")

/** path.Clean: no ./ parts, no a/.. pairs, no trailing slash; "." for the root. */
export const clean = (name: string): string => {
  const normal = posix.normalize(name)
  return normal.length > 1 && normal.endsWith("/") ? normal.slice(0, -1) : normal
}

/**
 * Whether name can be a path in the repository, relative to its root: not empty, not the root
 * itself (., a/..), and neither absolute nor leading out of it (/etc/passwd, ../x.go).
 */
export const repoPath = (name: string): boolean => {
  if (name === "" || name.startsWith("/")) return false
  const cleaned = clean(name)
  return cleaned !== "." && cleaned !== ".." && !cleaned.startsWith("../")
}

const dirname = (name: string): string => {
  const end = name.lastIndexOf("/")
  return end === -1 ? "." : name.slice(0, end)
}

const basename = (name: string): string => name.slice(name.lastIndexOf("/") + 1)

/** The extension of a path's base name, lower-cased and without its dot: "" for none. */
export const extensionOf = (name: string): string => {
  const base = basename(name)
  const dot = base.lastIndexOf(".")
  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase()
}

/** The names, each once, sorted. */
export const sorted = (items: Iterable<string>): ReadonlyArray<string> => [...new Set(items)].sort()

/** A name as resolve compares it, and whether it is written as a folder (web/src/, web/src/.). */
const cleanName = (name: string): { readonly name: string; readonly folder: boolean } => {
  const n = nfc(name.startsWith("./") ? name.slice(2) : name)
  if (!repoPath(n)) return { name: "", folder: false }
  const last = basename(n)
  return { name: clean(n), folder: last === "" || last === "." || last === ".." }
}

/** Whether p, a file and not a folder, is a document: prose (.md, .txt) that tickets often cite. */
export const isDocument = (p: string): boolean =>
  !p.endsWith("/") && docExtensions.has(extensionOf(p))

/**
 * The repository's files, to tell a path a ticket names from other words, to find the file a bare
 * name (run.ts) or a partial path (run/ledger.ts) means, and the files the check commands name.
 * Names are compared in one Unicode form, NFC: a name with é written as e and U+0301 (NFD, as
 * Finder gives it) means the file git lists with é, and the reverse.
 */
export interface RepoFiles {
  /** Whether git listed the files; without them, names are judged by their look. */
  readonly known: boolean
  /** The files a name means, as git lists them (see `ticketFootprint`). */
  resolve(name: string, explicit: boolean): ReadonlyArray<string>
  /**
   * What an entry of the files metadata means: the files resolve gives it, or, for a glob (a name
   * with a *, ? or [), the files it matches and the globs holding those other footprints name that
   * it would match (`Footprint.globs`): itself anchored at each folder it matched in, or, matching
   * none of the repository's files (any, the files unknown), itself. A name with brackets and no *
   * or ? (pages/[id].tsx, src/routes/[slug]/) also means the file or folder of that name.
   */
  listed(name: string): {
    readonly files: ReadonlyArray<string>
    readonly globs: ReadonlyArray<string>
  }
  /** The file a name is, as git lists it; for one git doesn't track, the name in NFC. */
  file(name: string): string
  /**
   * Whether word, a path token without an extension, names a file git tracks: as its path, with a /
   * (scripts/release, bin/tutti), or, `marked` (written in backticks) or capitalised, as its base
   * name (`tutti`, Makefile, Dockerfile). Never when the files aren't known: a word without an
   * extension is no path by its look.
   */
  bare(word: string, marked: boolean): boolean
  /** Whether a check command names the file. */
  checks(file: string): boolean
  /**
   * Whether git merges the file by union (`merge=union` in .gitattributes): two tickets' lines in
   * it can't conflict, as git keeps both, so it never holds them apart. A folder is merged by none.
   */
  unioned(file: string): boolean
  /**
   * Whether the settings' `queue.shared_files` name the file, or a footprint's glob as written: a
   * file nearly every ticket edits in place, whose conflicts are cheap to resolve, so that it holds
   * no two tickets apart, though it stays in their footprints. A folder is shared by none.
   */
  shared(file: string): boolean
  /**
   * Whether the repository declares a function a footprint names (declared.ts), which only then
   * counts toward overlap: a name (merge) when a source file declares it, Type.method (Loop.merge)
   * when one declares the type and one the method. Every function, the declarations unknown.
   */
  declares(fn: string): boolean
}

/**
 * Indexes the files git tracks (undefined when git couldn't list them) and finds those the check
 * commands (`scripts/check-fast.sh`, `bun test && sh scripts/lint.sh`) name among them. `union`
 * holds the files git merges by union (`Git.mergedByUnion`), as git lists them; `sharedFiles` the
 * settings' `queue.shared_files`, paths and globs; `declared` the names their source files declare
 * (`readDeclared`), undefined when unknown.
 */
export const repoFiles = (
  tracked: ReadonlyArray<string> | undefined,
  checkCommands: ReadonlyArray<string> = [],
  union: Iterable<string> = [],
  sharedFiles: ReadonlyArray<string> = [],
  declared?: ReadonlySet<string>,
): RepoFiles => {
  // The files as git lists them, by their NFC form: two whose names differ only in form are both meant.
  const files = new Map<string, Array<string>>()
  const byBase = new Map<string, Array<string>>()
  const dirs = new Set<string>(["."])
  for (const f of tracked ?? []) {
    const n = nfc(f)
    if (!repoPath(n)) continue // git lists none of these
    const forms = files.get(n)
    if (forms === undefined) {
      files.set(n, [f])
      const base = byBase.get(basename(n)) ?? []
      base.push(n)
      byBase.set(basename(n), base)
    } else if (!forms.includes(f)) {
      forms.push(f)
    }
    for (let d = dirname(n); d !== "." && !dirs.has(d); d = dirname(d)) dirs.add(d)
  }
  const names = [...files.keys()].sort()
  const known = tracked !== undefined
  const formsOf = (n: string): ReadonlyArray<string> => files.get(n) ?? []

  // The files pattern matches, in any folder as a partial path does: its last part a file's name or
  // a folder's, holding every file under it; and pattern anchored at each folder it matched in
  // (run/*.ts as src/run/*.ts), which holds the files another ticket adds there that it would match,
  // from the repository's root (globHolds). A folder's name is a part of the glob as it is.
  const glob = (
    pattern: string,
  ): { readonly files: ReadonlyArray<string>; readonly anchored: ReadonlyArray<string> } => {
    const pat = pattern.split("/")
    const anchored = new Set<string>()
    const files = names.flatMap((n) => {
      const parts = n.split("/")
      // A glob starting with ** matches from the root wherever it matches deeper.
      const starts = pat[0] === "**" ? 1 : parts.length
      let matched = false
      for (let start = 0; start < starts; start++) {
        for (let end = start + 1; end <= parts.length; end++) {
          if (globMatch(pat, parts.slice(start, end), true)) {
            anchored.add(posix.join(...parts.slice(0, start), pattern))
            matched = true
            break
          }
        }
      }
      return matched ? formsOf(n) : []
    })
    return { files, anchored: sorted(anchored) }
  }

  const resolve = (raw: string, explicit: boolean): ReadonlyArray<string> => {
    const { name, folder: written } = cleanName(raw)
    if (name === "") return []
    const folder = explicit && written
    if (!known) {
      const ext = extensionOf(name)
      // An extension alone (.tsx, as in "the .tsx files") is no file's name.
      const named = sourceExtensions.has(ext) && name.replace(/^\.+/, "").toLowerCase() !== ext
      if (folder) return [`${name}/`]
      return explicit || name.includes("/") || named ? [name] : []
    }
    return literal(name, explicit, folder)
  }

  const listed = (
    raw: string,
  ): { readonly files: ReadonlyArray<string>; readonly globs: ReadonlyArray<string> } => {
    const { name: cleaned, folder } = cleanName(raw)
    if (!isGlob(cleaned)) return { files: resolve(raw, true), globs: [] }
    const name = collapseAny(cleaned)
    // A name with brackets around names and no * or ? (pages/[id].tsx, app/[[...slug]]/) also
    // means the file or folder of that name, one the ticket adds among them.
    const named =
      /[*?]/.test(name) || !bracketed.test(name)
        ? []
        : known
          ? literal(name, true, folder)
          : [folder ? `${name}/` : name]
    const { files, anchored } = known ? glob(name) : { files: [], anchored: [] }
    return {
      files: sorted([...files, ...named]),
      globs: files.length === 0 ? [name] : anchored,
    }
  }

  // What a cleaned name means as it is written, not as a glob.
  const literal = (name: string, explicit: boolean, folder: boolean): ReadonlyArray<string> => {
    const found = [...formsOf(name)]
    for (const n of byBase.get(basename(name)) ?? []) {
      if (n.endsWith(`/${name}`)) found.push(...formsOf(n))
    }
    if (explicit) {
      for (const n of names) {
        if (n.startsWith(`${name}/`) || n.includes(`/${name}/`)) found.push(...formsOf(n))
      }
      for (const d of [...dirs].sort()) {
        if (d === name || d.endsWith(`/${name}`)) found.push(`${d}/`)
      }
    }
    if (found.length > 0) return found
    if (folder) return [`${name}/`]
    return explicit || (name.includes("/") && dirs.has(dirname(name))) ? [name] : []
  }

  const bare = (word: string, marked: boolean): boolean => {
    if (!known) return false
    const { name } = cleanName(word)
    if (name.includes("/")) return files.has(name)
    return (marked || /^\p{Lu}/u.test(name)) && byBase.has(name)
  }

  const unions = new Set(union)
  const check = new Set<string>()
  for (const command of checkCommands) {
    eachPathToken(
      command,
      (token) => {
        const found = resolve(token, false)
        for (const f of found) check.add(f)
        return found.length > 0
      },
      bare,
    )
  }

  return {
    known,
    resolve,
    listed,
    file: (name) => {
      const forms = files.get(nfc(name))
      if (forms === undefined) return nfc(name)
      return forms.includes(name) ? name : (forms[0] ?? nfc(name))
    },
    checks: (f) => check.has(f),
    bare,
    unioned: (f) => !f.endsWith("/") && unions.has(f),
    shared: (f) =>
      !f.endsWith("/") && sharedFiles.some((glob) => settingsGlobMatch(nfc(glob), nfc(f))),
    declares: (fn) => declared === undefined || fn.split(".").every((part) => declared.has(part)),
  }
}
