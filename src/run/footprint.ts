// Footprints (§ 5 item 5, § 2): where a ticket works, as orchestra v0.9.0 reads it. The files and
// functions its title, description, design and acceptance criteria name, its area:<name> labels and
// the files its `files` metadata lists (folders and globs among them), resolved against git
// ls-files; with none of these, its `predicted_files`. Not its notes: they say what happened to it
// (the run's notes, its workers', a reopening's), naming files and functions it doesn't change. The
// files the project's check commands name are left out unless the metadata lists them, as is the
// spec the ticket's `spec` metadata cites: nearly every ticket asks for the check to pass, and cites
// its spec, without changing them. The files git merges by union (`merge=union` in .gitattributes,
// as tutti init offers for the changelog) are left out always: two tickets' lines in one can't
// conflict, git keeps both. A ticket with commits on its branch (reopened, carried over) is
// footprinted from what its branch changes, its files metadata and its area labels
// (`branchFootprint`). A running ticket's footprint also grows with the files its worktree has
// changed (§ 5). Two tickets whose footprints overlap don't run side by side; a file both name holds
// them apart only when one of them is to change it (`sharedFile`).
import { join, posix } from "node:path"
import { Effect, FileSystem, Option } from "effect"
import type { Issue } from "../services/Beads.ts"
import { Git, type GitError } from "../services/Git.ts"

export interface Footprint {
  /**
   * Paths in the repository, sorted. A folder the files metadata lists is kept as one, ending in /,
   * beside the tracked files under it: it holds the files under it, those another ticket adds there
   * included, and is all there is of a folder the ticket adds.
   */
  readonly files: ReadonlyArray<string>
  /** Functions and types, as named: Loop.merge, refreshBranch. Sorted. */
  readonly funcs: ReadonlyArray<string>
  /** The ticket's area:<name> labels, sorted. */
  readonly areas: ReadonlyArray<string>
  /**
   * The files among `files` the ticket names only to read, sorted: those its text names when its
   * files metadata lists others (the files it changes), and, without files metadata, a document
   * (.md, .txt) its text names in no sentence asking to change it, as tickets cite the project's
   * guides and spikes for conventions and findings.
   */
  readonly cited: ReadonlyArray<string>
  /** The files metadata lists the files the ticket changes: a function it names changes no other. */
  readonly listed: boolean
  /** `files` are the predictor's guess, for a ticket naming nothing. */
  readonly predicted: boolean
  /** `files` are those the ticket's branch changes, with those its metadata lists (`branchFootprint`). */
  readonly branch: boolean
  /** The files the ticket's worktree has changed, sorted (`withChanges`). */
  readonly changed: ReadonlyArray<string>
}

/** What a footprint is read from: an Issue, or as much of one. */
export type FootprintTicket = Pick<
  Issue,
  | "title"
  | "description"
  | "design"
  | "acceptance"
  | "labels"
  | "metadata"
  | "files"
  | "predictedFiles"
>

/** Starts a label naming the part of the project a ticket works on: tickets sharing one overlap. */
export const AreaPrefix = "area:"

/** The metadata key naming the spec a ticket was broken down from (§ 11). */
export const SpecKey = "spec"

/** The footprint of a ticket naming nothing. */
export const emptyFootprint: Footprint = {
  files: [],
  funcs: [],
  areas: [],
  cited: [],
  listed: false,
  predicted: false,
  branch: false,
  changed: [],
}

/** Whether the footprint names nothing (its worktree's changes aside). */
export const isEmpty = (fp: Footprint): boolean =>
  fp.files.length + fp.funcs.length + fp.areas.length === 0

/** The footprint for the log: functions, files, then areas (`<id> footprint: …`). */
export const showFootprint = (fp: Footprint): string =>
  isEmpty(fp)
    ? "nothing named"
    : [...fp.funcs, ...fp.files, ...fp.areas].join(", ") +
      (fp.predicted ? " (predicted)" : "") +
      (fp.branch ? " (from its branch)" : "")

