// scripts/check-own.ts: picks the test files a change touches, for scripts/check-own.sh.
//
// A test file is touched when it changed, or when it reads a changed file: imports it, or a module
// that imports it, at any depth, or names it by path outside its imports (a script it runs, a fixture
// it reads): tests and their helpers only, as the product's own modules name paths of the projects
// it runs in. Imports are read from the text, not resolved by Bun, so a deleted module still counts
// for the files that import it. A type-only statement (import type … from, export type … from)
// doesn't count: Bun erases it, so the test runs the same whatever the module holds, and a type
// error a change causes in a test is tsc's to find, which check-own.sh runs on the whole project
// when TypeScript changed. import { type X } … still counts, as verbatimModuleSyntax keeps it as a
// side-effect import. A change to the test runner (scripts/test.ts) or its preload
// (test/warm-up.ts) touches every test.
//
// A pass stands for the next run in the same worktree (standOn): check-own.sh keeps, under the
// worktree's own git dir, the tree its tests passed on (HEAD's with what isn't committed yet,
// untracked files included), its mode (plain, or slow for TUTTI_SLOW=1) and the test files that
// passed there. The next run leaves out those that what changed since that tree doesn't touch. A
// slow pass stands for a plain run too, as it ran more; a plain one stands for a slow run only for
// the test files with no slow gate (slowGated), which run the same in both modes. A run
// whose tests failed keeps, at its tree, the test files whose tests all passed in it and the earlier
// pass's that it left out (afterFailure): the next one runs the files that failed again.
//
// Run as `bun scripts/check-own.ts <changed file>...`: it prints the test files to run, one a line,
// or ALL for the whole suite, reading the repository's src/, test/ and scripts/ from the current
// folder, after lines saying what it left out, which start with "check-own:" or "test:". It writes
// the record should the run pass to <git dir>/tutti-check-own-next.json, which check-own.sh keeps
// on a pass, and the earlier pass's tests it leaves out to tutti-check-own-unrun.json. After a
// failed test step, check-own.sh runs `bun scripts/check-own.ts --failed <file>`, the file the
// files that passed, which scripts/test.ts wrote (TUTTI_CHECK_OWN_PASSED), to keep them.
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, normalize } from "node:path"

/** Changes that touch every test. */
export const wholeSuite: ReadonlyArray<string> = ["scripts/test.ts", "test/warm-up.ts"]

/**
 * The project's setup, a change to which since main makes check-own.sh run scripts/check.sh whole
 * (its list, kept the same), and a change to which since a pass makes no earlier test stand.
 */
export const setupFiles: ReadonlyArray<string> = [
  "package.json",
  "bun.lock",
  "tsconfig.json",
  "bunfig.toml",
  "biome.json",
  "scripts/check.sh",
]

export const isTestFile = (file: string): boolean =>
  file.startsWith("test/") && /\.test\.tsx?$/.test(file)

const isModule = (file: string): boolean => /\.(ts|tsx|js|mjs)$/.test(file)

