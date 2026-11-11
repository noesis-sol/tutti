// The git reads that steer a merge (merge.ts), a hand-back (handback.ts), a train (mergetrain.ts)
// and a worker's settling (settle.ts): what a ticket's worktree has checked out, its status, where
// its branch is, whether the base moved on, each made again a few seconds later while it fails, up
// to gitTries reads (steering), and giving a tagged result whose failure is Unknown: never on its
// branch, clean or the base not moved. And restoreBranch, which puts a ticket's branch back where it
// was, as each of them does when its own step can't go on.
import { Data, Duration, Effect, Result } from "effect"
import { detail, Log, line, Tag } from "../core/log.ts"
import { formatDuration } from "../project/configFile.ts"
import type { EventStream } from "../services/EventStream.ts"
import {
  Git,
  type GitError,
  gitWhy,
  givenHash,
  type Sha,
  type StatusEntry,
} from "../services/Git.ts"
import { trackedChanges } from "../services/gitStatus.ts"
import { type Again, retrying } from "./again.ts"
import type { FinishedTicket, MergeTarget } from "./merge.ts"
import { warn } from "./say.ts"

/** How many times a git read that steers a merge is made while it fails, as orchestra asks git. */
export const gitTries = 3

/** How long after a failed read, or one past its time limit, git is asked again. */
export const gitAgainAfter: Duration.Duration = Duration.seconds(3)

/**
 * How a git read that steers a merge, or a fast-forward git was kept from, is made again while it
 * fails: gitTries in all, gitAgainAfter apart.
 */
export const gitAgain: Again = { tries: gitTries, after: gitAgainAfter }

/**
 * How a fast-forward git was kept from (merge.ts's Kept) is made again: gitAgainAfter first, then
 * twice as long each time, up to a minute apart, for about five and a half minutes in all. Another
 * git's lock (an editor's, git gc --auto) goes in seconds; one a git stopped mid-write left is
 * removed by clearStaleLocks between the tries, once it is staleLockAge old.
 */
export const keptAgain: Again = { tries: 10, after: gitAgainAfter, upTo: Duration.minutes(1) }

/**
 * How long ago a lock file in the main repository's git folder was left for clearStaleLocks to take
 * it for one no git holds: longer than tutti's own git writes may take (exec.ts's TimeLimit.write),
 * and short of keptAgain's tries, so that a lock a run killed just before left is removed while the
 * first merge waits on it.
 */
export const staleLockAge: Duration.Duration = Duration.minutes(3)

/**
 * Removes the lock files git left in the main repository at `repo`, staleLockAge or more ago (Git's
 * removeStaleLocks), each said in a warning: tutti killed mid fast-forward, or a power loss, leaves
 * one, which would keep every later merge from writing. Git failing, nothing is removed, and that is
 * logged.
 */
export const clearStaleLocks = (
  repo: string,
): Effect.Effect<void, never, Git | Log | EventStream> =>
  Effect.gen(function* () {
    const removed = yield* Effect.result((yield* Git).removeStaleLocks(repo, staleLockAge))
    if (Result.isFailure(removed)) {
      yield* (yield* Log).write(
        detail`git can't say where ${repo}'s lock files are: ${gitWhy(removed.failure)}; none removed`,
      )
      return
    }
    for (const { path, age } of removed.success) {
      yield* warn(
        line`${Tag.staleLock}: removed ${path}, which a git left ${formatDuration(age)} ago and no git holds that long: one stopped mid-write leaves its lock, which keeps git from writing there`,
      )
    }
  })

/**
 * A git read that steers the merge, made again as gitAgain says while it fails, up to `tries` reads
 * in all: one slow or failed read, as on a loaded machine, is not the merge's answer. Then it fails
 * with git's last error, which its caller takes for "can't tell".
 */
export const steering = <A, R>(
  read: Effect.Effect<A, GitError, R>,
  tries = gitTries,
): Effect.Effect<A, GitError, R> => retrying(read, { ...gitAgain, tries })

/** What a ticket's worktree has checked out: its branch, something else, or git can't tell. */
export type Checkout = Data.TaggedEnum<{
  OnBranch: Record<never, never>
  /** `on` says what it has instead, as in `main checked out` or `a detached HEAD`. */
  OffBranch: { readonly on: string }
  Unknown: { readonly error: GitError }
}>

export const Checkout = Data.taggedEnum<Checkout>()

/**
 * What the ticket's worktree has checked out, git asked up to `tries` times while it fails. A
 * failure is Unknown, never its branch.
 */
