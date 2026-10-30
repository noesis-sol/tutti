// The trash (§ 5 item 12): a merged ticket's worktree folder, moved into the worktrees' trash folder
// by its merge (Worktrees.remove's `aside`, an instant rename), deleted here in the background,
// outside the merge queue: a worktree's node_modules alone can be half a gigabyte in thousands of
// files, and deleting them in the merge step held the queue for minutes. The deletions run in a
// FiberSet of the layer's own, which lasts as long as tutti does rather than the run, so no
// registered set (fibers.ts) holds them: one under way as tutti ends is cut short, and what it left
// in the trash, as what a crashed run left, is deleted as the next run starts (clearLeft). A
// deletion that fails is a CLEANUP_FAILED warning naming the folder: the merge said its ticket's
// worktree and branch removed, which git has forgotten, and only the folder's files are left.
//
// What a ticket's worker left running in its worktree (Strays.ts) is stopped before its folder is
// deleted, and before git removes a worktree that isn't set aside (stopLeft): a detail line names
// them, as tutti's load line counted them against the run.
import { Context, Effect, FiberSet, Layer, Result } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type { TicketId } from "../services/Beads.ts"
import { Strays } from "../services/Strays.ts"
import { Worktrees } from "../services/Worktrees.ts"
import type { EventStream } from "./eventstream.ts"
import { detail, Log, Tag, ticketLine } from "./log.ts"
import { sayer } from "./say.ts"

export class Trash extends Context.Service<
  Trash,
  {
    /**
     * Deletes `path`, the folder Worktrees.remove set aside for `ticket`'s worktree, in the
     * background: it returns at once. A deletion that fails is a CLEANUP_FAILED warning.
     */
    delete(path: string, ticket: TicketId): Effect.Effect<void>
    /**
     * Deletes what an earlier run left in the trash folder, killed or ended before it could, in
     * the background, each folder a detail line once it is gone. It never fails.
     */
    readonly clearLeft: Effect.Effect<void>
    /**
     * Stops the processes left running in `path`, `ticket`'s worktree or its folder set aside,
     * before it is removed (Strays.stop), a detail line naming them. It never fails.
     */
    stopLeft(path: string, ticket?: TicketId): Effect.Effect<void>
    /** Waits for the deletions under way to end. */
    readonly settled: Effect.Effect<void>
  }
>()("tutti/run/Trash") {}

/** What the trash needs: the run's Worktrees, Strays, Log and EventStream. */
type TrashEnv = Worktrees | Strays | Log | EventStream

/** The trash over TrashEnv. The live run and the tests use it. */
export const layer: Layer.Layer<Trash, never, TrashEnv> = Layer.effect(
  Trash,
  Effect.gen(function* () {
    const worktrees = yield* Worktrees
    const strays = yield* Strays
    const logs = yield* Log
    const says = yield* sayer
    const deletions = yield* FiberSet.make<void, never>()
    // The folders being deleted, so clearLeft doesn't delete one a second time beside it.
    const deleting = new Set<string>()

    const failed = (path: string, error: PlatformError, ticket?: TicketId) =>
      says.warn(
        ticketLine(
          Tag.cleanupFailed,
        )`for ${path}: the folder of a merged worktree, set aside to be deleted, is left (${error.message}); rm -rf ${path} deletes it`,
        ticket,
      )

    const stopLeft = (path: string, ticket?: TicketId) =>
      Effect.gen(function* () {
        const stopped = yield* strays.stop(path)
        if (stopped.length === 0) return
        const count = stopped.length === 1 ? "1 process" : `${stopped.length} processes`
        const commands = stopped.map((stray) => stray.command)
        yield* logs.write(
          ticket === undefined
            ? detail`stopped ${count} left running in ${path}: ${commands}`
            : detail`${ticket}: stopped ${count} left running in ${path}: ${commands}`,
        )
      })

    const remove = (path: string, gone: Effect.Effect<void>, ticket?: TicketId) =>
      Effect.suspend(() => {
        if (deleting.has(path)) return Effect.void
        deleting.add(path)
        return Effect.asVoid(
          FiberSet.run(
            deletions,
            Effect.matchEffect(
              Effect.andThen(stopLeft(path, ticket), worktrees.deleteAside(path)),
              {
                onFailure: (error) => failed(path, error, ticket),
                onSuccess: () => gone,
              },
            ).pipe(Effect.ensuring(Effect.sync(() => deleting.delete(path)))),
          ),
        )
      })

    const clearLeft = Effect.gen(function* () {
      const left = yield* Effect.result(worktrees.leftAside)
      if (Result.isFailure(left)) {
        yield* says.warn(
          ticketLine(
            Tag.cleanupFailed,
          )`could not look for the merged worktrees' folders an earlier run left to be deleted (${left.failure.message})`,
        )
        return
      }
      for (const path of left.success) {
        yield* remove(
          path,
          logs.write(detail`deleted ${path}, a merged worktree's folder an earlier run left`),
        )
      }
    })

    return Trash.of({
      delete: (path, ticket) => remove(path, Effect.void, ticket),
      clearLeft,
      stopLeft,
      settled: FiberSet.awaitEmpty(deletions),
    })
  }),
)
