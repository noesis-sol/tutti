// What the merge check's and the full check's scripts run (repoFiles' check files, § 5 item 5): a
// check command that is a script in the repository (scripts/check-fast.sh) runs what its lines
// name (scripts/check.sh), and a ticket that says the check passes names that, not the script.
// Their lines join the check commands, one level deep: what they run is read no further. The
// worker's own check's script is left out: what it runs (scripts/check-own.ts) tickets change.
import { Effect, FileSystem } from "effect"
import { nfc } from "./glob.ts"
import { readSource, realRoot } from "./overlap.ts"
import { clean, repoPath } from "./repoFiles.ts"
import { eachPathToken } from "./text.ts"

/**
 * The tracked files (`tracked`, as git lists them) a check command runs as scripts: the paths from
 * the repository's root it names (`scripts/check-fast.sh`, `sh ./scripts/lint.sh`), each once.
 */
export const scriptsRun = (
  command: string,
  tracked: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const byName = new Map<string, string>()
  for (const f of tracked) if (repoPath(f)) byName.set(nfc(f), f)
  const found: Array<string> = []
  const named = (word: string): string | undefined => {
    const n = nfc(word.startsWith("./") ? word.slice(2) : word)
    return repoPath(n) ? byName.get(clean(n)) : undefined
  }
  eachPathToken(
    command,
    (token) => {
      const f = named(token)
      if (f !== undefined && !found.includes(f)) found.push(f)
      return f !== undefined
    },
    (word) => word.includes("/") && named(word) !== undefined,
  )
  return found
}

/** A script's lines but its comments, those starting with # (a shebang too) or //. */
export const uncommented = (text: string): ReadonlyArray<string> =>
  text.split("\n").filter((line) => !/^\s*(?:#|\/\/)/.test(line))

/**
 * The uncommented lines of the scripts `commands` run (`scriptsRun`) among `tracked`, in the
 * checkout at repo: never a file that resolves outside it, and none of a script that can't be read.
 */
export const checkScriptLines = (
  repo: string,
  tracked: ReadonlyArray<string>,
  commands: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const scripts = [...new Set(commands.flatMap((command) => scriptsRun(command, tracked)))]
    if (scripts.length === 0) return []
    const fs = yield* FileSystem.FileSystem
    const root = yield* realRoot(fs, repo)
    const texts = yield* Effect.forEach(scripts, (file) => readSource(fs, root, repo, file))
    return texts.flatMap((text) => (text === undefined ? [] : uncommented(text)))
  })
