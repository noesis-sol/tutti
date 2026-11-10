// scripts/check-deps.ts: fails the tests when node_modules is behind bun.lock (tutti-a8q2).
//
// A checkout whose node_modules was installed before a dependency bump runs the suites on the old
// packages: the main checkout, which tutti's merges fast-forward but nobody reinstalls in, still had
// OpenTUI 0.7.0 a week after the bump to 0.8.1, and ui-worker-view-range-shrink.test.tsx failed
// there on every run on the bug 0.8.0 fixed, passing everywhere else. So scripts/test.ts starts by
// comparing each package bun.lock resolves with the one installed, and stops, naming the packages
// and `bun install --frozen-lockfile`, when one differs. A package bun.lock has that isn't installed counts only when package.json names it: the
// other platforms' optional packages are in bun.lock too.
//
// Run as `bun scripts/check-deps.ts [<name>]`, from the repository's root: it prints nothing and
// exits 0 when node_modules matches, else says what differs, prefixed with the name, and exits 1.
import { readFileSync } from "node:fs"
import { join } from "node:path"

/** bun.lock's fields this reads: the workspace's dependencies, and each package's `name@version`. */
interface Lock {
  readonly workspaces?: Readonly<
    Record<string, { readonly [field: string]: Readonly<Record<string, string>> | string }>
  >
  readonly packages?: Readonly<Record<string, ReadonlyArray<unknown>>>
}

/** node_modules' folder for a bun.lock key: `a/b` is b nested in a, `@s/a/@t/b` is @t/b in @s/a. */
export const packageFolder = (root: string, key: string): string => {
  const parts = key.split("/")
  const names: Array<string> = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? ""
    names.push(part.startsWith("@") ? `${part}/${parts[++i] ?? ""}` : part)
  }
  return join(root, ...names.flatMap((name) => ["node_modules", name]))
}

/** The version in a `name@version` entry, `@s/a@1.2.3` included; none for a git or file one. */
export const lockedVersion = (entry: string): string | undefined => {
  const version = entry.slice(entry.lastIndexOf("@") + 1)
  return /^\d/.test(version) ? version : undefined
}

const installedVersion = (folder: string): string | undefined => {
  try {
    const manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"))
    return typeof manifest.version === "string" ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/** The packages whose installed version isn't bun.lock's, a line each, in bun.lock's order. */
export const staleDependencies = (root: string): ReadonlyArray<string> => {
  const lock = Bun.JSONC.parse(readFileSync(join(root, "bun.lock"), "utf8")) as Lock
  const workspace = lock.workspaces?.[""] ?? {}
  const direct = new Set(
    ["dependencies", "devDependencies", "optionalDependencies"].flatMap((field) => {
      const names = workspace[field]
      return typeof names === "object" ? Object.keys(names) : []
    }),
  )
  return Object.entries(lock.packages ?? {}).flatMap(([key, value]) => {
    const entry = value[0]
    const locked = typeof entry === "string" ? lockedVersion(entry) : undefined
    if (locked === undefined) return []
    const installed = installedVersion(packageFolder(root, key))
    if (installed === locked) return []
    if (installed === undefined) {
      return direct.has(key) ? [`${key} is not installed, bun.lock has ${locked}`] : []
    }
    return [`${key} ${installed} is installed, bun.lock has ${locked}`]
  })
}

/** What to say of a stale node_modules, or nothing when it matches bun.lock. */
export const staleReport = (name: string, stale: ReadonlyArray<string>): ReadonlyArray<string> =>
  stale.length === 0
    ? []
    : [
        `${name}: node_modules is behind bun.lock; run bun install --frozen-lockfile:`,
        ...stale.map((line) => `  ${line}`),
      ]

if (import.meta.main) {
  const report = staleReport(Bun.argv[2] ?? "scripts/check-deps.ts", staleDependencies("."))
  for (const line of report) console.error(line)
  process.exit(report.length === 0 ? 0 : 1)
}