/** An import, re-export or require in a module's text, its specifier the first group. */
const importPattern = /\b(?:from|import|require)\s*\(?\s*["']([^"'\n]+)["']/g

/**
 * A type-only import or re-export: import type X, import type { X }, import type * as X, export
 * type { X } and export type * (as X), each from a specifier. import type from "x" imports a default
 * named type, a value.
 */
const typeOnlyPattern =
  /\b(?:import|export)\s+type\s+(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|(?!from\s*["'])[\w$]+)\s*from\s*["'][^"'\n]+["']/g

/**
 * The specifiers a module's text imports, re-exports or requires, relative or not, leaving out
 * type-only statements, which Bun erases.
 */
export const specifiers = (source: string): ReadonlyArray<string> =>
  [...source.replace(typeOnlyPattern, "").matchAll(importPattern)].map((match) => match[1] ?? "")

/**
 * A module's text with its imports, re-exports and requires taken out, for pathMentions to look in:
 * the import graph follows those exactly, and a folder named in one ("../src/run/x.ts" names
 * src/run) doesn't make a test read every file in it.
 */
export const withoutImports = (source: string): string => source.replace(importPattern, "")

/**
 * The repository-relative file a relative specifier in `from` names, trying the extensions an
 * import may leave out where `exists` finds none of the bare path; undefined for a package.
 */
export const resolveSpecifier = (
  from: string,
  specifier: string,
  exists: (file: string) => boolean,
): string | undefined => {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined
  const bare = normalize(join(dirname(from), specifier))
  if (bare.startsWith("../")) return undefined
  const candidates = [bare, `${bare}.ts`, `${bare}.tsx`, `${bare}/index.ts`, `${bare}/index.tsx`]
  return candidates.find(exists) ?? bare
}

/**
 * The texts that name a file in a test that reads it other than by importing it (a script or a
 * fixture it runs or reads): its path, and each folder it is in, from the folder under the top one
 * down (fixtures/bd for test/fixtures/bd/x.json), relative to test/ for the files there, as tests
 * name them from their own folder. The path is named as join's arguments too ("src", "main.ts"),
 * as the tests that start tutti name src/main.ts.
 */
export const pathMentions = (file: string): ReadonlyArray<string> => {
  const parts = (file.startsWith("test/") ? file.slice("test/".length) : file).split("/")
  const mentions = [parts.join("/")]
  if (parts.length > 1) mentions.push(`"${parts.join('", "')}"`)
  for (let end = parts.length - 1; end >= 2; end--) {
    const folder = parts.slice(0, end)
    mentions.push(folder.join("/"), folder.join('", "'))
  }
  return mentions
}

/** The modules that import, re-export or require each module of `sources`, by its path. */
const importersOf = (
  sources: ReadonlyMap<string, string>,
  exists: (file: string) => boolean,
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const importers = new Map<string, Array<string>>()
  for (const [file, source] of sources) {
    for (const specifier of specifiers(source)) {
      const target = resolveSpecifier(file, specifier, exists)
      if (target === undefined) continue
      const list = importers.get(target)
      if (list === undefined) importers.set(target, [file])
      else list.push(file)
    }
  }
  return importers
}

/**
 * The test files a change touches, sorted, or "all" for the whole suite. `sources` holds the text of
 * every module that may import or name another (src/, test/, scripts/), by repository-relative path.
 */
export const testsFor = (
  changed: ReadonlyArray<string>,
  sources: ReadonlyMap<string, string>,
  exists: (file: string) => boolean,
): ReadonlyArray<string> | "all" => {
  if (changed.some((file) => wholeSuite.includes(file))) return "all"
  const importers = importersOf(sources, exists)
  const touched = new Set<string>()
  const queue: Array<string> = []
  const touch = (file: string) => {
    if (touched.has(file)) return
    touched.add(file)
    queue.push(file)
  }
  const testTexts = [...sources]
    .filter(([source]) => source.startsWith("test/"))
    .map(([source, text]) => [source, withoutImports(text)] as const)
  for (const file of changed) {
    touch(file)
    const mentions = pathMentions(file)
    for (const [source, text] of testTexts) {
      if (mentions.some((mention) => text.includes(mention))) touch(source)
    }
  }
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const importer of importers.get(file) ?? []) touch(importer)
  }
  return [...touched].filter((file) => isTestFile(file) && exists(file)).sort()
}

/** The tests' gates (§ 13): slow.test and slow.describe there run only with TUTTI_SLOW=1. */
export const gatesModule = "test/gates.ts"

/** A named import's list and specifier: import { slow, live as l } from "./gates.ts". */
const namedImportPattern = /\bimport\s*\{([^}]*)\}\s*from\s*["']([^"'\n]+)["']/g

/** A namespace import's name and specifier: import * as gates from "./gates.ts". */
const namespaceImportPattern = /\bimport\s*\*\s*as\s+([\w$]+)\s+from\s*["']([^"'\n]+)["']/g

const escaped = (name: string): string => name.replace(/\$/g, "\\$")

/**
 * Whether a module's own text in test/, test/gates.ts aside, may run a test differently with
 * TUTTI_SLOW=1: a call of the gates' slow (slow.test, slow.describe, or a property of the name it
 * imports slow as), or the variable named, as a test that sets it for a script it runs does.
 * Importing slow alone doesn't count: a test that imports it but calls only live runs the same.
 * Modules outside test/ don't use the gates, and their text (this file's) names them freely.
 */
const gatesItself = (file: string, source: string, exists: (file: string) => boolean): boolean => {
  if (!file.startsWith("test/") || file === gatesModule) return false
  if (source.includes("TUTTI_SLOW")) return true
  const calls = [/\bslow\s*\.\s*(?:test|describe)\b/]
  const fromGates = (specifier: string) => resolveSpecifier(file, specifier, exists) === gatesModule
  for (const [, names = "", specifier = ""] of source.matchAll(namedImportPattern)) {
    if (!fromGates(specifier)) continue
    for (const name of names.split(",")) {
      const [imported, local = imported] = name.trim().split(/\s+as\s+/)
      if (imported === "slow" && local !== undefined && local !== "slow") {
        calls.push(new RegExp(`(?<![\\w$.])${escaped(local)}\\s*\\.`))
      }
    }
  }
  for (const [, name = "", specifier = ""] of source.matchAll(namespaceImportPattern)) {
    if (fromGates(specifier))
      calls.push(new RegExp(`(?<![\\w$.])${escaped(name)}\\s*\\.\\s*slow\\b`))
  }
  return calls.some((call) => call.test(source))
}

/**
 * The test files that may run differently in a TUTTI_SLOW=1 run (slow-gated), sorted: those whose
 * text calls the gates' slow or names TUTTI_SLOW (gatesItself), or imports a module that does, at
 * any depth, as testsFor follows imports. A plain pass stands for the others in a slow run, as they
 * run the same in both modes.
 */
export const slowGated = (
  sources: ReadonlyMap<string, string>,
  exists: (file: string) => boolean,
): ReadonlyArray<string> => {
  const importers = importersOf(sources, exists)
  const gated = new Set<string>()
  const queue = [...sources]
    .filter(([file, source]) => gatesItself(file, source, exists))
    .map(([file]) => file)
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (gated.has(file)) continue
    gated.add(file)
    queue.push(...(importers.get(file) ?? []))
  }
  return [...gated].filter(isTestFile).sort()
}

