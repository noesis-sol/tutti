// The untracked files tutti's own setups and merge checks write in a ticket's worktree (§ 5 item 7):
// a coverage report or build output the project doesn't git-ignore. They don't count as uncommitted
// changes (merge.ts's setAsideLeftDirty), but git worktree remove refuses a worktree with untracked
// files, so the worktree and branch would be left after the merge (CLEANUP_FAILED). So each setup
// and check tutti runs in the worktree has its untracked files read before and after it, and those
// it added are kept in the worktree's .tutti/run/check-wrote, added to across checks and runs; the
// merge removes the worktree with --force when the files listed there are its only changes. An
// untracked file that was there before tutti's setup or check, its worker's (even one its worker's
// own run of the check made), keeps the worktree as it was: it may be work its worker didn't commit.
import { Effect, Result } from "effect"
import { Git, type StatusEntry } from "../services/Git.ts"
import { trackedChanges, untrackedFiles } from "../services/gitStatus.ts"
import { readRunFile, writeRunFile } from "../services/Worktrees.ts"

/** The run file listing the untracked files tutti's setups and checks wrote in a worktree. */
export const checkWroteName = "check-wrote"

/** The most of the list read: a longer one, cut short, isn't trusted. */
const mostListed = 1 << 20

/** The worktree's status, as git read it; undefined when git can't say. */
const statusIn = (
  worktree: string,
): Effect.Effect<ReadonlyArray<StatusEntry> | undefined, never, Git> =>
  Effect.map(Effect.result(Effect.flatMap(Git, (git) => git.status(worktree))), (status) =>
    Result.isSuccess(status) ? status.success : undefined,
  )

/** The files listed in the worktree's check-wrote, NUL-separated; none when it can't be read whole. */
const listed = (worktree: string): Effect.Effect<ReadonlySet<string>> =>
  readRunFile(worktree, checkWroteName, mostListed).pipe(
    Effect.map((text) =>
      text.length >= mostListed ? new Set<string>() : new Set(text.split("\0").filter(Boolean)),
    ),
    Effect.orElseSucceed(() => new Set<string>()),
  )

/**
 * Runs `effect`, a setup or check in the worktree, and adds the untracked files it made there to
 * its check-wrote list. Nothing is added when git can't read the worktree before or after, or
 * when `effect` fails or is interrupted: no file is taken for one tutti wrote that it may not have.
 * `before`: the worktree's status its caller read just before, nothing having run in it since; it
 * is read here without one. `read` is given the worktree's status read after it, when git read one,
 * for its caller to go on with rather than read it again.
 */
export const noteWritten = <A, E, R>(
  worktree: string,
  effect: Effect.Effect<A, E, R>,
  how: {
    readonly before?: ReadonlyArray<StatusEntry> | undefined
    readonly read?: (after: ReadonlyArray<StatusEntry>) => void
  } = {},
): Effect.Effect<A, E, R | Git> =>
  Effect.gen(function* () {
    const before = how.before ?? (yield* statusIn(worktree))
    const result = yield* effect
    const status = before === undefined ? undefined : yield* statusIn(worktree)
    if (before === undefined || status === undefined) return result
    how.read?.(status)
    const earlier = new Set(untrackedFiles(before))
    const made = untrackedFiles(status).filter((file) => !earlier.has(file))
    if (made.length === 0) return result
    const known = yield* listed(worktree)
    const all = [...new Set([...known, ...made])].sort()
    yield* Effect.ignore(writeRunFile(worktree, checkWroteName, `${all.join("\0")}\0`))
    return result
  })

/**
 * The untracked files in the worktree, when they are its only changes and tutti's setups or checks
 * wrote every one of them (noteWritten): git worktree remove --force then loses nothing of its
 * worker's. Undefined when it has none, has changes to tracked files or untracked files tutti didn't
 * write, or git can't read it. `read`: its status as git read it just before; it is read here
 * without it.
 */
export const writtenOnly = (
  worktree: string,
  read?: ReadonlyArray<StatusEntry>,
): Effect.Effect<ReadonlyArray<string> | undefined, never, Git> =>
  Effect.gen(function* () {
    const status = read ?? (yield* statusIn(worktree))
    if (status === undefined || trackedChanges(status).length > 0) return undefined
    const untracked = untrackedFiles(status)
    if (untracked.length === 0) return undefined
    const wrote = yield* listed(worktree)
    return untracked.every((file) => wrote.has(file)) ? untracked : undefined
  })
