// The start question's Spec file field (§ 5 item 3, § 7.1), as pure functions: what was typed read
// as a path or a URL, Tab's completions, the file browser's rows, and paths as the field shows
// them. As orchestra's spec field (internal/tui/spec_field.go): a path typed or pasted, a relative
// one from the repository, `~` or `~/` for the home folder, a path in quotes, or a file dropped on
// the terminal with its spaces escaped by backslashes; or an https:// URL, which nothing completes.
// The folders are read by specFiles.ts.
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { isSpecUrl } from "../run/specSource.ts"

/** The files offered as specs, by Tab and by the browser: another file of text can still be typed. */
export const specExtensions: ReadonlyArray<string> = [".md", ".markdown", ".txt"]

/** Whether a file named `name` is offered as a spec. */
export const isSpecName = (name: string): boolean =>
  specExtensions.some((extension) => name.toLowerCase().endsWith(extension))

/** Where a path typed starts: the repository, for a relative one, and the home folder, for `~`. */
export interface Where {
  readonly repo: string
  /** The home folder; "" when unknown, `~` then a folder of that name. */
  readonly home: string
}

/** What was typed in the field, read. */
export type Typed =
  | { readonly _tag: "Empty" }
  /** A URL, as typed, without the spaces and quotes around it. */
  | { readonly _tag: "Url"; readonly url: string }
  /** A path, absolute and normal. */
  | { readonly _tag: "Path"; readonly path: string }

/** `text` without the spaces around it, and the quotes around it, `'…'` or `"…"`. */
export const unquoted = (text: string): string => {
  const trimmed = text.trim()
  const first = trimmed[0]
  return trimmed.length >= 2 && (first === "'" || first === '"') && trimmed.at(-1) === first
    ? trimmed.slice(1, -1)
    : trimmed
}

/** `text` without the backslash before each character a shell would take literally. */
export const unescapeShell = (text: string): string => text.replace(/\\(.)/gsu, "$1")

/** The path `text` names from `where`, absolute and normal: `~` from home, a relative one from repo. */
const absolute = (text: string, where: Where): string => {
  if (where.home !== "" && (text === "~" || text.startsWith("~/"))) {
    return resolve(where.home, `.${text.slice(1)}`)
  }
  return resolve(where.repo, text)
}

/**
 * What `typed` names, from `where`: nothing, a URL, or a path, absolute and normal. A path with
 * backslashes that names nothing (by `exists`) is read again without them, as a file dropped on
 * the terminal is pasted with its spaces escaped, and taken where that names something.
 */
export const readTyped = (
  typed: string,
  where: Where,
  exists: (path: string) => boolean,
): Typed => {
  const text = unquoted(typed)
  if (text === "") return { _tag: "Empty" }
  if (isSpecUrl(text)) return { _tag: "Url", url: text }
  const path = absolute(text, where)
  if (text.includes("\\") && !exists(path)) {
    const unescaped = unescapeShell(text)
    if (unescaped !== "") {
      const other = absolute(unescaped, where)
      if (exists(other)) return { _tag: "Path", path: other }
    }
  }
  return { _tag: "Path", path }
}

/** An entry of a folder: its name, and whether it is a folder (or a link to one). */
export interface Entry {
  readonly name: string
  readonly folder: boolean
}

/** Where Tab completes what was typed: the folder to read, what was typed up to it, the name begun. */
export interface Completing {
  /** The folder the completions are in, absolute. */
  readonly folder: string
  /** What was typed up to and with its last `/`, which each completion starts with. */
  readonly before: string
  /** What was typed after it: the start of each completion's name. */
  readonly name: string
}

/**
 * Where Tab completes `typed`, from `where`: in the folder typed so far (the repository with none),
 * names starting with what follows its last `/`. Null for a URL, which nothing completes, and for
 * `~` alone, which completes to `~/` (completeHome).
 */