/** A pass of check-own's tests: the tree it ran on, its mode, and the test files that passed. */
export interface PassRecord {
  readonly tree: string
  readonly mode: "plain" | "slow"
  readonly tests: ReadonlyArray<string>
}

/** A pass record read from its file's text, or undefined where the text isn't one. */
export const readRecord = (text: string): PassRecord | undefined => {
  try {
    const { tree, mode, tests } = JSON.parse(text) ?? {}
    if (typeof tree !== "string" || !/^[0-9a-f]{40,64}$/.test(tree)) return undefined
    if (mode !== "plain" && mode !== "slow") return undefined
    if (!Array.isArray(tests) || !tests.every((test) => typeof test === "string")) return undefined
    return { tree, mode, tests }
  } catch {
    return undefined
  }
}

/**
 * The tests a run picks standing on an earlier pass: `selection` is testsFor of the change since
 * main, `since` testsFor of the change since the pass's tree, `passed` the pass's tests and `all`
 * every test file. It leaves out those that passed and that the change since doesn't touch.
 * `passed` in the result is what holds at this tree should the run pass: the tests it runs, and the
 * earlier pass's that the change since doesn't touch.
 */
export const standOn = (
  selection: ReadonlyArray<string> | "all",
  since: ReadonlyArray<string> | "all",
  passed: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
): {
  readonly run: ReadonlyArray<string> | "all"
  readonly leftOut: number
  readonly passed: ReadonlyArray<string>
} => {
  const picked = standOnPasses(selection, [{ since, passed }], all)
  return { run: picked.run, leftOut: picked.leftOut[0] ?? 0, passed: picked.passed }
}

/**
 * standOn on several passes at once: a slow run stands on its mode's pass and on the plain pass's
 * tests with no slow gate (slowGated), each with the change since its own tree. A test stands where
 * any pass stands for it; `leftOut` counts, for each pass in turn, the selected tests it stands for
 * that no earlier one does.
 */
export const standOnPasses = (
  selection: ReadonlyArray<string> | "all",
  passes: ReadonlyArray<{
    readonly since: ReadonlyArray<string> | "all"
    readonly passed: ReadonlyArray<string>
  }>,
  all: ReadonlyArray<string>,
): {
  readonly run: ReadonlyArray<string> | "all"
  readonly leftOut: ReadonlyArray<number>
  readonly passed: ReadonlyArray<string>
} => {
  const chosen = selection === "all" ? all : selection
  const present = new Set(all)
  const stands = new Set<string>()
  const leftOut = passes.map(({ since, passed }) => {
    const touched = new Set(since === "all" ? all : since)
    const before = chosen.filter((test) => stands.has(test)).length
    for (const test of passed) {
      if (present.has(test) && !touched.has(test)) stands.add(test)
    }
    return chosen.filter((test) => stands.has(test)).length - before
  })
  const run = chosen.filter((test) => !stands.has(test))
  return {
    run: run.length === chosen.length ? selection : run,
    leftOut,
    passed: [...new Set([...run, ...stands])].sort(),
  }
}

