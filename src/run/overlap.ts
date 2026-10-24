// Whether two footprints overlap (footprint.ts, § 5 item 5): an area, a function, or a file or
// folder both work on and one of them is to change (`sharedFile`); and the functions each names
// placed in the files they mention, read from the checkout, for a fill's comparisons.
import { join } from "node:path"
import { Effect, FileSystem, Option } from "effect"
import type { Footprint } from "./footprint.ts"
import { globHolds, globsMeet } from "./glob.ts"
import { isDocument, repoPath } from "./repoFiles.ts"

// A word of source code, for the functions a file mentions.
const identifier = /[A-Za-z_]\w*/g

/**
 * Whether a repository file mentions a function, by its name and its type when it gives one
 * (Loop.merge: Loop and merge), as identifiers. A file whose contents aren't known mentions none.
 */
export type Mentions = (file: string, fn: string) => boolean

/** Mentions read from the files' contents, by path. */
export const mentionsIn = (contents: ReadonlyMap<string, string>): Mentions => {
  const words = new Map<string, ReadonlySet<string>>()
  return (file, fn) => {
    let known = words.get(file)
    if (known === undefined) {
      const content = contents.get(file)
      if (content === undefined) return false
      known = new Set(content.match(identifier) ?? [])
      words.set(file, known)
    }
    const dot = fn.indexOf(".")
    return dot === -1 ? known.has(fn) : known.has(fn.slice(0, dot)) && known.has(fn.slice(dot + 1))
  }
}

/** The most of a file read for the functions it mentions. */
export const maxSource = 4 << 20

/**
 * The files `shared` may ask mentions about as it compares each pair: those either footprint works
 * on, for a pair of which one names a function and that share no area or function, which `shared`
 * would answer first. A folder is never asked about.
 */
export const askedFiles = (
  pairs: Iterable<readonly [Footprint, Footprint]>,
): ReadonlySet<string> => {
  const asked = new Set<string>()
  for (const [a, b] of pairs) {
    if (a.funcs.length + b.funcs.length === 0) continue
    if (a.areas.some((x) => b.areas.includes(x)) || sharedFunc(a, b) !== "") continue
    for (const f of [...a.files, ...a.changed, ...b.files, ...b.changed])
      if (!f.endsWith("/") && repoPath(f)) asked.add(f)
  }
  return asked
}

/**
 * The contents of files read so far, by path, kept for one fill so that each is read once however
 * often its footprint is compared: undefined for a file that couldn't be read.
 */
export type Sources = Map<string, string | undefined>

/**
 * Places the functions of the footprints paired in the files `shared` asks about comparing them
 * (askedFiles), read from the checkout at repo and kept in `sources`: a fill's comparisons read
 * none for footprints that name no function, and each file once.
 */
export const readMentions = (
  repo: string,
  pairs: Iterable<readonly [Footprint, Footprint]>,
  sources: Sources = new Map(),
): Effect.Effect<Mentions, never, FileSystem.FileSystem> =>
  Effect.map(readFiles(repo, askedFiles(pairs), sources), mentionsIn)

/**
 * The contents of the files the footprints work on, in the checkout at repo: up to `maxSource`
 * bytes of each, never a file that resolves outside repo. A file that can't be read is left out.
 */
export const readSources = (
  repo: string,
  footprints: Iterable<Footprint>,
): Effect.Effect<ReadonlyMap<string, string>, never, FileSystem.FileSystem> => {
  const wanted = new Set<string>()
  for (const fp of footprints) {
    for (const f of [...fp.files, ...fp.changed]) if (!f.endsWith("/") && repoPath(f)) wanted.add(f)
  }
  return readFiles(repo, wanted, new Map())
}

/**
 * The contents of files, in the checkout at repo: up to `maxSource` bytes of each, never a file that
 * resolves outside repo, those in `sources` as read before, and the others read into it. A file
 * that can't be read is left out.
 */
const readFiles = (
  repo: string,
  files: ReadonlySet<string>,
  sources: Sources,
): Effect.Effect<ReadonlyMap<string, string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const unread = [...files].filter((f) => !sources.has(f))
    const root =
      unread.length === 0 ? repo : yield* fs.realPath(repo).pipe(Effect.orElseSucceed(() => repo))
    for (const file of unread) {
      const content = yield* Effect.scoped(
        Effect.gen(function* () {
          const real = yield* fs.realPath(join(repo, file))
          if (!real.startsWith(`${root}/`)) return Option.none<Uint8Array>()
          const handle = yield* fs.open(real, { flag: "r" })
          return yield* handle.readAlloc(maxSource)
        }),
      ).pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()))
      sources.set(
        file,
        Option.isSome(content) ? new TextDecoder().decode(content.value) : undefined,
      )
    }
    const contents = new Map<string, string>()
    for (const file of files) {
      const content = sources.get(file)
      if (content !== undefined) contents.set(file, content)
    }
    return contents
  })