// The rest of a run of a path token outside brackets: letters, digits, marks, _ . / -, and a +
// starting a name after a /.
const pathRest = String.raw`(?:/\+[\p{L}\p{M}\p{N}_]|[\p{L}\p{M}\p{N}_./-])*`
// A path token is anything that could be a path: loop.go, src/run/loop.ts:661 (the line number is
// left off), docs/café.md, Loop.merge (sorted out later). Letters and digits of any script count,
// and combining marks: macOS often writes é as e and U+0301. So do brackets, single or double,
// around a name inside a word, as in the routes of a Next.js or SvelteKit project (pages/[id].tsx,
// app/[[...slug]]/page.tsx), but not one starting it: [README.md](/README.md), a Markdown link,
// names README.md. So does a + starting a name at the word's start or after a /, as in a
// SvelteKit route's files (src/routes/[slug]/+page.svelte, +layout.ts), but no other: C++, 1.26+
// and the + of a+b, which eachPathToken drops, are no part of a path.
const pathToken = new RegExp(
  String.raw`(?:\+[\p{L}\p{M}\p{N}_]|[\p{L}\p{M}\p{N}_./-])${pathRest}` +
    String.raw`(?:(?:\[[\p{L}\p{M}\p{N}_.=-]+\]|\[\[[\p{L}\p{M}\p{N}_.=-]+\]\])${pathRest})*`,
  "gu",
)
// A part of a path token without brackets or a +, which a word with them may be made of instead: an
// index expression (files[i], Footprint.files[0]), or a + marking an added line.
const plainPathToken = /[\p{L}\p{M}\p{N}_./-]+/gu
// A path token's ASCII part, which may be a path run into words of a script written without spaces:
// 修改loop.go, loop.goを直す.
const asciiPathToken = /[\w./-]+/g
const extension = /\.[A-Za-z][A-Za-z0-9]*$/
// A name whose brackets, single or double, each close around a name within a part of its path, as
// in a route of a Next.js or SvelteKit project: pages/[id].tsx, app/[[...slug]]/page.tsx.
const bracketed = /^(?:[^[\]]|\[[^[\]/]+\]|\[\[[^[\]/]+\]\])*$/
// Type.method, which a path token without a known extension may be.
const typeMethod = /^[A-Z]\w*\.[A-Za-z_]\w*$/
// A function named with its parentheses: refreshBranch(), Loop.merge(), o.log.Raw().
const called = /\b((?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*)\(\)/g
// Markdown's `code`, where a function is often named without parentheses.
const codeSpan = /`([^`\n]+)`/g
// A call in a code span, with or without arguments: o.agentName(id).
const callIn = /\b((?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*)\(/g
// An identifier with a hump (waitSettled, LastToolUse), which in a code span is code, where a plain
// word (solo, bd) may not be.
const camelCase = /^[A-Za-z_]\w*[a-z0-9][A-Z]\w*$/
// A word of source code, for the functions a file mentions.
const identifier = /[A-Za-z_]\w*/g
// The end of a sentence of a ticket's text: a line's end, or a . ! or ? and the spaces after it (a
// closing quote or bracket between them), unless a lower-case letter follows (e.g. docs/x.md).
const sentenceBreak = /[.!?]["'’”)\]]*\s+|\n/g
// A word asking for a change to a document a sentence names near it (asksChange), before or after
// it: "Update docs/running.md", "Add the result to docs/spikes/07-compile.md", "docs/x.md updated".
const changeWord = new RegExp(
  String.raw`\b(?:add|added|adding|update|updated|updating|change|changed|changing|edit|edited|` +
    "editing|write|written|writing|rewrite|rewritten|reword|reworded|document|fix|fixed|" +
    "correct|corrected|mention|say|describe|explain|note|record|remove|removed|delete|" +
    String.raw`deleted|drop|replace|rename|move|put|pin|keep|extend|create|split|trim|shorten|expand)\b`,
  "i",
)
// A word saying, after a document it follows, what the document is to do or have: "docs/setup.md
// says how to run them". Before a document, its subject is something else ("the help says it
// disables CLAUDE.md").
const changesWord = new RegExp(
  String.raw`\b(?:adds|updates|changes|edits|writes|rewrites|rewords|fixes|mentions|says|describes|` +
    "explains|notes|records|removes|deletes|drops|replaces|renames|moves|extends|creates|" +
    String.raw`lists|names|gives|shows|covers)\b`,
  "i",
)

const setOf = (words: string): ReadonlySet<string> => new Set(words.split(/\s+/).filter(Boolean))

// Names written with a hump that are no code of the project's.
const camelWords = setOf(`GitHub GitLab BitBucket JavaScript TypeScript CoffeeScript PostgreSQL
  MySQL SQLite MongoDB MariaDB GraphQL WebSocket WebSockets YouTube LinkedIn OpenAI PowerShell
  WordPress DevOps DockerHub NuGet PyPI NumPy SciPy PyTorch TensorFlow FastAPI LaTeX OpenAPI IntelliJ
  JetBrains VSCode iOS iPadOS macOS tvOS watchOS visionOS iPhone iPad iCloud iTerm iTerm2 eBPF`)

// The extensions a bare name (loop.go) is taken for a file by when the repository's files aren't
// known.
const sourceExtensions = setOf(`go md json yaml yml toml swift py js ts tsx jsx mjs rs rb java kt
  kts c h cc cpp hpp m mm sh bash zsh txt html css scss sql mod sum lock xml plist gradle cs php ex
  exs erl hs ml scala dart vue svelte proto tf ini cfg conf`)

// Standard packages whose functions tickets name in passing (os.WriteFile, strings.HasPrefix): they
// say nothing about where a ticket works.
const stdPackages = setOf(`atomic base64 binary bits bufio bytes cmp context debug errors exec
  filepath flag fmt gzip hash hex hmac http httptest io ioutil iter json log maps math md5 netip os
  path pprof rand reflect regexp runtime sha1 sha256 signal slices slog sort strconv strings sync
  synctest syscall tabwriter testing time unicode unsafe url utf16 utf8`)

// Go's keywords and builtins, which a ticket calls bare (func(), len(x), string(b)).
const goWords = setOf(`break case chan const continue default defer else fallthrough for func go
  goto if import interface map package range return select struct switch type var append cap clear
  close complex copy delete imag len make max min new panic print println real recover any bool
  byte comparable complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string
  uint uint8 uint16 uint32 uint64 uintptr`)

// The names tests give a *testing.T, B or F, and those types' methods: t.Run() is no function of
// the project's.
const testVars = setOf("t b f tb")
// The extensions of documents, files of prose that tickets cite for conventions and findings more
// often than they change them.
const docExtensions = setOf("md markdown mdx txt rst adoc")
// The words that, among the two before a document, cite it: "per docs/setup.md", "as docs/x.md says".
const citeWords = setOf("per see following as like cf according via")
// Around a document a sentence names, how many words before it and after it a changeWord is looked
// for in: "Add the result to docs/spikes/07-compile.md", "docs/running.md updated".
const changeBefore = 8
const changeAfter = 3
const testingMethods = setOf(`Add Attr Chdir Cleanup Context Deadline Error Errorf Fail FailNow
  Failed Fatal Fatalf Fuzz Helper Log Logf Loop Name Output Parallel ReportAllocs ReportMetric
  ResetTimer Run RunParallel SetBytes Setenv Skip SkipNow Skipf Skipped StartTimer StopTimer TempDir`)

const nfc = (name: string): string => name.normalize("NFC")

/** path.Clean: no ./ parts, no a/.. pairs, no trailing slash; "." for the root. */
const clean = (name: string): string => {
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

const extensionOf = (name: string): string => {
  const base = basename(name)
  const dot = base.lastIndexOf(".")
  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase()
}

const trimRight = (word: string): string => word.replace(/[./-]+$/, "")

const nonASCII = (c: string): boolean => (c.codePointAt(0) ?? 0) > 0x7f

const sorted = (items: Iterable<string>): ReadonlyArray<string> => [...new Set(items)].sort()

/** A name as resolve compares it, and whether it is written as a folder (web/src/, web/src/.). */
const cleanName = (name: string): { readonly name: string; readonly folder: boolean } => {
  const n = nfc(name.startsWith("./") ? name.slice(2) : name)
  if (!repoPath(n)) return { name: "", folder: false }
  const last = basename(n)
  return { name: clean(n), folder: last === "" || last === "." || last === ".." }
}

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
  const [first, ...rest] = pattern
  if (first === undefined) return parts.length === 0
  if (first === "**") {
    for (let i = 0; i <= parts.length; i++) {
      if (globMatch(rest, parts.slice(i), asWritten)) return true
    }
    return false
  }
  const [name, ...others] = parts
  return (
    name !== undefined &&
    ((asWritten && first === name) || partMatch(first, name)) &&
    globMatch(rest, others, asWritten)
  )
}

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
  /** The file a name is, as git lists it; for one git doesn't track, the name in NFC. */
  file(name: string): string
  /** Whether a check command names the file. */
  checks(file: string): boolean
  /**
   * Whether git merges the file by union (`merge=union` in .gitattributes): two tickets' lines in
   * it can't conflict, as git keeps both, so it never holds them apart. A folder is merged by none.
   */
  unioned(file: string): boolean
}

/**
 * Indexes the files git tracks (undefined when git couldn't list them) and finds those the check
 * commands (`scripts/check-fast.sh`, `bun test && sh scripts/lint.sh`) name among them. `union`
 * holds the files git merges by union (`Git.mergedByUnion`), as git lists them.
 */
export const repoFiles = (
  tracked: ReadonlyArray<string> | undefined,
  checkCommands: ReadonlyArray<string> = [],
  union: Iterable<string> = [],
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

  const glob = (pattern: string): ReadonlyArray<string> => {
    // In any folder, as a partial path is; its last part a file's name or a folder's, holding every
    // file under it. A run of ** is one.
    const pat = ["**", ...pattern.split("/")].filter(
      (part, i, all) => !(part === "**" && all[i - 1] === "**"),
    )
    return names.flatMap((n) => {
      const parts = n.split("/")
      for (let end = 1; end <= parts.length; end++) {
        if (globMatch(pat, parts.slice(0, end), true)) return formsOf(n)
      }
      return []
    })
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
    if (explicit && /[*?[]/.test(name)) {
      // A name with brackets around names and no * or ? (pages/[id].tsx, app/[[...slug]]/) also
      // means the file or folder of that name, one the ticket adds among them.
      const matched = glob(name)
      if (/[*?]/.test(name) || !bracketed.test(name)) return matched
      return sorted([...matched, ...literal(name, explicit, folder)])
    }
    return literal(name, explicit, folder)
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

  const unions = new Set(union)
  const check = new Set<string>()
  for (const command of checkCommands) {
    eachPathToken(command, (token) => {
      const found = resolve(token, false)
      for (const f of found) check.add(f)
      return found.length > 0
    })
  }

  return {
    known,
    resolve,
    file: (name) => {
      const forms = files.get(nfc(name))
      if (forms === undefined) return nfc(name)
      return forms.includes(name) ? name : (forms[0] ?? nfc(name))
    },
    checks: (f) => check.has(f),
    unioned: (f) => !f.endsWith("/") && unions.has(f),
  }
}

/**
 * Calls take with each word of text that may be a path: with an extension, and neither an absolute
 * path nor a URL, which aren't in the repository. take says whether the word names something. A +
 * starts a word only after a space or punctuation that isn't a closing bracket: after a letter,
 * digit, mark, _ . - + or a closing bracket it joins two words of an expression (a+b.go, x[0]+y.go,
 * C++), and is left off. A word with brackets or a + that names nothing is tried in its parts
 * without them instead: an index expression (Footprint.files[0]) and a + marking an added line
 * (+loop.go) are among them. A word with characters outside ASCII that names nothing is tried in
 * its ASCII parts: a path run into words of a script written without spaces (修改loop.go,
 * loop.goを直す) is one of them.
 */
const eachPathToken = (text: string, take: (token: string) => boolean): void => {
  for (const match of text.matchAll(pathToken)) {
    const before = [...text.slice(0, match.index)].at(-1) ?? ""
    takePath(joinsWords(before) ? match[0].replace(/^\+/, "") : match[0], take)
  }
}

/**
 * Whether c, the character before a + starting a path token, makes the + join two words of an
 * expression rather than start a name: a letter, digit, mark, _ . - + or a closing bracket.
 */
const joinsWords = (c: string): boolean => /^[\p{L}\p{M}\p{N}_.\-+)\]}]$/u.test(c)

/** Calls take with word, a path token, or with its parts, as eachPathToken says. */
const takePath = (token: string, take: (token: string) => boolean): void => {
  const word = trimRight(token)
  if (word.startsWith("/")) return // an absolute path or a URL, no part of which is in the repository
  if (extension.test(word) && take(word)) return
  if (/[[\]+]/.test(word)) {
    for (const [part] of word.matchAll(plainPathToken)) takePath(part, take)
    return
  }
  if (![...word].some(nonASCII)) return
  for (const [ascii] of word.matchAll(asciiPathToken)) {
    const part = trimRight(ascii)
    if (!part.startsWith("/") && extension.test(part)) take(part)
  }
}

/**
 * A function as the footprint keeps it, from a call's name: a lower-case qualifier is a package, a
 * variable or a field (o.merge, o.log.Raw), not a type, and is left off. "" for a standard
 * package's function or a variable's method (os.WriteFile, os.Stdout.Write), a test's method (t.Run)
 * and a Go keyword or builtin called bare; a method of the same name (o.close) is kept.
 */
const funcName = (call: string): string => {
  const parts = call.split(".")
  const name = parts.at(-1) ?? ""
  if (parts.length === 1) return goWords.has(call) ? "" : call
  const qualifier = parts.at(-2) ?? ""
  if (stdPackages.has(parts[0] ?? "") || (testVars.has(qualifier) && testingMethods.has(name))) {
    return ""
  }
  return /^[A-Z]/.test(qualifier) ? `${qualifier}.${name}` : name
}

/** The functions text names with their parentheses: refreshBranch(), Loop.merge(). */
const callsIn = (text: string): ReadonlyArray<string> =>
  [...text.matchAll(called)].map((m) => funcName(m[1] ?? "")).filter((f) => f !== "")

/**
 * The functions text names in its code spans: an identifier with a hump (`waitSettled`), or a call
 * with or without arguments (`o.agentName(id)`).
 */
const codeSpansIn = (text: string): ReadonlyArray<string> =>
  [...text.matchAll(codeSpan)].flatMap((m) => {
    const code = (m[1] ?? "").trim()
    const funcs = camelCase.test(code) && !camelWords.has(code) ? [code] : []
    for (const c of code.matchAll(callIn)) {
      const f = funcName(c[1] ?? "")
      if (f !== "") funcs.push(f)
    }
    return funcs
  })

/** The spec the ticket's metadata cites, as the repository's files: left out unless listed. */
const specFiles = (ticket: FootprintTicket, repo: RepoFiles): ReadonlySet<string> => {
  const spec = Object.hasOwn(ticket.metadata, SpecKey) ? ticket.metadata[SpecKey] : undefined
  return new Set(typeof spec === "string" ? repo.resolve(spec, false) : [])
}

/** Whether p, a file and not a folder, is a document: prose (.md, .txt) that tickets often cite. */
export const isDocument = (p: string): boolean =>
  !p.endsWith("/") && docExtensions.has(extensionOf(p))

/** The sentences of text (sentenceBreak), each with the break that ends it. */
const sentences = (text: string): ReadonlyArray<string> => {
  const out: Array<string> = []
  let start = 0
  for (const m of text.matchAll(sentenceBreak)) {
    const end = m.index + m[0].length
    // e.g. docs/x.md: the sentence goes on.
    if (m[0] !== "\n" && /^\p{Ll}/u.test(text.slice(end))) continue
    out.push(text.slice(start, end))
    start = end
  }
  out.push(text.slice(start))
  return out
}

const letter = /\p{L}/u

/**
 * Whether a sentence, as its words, asks to change the document its i-th word names: the document
 * starts it, after a list's marker ("- docs/running.md: say …", "CLAUDE.md and docs/setup.md say
 * …"), or, unless one of the two words before it is a citeWord, a changeWord is among the
 * changeBefore words before it (none when it opens a parenthesis) or the changeAfter words after
 * it, or a changesWord among those after it. A sentence citing it ("Reproduce per docs/setup.md",
 * "Spike 1 (docs/spikes/01-sdk.md, item 4) found that …") does none of these.
 */
export const asksChange = (words: ReadonlyArray<string>, i: number): boolean => {
  if (i === words.findIndex((w) => letter.test(w))) return true
  for (const w of words.slice(Math.max(0, i - 2), i)) {
    if (citeWords.has(w.replace(/^\P{L}+|\P{L}+$/gu, "").toLowerCase())) return false
  }
  const before = (words[i] ?? "").startsWith("(")
    ? ""
    : words.slice(Math.max(0, i - changeBefore), i).join(" ")
  const after = words.slice(i + 1, i + 1 + changeAfter).join(" ")
  return changeWord.test(before) || changeWord.test(after) || changesWord.test(after)
}

/**
 * The repository files the words of text that may be paths name, but those named in passing, each
 * with whether text asks to change it: any file but a document, and a document a sentence asks to
 * change (asksChange); and the Type.method words among them that name no file.
 */
const pathsIn = (
  text: string,
  repo: RepoFiles,
  inPassing: (file: string) => boolean,
): { readonly files: Map<string, boolean>; readonly funcs: Set<string> } => {
  const files = new Map<string, boolean>()
  const funcs = new Set<string>()
  for (const sentence of sentences(text)) {
    // A path token holds no space, so each is in one word, and starts it as it would the text.
    const words = sentence.split(/\s+/).filter(Boolean)
    words.forEach((word, i) => {
      eachPathToken(word, (token) => {
        const found = repo.resolve(token, false)
        if (found.length > 0) {
          for (const f of found) {
            if (inPassing(f)) continue // "scripts/check.sh passes" says nothing of where a ticket works
            files.set(f, files.get(f) === true || !isDocument(f) || asksChange(words, i))
          }
          return true
        }
        if (typeMethod.test(token) && !sourceExtensions.has(extensionOf(token))) {
          funcs.add(token)
          return true
        }
        return false
      })
    })
  }
  return { files, funcs }
}

/** The ticket's area:<name> labels, sorted. */
const areasOf = (ticket: Pick<FootprintTicket, "labels">): ReadonlyArray<string> =>
  sorted(ticket.labels.filter((l) => l.startsWith(AreaPrefix) && l.length > AreaPrefix.length))

/**
 * Where the ticket works: the files and functions named in its title and text, its area labels and
 * the files its metadata lists; with none of these, the files predicted for it (`predicted_files`).
 *
 * - **Text** is the title, description, design and acceptance criteria, not the notes. It names a
 *   file by its path (`src/run/ledger.ts:120`), its base name (`ledger.ts`, every file of that
 *   name) or a partial path (`run/ledger.ts`), and a new file by its path in a folder that exists.
 *   A path keeps its brackets and a + starting a name (`src/routes/[slug]/+page.svelte`).
 *   Functions are `Type.method`, a call (`refreshBranch()`, not `len(x)`, `os.Exit()` or
 *   `t.Run()`), or a camel-case name in backticks (`waitSettled`, not `GitHub`). Text names no
 *   folder or glob.
 * - **The files metadata** also takes a folder (`src/run/`, or `run/`), meaning the files under it
 *   and, kept as `src/run/`, those another ticket adds there, and a glob (`*.ts`, `src/**\/*.ts`)
 *   meaning the files it matches. A name that means none of these is a file or folder the ticket adds.
 * - **Cited**: with files metadata, the files its text names are those it reads; without, so is a
 *   document its text names in no sentence asking to change it (`per CLAUDE.md`, not
 *   `Update docs/guide.md`). A file cited holds no other ticket apart from it (`sharedFile`).
 * - **Left out**: names outside the repository (`../x.ts`, `/etc/passwd`), the files git merges by
 *   union, and the files the check commands name and the spec the `spec` metadata cites, unless
 *   the files metadata lists them.
 */