/**
 * What a failed run keeps (tutti-0vbd.2): `next` is the record it wrote should it pass, `unrun` the
 * one should it fail, the earlier pass's tests it left out, at the same tree, and `passed` the test
 * files whose tests all passed in it (scripts/test.ts' passedFiles). `kept` holds, at the run's
 * tree, the tests it left out and those it ran that passed; `failed` the tests it ran that didn't.
 */
export const afterFailure = (
  next: PassRecord,
  unrun: PassRecord,
  passed: ReadonlyArray<string>,
): { readonly kept: PassRecord; readonly failed: ReadonlyArray<string> } => {
  const left = new Set(unrun.tests)
  const ok = new Set(passed)
  return {
    kept: { ...next, tests: next.tests.filter((test) => left.has(test) || ok.has(test)) },
    failed: next.tests.filter((test) => !left.has(test) && !ok.has(test)),
  }
}

/**
 * The file a mode's pass record is kept in, under the worktree's git dir; "next" and "unrun" are a
 * run's own, what holds at its tree should it pass and should its tests fail.
 */
export const recordFile = (gitDir: string, mode: PassRecord["mode"] | "next" | "unrun"): string =>
  join(gitDir, `tutti-check-own-${mode}.json`)

/** The pass record kept in a file, or undefined where there is none. */
const readKept = (file: string): PassRecord | undefined =>
  existsSync(file) ? readRecord(readFileSync(file, "utf8")) : undefined

const writeRecord = (file: string, record: PassRecord): void =>
  writeFileSync(file, `${JSON.stringify(record)}\n`)

/** git's output, trimmed, or undefined where it failed. */
const git = (args: ReadonlyArray<string>, env?: Record<string, string>): string | undefined => {
  const result = Bun.spawnSync(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  })
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined
}

/**
 * The tree of the worktree as it is: HEAD's, with the changes not committed yet and the untracked
 * files git doesn't ignore, written through an index of its own, so the worktree's isn't touched.
 * A copy of that index starts it, so git hashes only the files changed since it was written.
 */
const workingTree = (gitDir: string): string | undefined => {
  const index = join(gitDir, `tutti-check-own-index-${process.pid}`)
  const env = { GIT_INDEX_FILE: index }
  try {
    const own = git(["rev-parse", "--path-format=absolute", "--git-path", "index"])
    if (own !== undefined && existsSync(own)) writeFileSync(index, readFileSync(own))
    else if (git(["read-tree", "HEAD"], env) === undefined) return undefined
    return git(["add", "--all"], env) === undefined ? undefined : git(["write-tree"], env)
  } finally {
    rmSync(index, { force: true })
  }
}

/**
 * Keeps, after a run whose tests failed, what passed in it (afterFailure) as its mode's pass, a slow
 * one for plain runs too, and takes the tests that failed out of the slow pass a plain run leaves:
 * a failed test's file always runs again. `passedFile` is scripts/test.ts' list of the files that
 * passed. False where there is nothing to keep from: the run's records or the list missing.
 */
const keepFailed = (gitDir: string, passedFile: string): boolean => {
  const next = readKept(recordFile(gitDir, "next"))
  const unrun = readKept(recordFile(gitDir, "unrun"))
  if (next === undefined || unrun?.tree !== next.tree || !existsSync(passedFile)) return false
  const passed = readFileSync(passedFile, "utf8").split("\n")
  const { kept, failed } = afterFailure(next, unrun, passed)
  writeRecord(recordFile(gitDir, next.mode), kept)
  const count = kept.tests.length
  console.log(
    `check-own: kept ${count} test file${count === 1 ? "" : "s"} passed at ` +
      `${kept.tree.slice(0, 7)} for the next run; ${failed.length} failed.`,
  )
  if (next.mode === "slow") writeRecord(recordFile(gitDir, "plain"), kept)
  else {
    const slow = readKept(recordFile(gitDir, "slow"))
    if (slow !== undefined) {
      writeRecord(recordFile(gitDir, "slow"), {
        ...slow,
        tests: slow.tests.filter((test) => !failed.includes(test)),
      })
    }
  }
  return true
}

