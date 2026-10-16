// The Worktrees test layer (§ 3.3): temp folders. A ticket's worktree is a plain folder at
// <root>/<id>, with no git in it: reused when it is there already, with what the script says an
// earlier attempt left. IDs are checked, and run files opened through the symlink guard, as live.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import {
  branchOf,
  checkTicketId,
  type Earlier,
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

export interface Options {
  /** The folder the worktrees go in; a new temp folder by default. */
  readonly root?: string
  /** What an earlier attempt left, by ticket, for a worktree reused. */
  readonly earlier?: Readonly<Record<string, Earlier>>
}

/** The test layer; each call is pushed onto `calls` when one is given. */
export const layer = (options: Options = {}, calls: Array<WorktreeCall> = []) =>
  Layer.sync(Worktrees, () => {
    const root = options.root ?? realpathSync(mkdtempSync(join(tmpdir(), "tutti-worktrees-")))
    return Worktrees.of({
      prepare: (id) =>
        Effect.flatMap(checkTicketId(id), () =>
          Effect.sync((): TicketWorktree => {
            calls.push({ op: "prepare", id })
            const path = join(root, id)
            const made = mkdirSync(path, { recursive: true }) !== undefined
            const earlier = made ? nothingEarlier : (options.earlier?.[id] ?? nothingEarlier)
            return { id, branch: branchOf(id), path, reused: !made, earlier }
          }),
        ),
      remove: (id, removal = {}) =>
        Effect.flatMap(checkTicketId(id), () =>
          Effect.sync(() => {
            calls.push({ op: "remove", id, force: removal.force === true })
            rmSync(join(root, id), { recursive: true, force: true })
          }),
        ),
      openRunFile,
      writeRunFile,
    })
  })