export const ticketFootprint = (ticket: FootprintTicket, repo: RepoFiles): Footprint => {
  const text = [ticket.title, ticket.description, ticket.design, ticket.acceptance].join("\n")
  const spec = specFiles(ticket, repo)
  const inPassing = (f: string) => repo.checks(f) || spec.has(f)
  const { files, funcs } = pathsIn(text, repo, inPassing)
  for (const f of callsIn(text)) funcs.add(f)
  for (const f of codeSpansIn(text)) funcs.add(f)
  const listed = ticket.files.length > 0
  // The files it changes are listed: those its text names it reads.
  if (listed) for (const f of files.keys()) files.set(f, false)
  for (const name of ticket.files) for (const f of repo.resolve(name, true)) files.set(f, true)
  for (const f of [...files.keys()]) if (repo.unioned(f)) files.delete(f)
  const fp: Footprint = {
    ...emptyFootprint,
    files: sorted(files.keys()),
    funcs: sorted(funcs),
    areas: areasOf(ticket),
    cited: sorted([...files].filter(([, change]) => !change).map(([f]) => f)),
    listed,
  }
  if (!isEmpty(fp)) return fp
  const predicted = new Set<string>()
  for (const name of ticket.predictedFiles) {
    for (const f of repo.resolve(name, false)) {
      if (!inPassing(f) && !repo.unioned(f)) predicted.add(f)
    }
  }
  return { ...emptyFootprint, files: sorted(predicted), predicted: predicted.size > 0 }
}

