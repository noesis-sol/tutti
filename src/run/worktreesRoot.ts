// The worktrees' root (§ 11): where a run's worktrees go, made ready as the run starts, with the run
// lock held, before the overnight pre-flight and the run's services, which make worktrees there.
//
// The default is ~/.tutti/worktrees/<name>, one per-user folder for every project's worktrees, as the
// parallel-agent tools keep theirs (Codex's ~/.codex/worktrees, Cursor's ~/.cursor/worktrees/<project>),
// so that one exclusion covers them all; not inside the repository, where git status, the
// repository's tools and upward lookups (node resolution, tsconfig, CLAUDE.md) would see them.
// <name> is the repository folder's name, or, where another repository of that name has it (its
// .repo file names that one), the name with a short hash of the repository's path, as app-3f9c. The
// .repo file, written as a run first claims the root, keeps the choice stable.
//
// On macOS the run excludes the folder from Time Machine (tmutil addexclusion, sticky, on the folder
// itself: ~/.tutti/worktrees for the default, the root itself for --worktrees), checking at each
// start that it still is, unless exclude_worktrees is false; a failure is a warning, never a stop.
// Spotlight indexes nothing under a hidden folder (found on 2026-11-03, § 11), nor under a folder
// named *.noindex: ~/.tutti's worktrees aren't indexed, and tutti changes nothing for it.
//
// Before tutti-omox the default was <repo>-tutti beside the repository. A run on the default root
// moves the worktrees git lists under that old root, and its .trash, into the new one, once, while
// the new one has none of the repository's: each folder renamed, then git worktree repair from the
// main checkout, then state.json's worktree paths. Claude Code finds a saved session by its working
// folder (its projects folder's <the path, each character but a letter or digit a dash>), so a
// worktree's session folder is renamed with it; one whose can't be (its new name is taken, or too
// long to know) is left where it is until its ticket ends. A failure undoes every step done, and the
// run uses the old root, warning once. An old root left empty is removed.
import { createHash } from "node:crypto"
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path"
import { Config, Effect, FileSystem, Option, Result } from "effect"
import type { AppConfigValue } from "../cli/AppConfig.ts"
import { currentHome, fromHome } from "../project/userConfig.ts"
import { Git } from "../services/Git.ts"
import { parseState, readStateText, type State, statePath, writeState } from "../services/Store.ts"
import { TimeMachine } from "../services/TimeMachine.ts"
import { trashFolder } from "../services/Worktrees.ts"

/** The folder of every project's worktrees: `~/.tutti/worktrees`. */
export const worktreesHome = (home: string): string => join(home, ".tutti", "worktrees")

/** The repository's root as no other repository has its name: `~/.tutti/worktrees/<name>`. */
export const plainRoot = (home: string, repo: string): string =>
  join(worktreesHome(home), basename(repo))

/** The file in a root naming the repository whose worktrees it holds: its main checkout's path. */
export const ownerFile = ".repo"

/** The default root before tutti-omox: `<repo>-tutti` beside the repository. */
export const oldDefaultRoot = (repo: string): string =>
  join(dirname(repo), `${basename(repo)}-tutti`)

/**
 * The names the repository's root may take under worktreesHome, in order: its folder's name, then
 * that with 4, 8 and every hex digit of the SHA-256 of its path.
 */
export const rootNames = (repo: string): ReadonlyArray<string> => {
  const name = basename(repo)
  const hash = createHash("sha256").update(repo).digest("hex")
  return [name, `${name}-${hash.slice(0, 4)}`, `${name}-${hash.slice(0, 8)}`, `${name}-${hash}`]
}

/** Whether `path` is `dir` or inside it, ignoring case on macOS, whose filesystems usually do. */
export const within = (path: string, dir: string): boolean => {
  const fold = (p: string) => (process.platform === "darwin" ? p.toLowerCase() : p)
  const rel = relative(fold(dir), fold(path))
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** The repository the root's owner file names; undefined for none, null where it can't be read. */
const ownerOf = (fs: FileSystem.FileSystem, root: string) =>
  fs.readFileString(join(root, ownerFile)).pipe(
    Effect.map((text): string | undefined | null => text.trim()),
    Effect.catchTag("PlatformError", (error) =>
      Effect.succeed(error.reason._tag === "NotFound" ? undefined : null),
    ),
  )

/**
 * The default root of the repository at `repo`: the first of rootNames under worktreesHome that is
 * no other repository's, its owner file naming `repo` or missing. It writes nothing.
 */
export const findRoot = (
  home: string,
  repo: string,
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const roots = rootNames(repo).map((name) => join(worktreesHome(home), name))
    for (const root of roots) {
      const owner = yield* ownerOf(fs, root)
      if (owner === undefined || owner === repo) return root
    }
    return roots[roots.length - 1] as string
  })

