// The heuristics a footprint reads a ticket's text with (footprint.ts): the words that may be
// paths, the functions it names, its sentences, and whether a sentence asks to change a document
// it names or only cites it. Each is a guess at what an author meant, as orchestra v0.9.0 makes it.

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

// Type.method, which a path token without a known extension may be.
export const typeMethod = /^[A-Z]\w*\.[A-Za-z_]\w*$/
// A function named with its parentheses: refreshBranch(), Loop.merge(), o.log.Raw().
const called = /\b((?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*)\(\)/g
// Markdown's `code`, where a function is often named without parentheses.
const codeSpan = /`([^`\n]+)`/g
// A call in a code span, with or without arguments: o.agentName(id).
const callIn = /\b((?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*)\(/g
// An identifier with a hump (waitSettled, LastToolUse), which in a code span is code, where a plain
// word (solo, bd) may not be.
const camelCase = /^[A-Za-z_]\w*[a-z0-9][A-Z]\w*$/

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

/** The words of a list written one after another, as a set. */
export const setOf = (words: string): ReadonlySet<string> =>
  new Set(words.split(/\s+/).filter(Boolean))

// Names written with a hump that are no code of the project's.
const camelWords = setOf(`GitHub GitLab BitBucket JavaScript TypeScript CoffeeScript PostgreSQL
  MySQL SQLite MongoDB MariaDB GraphQL WebSocket WebSockets YouTube LinkedIn OpenAI PowerShell
  WordPress DevOps DockerHub NuGet PyPI NumPy SciPy PyTorch TensorFlow FastAPI LaTeX OpenAPI IntelliJ
  JetBrains VSCode iOS iPadOS macOS tvOS watchOS visionOS iPhone iPad iCloud iTerm iTerm2 eBPF`)

// The extensions a bare name (loop.go) is taken for a file by when the repository's files aren't
// known.
export const sourceExtensions =
  setOf(`go md json yaml yml toml swift py js ts tsx jsx mjs rs rb java kt
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

// The words that, among the two before a document, cite it: "per docs/setup.md", "as docs/x.md says".
const citeWords = setOf("per see following as like cf according via")
// Around a document a sentence names, how many words before it and after it a changeWord is looked
// for in: "Add the result to docs/spikes/07-compile.md", "docs/running.md updated".
const changeBefore = 8
const changeAfter = 3
const testingMethods = setOf(`Add Attr Chdir Cleanup Context Deadline Error Errorf Fail FailNow
  Failed Fatal Fatalf Fuzz Helper Log Logf Loop Name Output Parallel ReportAllocs ReportMetric
  ResetTimer Run RunParallel SetBytes Setenv Skip SkipNow Skipf Skipped StartTimer StopTimer TempDir`)

const trimRight = (word: string): string => word.replace(/[./-]+$/, "")

const nonASCII = (c: string): boolean => (c.codePointAt(0) ?? 0) > 0x7f

/**
 * Calls take with each word of text that may be a path: with an extension, or without one one bare
 * says names a tracked file (Makefile, scripts/release), told whether the word is written in
 * backticks; and neither an absolute path nor a URL, which aren't in the repository. take says
 * whether the word names something. A +
 * starts a word only after a space or punctuation that isn't a closing bracket: after a letter,
 * digit, mark, _ . - + or a closing bracket it joins two words of an expression (a+b.go, x[0]+y.go,
 * C++), and is left off. A word with brackets or a + that names nothing is tried in its parts
 * without them instead: an index expression (Footprint.files[0]) and a + marking an added line
 * (+loop.go) are among them. A word with characters outside ASCII that names nothing is tried in
 * its ASCII parts: a path run into words of a script written without spaces (修改loop.go,
 * loop.goを直す) is one of them.
 */
export const eachPathToken = (
  text: string,
  take: (token: string) => boolean,
  bare: (word: string, marked: boolean) => boolean,
): void => {
  for (const match of text.matchAll(pathToken)) {
    const before = [...text.slice(0, match.index)].at(-1) ?? ""
    const marked = before === "`" && text[match.index + match[0].length] === "`"
    const token = joinsWords(before) ? match[0].replace(/^\+/, "") : match[0]
    takePath(token, take, (word) => bare(word, marked))
  }
}

/**
 * Whether c, the character before a + starting a path token, makes the + join two words of an
 * expression rather than start a name: a letter, digit, mark, _ . - + or a closing bracket.
 */
const joinsWords = (c: string): boolean => /^[\p{L}\p{M}\p{N}_.\-+)\]}]$/u.test(c)

/** Calls take with word, a path token, or with its parts, as eachPathToken says. */
const takePath = (
  token: string,
  take: (token: string) => boolean,
  bare: (word: string) => boolean,
): void => {
  const word = trimRight(token)
  if (word.startsWith("/")) return // an absolute path or a URL, no part of which is in the repository
  if ((extension.test(word) || bare(word)) && take(word)) return
  if (/[[\]+]/.test(word)) {
    for (const [part] of word.matchAll(plainPathToken)) takePath(part, take, bare)
    return
  }
  if (![...word].some(nonASCII)) return
  for (const [ascii] of word.matchAll(asciiPathToken)) {
    const part = trimRight(ascii)
    if (!part.startsWith("/") && (extension.test(part) || bare(part))) take(part)
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
export const callsIn = (text: string): ReadonlyArray<string> =>
  [...text.matchAll(called)].map((m) => funcName(m[1] ?? "")).filter((f) => f !== "")

/**
 * The functions text names in its code spans: an identifier with a hump (`waitSettled`), or a call
 * with or without arguments (`o.agentName(id)`).
 */
export const codeSpansIn = (text: string): ReadonlyArray<string> =>
  [...text.matchAll(codeSpan)].flatMap((m) => {
    const code = (m[1] ?? "").trim()
    const funcs = camelCase.test(code) && !camelWords.has(code) ? [code] : []
    for (const c of code.matchAll(callIn)) {
      const f = funcName(c[1] ?? "")
      if (f !== "") funcs.push(f)
    }
    return funcs
  })

/** The sentences of text (sentenceBreak), each with the break that ends it. */
export const sentences = (text: string): ReadonlyArray<string> => {
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