/**
 * The footprint of a ticket whose branch changes `changed` on top of the base (reopened, or
 * carried over): it has done its work there, and its text names what it read and was told as
 * well. Those files and the ones its files metadata lists, all to be changed, and its area labels;
 * not what its text names. The files git merges by union are left out; those the check commands
 * name and its spec are kept: the branch changes them.
 */
export const branchFootprint = (
  ticket: Pick<FootprintTicket, "files" | "labels">,
  changed: ReadonlyArray<string>,
  repo: RepoFiles,
): Footprint => {
  const files = new Set(changed.filter(repoPath).map((f) => repo.file(f)))
  for (const name of ticket.files) for (const f of repo.resolve(name, true)) files.add(f)
  return {
    ...emptyFootprint,
    files: sorted([...files].filter((f) => !repo.unioned(f))),
    areas: areasOf(ticket),
    listed: true,
    branch: true,
  }
}

/**
 * The footprint grown by the files its ticket's worktree has changed (`worktreeChanges`), in the
 * form the repository's files are in, so they compare with those other tickets name; but those git
 * merges by union.
 */
export const withChanges = (
  fp: Footprint,
  changed: ReadonlyArray<string>,
  repo: RepoFiles,
): Footprint => ({
  ...fp,
  changed: sorted([
    ...fp.changed,
    ...changed
      .filter(repoPath)
      .map((f) => repo.file(f))
      .filter((f) => !repo.unioned(f)),
  ]),
})

