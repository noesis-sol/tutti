// scripts/check-own.ts: picks the test files a change touches, for scripts/check-own.sh.
//
// A test file is touched when it changed, or when it reads a changed file: imports it, or a module
// that imports it, at any depth, or names it by path (a script it runs, a fixture it reads): tests and
// their helpers only, as the product's own modules name paths of the projects it runs in. Imports
// are read from the text, not resolved by Bun, so type-only imports count too, and a deleted module
// still counts for the files that import it. A change to the test runner (scripts/test.ts) or its
// preload (test/warm-up.ts) touches every test.
//
// Run as `bun scripts/check-own.ts <changed file>...`: it prints the test files, one a line, or ALL
// for the whole suite, reading the repository's src/, test/ and scripts/ from the current folder.
import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join, normalize } from "node:path"

/** Changes that touch every test. */
export const wholeSuite: ReadonlyArray<string> = ["scripts/test.ts", "test/warm-up.ts"]

export const isTestFile = (file: string): boolean =>
  file.startsWith("test/") && /\.test\.tsx?$/.test(file)

const isModule = (file: string): boolean => /\.(ts|tsx|js|mjs)$/.test(file)

/** The specifiers a module's text imports, re-exports or requires, relative or not. */
export const specifiers = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(/\b(?:from|import|require)\s*\(?\s*["']([^"'\n]+)["']/g)].map(
    (match) => match[1] ?? "",
  )

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
 * name them from their own folder.
 */
export const pathMentions = (file: string): ReadonlyArray<string> => {
  const parts = (file.startsWith("test/") ? file.slice("test/".length) : file).split("/")
  const mentions = [parts.join("/")]
  for (let end = parts.length - 1; end >= 2; end--) {
    const folder = parts.slice(0, end)
    mentions.push(folder.join("/"), folder.join('", "'))
  }
  return mentions
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
  const importers = new Map<string, Array<string>>()
  const readsOf = (file: string): Array<string> => {
    let list = importers.get(file)
    if (list === undefined) {
      list = []
      importers.set(file, list)
    }
    return list
  }
  for (const [file, source] of sources) {
    for (const specifier of specifiers(source)) {
      const target = resolveSpecifier(file, specifier, exists)
      if (target !== undefined) readsOf(target).push(file)
    }
  }
  const touched = new Set<string>()
  const queue: Array<string> = []
  const touch = (file: string) => {
    if (touched.has(file)) return
    touched.add(file)
    queue.push(file)
  }
  for (const file of changed) {
    touch(file)
    const mentions = pathMentions(file)
    for (const [source, text] of sources) {
      if (!source.startsWith("test/")) continue
      if (mentions.some((mention) => text.includes(mention))) touch(source)
    }
  }
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const importer of importers.get(file) ?? []) touch(importer)
  }
  return [...touched].filter((file) => isTestFile(file) && exists(file)).sort()
}

if (import.meta.main) {
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
  const tests = testsFor(Bun.argv.slice(2), sources, isFile)
  console.log(tests === "all" ? "ALL" : tests.join("\n"))
}