/** Whether Spotlight leaves `path` out: a folder on the way hidden, or named `*.noindex`. */
export const unindexed = (path: string): boolean =>
  path
    .split(sep)
    .some(
      (part) =>
        (part.startsWith(".") && part !== "." && part !== "..") || part.endsWith(".noindex"),
    )

/**
 * The name of the folder Claude Code keeps a working folder's sessions in, under its projects
 * folder: the path, each character but a letter or digit a dash; undefined past 200 characters,
 * where Claude Code adds a hash of its own.
 */
export const sessionFolderName = (path: string): string | undefined => {
  const name = path.replace(/[^a-zA-Z0-9]/g, "-")
  return name.length <= 200 ? name : undefined
}

/** Claude Code's projects folder: `projects` in CLAUDE_CONFIG_DIR, else in `~/.claude`. */
export const claudeProjects: Effect.Effect<string> = Effect.gen(function* () {
  const dir = yield* Config.option(Config.String("CLAUDE_CONFIG_DIR"))
  return Option.isSome(dir) && dir.value !== ""
    ? join(dir.value, "projects")
    : join(yield* currentHome, ".claude", "projects")
}).pipe(Effect.orDie)

/** The message of whatever failed. */
const reasonOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error)

/** A count of worktrees, as `1 worktree` or `7 worktrees`. */
const worktreeCount = (n: number): string => (n === 1 ? "1 worktree" : `${n} worktrees`)

/** What moving the worktrees from the old root did. */
export interface Moved {
  /** The worktrees moved. */
  readonly moved: number
  /** The worktrees left in the old root, by folder name, as their sessions couldn't be moved. */
  readonly left: ReadonlyArray<string>
  /** The old root was removed, empty. */
  readonly removed: boolean
}

/** Where the move runs. */
export interface MoveFrom {
  /** The main checkout. */
  readonly repo: string
  /** The old root, `<repo>-tutti`. */
  readonly old: string
  /** The new root, made already. */
  readonly root: string
  /** Claude Code's projects folder. */
  readonly projects: string
}

/** Removes `dir` when nothing is in it but .DS_Store and an empty trash folder; whether it did. */
const removeIfEmpty = (fs: FileSystem.FileSystem, dir: string) =>
  Effect.gen(function* () {
    const names = (yield* fs.readDirectory(dir)).filter((name) => name !== ".DS_Store")
    for (const name of names) {
      if (name !== trashFolder) return false
      if ((yield* fs.readDirectory(join(dir, name))).length > 0) return false
    }
    yield* fs.remove(dir, { recursive: true })
    return true
  })

/**
 * Moves the repository's worktrees from the old root into the new one (see the top), once: nothing
 * where the old root isn't there, and only its removal, when empty, where the new root has worktrees
 * of the repository already. Fails with what went wrong, every step done undone.
 */