/**
 * The files the worktree has changed since it left base: those its commits changed (`git diff
 * --name-only <base>...HEAD`) and those changed or added and not committed (`git status`).
 */
export const worktreeChanges = (
  worktree: string,
  base: string,
): Effect.Effect<ReadonlyArray<string>, GitError, Git> =>
  Effect.gen(function* () {
    const git = yield* Git
    const committed = yield* git.changedFiles(worktree, base)
    const status = yield* git.status(worktree)
    return sorted([
      ...committed,
      ...status.flatMap((entry) =>
        entry.from === undefined ? [entry.path] : [entry.path, entry.from],
      ),
    ])
  })

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
 * Reads the files the footprints work on from the checkout at repo, for `shared` to place their
 * functions in: up to `maxSource` bytes of each, never a file that resolves outside repo. A file
 * that can't be read mentions nothing.
 */
export const readMentions = (
  repo: string,
  footprints: Iterable<Footprint>,
): Effect.Effect<Mentions, never, FileSystem.FileSystem> =>
  Effect.map(readSources(repo, footprints), mentionsIn)

/**
 * The contents of the files the footprints work on, in the checkout at repo: up to `maxSource`
 * bytes of each, never a file that resolves outside repo. A file that can't be read is left out.
 */
export const readSources = (
  repo: string,
  footprints: Iterable<Footprint>,
): Effect.Effect<ReadonlyMap<string, string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.realPath(repo).pipe(Effect.orElseSucceed(() => repo))
    const wanted = new Set<string>()
    for (const fp of footprints) {
      for (const f of [...fp.files, ...fp.changed])
        if (!f.endsWith("/") && repoPath(f)) wanted.add(f)
    }
    const contents = new Map<string, string>()
    for (const file of wanted) {
      const content = yield* Effect.scoped(
        Effect.gen(function* () {
          const real = yield* fs.realPath(join(repo, file))
          if (!real.startsWith(`${root}/`)) return Option.none<Uint8Array>()
          const handle = yield* fs.open(real, { flag: "r" })
          return yield* handle.readAlloc(maxSource)
        }),
      ).pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()))
      if (Option.isSome(content)) contents.set(file, new TextDecoder().decode(content.value))
    }
    return contents
  })