export const onBranch = (
  ticket: Pick<FinishedTicket, "branch" | "worktree">,
  tries = gitTries,
): Effect.Effect<Checkout, never, Git> =>
  Effect.gen(function* () {
    const git = yield* Git
    const on = yield* Effect.result(steering(git.currentBranch(ticket.worktree), tries))
    if (Result.isFailure(on)) return Checkout.Unknown({ error: on.failure })
    if (on.success._tag === "Some") {
      return on.success.value === ticket.branch
        ? Checkout.OnBranch()
        : Checkout.OffBranch({ on: `${on.success.value} checked out` })
    }
    const rebasing = yield* Effect.result(git.rebaseInProgress(ticket.worktree))
    return Checkout.OffBranch({
      on:
        Result.isSuccess(rebasing) && rebasing.success
          ? "a rebase in progress, on a detached HEAD"
          : "a detached HEAD",
    })
  })

/** Whether a worktree has uncommitted changes to tracked files (`trackedChanges`), or git can't tell. */
export type WorktreeStatus = Data.TaggedEnum<{
  Clean: Record<never, never>
  Dirty: { readonly files: ReadonlyArray<string> }
  Unknown: { readonly error: GitError }
}>

export const WorktreeStatus = Data.taggedEnum<WorktreeStatus>()

/** The worktree's status as git read it: Clean or Dirty. */
export const statusOf = (status: ReadonlyArray<StatusEntry>): WorktreeStatus => {
  const files = trackedChanges(status)
  return files.length === 0 ? WorktreeStatus.Clean() : WorktreeStatus.Dirty({ files })
}

/** The worktree's status, git asked up to gitTries times while it fails: a failure is Unknown. */
export const worktreeStatus = (worktree: string): Effect.Effect<WorktreeStatus, never, Git> =>
  Effect.gen(function* () {
    const status = yield* Effect.result(steering((yield* Git).status(worktree)))
    if (Result.isFailure(status)) return WorktreeStatus.Unknown({ error: status.failure })
    return statusOf(status.success)
  })

/**
 * What says you are still working in the ticket's worktree, which a merge would set aside for it:
 * off its branch (mid-rebase, as a rebase's detached HEAD is), an operation in progress on it, or
 * uncommitted changes. Undefined when it is on its branch and left clean. git failing, it is taken
 * as being worked in.
 */
export const stillWorkedIn = (
  ticket: FinishedTicket,
): Effect.Effect<string | undefined, never, Git> =>
  Effect.gen(function* () {
    const unread = line`git could not read its worktree ${ticket.worktree}`
    const on = yield* onBranch(ticket, 1)
    if (on._tag === "OffBranch") return line`its worktree ${ticket.worktree} has ${on.on}`
    if (on._tag === "Unknown") return unread
    const operation = yield* Effect.result((yield* Git).operationInProgress(ticket.worktree))
    if (Result.isFailure(operation)) return unread
    if (operation.success)
      return line`its worktree ${ticket.worktree} has a merge or pick in progress`
    return WorktreeStatus.$match(yield* worktreeStatus(ticket.worktree), {
      Clean: () => undefined,
      Dirty: ({ files }) =>
        line`its worktree ${ticket.worktree} has uncommitted changes to ${files}`,
      Unknown: () => unread,
    })
  })

/** Independent git reads, as Effect.all's: side by side, as git reads take no locks. */
export const gitReads = { concurrency: "unbounded" } as const

/**
 * What came of putting a branch back (restoreBranch). `at` is where the branch is left, undefined
 * when git couldn't say.
 */
export type Restored = Data.TaggedEnum<{
  /** At `to` already, once a rebase in progress was aborted (`aborted`), or none was. */
  AlreadyThere: { readonly aborted: boolean }
  /**
   * Reset to `to` from `from`, its worker's attempt; undefined when git couldn't say where.
   * `discarded` are the tracked files whose changes the reset discarded, where it was told to.
   */
  Reset: { readonly from: Sha | undefined; readonly discarded: ReadonlyArray<string> }
  /** Left: its worktree has uncommitted changes, or git can't say whether it has. */
  Dirty: { readonly at: Sha | undefined }
  /** Left: its worktree has something else checked out, as `on` says (Checkout's OffBranch). */
  OffBranch: { readonly at: Sha | undefined; readonly on: string }
  /** Left: git can't tell what its worktree has checked out. */
  Unknown: { readonly at: Sha | undefined; readonly error: GitError }
  /** Left mid-rebase: git could not abort the rebase in progress. */
  AbortFailed: { readonly error: GitError }
  /** Left: git reset failed. */
  ResetFailed: { readonly at: Sha | undefined; readonly error: GitError }
}>

