// The startup check that what a ticket's worktree runs is committed (§ 5 item 1; tutti-m9cm): a
// worktree has only what the base's head commit holds, so a merge check, full check or setup
// command whose script isn't committed fails every ticket with `No such file or directory`. A
// command that isn't a path in the repository (npm test, make check) is found on PATH, and isn't
// looked at. The project's settings and worker prompt untracked are a warning: a worker reads the
// project's files from its own tree.
import { isAbsolute, relative, resolve, sep } from "node:path"
import { Effect, Result } from "effect"
import { workerPromptFile } from "../core/AppConfig.ts"
import { formatDuration } from "../project/configFile.ts"
import { type Settings, settingsFile } from "../project/settings.ts"
import { Git } from "../services/Git.ts"
import { sanitizeLine } from "../text/sanitize.ts"

/** A variable's assignment before a command's first word: `TUTTI_SLOW=1 scripts/check.sh`. */
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/u

/** A word the shell would expand or split, whose path tutti can't know without running it. */
const expanded = /[$`*?~[\]{}()<>|;&\\'"]/u

/**
 * The path in the repository `repo` that `command`'s first word names, as git names it (from the
 * repository's top, `/`-separated); null where it names none: a word without a `/`, found on PATH,
 * one the shell expands, or a path outside the repository.
 */
export const commandPath = (command: string, repo: string): string | null => {
  const words = command.trim().split(/\s+/u)
  const first = words.find((word) => !assignment.test(word))
  if (first === undefined) return null
  // A word quoted whole is that word.
  const word = /^(["'])(.*)\1$/u.exec(first)?.[2] ?? first
  if (!word.includes("/") || expanded.test(word)) return null
  const path = relative(repo, resolve(repo, word))
  if (path === "" || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return null
  return path.split(sep).join("/")
}

/** The checks whose scripts a ticket's worktree runs, with what the run calls each. */
const checksOf = (checks: Settings["checks"]): ReadonlyArray<readonly [string, string | null]> => [
  ["the merge check", checks.fast.command],
  ["the full check", checks.full.command],
  ["the setup command", checks.setup.command],
]

/** `a`, `a and b`, `a, b and c`. */
const listed = (names: ReadonlyArray<string>): string =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`

/**
 * The problems with the checks' scripts in `repo`: each script a check's command names that the
 * base's head commit doesn't hold, unless git ignores it (a tool's, under node_modules/) or it is
 * one of `uncommitted`, which a spec run commits with its spec. A script committed but changed is
 * the clean-tree check's.
 */
export const checkScriptsCommitted = (
  repo: string,
  base: string,
  checks: Settings["checks"],
  uncommitted: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const git = yield* Git
    const scripts = new Map<string, Array<string>>()
    for (const [name, command] of checksOf(checks)) {
      const path = command === null ? null : commandPath(command, repo)
      if (path === null || uncommitted.includes(path)) continue
      scripts.set(path, [...(scripts.get(path) ?? []), name])
    }
    const problems = yield* Effect.forEach(
      [...scripts],
      ([path, names]) =>
        Effect.gen(function* () {
          const there = yield* Effect.result(git.fileAt(repo, base, path))
          if (Result.isSuccess(there)) return []
          const error = there.failure
          const shown = sanitizeLine(path)
          if (error._tag === "GitTimedOut") {
            return [
              `Could not read whether ${shown}, ${listed(names)}, is committed on ${sanitizeLine(base)}: git took longer than ${formatDuration(error.timeLimit)}.`,
            ]
          }
          if (yield* git.ignored(repo, path).pipe(Effect.orElseSucceed(() => false))) return []
          return [
            `${shown}, ${listed(names)}, is not committed on ${sanitizeLine(base)}: a ticket's worktree would not have it. Commit it (git add ${shown} .tutti && git commit), then start again.`,
          ]
        }),
      { concurrency: "unbounded" },
    )
    return problems.flat()
  })

/**
 * The warning when the project's settings or worker prompt (unless the run has one of its own) are
 * untracked in `repo`, except those of `uncommitted`, which a spec run commits with its spec; none
 * when git can't say.
 */
export const projectFilesUntracked = (
  repo: string,
  ownPrompt: boolean,
  uncommitted: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const git = yield* Git
    const files = [settingsFile, ...(ownPrompt ? [] : [workerPromptFile])].map((file) =>
      file.split(sep).join("/"),
    )
    const status = yield* git.status(repo, files).pipe(Effect.orElseSucceed(() => []))
    const untracked = status
      .filter((entry) => entry.code === "??" && !uncommitted.includes(entry.path))
      .map((entry) => sanitizeLine(entry.path))
    if (untracked.length === 0) return []
    const [subject, them] = untracked.length === 1 ? ["is", "it"] : ["are", "them"]
    return [
      `${listed(untracked)} ${subject} not committed: a ticket's worktree would not have ${them}, and its worker reads the project's files from its own tree. Commit ${them} (git add .tutti && git commit).`,
    ]
  })
