// Globs (§ 5 item 5, footprint.ts): the files metadata's globs, matched against the repository's
// paths part by part as Go's path.Match matches them, ** matching any number of folders; and
// whether a glob holds a path, or two globs can match one file, for the footprints' overlap.
// .tutti/settings.json's globs are matched here too: the setup's (setup.ts) and the queue's shared
// files (repoFiles.ts).

/** A name in NFC, the Unicode form names are compared in. */
export const nfc = (name: string): string => name.normalize("NFC")

// Glob parts are matched as Go's path.Match matches them: * any run of characters, ? one, [a-z] and
// [^a-z] a class, \ escaping the next character. A malformed part matches nothing.
const partPatterns = new Map<string, RegExp | undefined>()

const escapeChar = (c: string): string => `\\u{${c.codePointAt(0)?.toString(16)}}`

const compilePart = (part: string): RegExp | undefined => {
  const chars = [...part]
  let source = ""
  let i = 0
  // The next character of a class, escaped or not; undefined when the class is malformed there.
  const classChar = (): string | undefined => {
    let c = chars[i]
    if (c === undefined || c === "-" || c === "]") return undefined
    if (c === "\\") {
      i++
      c = chars[i]
      if (c === undefined) return undefined
    }
    i++
    return c
  }
  while (i < chars.length) {
    const c = chars[i] ?? ""
    if (c === "*") {
      source += "[^/]*"
      i++
    } else if (c === "?") {
      source += "[^/]"
      i++
    } else if (c === "\\") {
      const next = chars[i + 1]
      if (next === undefined) return undefined
      source += escapeChar(next)
      i += 2
    } else if (c === "[") {
      i++
      let negated = false
      if (chars[i] === "^") {
        negated = true
        i++
      }
      let ranges = ""
      for (let count = 0; ; count++) {
        if (chars[i] === "]" && count > 0) {
          i++
          break
        }
        const lo = classChar()
        if (lo === undefined) return undefined
        let hi = lo
        if (chars[i] === "-") {
          i++
          const end = classChar()
          if (end === undefined) return undefined
          hi = end
        }
        // A range running backwards matches nothing, as in Go.
        if ((lo.codePointAt(0) ?? 0) <= (hi.codePointAt(0) ?? 0)) {
          ranges += `${escapeChar(lo)}-${escapeChar(hi)}`
        }
      }
      if (negated) source += ranges === "" ? "[^/]" : `(?![${ranges}])[^/]`
      else source += ranges === "" ? "(?!)" : `[${ranges}]`
    } else {
      source += escapeChar(c)
      i++
    }
  }
  try {
    return new RegExp(`^${source}$`, "u")
  } catch {
    return undefined
  }
}

const partMatch = (pattern: string, name: string): boolean => {
  if (!partPatterns.has(pattern)) partPatterns.set(pattern, compilePart(pattern))
  return partPatterns.get(pattern)?.test(name) ?? false
}

/**
 * Whether a path's parts match the pattern's: each as partMatch, but **, which matches any number.
 * `asWritten`, a part also matches the name it is written as: a route of a Next.js or SvelteKit
 * project is named with brackets (pages/[id].tsx, src/routes/[slug]/), which partMatch takes for a
 * class (i.tsx or d.tsx).
 */
export const globMatch = (
  pattern: ReadonlyArray<string>,
  parts: ReadonlyArray<string>,
  asWritten = false,
): boolean => {
  // The ways tried that matched nothing, as in partsMeet: each pattern part and path part is
  // compared once, however many **s the pattern has.
  const failed = new Set<number>()
  const match = (i: number, j: number): boolean => {
    const key = i * (parts.length + 1) + j
    if (failed.has(key)) return false
    const first = pattern[i]
    const name = parts[j]
    let ok: boolean
    if (first === undefined) ok = name === undefined
    else if (first === "**") ok = match(i + 1, j) || (name !== undefined && match(i, j + 1))
    else
      ok =
        name !== undefined &&
        ((asWritten && first === name) || partMatch(first, name)) &&
        match(i + 1, j + 1)
    if (!ok) failed.add(key)
    return ok
  }
  return match(0, 0)
}

// A glob with each run of **s as one, which matches the same paths: a/**/**/b as a/**/b.
export const collapseAny = (glob: string): string =>
  glob.replace(/(^|\/)\*\*(?:\/\*\*)+(?=\/|$)/g, "$1**")

/**
 * Whether a glob of .tutti/settings.json matches a file: by its name, or by its path from the
 * repository's top when the glob has a slash (a leading one aside), as orchestra matches them.
 */
export const settingsGlobMatch = (glob: string, file: string): boolean =>
  glob.includes("/")
    ? globMatch((glob.startsWith("/") ? glob.slice(1) : glob).split("/"), file.split("/"))
    : globMatch([glob], [file.slice(file.lastIndexOf("/") + 1)])