export const Restored = Data.taggedEnum<Restored>()

/** Where a branch not put back is left, for a line: `at <commit>`; where it is, git not saying. */
export const leftAt = (at: Sha | undefined): string =>
  at === undefined ? "where it is" : `at ${givenHash(at)}`

/** Its worker's attempt a branch was reset from, for a line, when git said where it was. */
export const attemptAt = (from: Sha | undefined): string =>
  from === undefined ? "" : ` (its worker's attempt is ${givenHash(from)})`

/**
 * Puts the ticket's branch back at `to`: a rebase in progress in its worktree aborted, then the
 * branch, when it is elsewhere, reset to `to` if its worktree is clean and has it checked out. A
 * branch at `to` already is left as it is, whatever its worktree holds. `to` is a full hash, or a
 * ref, which is never taken for where the branch is. Its worktree's checkout is asked up to `tries`
 * times (onBranch). With `discard`, a worktree whose changes to tracked files are tutti's own (the
 * merge train's setup and check, in a worktree it found clean) is reset all the same, the files
 * whose changes went named. Each caller says what came of it in its own words.
 */
export const restoreBranch = (
  ticket: Pick<FinishedTicket, "branch" | "worktree">,
  to: string,
  tries = gitTries,
  discard = false,
): Effect.Effect<Restored, never, Git> =>
  Effect.gen(function* () {
    const git = yield* Git
    const { branch, worktree } = ticket
    let aborted = false
    const rebasing = yield* Effect.result(git.rebaseInProgress(worktree))
    if (Result.isFailure(rebasing) || rebasing.success) {
      const abort = yield* Effect.result(git.abortRebase(worktree))
      if (Result.isFailure(abort)) return Restored.AbortFailed({ error: abort.failure })
      aborted = true
    }
    const status = yield* Effect.result(git.status(worktree))
    const head = yield* Effect.result(git.revParse(worktree, branch))
    const at = Result.isSuccess(head) ? head.success : undefined
    if (at === to) return Restored.AlreadyThere({ aborted })
    if (Result.isFailure(status)) return Restored.Dirty({ at })
    const changed = trackedChanges(status.success)
    if (changed.length > 0 && !discard) return Restored.Dirty({ at })
    const on = yield* onBranch(ticket, tries)
    if (on._tag === "OffBranch") return Restored.OffBranch({ at, on: on.on })
    if (on._tag === "Unknown") return Restored.Unknown({ at, error: on.error })
    const reset = yield* Effect.result(git.resetBranch(worktree, to))
    if (Result.isFailure(reset)) return Restored.ResetFailed({ at, error: reset.failure })
    return Restored.Reset({ from: at, discarded: changed })
  })

/**
 * The commit the ticket's branch is at, git asked up to gitTries times while it fails, read before
 * its setup and check: the one a check that passes passed on, a commit made while it runs not
 * checked. Undefined when git can't say.
 */
export const branchHead = (
  ticket: FinishedTicket,
  options: MergeTarget,
): Effect.Effect<Sha | undefined, never, Git> =>
  Effect.gen(function* () {
    const at = yield* Effect.result(steering((yield* Git).revParse(options.repo, ticket.branch)))
    return Result.isSuccess(at) ? at.success : undefined
  })

/** Whether the base has moved on from a commit, or git can't tell. */
export type BaseSince = Data.TaggedEnum<{
  Moved: Record<never, never>
  Still: Record<never, never>
  Unknown: { readonly error: GitError }
}>

export const BaseSince = Data.taggedEnum<BaseSince>()

/**
 * Whether the base has moved on from `onto`, the commit a branch was rebased onto or is on top of,
 * as when other tickets merged while its worker worked on a hand-back, git asked up to gitTries
 * times while it fails. A failure is Unknown, never Still.
 */
export const baseSince = (options: MergeTarget, onto: Sha): Effect.Effect<BaseSince, never, Git> =>
  Effect.gen(function* () {
    const now = yield* Effect.result(steering((yield* Git).revParse(options.repo, options.base)))
    if (Result.isFailure(now)) return BaseSince.Unknown({ error: now.failure })
    return now.success !== onto ? BaseSince.Moved() : BaseSince.Still()
  })
