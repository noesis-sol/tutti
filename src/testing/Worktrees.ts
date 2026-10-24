// The Worktrees test layer (§ 3.3): temp folders. A ticket's worktree is a plain folder at
// <root>/<id>, with no git in it: reused when it is there already, or made anew where the options
// say its branch was left without it, with what they say an earlier attempt left, as live's found
// counts it. A detached worktree is a new folder under <root>, its name starting with
// its prefix. IDs are checked, and run files opened through the symlink guard, as live.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import {
  checkRunFolder,
  checkTicketId,
  type Earlier,
  found,
  nothingEarlier,
  openRunFile,
  type TicketWorktree,
  Worktrees,
  writeRunFile,
} from "../services/Worktrees.ts"

/** A call the layer was asked for. */
export type WorktreeCall =
  | { readonly op: "prepare"; readonly id: string }
  | { readonly op: "remove"; readonly id: string; readonly force: boolean }
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

/** The test layer; each call is pushed onto `calls` when one is given. */
export const layer = (options: Options = {}, calls: Array<WorktreeCall> = []) =>
  Layer.sync(Worktrees, () => {
    const root = options.root ?? realpathSync(mkdtempSync(join(tmpdir(), "tutti-worktrees-")))
    const branchesLeft = new Set(options.branchesLeft)
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
        Effect.flatMap(checkTicketId(id), () =>
          Effect.sync(() => {
            calls.push({ op: "remove", id, force: removal.force === true })
            rmSync(join(root, id), { recursive: true, force: true })
            branchesLeft.delete(id)
          }),
        ),
      addDetached: (prefix, commit) =>
        Effect.sync(() => {
          const path = mkdtempSync(join(root, prefix))
          calls.push({ op: "addDetached", path, commit })
          return path
        }),
      removeDetached: (path) =>
        Effect.sync(() => {
          calls.push({ op: "removeDetached", path })
          rmSync(path, { recursive: true, force: true })
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