export const moveOld = (
  from: MoveFrom,
): Effect.Effect<Moved | undefined, string, Git | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const git = yield* Git
    const { repo, old, root, projects } = from
    if (!(yield* fs.exists(old))) return undefined
    const oldReal = yield* fs.realPath(old)
    const rootReal = yield* fs.realPath(root)
    const listed = (yield* git.worktrees(repo)).slice(1).filter((each) => !each.prunable)
    if (listed.some((each) => within(each.path, rootReal) || within(each.path, root))) {
      const removed = yield* removeIfEmpty(fs, old)
      return { moved: 0, left: [], removed }
    }
    const text = yield* readStateText(repo)
    const state = text === undefined ? undefined : yield* parseState(statePath(repo), text)

    // Each worktree under the old root, where it goes, and its session folders.
    const moves: Array<{ readonly from: string; readonly to: string; readonly rel: string }> = []
    const sessions: Array<{ readonly from: string; readonly to: string }> = []
    const left: Array<string> = []
    for (const worktree of listed) {
      const rel = [oldReal, old]
        .filter((dir) => within(worktree.path, dir))
        .map((dir) => relative(dir, worktree.path))[0]
      if (rel === undefined || rel === "") continue
      const to = join(root, rel)
      // The paths Claude Code may have saved its sessions under: git's, and the Store's.
      const saved = Object.values(state?.tickets ?? {}).filter(
        (ticket) =>
          ticket.worktree !== undefined &&
          (ticket.worktree === worktree.path || ticket.worktree === join(old, rel)),
      )
      const paths = [...new Set([worktree.path, join(old, rel)])]
      const own: Array<{ readonly from: string; readonly to: string }> = []
      let movable = true
      for (const path of paths) {
        const name = sessionFolderName(path)
        if (name === undefined) {
          // Its folder can't be found: one with a saved session stays where it is.
          if (saved.some((ticket) => ticket.session !== undefined)) movable = false
          continue
        }
        if (!(yield* fs.exists(join(projects, name)))) continue
        const target = sessionFolderName(to)
        if (target === undefined || (yield* fs.exists(join(projects, target)))) {
          movable = false
          continue
        }
        if (!own.some((each) => each.from === join(projects, name))) {
          own.push({ from: join(projects, name), to: join(projects, target) })
        }
      }
      // Two old paths whose sessions both go to one new folder: neither can be moved safely.
      if (own.length > 1) movable = false
      if (!movable) {
        left.push(rel)
        continue
      }
      if (yield* fs.exists(to)) return yield* Effect.fail(`${to} is there already`)
      moves.push({ from: worktree.path, to, rel })
      sessions.push(...own)
    }

    // Every rename done, to be undone, last first, should a later step fail.
    const done: Array<{ readonly from: string; readonly to: string }> = []
    const rename = (step: { readonly from: string; readonly to: string }) =>
      Effect.tap(fs.rename(step.from, step.to), () => Effect.sync(() => done.push(step)))
    let repaired = false
    const steps = Effect.gen(function* () {
      for (const move of moves) {
        yield* fs.makeDirectory(dirname(move.to), { recursive: true })
        yield* rename(move)
      }
      for (const session of sessions) yield* rename(session)
      const trash = join(oldReal, trashFolder)
      if (yield* fs.exists(trash)) {
        const into = join(root, trashFolder)
        yield* fs.makeDirectory(into, { recursive: true })
        for (const name of yield* fs.readDirectory(trash)) {
          if (!(yield* fs.exists(join(into, name)))) {
            yield* rename({ from: join(trash, name), to: join(into, name) })
          }
        }
      }
      if (moves.length > 0) {
        repaired = true
        yield* git.repairWorktrees(
          repo,
          moves.map((move) => move.to),
        )
      }
      if (state !== undefined) {
        const changed = rewritten(state, old, oldReal, root, new Set(moves.map((move) => move.rel)))
        if (changed !== state) yield* writeState(repo, changed)
      }
    })
    const ran = yield* Effect.result(steps)
    if (Result.isFailure(ran)) {
      for (const step of done.reverse()) yield* Effect.ignore(fs.rename(step.to, step.from))
      if (repaired) {
        yield* Effect.ignore(
          git.repairWorktrees(
            repo,
            moves.map((move) => move.from),
          ),
        )
      }
      return yield* Effect.fail(reasonOf(ran.failure))
    }
    const removed =
      left.length === 0 &&
      Result.getOrElse(yield* Effect.result(removeIfEmpty(fs, old)), () => false)
    return { moved: moves.length, left, removed }
  }).pipe(Effect.mapError(reasonOf))

/**
 * The state with each ticket's worktree under the old root (`old` or its real path `oldReal`) whose
 * folder, relative to it, is in `moved` taken to the same place under `root`; the state itself
 * where none is.
 */
export const rewritten = (
  state: State,
  old: string,
  oldReal: string,
  root: string,
  moved: ReadonlySet<string>,
): State => {
  let changed = false
  const tickets = Object.fromEntries(
    Object.entries(state.tickets).map(([id, ticket]) => {
      const path = ticket.worktree
      const rel =
        path === undefined
          ? undefined
          : [oldReal, old].filter((dir) => within(path, dir)).map((dir) => relative(dir, path))[0]
      if (rel === undefined || !moved.has(rel)) return [id, ticket]
      changed = true
      return [id, { ...ticket, worktree: join(root, rel) }]
    }),
  )
  return changed ? { ...state, tickets } : state
}