/** Whether two function names can mean one function: the same name, and the same type when both give one. */
const funcsMeet = (a: string, b: string): boolean => {
  const [ta, na] = a.includes(".") ? a.split(".", 2) : ["", a]
  const [tb, nb] = b.includes(".") ? b.split(".", 2) : ["", b]
  return na === nb && (ta === "" || tb === "" || ta === tb)
}

/** Whether p is a file or folder the footprint names, is under a folder it names, or was changed. */
const takesIn = (fp: Footprint, p: string): boolean =>
  fp.changed.includes(p) || fp.files.some((f) => f === p || (f.endsWith("/") && p.startsWith(f)))

/** Whether p is a folder holding a file among files: one that exists, or one a ticket adds there. */
const holdsNamed = (p: string, files: ReadonlyArray<string>): boolean =>
  p.endsWith("/") && files.some((f) => !f.endsWith("/") && f.startsWith(p))

/** A function both footprints name, as a names it, or "". */
export const sharedFunc = (a: Footprint, b: Footprint): string =>
  a.funcs.find((x) => b.funcs.some((y) => funcsMeet(x, y))) ?? ""

/**
 * Whether the footprint is to change p, a file or a folder: its worktree changed p, it names p or
 * a folder p is under and doesn't only cite it (`cited`), or, `named` true, it names a function p
 * mentions while its files metadata lists none and p is no document, which mentions functions
 * without holding them.
 */
const changes = (fp: Footprint, p: string, named: boolean): boolean =>
  fp.changed.includes(p) ||
  (named && !fp.listed && !isDocument(p)) ||
  fp.files.some((f) => (f === p || (f.endsWith("/") && p.startsWith(f))) && !fp.cited.includes(f))

/**
 * A file both footprints work on, for which keep holds (any, without keep), or "". A ticket works
 * on a file it names, one under a folder it names and one its worktree changed (takesIn), and on
 * one the other names that mentions a function it names; a file both work on is shared unless both
 * name functions it mentions: they are compared by function instead. A folder both name is shared
 * only when neither names a file in it (a new folder): otherwise its files are compared one by one.
 * A file both work on is shared only when one of them is to change it (`changes`): two tickets that
 * only cite a document, or name files their files metadata doesn't list, don't conflict over it.
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
