// The Worktrees test layer (§ 3.3): temp folders. A ticket's worktree is a plain folder at
// <root>/<id>, with no git in it: reused when it is there already, or made anew where the options
// say its branch was left without it, with what they say an earlier attempt left, as live's found
// counts it. A ticket's worktree is looked for (worktreeOf) as live looks, among the worktrees of
// Git's test layer where the caller has it: the one on its branch, else the one at <root>/<id>; with
// no Git, the folder at <root>/<id> is it, on its branch. A detached worktree is a new folder under
// <root>, its name starting with its prefix, checked out in Git's test layer too where the caller has it (its Repository), as live
// adds it with git, so that git commands run in it; removed, git forgets it. IDs are checked by prepare, and run files opened through the symlink guard, as live;
// remove, which takes an ID unchecked as live does, deletes no folder for one prepare refuses; asked
// to set a worktree aside, it moves its folder into <root>/.trash, as live, when it is there.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Option } from "effect"
import type { TicketId } from "../services/Beads.ts"
import { Git, type Worktree } from "../services/Git.ts"
import {
  branchOf,
  checkRunFolder,
  checkTicketId,
  type Earlier,
  found,
  nothingEarlier,
  openRunFile,
  type TicketWorktree,
  ticketIdProblem,
  trashFolder,
  Worktrees,
  writeRunFile,
} from "../services/Worktrees.ts"
import { Repository } from "./Git.ts"

/** A call the layer was asked for. */
export type WorktreeCall =
  | { readonly op: "prepare"; readonly id: TicketId }
  | {
      readonly op: "remove"
      readonly id: TicketId
      readonly force: boolean
      /** Only when asked: the worktree removed with its untracked files. */
      readonly untracked?: true
      /** Only when asked: its folder moved into the trash folder. */
      readonly aside?: true
    }
  | { readonly op: "deleteAside"; readonly path: string }
  | { readonly op: "addDetached"; readonly path: string; readonly commit: string }
  | { readonly op: "removeDetached"; readonly path: string }

export interface Options {
  /** The folder the worktrees go in; a new temp folder by default. */
  readonly root?: string
  /** What an earlier attempt left, by ticket, for a worktree reused. */
  readonly earlier?: Readonly<Record<string, Earlier>>
  /** The tickets whose branch an earlier attempt left without its worktree, until removed. */
  readonly branchesLeft?: ReadonlyArray<string>
}

/** Git's test layer and its repository, where the caller has them. */
const inGit = Effect.gen(function* () {
  const git = yield* Effect.serviceOption(Git)
  const repo = yield* Effect.serviceOption(Repository)
  return Option.isSome(git) && Option.isSome(repo)
    ? { git: git.value, repo: repo.value }
    : undefined
})

/** The test layer; each call is pushed onto `calls` when one is given. */
export const layer = (options: Options = {}, calls: Array<WorktreeCall> = []) =>
  Layer.sync(Worktrees, () => {
    const root = options.root ?? realpathSync(mkdtempSync(join(tmpdir(), "tutti-worktrees-")))
    const branchesLeft = new Set(options.branchesLeft)
    const trash = join(root, trashFolder)
    // The detached worktrees checked out in Git's test layer, which git forgets as they go.
    const inRepository = new Set<string>()
    return Worktrees.of({
      prepare: (id) =>
        Effect.flatMap(checkTicketId(id), () =>
          Effect.sync((): TicketWorktree => {
            calls.push({ op: "prepare", id })
            const path = join(root, id)
            const existing = mkdirSync(path, { recursive: true }) === undefined
            const earlier = options.earlier?.[id] ?? nothingEarlier
            return found(id, path, { existing, branchLeft: branchesLeft.has(id), earlier })
          }),
        ),
      remove: (id, removal = {}) =>
        Effect.sync(() => {
          const aside = removal.aside === true && removal.at !== undefined
          calls.push({
            op: "remove",
            id,
            force: removal.force === true,
            ...(removal.untracked === true ? { untracked: true as const } : {}),
            ...(aside ? { aside: true as const } : {}),
          })
          branchesLeft.delete(id)
          if (ticketIdProblem(id) !== undefined) return undefined
          const path = join(root, id)
          if (!aside || !existsSync(path)) {
            rmSync(path, { recursive: true, force: true })
            return undefined
          }
          mkdirSync(trash, { recursive: true })
          const moved = mkdtempSync(join(trash, `${id}-`))
          renameSync(path, join(moved, id))
          return moved
        }),
      worktreeOf: (id) =>
        Effect.gen(function* () {
          const path = ticketIdProblem(id) === undefined ? join(root, id) : undefined
          const git = yield* inGit
          if (git !== undefined) {
            const listed = yield* git.git.worktrees(git.repo.dir)
            const kept = listed.filter((worktree) => !worktree.prunable)
            return (
              kept.find((worktree) => worktree.branch === branchOf(id)) ??
              kept.find((worktree) => worktree.path === path)
            )
          }
          const folder: Worktree | undefined =
            path !== undefined && existsSync(path)
              ? { path, branch: branchOf(id), prunable: false }
              : undefined
          return folder
        }),
      deleteAside: (path) =>
        Effect.sync(() => {
          calls.push({ op: "deleteAside", path })
          rmSync(path, { recursive: true, force: true })
        }),
      leftAside: Effect.sync(() =>
        existsSync(trash)
          ? readdirSync(trash)
              .sort()
              .map((name) => join(trash, name))
          : [],
      ),
      addDetached: (prefix, commit) =>
        Effect.gen(function* () {
          const path = mkdtempSync(join(root, prefix))
          calls.push({ op: "addDetached", path, commit })
          const git = yield* inGit
          if (git !== undefined) {
            yield* git.git.addDetachedWorktree(git.repo.dir, path, commit)
            inRepository.add(path)
          }
          return path
        }),
      removeDetached: (path) =>
        Effect.gen(function* () {
          calls.push({ op: "removeDetached", path })
          rmSync(path, { recursive: true, force: true })
          const git = yield* inGit
          if (git !== undefined && inRepository.delete(path)) {
            yield* git.repo.removeFolder(path)
            yield* git.git.pruneWorktrees(git.repo.dir)
          }
        }),
      leftDetached: (prefix) =>
        Effect.sync(() =>
          existsSync(root)
            ? readdirSync(root)
                .filter((name) => name.startsWith(prefix))
                .sort()
                .map((name) => join(root, name))
            : [],
        ),
      openRunFile,
      checkRunFolder,
      writeRunFile,
    })
  })