const pick = (): void => {
  const listed = Bun.spawnSync([
    "git",
    "ls-files",
    "-co",
    "--exclude-standard",
    "src",
    "test",
    "scripts",
  ])
  const sources = new Map<string, string>()
  for (const file of listed.stdout.toString().split("\n")) {
    if (isModule(file) && existsSync(file)) sources.set(file, readFileSync(file, "utf8"))
  }
  const isFile = (file: string) => existsSync(file) && statSync(file).isFile()
  const selection = testsFor(Bun.argv.slice(2), sources, isFile)
  const all = [...sources.keys()].filter((file) => isTestFile(file) && isFile(file)).sort()
  const mode = process.env.TUTTI_SLOW === "1" ? "slow" : "plain"
  const gitDir = git(["rev-parse", "--absolute-git-dir"])
  const tree = gitDir === undefined ? undefined : workingTree(gitDir)
  const record = gitDir === undefined ? undefined : readKept(recordFile(gitDir, mode))
  // In a slow run, the plain pass stands for the test files with no slow gate too.
  const plain =
    gitDir === undefined || mode !== "slow" ? undefined : readKept(recordFile(gitDir, "plain"))
  // The tests the change since a pass's tree touches; undefined for a tree git no longer has
  // (pruned), which reads as no pass.
  const touchedSince = (pass: PassRecord): ReadonlyArray<string> | "all" | undefined => {
    if (tree === undefined) return undefined
    const since = git(["diff", "--name-only", "--no-renames", pass.tree, tree, "--"])
    if (since === undefined) return undefined
    const changed = since.split("\n").filter((file) => file !== "")
    return changed.some((file) => setupFiles.includes(file))
      ? "all"
      : testsFor(changed, sources, isFile)
  }
  const passes: Array<{
    readonly since: ReadonlyArray<string> | "all"
    readonly passed: ReadonlyArray<string>
    readonly why: (count: number) => string
  }> = []
  const files = (count: number) => `${count} test file${count === 1 ? "" : "s"}`
  const ownSince = record === undefined ? undefined : touchedSince(record)
  if (record !== undefined && ownSince !== undefined) {
    passes.push({
      since: ownSince,
      passed: record.tests,
      why: (count) => `${files(count)} passed at ${record.tree.slice(0, 7)}`,
    })
  }
  const plainSince = plain === undefined ? undefined : touchedSince(plain)
  if (plain !== undefined && plainSince !== undefined) {
    const gated = new Set(slowGated(sources, isFile))
    passes.push({
      since: plainSince,
      passed: plain.tests.filter((test) => !gated.has(test)),
      why: (count) =>
        `${files(count)} with no slow test passed at ${plain.tree.slice(0, 7)} in a plain run`,
    })
  }
  const picked = standOnPasses(selection, passes, all)
  const reasons = passes.flatMap(({ why }, at) => {
    const count = picked.leftOut[at] ?? 0
    return count > 0 ? [why(count)] : []
  })
  if (reasons.length > 0) {
    const running = picked.run === "all" ? all.length : picked.run.length
    console.log(
      `check-own: ${reasons.join(", and ")} and nothing since touches them; ` +
        `running ${running || "none"}.`,
    )
  }
  if (gitDir !== undefined && tree !== undefined) {
    writeRecord(recordFile(gitDir, "next"), { tree, mode, tests: picked.passed })
    const ran = new Set(picked.run === "all" ? all : picked.run)
    const unrun = picked.passed.filter((test) => !ran.has(test))
    writeRecord(recordFile(gitDir, "unrun"), { tree, mode, tests: unrun })
  }
  if (selection !== "all" && selection.length === 0) {
    console.log("test: no test file covers the change")
  }
  console.log(picked.run === "all" ? "ALL" : picked.run.join("\n"))
}

if (import.meta.main) {
  if (Bun.argv[2] === "--failed") {
    const gitDir = git(["rev-parse", "--absolute-git-dir"])
    process.exit(gitDir !== undefined && keepFailed(gitDir, Bun.argv[3] ?? "") ? 0 : 1)
  }
  pick()
}
