// A worker's own check on its card (§ 7.2): a testing Bash call of its worker, as the session's hooks
// show it begin and end (AgentHost's testRuns), is watched in Checking under ownCheckKey while it
// runs, so that its card draws a bar beside its action as it draws its merge check's. Nothing comes
// from the hooks between the two, and the worker can say nothing while its Bash call runs, so the
// count comes from the command: the worker's session names a file in its worktree's .tutti/run/ in
// TUTTI_PROGRESS_FILE, the runners tutti init writes copy their SUITE: and PROGRESS: lines to it as
// they print them, and the file is read every showEvery while the call runs, as a check's output is
// (CheckOutput). It is emptied as each call begins, so that what a killed command left there isn't
// read for the next one, and forgotten as it ends. A command that copies nothing there, a
// project's own runner, has the estimate alone: the time it has run against the median of its last
// passes, kept by its command for the run, or the merge check's or the full check's where it is
// theirs, which count from the run's first.
import { Clock, Effect, FiberMap, Stream } from "effect"
import type { TestRun } from "../agent/AgentHost.ts"
import type { TicketId } from "../services/Beads.ts"
import {
  type CheckAt,
  type CheckKind,
  CheckOutput,
  noCheckAt,
  progressLogName,
} from "../services/Checks.ts"
import { readRunFileFrom, writeRunFile } from "../services/Worktrees.ts"
import { type Checking, showEvery } from "./checking.ts"

/** How much of the progress file is read at a time: more waits for the next read. */
export const progressChunk = 64 * 1024

/** The project's checks whose passes estimate a worker's run of the same command. */
export interface OwnCheckCommands {
  readonly fast: string | null
  readonly full: string | null
}

/**
 * Which check's passes estimate a worker's `command`: the full check's where it runs that check's
 * command, the merge check's where it runs that one's, else null, its own.
 */
export const ownKindOf = (command: string, checks: OwnCheckCommands): CheckKind | null => {
  const runs = (check: string | null) => check !== null && check !== "" && command.includes(check)
  // The full check's command may be the merge check's with more to it (TUTTI_SLOW=1 …): it first.
  if (runs(checks.full)) return "full"
  return runs(checks.fast) ? "fast" : null
}

/**
 * Feeds what the worker's checks have copied to the progress file in `worktree` to `onAt`, every
 * showEvery, from its start; for ever, until interrupted. A file that shrinks has been started
 * again: it is read afresh. One that can't be read is read again at the next turn.
 */
const followProgress = (worktree: string, onAt: (at: CheckAt) => void): Effect.Effect<never> =>
  Effect.gen(function* () {
    let output = new CheckOutput(onAt)
    let offset = 0
    const take = (read: { readonly size: number; readonly bytes: Uint8Array }): void => {
      if (read.size < offset) {
        output = new CheckOutput(onAt)
        offset = 0
        onAt(noCheckAt)
        return
      }
      output.write(read.bytes)
      offset += read.bytes.length
    }
    return yield* Effect.forever(
      Effect.andThen(
        Effect.sleep(showEvery),
        Effect.suspend(() =>
          readRunFileFrom(worktree, progressLogName, offset, progressChunk).pipe(
            Effect.map(take),
            Effect.ignore,
          ),
        ),
      ),
    )
  })

/** A worker's test run under way: its call, its command and when it began. */
interface Running {
  readonly call: string
  readonly command: string
  readonly began: number
}

/**
 * Watches each worker's test runs, `runs`, in `checking`, for the scope: one at a time per ticket,
 * a run begun while another runs taking its place. A run that passed keeps its time among its
 * command's passes: the time its hook gave, else the time from its start to its end. The kind
 * whose passes estimate a command is read from `checks` as each run begins.
 */
export const followOwnChecks = (
  runs: Stream.Stream<TestRun>,
  checking: Checking["Service"],
  checks: Effect.Effect<OwnCheckCommands>,
): Effect.Effect<void> =>
  Effect.scoped(
    Effect.gen(function* () {
      const following = yield* FiberMap.make<TicketId>()
      const running = new Map<TicketId, Running>()
      yield* Stream.runForEach(runs, ({ ticket, worktree, event }) =>
        Effect.gen(function* () {
          if (event._tag === "Began") {
            const began = yield* Clock.currentTimeMillis
            const run = { call: event.call, command: event.command, began }
            running.set(ticket, run)
            const kind = ownKindOf(run.command, yield* checks)
            const follow = Effect.gen(function* () {
              // What a command before it left, killed before its end, is no part of this one.
              if (worktree !== undefined) {
                yield* Effect.ignore(writeRunFile(worktree, progressLogName, ""))
              }
              const watched = yield* checking.watchOwn(ticket, {
                command: run.command,
                kind,
                began,
              })
              return yield* worktree === undefined
                ? Effect.never
                : followProgress(worktree, watched.onAt)
            })
            yield* FiberMap.run(following, ticket)(Effect.scoped(follow))
            return
          }
          const run = running.get(ticket)
          if (run?.call !== event.call) return
          running.delete(ticket)
          if (event.passed) {
            const ms = event.ms ?? (yield* Clock.currentTimeMillis) - run.began
            if (ms > 0) yield* checking.ownPassed(run.command, ms / 1000)
          }
          yield* FiberMap.remove(following, ticket)
        }),
      )
    }),
  )