/** The worktrees' root made ready for the run. */
export interface RootReady {
  /** The root the run uses: the old one where the move failed. */
  readonly root: string
  /**
   * The START block's line: the root from `~`, and what was done to keep it out of Time Machine
   * and Spotlight on macOS: `~/.tutti/worktrees/app (excluded from Time Machine; not indexed by
   * Spotlight)`.
   */
  readonly line: string
  /** What the START block says of the move. */
  readonly notes: ReadonlyArray<string>
  /** What couldn't be done, said once in the START block. */
  readonly warnings: ReadonlyArray<string>
}

/** Where the root is made ready. */
export interface Where {
  readonly platform: NodeJS.Platform
  readonly home: string
  /** Claude Code's projects folder (claudeProjects). */
  readonly projects: string
}

/**
 * Makes the run's worktrees' root ready (see the top): the default claimed and the old root's
 * worktrees moved into it, and on macOS its Time Machine exclusion made. It never fails: what
 * can't be done is a warning.
 */
export const readyRoot = (
  config: Pick<AppConfigValue, "repo" | "worktrees" | "worktreesDefault" | "settings">,
  where: Where,
): Effect.Effect<RootReady, never, Git | FileSystem.FileSystem | TimeMachine> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { repo } = config
    const shown = (path: string) => fromHome(path, where.home)
    const notes: Array<string> = []
    const warnings: Array<string> = []
    let root = config.worktrees
    if (config.worktreesDefault) {
      root = yield* findRoot(where.home, repo)
      const claimed = yield* Effect.result(
        Effect.gen(function* () {
          yield* fs.makeDirectory(root, { recursive: true })
          if ((yield* ownerOf(fs, root)) === undefined) {
            yield* fs.writeFileString(join(root, ownerFile), `${repo}\n`)
          }
        }),
      )
      if (Result.isFailure(claimed)) {
        warnings.push(
          `the worktrees' folder ${shown(root)} can't be made (${reasonOf(claimed.failure)})`,
        )
      } else {
        const old = oldDefaultRoot(repo)
        const moved = yield* Effect.result(moveOld({ repo, old, root, projects: where.projects }))
        if (Result.isFailure(moved)) {
          warnings.push(
            `the worktrees in ${shown(old)} can't be moved to ${shown(root)} (${moved.failure}); everything is left where it was, and this run keeps them in ${shown(old)}`,
          )
          root = old
        } else if (moved.success !== undefined) {
          const { moved: count, left, removed } = moved.success
          if (count > 0)
            notes.push(`moved ${worktreeCount(count)} from ${shown(old)} to ${shown(root)}`)
          if (left.length > 0) {
            notes.push(
              `left ${worktreeCount(left.length)} in ${shown(old)} until ${left.length === 1 ? "its ticket ends" : "their tickets end"}, as ${left.length === 1 ? "its" : "their"} Claude Code session can't be moved: ${left.join(", ")}`,
            )
          }
          if (removed) notes.push(`removed ${shown(old)}, the worktrees' old folder, empty`)
        }
      }
    }
    const said: Array<string> = []
    if (where.platform === "darwin") {
      const spotlight = unindexed(root) ? "not indexed by Spotlight" : "indexed by Spotlight"
      if (!config.settings.exclude_worktrees) {
        said.push("not excluded from Time Machine: exclude_worktrees is false", spotlight)
      } else {
        const home = worktreesHome(where.home)
        const folder = within(root, home) ? home : root
        const timeMachine = yield* TimeMachine
        const excluded = yield* Effect.result(
          Effect.gen(function* () {
            // tmutil can't exclude a folder that isn't there yet.
            yield* fs
              .makeDirectory(folder, { recursive: true })
              .pipe(Effect.mapError((error) => ({ message: error.message })))
            if (!(yield* timeMachine.isExcluded(folder))) yield* timeMachine.exclude(folder)
          }),
        )
        if (Result.isFailure(excluded)) {
          said.push("not excluded from Time Machine", spotlight)
          warnings.push(
            `the worktrees' folder ${shown(folder)} can't be excluded from Time Machine (${reasonOf(excluded.failure)}); tmutil addexclusion ${folder} excludes it`,
          )
        } else said.push("excluded from Time Machine", spotlight)
      }
    }
    return {
      root,
      line: `${shown(root)}${said.length === 0 ? "" : ` (${said.join("; ")})`}`,
      notes,
      warnings,
    }
  })