/** Whether two function names can mean one function: the same name, and the same type when both give one. */
const funcsMeet = (a: string, b: string): boolean => {
  const [ta, na] = a.includes(".") ? a.split(".", 2) : ["", a]
  const [tb, nb] = b.includes(".") ? b.split(".", 2) : ["", b]
  return na === nb && (ta === "" || tb === "" || ta === tb)
}

/**
 * Whether p is a file or folder the footprint names, is under a folder it names, was changed, or is
 * held by one of its globs (globHolds).
 */
const takesIn = (fp: Footprint, p: string): boolean =>
  fp.changed.includes(p) ||
  fp.files.some((f) => f === p || (f.endsWith("/") && p.startsWith(f))) ||
  fp.globs.some((g) => globHolds(g, p))

/**
 * Whether the footprint works where glob g does: on a file or folder g holds, or by a glob of its own
 * that can match a file g does.
 */
const meetsGlob = (fp: Footprint, g: string): boolean =>
  fp.files.some((p) => globHolds(g, p)) || fp.globs.some((h) => globsMeet(g, h))

/** Whether p is a folder holding a file among files: one that exists, or one a ticket adds there. */
const holdsNamed = (p: string, files: ReadonlyArray<string>): boolean =>
  p.endsWith("/") && files.some((f) => !f.endsWith("/") && f.startsWith(p))

/** A function both footprints name, as a names it, or "". */
export const sharedFunc = (a: Footprint, b: Footprint): string =>
  a.funcs.find((x) => b.funcs.some((y) => funcsMeet(x, y))) ?? ""

/**
 * Whether the footprint is to change p, a file or a folder: its worktree changed p, it names p or
 * a folder p is under and doesn't only cite it (`cited`), one of its globs holds p, or, `named` true, it names a function p
 * mentions while its files metadata lists none and p is no document, which mentions functions
 * without holding them.
 */
const changes = (fp: Footprint, p: string, named: boolean): boolean =>
  fp.changed.includes(p) ||
  (named && !fp.listed && !isDocument(p)) ||
  fp.files.some(
    (f) => (f === p || (f.endsWith("/") && p.startsWith(f))) && !fp.cited.includes(f),
  ) ||
  fp.globs.some((g) => globHolds(g, p))

/**
 * A file both footprints work on, for which keep holds (any, without keep), or "". A ticket works
 * on a file it names, one under a folder it names and one its worktree changed (takesIn), and on
 * one the other names that mentions a function it names; a file both work on is shared unless both
 * name functions it mentions: they are compared by function instead. A folder both name is shared
 * only when neither names a file in it (a new folder): otherwise its files are compared one by one.
 * A file both work on is shared only when one of them is to change it (`changes`): two tickets that
 * only cite a document, or name files their files metadata doesn't list, don't conflict over it. A
 * glob works on the files it holds (globHolds), and is compared itself, as a new folder is, only
 * when it holds no file either names: its files are compared one by one too.
 */
export const sharedFile = (
  a: Footprint,
  b: Footprint,
  mentions: Mentions | undefined,
  keep?: (file: string) => boolean,
): string => {
  const namesIn = (fp: Footprint, p: string) =>
    mentions !== undefined && !p.endsWith("/") && fp.funcs.some((fn) => mentions(p, fn))
  const seen = new Set<string>()
  for (const p of [...a.files, ...b.files, ...a.changed, ...b.changed]) {
    if (seen.has(p) || holdsNamed(p, a.files) || holdsNamed(p, b.files)) continue
    seen.add(p)
    const aIn = namesIn(a, p)
    const bIn = namesIn(b, p)
    const both = (aIn || takesIn(a, p)) && (bIn || takesIn(b, p)) && !(aIn && bIn)
    if (both && (changes(a, p, aIn) || changes(b, p, bIn)) && (keep?.(p) ?? true)) return p
  }
  const named = [...a.files, ...b.files]
  for (const g of [...a.globs, ...b.globs]) {
    const holdsFile = named.some((p) => !p.endsWith("/") && globHolds(g, p))
    if (!holdsFile && meetsGlob(a, g) && meetsGlob(b, g) && (keep?.(g) ?? true)) return g
  }
  return ""
}

/**
 * What two footprints share, for the log's `skipping <id>: touches <what>, like running <other>`:
 * an area label, a function (Loop.merge and merge meet, Loop.merge and Git.merge don't), or a file
 * or folder (see sharedFile); "" when nothing. mentions places their functions in files.
 */
export const shared = (a: Footprint, b: Footprint, mentions?: Mentions): string => {
  const area = a.areas.find((x) => b.areas.includes(x))
  if (area !== undefined) return area
  return sharedFunc(a, b) || sharedFile(a, b, mentions)
}

/** Whether two footprints share a file, folder, function or area: their tickets don't run side by side. */
export const overlaps = (a: Footprint, b: Footprint, mentions?: Mentions): boolean =>
  shared(a, b, mentions) !== ""