export const completing = (
  typed: string,
  where: Where,
  exists: (path: string) => boolean,
): Completing | null => {
  if (isSpecUrl(unquoted(typed)) || completeHome(typed, where) !== null) return null
  const cut = typed.lastIndexOf("/") + 1
  const before = typed.slice(0, cut)
  const name = typed.slice(cut)
  if (before.trim() === "") return { folder: where.repo, before, name }
  const read = readTyped(before, where, exists)
  return read._tag === "Path" ? { folder: read.path, before, name } : null
}

/** `~` alone completes to `~/` where the home folder is known; null for anything else. */
export const completeHome = (typed: string, where: Where): string | null =>
  where.home !== "" && typed.trim() === "~" ? `${typed}/` : null

/**
 * Tab's completions in `at.folder`, whose entries are `entries`: its folders, with a `/`, and its
 * spec files whose names start with `at.name`, each as the whole path typed; hidden ones only once
 * `at.name` starts with a `.`. In order of name.
 */
export const completions = (at: Completing, entries: ReadonlyArray<Entry>): ReadonlyArray<string> =>
  entries
    .filter(
      (entry) =>
        entry.name.startsWith(at.name) &&
        (!entry.name.startsWith(".") || at.name.startsWith(".")) &&
        (entry.folder || isSpecName(entry.name)),
    )
    .map((entry) => `${at.before}${entry.name}${entry.folder ? "/" : ""}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

/** The start every one of `list` shares: what Tab fills in. "" for none. */
export const sharedStart = (list: ReadonlyArray<string>): string => {
  const [first, ...rest] = list
  if (first === undefined) return ""
  let end = first.length
  for (const other of rest) {
    let at = 0
    while (at < end && at < other.length && first[at] === other[at]) at++
    end = at
  }
  // Not half a surrogate pair.
  const code = first.charCodeAt(end - 1)
  return first.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end)
}

/** A row of the file browser: `..`, a folder, a spec file, or another file, which can't be chosen. */
export type Row =
  | { readonly _tag: "Up" }
  | { readonly _tag: "Folder"; readonly name: string }
  | { readonly _tag: "File"; readonly name: string; readonly spec: boolean }

/**
 * The browser's rows for a folder whose entries are `entries`: `..` first (but at the root), then
 * its folders, then its files, each in order of name; dotfiles left out.
 */
export const browserRows = (entries: ReadonlyArray<Entry>, atRoot: boolean): ReadonlyArray<Row> => {
  const shown = entries
    .filter((entry) => !entry.name.startsWith("."))
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return [
    ...(atRoot ? [] : [{ _tag: "Up" } as const]),
    ...shown
      .filter((entry) => entry.folder)
      .map((entry) => ({ _tag: "Folder", name: entry.name }) as const),
    ...shown
      .filter((entry) => !entry.folder)
      .map((entry) => ({ _tag: "File", name: entry.name, spec: isSpecName(entry.name) }) as const),
  ]
}

/** The path `path` in the home folder `home` as from `~`; else as it is. */
export const tildeOf = (path: string, home: string): string => {
  if (home === "") return path
  if (path === home) return "~"
  const rel = relative(home, path)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
    ? `~/${rel.split(sep).join("/")}`
    : path
}

/**
 * The file at `path`, absolute, as the field shows it once chosen in the browser: from the
 * repository when inside it, else from `~` when in the home folder, else absolute.
 */
export const shownPath = (path: string, where: Where): string => {
  const rel = relative(where.repo, path)
  if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return rel.split(sep).join("/")
  return tildeOf(path, where.home)
}

/** The folder `path` as the browser's border names it: from `~`, ending in `/`. */
export const folderLabel = (path: string, home: string): string => {
  const shown = tildeOf(path, home)
  return shown.endsWith("/") ? shown : `${shown}/`
}

/** The folder above `path`, or null at the root. */
export const parentOf = (path: string): string | null => {
  const up = resolve(path, "..")
  return up === path ? null : up
}

/** `path` in the folder `folder`. */
export const inFolder = (folder: string, name: string): string => join(folder, name)
