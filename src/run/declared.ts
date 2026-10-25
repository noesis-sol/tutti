// The names the repository declares (footprint.ts, § 5 item 5): the functions, types, constants,
// methods and fields its tracked source files define, read once per commit with the files git
// lists (schedule.ts's footprintsOf). A function a footprint names counts toward overlap only when
// the repository declares it: tickets name library and everyday functions (Effect.fn,
// JSON.stringify, Object.is) that say nothing about where they work. A declaration is read by its
// look, a line at a time, in the languages tickets' projects are written in; a name read where
// there is none (a field of an object literal, a call written as a method would be) only holds
// tickets apart as every name did before.
import { Effect, FileSystem } from "effect"
import { readSource, realRoot } from "./overlap.ts"
import { extensionOf, repoPath } from "./repoFiles.ts"
import { setOf } from "./text.ts"

/** The extensions of the source files declarations are read from: code, not prose or data. */
export const codeExtensions = setOf(`go swift py js mjs cjs ts mts cts tsx jsx rs rb java kt kts c
  h cc cpp hpp m mm sh bash zsh gradle cs php ex exs erl hs ml scala dart vue svelte`)

// Words as alternatives of a regular expression.
const either = (words: string): string => [...setOf(words)].join("|")

// A declaration by its keyword, starting a line after its modifiers: function merge, export const
// Loop, pub fn run, async def main, class Git, type Footprint, interface RepoFiles, def self.name;
// not a type an import names on a line of its own (  type Effect,).
const keyword = new RegExp(
  String.raw`^[ \t]*(?:(?:${either(`export default declare async public private protected internal
    static abstract final sealed open override unsafe inline extern data case`)}|pub(?:\([\w ]*\))?|` +
    String.raw`const(?=[ \t]+fn\b))[ \t]+)*(?:function\b\*?|(?:${either(`func fn fun def class
    struct interface trait type enum union namespace module object record const let var val
    static`)})\b)` +
    String.raw`[ \t]*\*?[ \t]*(?:self\.)?([A-Za-z_$][\w$]*)(?![\w$]|[ \t]*[,}]|[ \t]+as\b)`,
  "gm",
)
// A Go method: func (r *Repo) Merge(.
const goMethod = /^func[ \t]*\([^)\n]*\)[ \t]*([A-Za-z_]\w*)/gm
// A method, a field or a shell function, starting a line after its modifiers: merge(a: A): B,
// merge(a) {, readonly merge: (a: A) => B, files?: string, name() {. A call starting a line
// (merge(a)) is none: a method's parameters are followed by its type or its body; nor is a
// statement (if (x) {). A signature is read up to 200 characters a part, so that a long line (a
// bundle's) takes no longer than a short one.
const member = new RegExp(
  String.raw`^[ \t]*(?:(?:${either(`public private protected internal static async readonly
    abstract override get set declare final open`)})[ \t]+)*` +
    String.raw`(?!(?:${either("if for while switch catch with elif else return")})\b)` +
    String.raw`([A-Za-z_$][\w$]*)[?!]?[ \t]*` +
    String.raw`(?:<[^>\n]{0,200}>[ \t]*)?(?:\([^\n]{0,200}\)[ \t]*(?::[^\n]{0,200})?\{[ \t]*$|` +
    String.raw`\([^\n]{0,200}\)[ \t]*:|:)`,
  "gm",
)
// An assignment starting a line, at a module's top: MAX_SIZE = 10 (Python), name=value (shell).
const assigned = /^([A-Za-z_$][\w$]*)[ \t]*=(?!=)/gm

/** The names source text declares, each once, by its look (see the regular expressions above). */
export const declaredIn = (text: string): ReadonlyArray<string> => [
  ...new Set(
    [keyword, goMethod, member, assigned].flatMap((form) =>
      [...text.matchAll(form)].map((m) => m[1] ?? "").filter((name) => name !== ""),
    ),
  ),
]

/** How many source files are read at once for their declarations. */
const readsAtOnce = 16

/**
 * The names declared in the source files (codeExtensions) among `files`, the files git tracks, in
 * the checkout at repo, up to `maxSource` bytes of each and never a file that resolves outside
 * repo: undefined, every name counting, when none of them could be read.
 */
export const readDeclared = (
  repo: string,
  files: ReadonlyArray<string>,
): Effect.Effect<ReadonlySet<string> | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const code = files.filter((f) => repoPath(f) && codeExtensions.has(extensionOf(f)))
    const declared = new Set<string>()
    if (code.length === 0) return declared
    const root = yield* realRoot(fs, repo)
    let read = 0
    yield* Effect.forEach(
      code,
      (file) =>
        Effect.map(readSource(fs, root, repo, file), (text) => {
          if (text === undefined) return
          read++
          for (const name of declaredIn(text)) declared.add(name)
        }),
      { concurrency: readsAtOnce, discard: true },
    )
    return read === 0 ? undefined : declared
  })
