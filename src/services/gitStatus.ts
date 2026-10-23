// What a `git status` says of a checkout, read one way everywhere: each caller says which changes
// count for it, the tracked ones only (what git won't rebase over) or the untracked files too (what
// a check in the worktree sees, or what removing it would lose).

import type { StatusEntry } from "./Git.ts"
import { runFolder } from "./Worktrees.ts"

/**
 * The folders a clean main checkout may have changes in: the run state of tutti and orchestra, and
 * bd's, which bd writes as it goes. The rest of .tutti/ and .orchestra/ is the project's, committed.
 */
export const ignoredFolders: ReadonlyArray<string> = [runFolder, ".orchestra/run", ".beads"]

/** Whether `path`, as git gives it, is `folder` or inside it. */
const under = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(`${folder}/`)

/** Whether an entry is a change outside `folders`: a file git ignores (`!!`) is none. */
const changeOutside =
  (folders: ReadonlyArray<string>) =>
  (entry: StatusEntry): boolean =>
    entry.code !== "!!" && !folders.some((folder) => under(entry.path, folder))

const byPath = (a: StatusEntry, b: StatusEntry): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0

const paths = (entries: ReadonlyArray<StatusEntry>): ReadonlyArray<string> =>
  entries.map((entry) => entry.path)

const inWorktree = changeOutside([runFolder])

/** The changes in a worktree, untracked files included, outside its .tutti/run/, by path. */
export const allChangeEntries = (status: ReadonlyArray<StatusEntry>): ReadonlyArray<StatusEntry> =>
  status.filter(inWorktree).sort(byPath)

/** The files with changes in a worktree, untracked ones included, outside its .tutti/run/. */
export const allChanges = (status: ReadonlyArray<StatusEntry>): ReadonlyArray<string> =>
  paths(allChangeEntries(status))

/** The tracked files with uncommitted changes, outside .tutti/run/: git won't rebase over them. */
export const trackedChanges = (status: ReadonlyArray<StatusEntry>): ReadonlyArray<string> =>
  paths(allChangeEntries(status).filter((entry) => entry.code !== "??"))

/**
 * The untracked files outside .tutti/run/: a check in the worktree sees them, but a merge of its
 * branch doesn't bring them in.
 */
export const untrackedFiles = (status: ReadonlyArray<StatusEntry>): ReadonlyArray<string> =>
  paths(allChangeEntries(status).filter((entry) => entry.code === "??"))

/** The files with changes in the main checkout, untracked ones included, outside `ignoredFolders`. */
export const checkoutChanges = (status: ReadonlyArray<StatusEntry>): ReadonlyArray<string> =>
  paths(status.filter(changeOutside(ignoredFolders)).sort(byPath))