/** Whether a files metadata entry is a glob: it has a *, a ? or a [. */
export const isGlob = (name: string): boolean => /[*?[]/.test(name)

/**
 * A part of a path as partsMeet takes it: a glob's (`glob`), matching the names partMatch does and
 * the name it is written as, or a file's or a folder's, matching its name alone.
 */
interface Part {
  readonly s: string
  readonly glob: boolean
}

/** Whether p is **, the part of a glob matching any number of folders, which ends a folder's parts too. */
const anyFolders = (p: Part): boolean => p.glob && p.s === "**"

const partMatches = (p: Part, name: string): boolean =>
  p.s === name || (p.glob && partMatch(p.s, name))

/** A glob's parts, followed by **: its last part a folder's name as well as a file's, as for glob. */
const globParts = (g: string): ReadonlyArray<Part> => [
  ...g.split("/").map((s) => ({ s, glob: true })),
  { s: "**", glob: true },
]

/** The parts of p, a file or a folder (ending in /), in NFC, a folder's followed by ** for its files. */
const pathParts = (p: string): ReadonlyArray<Part> => {
  const folder = p.endsWith("/")
  const parts: Array<Part> = nfc(folder ? p.slice(0, -1) : p)
    .split("/")
    .map((s) => ({ s, glob: false }))
  return folder ? [...parts, { s: "**", glob: true }] : parts
}

/**
 * The one name a glob's part matches, its escapes undone; undefined when it matches others (a *, a
 * ? or a [class]) or none (a \ ending it).
 */
const literalPart = (s: string): string | undefined => {
  if (!/[*?[\\]/.test(s)) return s
  let out = ""
  const chars = [...s]
  for (let i = 0; i < chars.length; i++) {
    let c = chars[i] ?? ""
    if (c === "*" || c === "?" || c === "[") return undefined
    if (c === "\\") {
      i++
      if (i === chars.length) return undefined
      c = chars[i] ?? ""
    }
    out += c
  }
  return out
}

/**
 * Whether a name can match both x and y: the name one of them is written as, which the other
 * matches, or, both a glob's, one both match: the name one stands for alone, which the other
 * matches, or any name their literal beginnings and ends allow (*.ts and c*.ts meet, *.ts and *.go
 * don't).
 */
const partMeet = (x: Part, y: Part): boolean => {
  if (partMatches(x, y.s) || partMatches(y, x.s)) return true
  if (!x.glob || !y.glob) return false
  const lx = literalPart(x.s)
  const ly = literalPart(y.s)
  if (lx !== undefined && ly !== undefined) return lx === ly
  if (ly !== undefined) return partMatch(x.s, ly)
  if (lx !== undefined) return partMatch(y.s, lx)
  // A pattern's literal beginning ends at its first *, ?, [ or \, and its literal end starts after
  // its last one or ].
  const px = x.s.slice(0, x.s.search(/[*?[\\]/))
  const py = y.s.slice(0, y.s.search(/[*?[\\]/))
  const sx = x.s.slice(lastSpecial(x.s) + 1)
  const sy = y.s.slice(lastSpecial(y.s) + 1)
  return (px.startsWith(py) || py.startsWith(px)) && (sx.endsWith(sy) || sy.endsWith(sx))
}

const lastSpecial = (s: string): number =>
  Math.max(...["*", "?", "[", "]", "\\"].map((c) => s.lastIndexOf(c)))

/**
 * Whether a path can match both a and b, the parts of globs or paths: ** any number of folders, the
 * others one name each, which partMeet compares.
 */
const partsMeet = (a: ReadonlyArray<Part>, b: ReadonlyArray<Part>): boolean => {
  // The ways tried that met nothing: each step moves on in a or b, so none comes round again.
  const failed = new Set<number>()
  const meet = (i: number, j: number): boolean => {
    const key = i * (b.length + 1) + j
    if (failed.has(key)) return false
    const x = a[i]
    const y = b[j]
    let ok: boolean
    if (x !== undefined && anyFolders(x)) ok = meet(i + 1, j) || (j < b.length && meet(i, j + 1))
    else if (y !== undefined && anyFolders(y))
      ok = meet(i, j + 1) || (i < a.length && meet(i + 1, j))
    else if (x === undefined || y === undefined) ok = x === undefined && y === undefined
    else ok = partMeet(x, y) && meet(i + 1, j + 1)
    if (!ok) failed.add(key)
    return ok
  }
  return meet(0, 0)
}

/**
 * Whether glob g, one of a footprint's globs, holds p, a file or a folder (ending in /) of another's:
 * a file g matches, or a folder holding one. g matches from the repository's root, as a name kept
 * for a file a ticket adds does (web/src/*.ts holds web/src/cart.ts, not app/web/src/cart.ts).
 */
export const globHolds = (g: string, p: string): boolean => partsMeet(globParts(g), pathParts(p))

/** Whether two footprints' globs can match the same file. */
export const globsMeet = (g: string, h: string): boolean =>
  g === h || partsMeet(globParts(g), globParts(h))
