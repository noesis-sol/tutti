// A finished ticket's merge (§ 5 item 7, § 5.1's Merging), one at a time from the merge queue. It
// comes in two parts:
//
// - prepare, which may be interrupted: a worktree off its branch (OFF_BRANCH) is set aside before
//   anything is done, and so is a branch a merge train rebased onto the branch ahead and git could
//   not put back as its worker left it (REBASE_FAILED, mergetrain.ts's checked_ahead); when the base moved on while the ticket ran, a worktree with uncommitted
//   changes (DIRTY_WORKTREE) is set aside, and the branch is rebased (a refusal is REBASE_FAILED,
//   conflicts MERGE_CONFLICT), set up when the rebase changed a dependency file (setup.ts), and
//   checked again (CHECKS_FAILED, a failing setup too). A branch on top of the base already, as
//   when nothing merged while its ticket ran, is checked too (set up first if a dependency file
//   changed since its last setup; a worktree with uncommitted changes set aside, DIRTY_WORKTREE, as
//   they would be checked but not merged), so that no ticket reaches the base unchecked, as
//   orchestra 0.8.5 has it; one whose commits change nothing needs none. A rebase interrupted is aborted, putting
//   the branch back; a setup or check interrupted is killed. The commit checked is the branch's as
//   its setup starts: one made meanwhile, as its worker's, is checked too before the merge goes on.
//   A setup or check that passes but leaves uncommitted changes to tracked files (a lockfile
//   rewritten, files formatted) sets the ticket aside, DIRTY_WORKTREE: it passed on files that
//   won't merge, and git would refuse to remove the worktree after the merge.
// - fastForward, the step from the fast-forward to the end of its notes, which the merge queue runs
//   protected from interruption (§ 3.4): the main checkout ready (DIRTY_TREE, GIT_FAILED), the base
//   fast-forwarded to the commit checked, the branch still at it (MERGE_FAILED; Moved, prepared
//   and checked again, when it is not; BaseMoved, the same, when the base moved on before it; a
//   fast-forward git was kept from tried again, then GIT_FAILED), the worktree and branch removed, the epics the ticket was the last
//   to merge under closed, up the tree. exec's time limits kill a command themselves, without
//   interrupting its fiber, so each git command's limit holds in there too.
// - closeUnchanged, its stand-in when the branch has no change of its own left to merge: git's
//   rebase dropped every commit, the base having their changes already, or its commits together
//   change nothing. The ticket is Done{noChange}, cleaned up as after a merge. A hand-back's
//   resolution that skipped every commit is closed so at once too (handback.ts).
//
// The git reads that steer a merge (what the worktree has checked out, its status, where the branch
// left the base, the main checkout's state) are made again a few seconds later while they fail, up
// to gitTries reads (steering), and give a tagged result whose failure is Unknown: never on its
// branch, clean or the base not moved. A worktree git can't read sets its ticket aside (GIT_FAILED),
// the other merges going on; the main repository git can't read stops them (GIT_FAILED).
//
// A rebase that stops on conflicts is handed back to the ticket's worker when it can take it
// (handback.ts): prepare is then over with the rebase left in progress, for the merge queue to hand
// it over; one that can't be handed back is Blocked. So is a check, or the setup before it, that
// fails on the branch, rebased or on top of the base already (checkback.ts): one that can't be
// handed back is set aside for review, kept to be checked once more once the base moves on
// (recheck.ts).
import { Data, Duration, Effect, Result, Schedule } from "effect"
import { absurd } from "effect/Function"
import type { AgentHost } from "../agent/AgentHost.ts"
import { AppConfig } from "../cli/AppConfig.ts"
import { formatDuration } from "../project/configFile.ts"
import { Beads, beadsWhy } from "../services/Beads.ts"
import type { CheckError, Checks } from "../services/Checks.ts"
import { Git, type GitError } from "../services/Git.ts"
import { checkoutChanges, trackedChanges } from "../services/gitStatus.ts"
import { Store } from "../services/Store.ts"
import { Worktrees } from "../services/Worktrees.ts"
import { aheadKey, clearAhead, rebasedAheadOf } from "./ahead.ts"
import { leaveForReview } from "./aside.ts"
import {
  failedHow,
  markUnchecked,
  type Passes,
  runMergeCheck,
  saidOf,
  uncheckedMark,
} from "./check.ts"
import {
  type Carried,
  type CheckStop,
  committed,
  type Fixes,
  fixFailed,
  fixPassed,
  setAside,
  whyNotFix,
} from "./checkback.ts"
import type { Event } from "./events.ts"
import { EventStream } from "./eventstream.ts"
import {
  type AtReset,
  type HandBacks,
  notHandedBack,
  type RebaseStop,
  whyNotHandBack,
} from "./handback.ts"
import { Ledger } from "./ledger.ts"
import { branchOn, detail, type Line, Log, line, Tag, tagged, ticketLine } from "./log.ts"
import { Cause, Detail } from "./phase.ts"
import { keepForRecheck, type Rechecks } from "./recheck.ts"
import { noteFailedCheck } from "./reportEvidence.ts"
import { excludedTypes, unmergedLabel } from "./scope.ts"
import { shownChanges } from "./settle.ts"
import { type SetUps, setUp } from "./setup.ts"
import { unlabel } from "./unmerged.ts"

/** A ticket its worker finished: closed, committed, its worktree clean and on its branch. */
export interface FinishedTicket {
  readonly id: string
  /** Its title as Beads gave it. */
  readonly title: string
  /** `tutti/<id>`. */
  readonly branch: string
  /** Its worktree's folder, absolute. */
  readonly worktree: string
}

export interface MergeOptions {
  /** The main checkout. */
  readonly repo: string
  /** The branch finished tickets land on. */
  readonly base: string
  /**
   * Why the run takes on no more work, as the merges say it (holds.ts's noMoreWork): undefined when
   * it does. A failed check isn't handed back to its worker then. Without it, only a drain counts.
   */
  readonly noMore?: Effect.Effect<string | undefined>
  /**
   * Where a hand-back due to a worker at the account's usage limit waits for the limit to lift: the
   * usage-limit hold, which sends it at the reset (handback.ts's give). Without it, it is sent at once.
   */
  readonly atReset?: AtReset
  /**
   * Whether the machine is loaded now: the run holds at --machine-workers, or its last load reading
   * has it pressed (load.ts's pressing). A hand-back's time limit leaves out the time it is, up to
   * the limit again (handback.ts's give). Without it, the machine is never loaded.
   */
  readonly loaded?: Effect.Effect<boolean>
  /**
   * Takes a slot for a ticket checked once more (recheck.ts) and runs `work` in it, as a running
   * ticket's: false, taking none, while a solo ticket runs or is next, no slot is free, or the
   * ticket holds one still (the scheduler's recheckSlot). Without it, a recheck takes no slot.
   */
  readonly recheckSlot?: (ticket: string, work: Effect.Effect<void>) => Effect.Effect<boolean>
  /** The run's setups (setup.ts), which starting a ticket shares; the queue's own without it. */
  readonly setUps?: SetUps
}

/** What stops the merges, and the exit code the run ends with for it (§ 5 item 10). */
export const stopCodes = { DIRTY_TREE: 5, GIT_FAILED: 4, MERGE_FAILED: 6 } as const
export type StopWhy = keyof typeof stopCodes

/** A merge that stopped the merges: its ticket is Blocked, and the run holds or stops. */
export interface MergeStop {
  readonly why: StopWhy
  readonly code: number
  readonly ticket: string
  /** The line the log has for it. */
  readonly line: Line
}

/**
 * What prepare leaves: the merge over (set aside, blocked or stopped), ready to fast-forward, with
 * nothing of its own left to merge, its rebase stopped on conflicts its worker can take, or its
 * check failed in a way its worker can take, to be handed back.
 */
export type Prepared =
  | { readonly _tag: "Over"; readonly stop?: MergeStop }
  | { readonly _tag: "Ready"; readonly onto: string; readonly at: string }
  | Unchanged
  | { readonly _tag: "HandBack"; readonly stop: RebaseStop }
  | { readonly _tag: "FixBack"; readonly stop: CheckStop }

/**
 * The branch, its worktree clean, changes nothing beyond the base: `why` says which way, and `own`
 * whether it has commits of its own still, which keep git from deleting it as merged.
 */
export interface Unchanged {
  readonly _tag: "Unchanged"
  readonly why: string
  readonly own: boolean
}

/**
 * What the fast-forward did: merged the branch; stopped the merges (`stop`), as the main checkout
 * or git kept it from merging; or, instead of merging, found the branch moved on to `to` from the
 * commit its check passed on, as when its worker committed while it ran, so it is checked again
 * first (Moved); or found the base moved on to `to` from `onto`, the commit the branch was rebased
 * onto or is on top of, so it is rebased and checked again first (BaseMoved).
 */
export type FastForward = Data.TaggedEnum<{
  Merged: Record<never, never>
  Stopped: { readonly stop: MergeStop }
  Moved: { readonly to: string }
  BaseMoved: { readonly to: string }
}>

export const FastForward = Data.taggedEnum<FastForward>()

/**
 * How many passes may find the base moved and rebase onto it. Only merges move it during a run,
 * and they queue; a second pass covers a commit made by hand while the check ran.
 */
export const maxPasses = 3

/** What git said of its failure, in a few words. */
export const gitWhy = (error: GitError): string =>
  error._tag === "GitFailed"
    ? (error.stderr.trim().split("\n")[0] ?? "") || `exit code ${error.exitCode}`
    : `git took longer than ${formatDuration(error.timeLimit)}`

// What bd said of its failure lives with BeadsError, where the agent layer can read it without the
// run's modules; it is said from here too, as the run's other failures are.
export { beadsWhy }

/** The first `shownChanges` of `files`, and how many more there are, as a line names them. */
export const someFiles = (files: ReadonlyArray<string>): string => {
  const more = files.length - shownChanges
  return `${files.slice(0, shownChanges).join(", ")}${more > 0 ? ` and ${more} more` : ""}`
}

/** `n` subtickets are merged, as the epic's line says. */
export const allMerged = (n: number): string =>
  n === 1 ? "its 1 subticket is merged" : `all ${n} subtickets are merged`

/** The reason an epic is closed with, as `after`, its last subticket, merged. */
export const epicCloseReason = (n: number, after: string): string => {
  const all = allMerged(n)
  return `${all[0]?.toUpperCase()}${all.slice(1)}; closed by tutti after ${after}`
}

/** The ticket whose merge closed the epic its close reason is, or undefined when tutti didn't. */
export const closedAfter = (reason: string): string | undefined =>
  /; closed by tutti after (\S+)$/.exec(reason)?.[1]

/** Every service a merge uses. */
export type MergeEnv =
  | AppConfig
  | Git
  | Worktrees
  | Beads
  | Ledger
  | Log
  | EventStream
  | Checks
  | AgentHost
  | Store

const services = Effect.all({
  config: AppConfig,
  git: Git,
  worktrees: Worktrees,
  beads: Beads,
  ledger: Ledger,
  log: Log,
  events: EventStream,
})

/** Sets the ticket aside for review, Merging → Review, with its note, warn record and log line. */
const aside = (ticket: FinishedTicket, why: string, short: string, text: Line) =>
  leaveForReview(ticket.id, { why, detail: short, text })

/** The ticket can't merge until you act: Merging → Blocked, with `record` beside it. */
const block = (ticket: FinishedTicket, why: string, record: Event, text: Line) =>
  Effect.gen(function* () {
    const { ledger } = yield* services
    yield* ledger.transition(ticket.id, Cause.Block({ why }), { beside: [record], lines: [text] })
  })

/** A merge that stops the merges: DIRTY_TREE and GIT_FAILED hold the run, MERGE_FAILED stops it. */
export const stopOver = (ticket: FinishedTicket, why: StopWhy, blocked: string, reason: string) =>
  Effect.gen(function* () {
    const text =
      why === "MERGE_FAILED" ? tagged(why)`${reason}` : tagged(Tag.hold)`${line`${why}: ${reason}`}`
    const record: Event =
      why === "MERGE_FAILED"
        ? { kind: "stop", detail: why, ticket: ticket.id, blocked, text }
        : { kind: "hold", ticket: ticket.id, blocked, text }
    yield* block(ticket, why, record, text)
    return { why, code: stopCodes[why], ticket: ticket.id, line: text } satisfies MergeStop
  })

/** A stop of the merges, as fastForward's result. */
const stopped = (...stop: Parameters<typeof stopOver>) =>
  Effect.map(stopOver(...stop), (made) => FastForward.Stopped({ stop: made }))

/** How many times a git read that steers a merge is made while it fails, as orchestra asks git. */
export const gitTries = 3

/** How long after a failed read, or one past its time limit, git is asked again. */
export const gitAgainAfter: Duration.Duration = Duration.seconds(3)

/**
 * A git read that steers the merge, made again `gitAgainAfter` later while it fails, up to `tries`
 * reads in all: one slow or failed read, as on a loaded machine, is not the merge's answer. Then
 * it fails with git's last error, which its caller takes for "can't tell".
 */
export const steering = <A, R>(
  read: Effect.Effect<A, GitError, R>,
  tries = gitTries,
): Effect.Effect<A, GitError, R> =>
  tries <= 1
    ? read
    : Effect.retry(read, { times: tries - 1, schedule: Schedule.spaced(gitAgainAfter) })

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

/** The worktree's status, git asked up to gitTries times while it fails: a failure is Unknown. */
export const worktreeStatus = (worktree: string): Effect.Effect<WorktreeStatus, never, Git> =>
  Effect.gen(function* () {
    const status = yield* Effect.result(steering((yield* Git).status(worktree)))
    if (Result.isFailure(status)) return WorktreeStatus.Unknown({ error: status.failure })
    const files = trackedChanges(status.success)
    return files.length === 0 ? WorktreeStatus.Clean() : WorktreeStatus.Dirty({ files })
  })

/**
 * The ticket's branch, its worktree clean, with no change of its own beyond where it left the base:
 * `why(own)` says why, given whether it has commits beyond the base. Undefined when it has a change,
 * or git can't say: the merge's next steps find out.
 */
export const unchanged = (
  ticket: FinishedTicket,
  options: MergeOptions,
  why: (own: boolean) => string,
): Effect.Effect<Unchanged | undefined, never, MergeEnv> =>
  Effect.gen(function* () {
    const { git } = yield* services
    const { repo, base } = options
    const read = yield* Effect.result(
      Effect.all({
        status: git.status(ticket.worktree),
        changed: git.changedFiles(repo, base, ticket.branch),
      }),
    )
    if (Result.isFailure(read)) return undefined
    if (read.success.changed.length > 0 || trackedChanges(read.success.status).length > 0) {
      return undefined
    }
    const commits = yield* Effect.result(git.log(repo, base, ticket.branch))
    const own = Result.isFailure(commits) || commits.success.length > 0
    return { _tag: "Unchanged", why: why(own), own } satisfies Unchanged
  })

/** Puts the branch back after a rebase that didn't finish, if one is under way. */
export const abandonRebase = (worktree: string) =>
  Effect.gen(function* () {
    const { git } = yield* services
    if (yield* git.rebaseInProgress(worktree)) yield* git.abortRebase(worktree)
  }).pipe(Effect.ignore)

/**
 * What came of putting a branch back (restoreBranch). `at` is where the branch is left, "" when
 * git couldn't say.
 */
export type Restored = Data.TaggedEnum<{
  /** At `to` already, once a rebase in progress was aborted (`aborted`), or none was. */
  AlreadyThere: { readonly aborted: boolean }
  /** Reset to `to` from `from`, its worker's attempt. */
  Reset: { readonly from: string }
  /** Left: its worktree has uncommitted changes, or git can't say whether it has. */
  Dirty: { readonly at: string }
  /** Left: its worktree has something else checked out, as `on` says (Checkout's OffBranch). */
  OffBranch: { readonly at: string; readonly on: string }
  /** Left: git can't tell what its worktree has checked out. */
  Unknown: { readonly at: string; readonly error: GitError }
  /** Left mid-rebase: git could not abort the rebase in progress. */
  AbortFailed: { readonly error: GitError }
  /** Left: git reset failed. */
  ResetFailed: { readonly at: string; readonly error: GitError }
}>

export const Restored = Data.taggedEnum<Restored>()

/**
 * Puts the ticket's branch back at `to`: a rebase in progress in its worktree aborted, then the
 * branch, when it is elsewhere, reset to `to` if its worktree is clean and has it checked out. A
 * branch at `to` already is left as it is, whatever its worktree holds. `to` is a full hash, or a
 * ref, which is never taken for where the branch is. Its worktree's checkout is asked up to `tries`
 * times (onBranch). Each caller says what came of it in its own words.
 */
export const restoreBranch = (
  ticket: Pick<FinishedTicket, "branch" | "worktree">,
  to: string,
  tries = gitTries,
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
    const at = Result.isSuccess(head) ? head.success : ""
    if (at === to) return Restored.AlreadyThere({ aborted })
    if (Result.isFailure(status) || trackedChanges(status.success).length > 0) {
      return Restored.Dirty({ at })
    }
    const on = yield* onBranch(ticket, tries)
    if (on._tag === "OffBranch") return Restored.OffBranch({ at, on: on.on })
    if (on._tag === "Unknown") return Restored.Unknown({ at, error: on.error })
    const reset = yield* Effect.result(git.resetBranch(worktree, to))
    if (Result.isFailure(reset)) return Restored.ResetFailed({ at, error: reset.failure })
    return Restored.Reset({ from: at })
  })

/**
 * What the merge train (mergetrain.ts) is told of the merge check of the ticket whose turn it is:
 * the tickets behind it may be checked ahead of their turn, on top of its branch, while it runs.
 */
export interface CheckWatch {
  /** Its check, the setup first if need be, starts on its branch at commit `at`. */
  starts(ticket: FinishedTicket, at: string): Effect.Effect<void>
  /** Its check, or the setup before it, ended: passed or not. */
  ends(passed: boolean): Effect.Effect<void>
}

/** What a merge keeps of each ticket for the run: rechecks due, setups done, passes, hand-backs. */
export interface MergeMemory {
  readonly rechecks: Rechecks
  readonly setUps: SetUps
  /** The commits the merge check passed on (check.ts). */
  readonly passes: Passes
  readonly handBacks: HandBacks
  /** The check hand-backs. */
  readonly fixes: Fixes
  /** The merge train, told of each check in a ticket's turn; none without it. */
  readonly train?: CheckWatch
}

/**
 * The commit the ticket's branch is at, git asked up to gitTries times while it fails, read before
 * its setup and check: the one a check that passes passed on, a commit made while it runs not
 * checked. "" when git can't say.
 */
export const branchHead = (
  ticket: FinishedTicket,
  options: MergeOptions,
): Effect.Effect<string, never, Git> =>
  Effect.gen(function* () {
    const at = yield* Effect.result(steering((yield* Git).revParse(options.repo, ticket.branch)))
    return Result.isSuccess(at) ? at.success : ""
  })

/**
 * Keeps `at`, the commit the ticket's branch was at as its setup and check started (branchHead), as
 * one its merge check passed on; nothing when git couldn't say what it was.
 */
export const notePass = (
  ticket: FinishedTicket,
  passes: Passes,
  at: string,
): Effect.Effect<void> => (at === "" ? Effect.void : passes.set(ticket.id, at))

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
 * times while it fails. Still when `onto` is "" (git couldn't say what it was): the merge reads
 * where the branch is again. A failure is Unknown, never Still.
 */
export const baseSince = (
  options: MergeOptions,
  onto: string,
): Effect.Effect<BaseSince, never, Git> =>
  Effect.gen(function* () {
    const now = yield* Effect.result(steering((yield* Git).revParse(options.repo, options.base)))
    if (Result.isFailure(now)) return BaseSince.Unknown({ error: now.failure })
    return onto !== "" && now.success !== onto ? BaseSince.Moved() : BaseSince.Still()
  })

/**
 * Sets the ticket aside, DIRTY_WORKTREE, when its worktree has uncommitted changes to tracked files,
 * `text` saying so of them, `why` in short: neither a rebase nor a check can go on with them there,
 * as only the branch's commits reach the base. A status git can't read, asked gitTries times, can't
 * show them not there: the ticket is set aside, GIT_FAILED, the other merges going on. True when it
 * did.
 */
const setAsideDirty = (
  ticket: FinishedTicket,
  text: (files: ReadonlyArray<string>) => Line,
  why = "uncommitted changes in its worktree",
) =>
  Effect.gen(function* () {
    const status = yield* worktreeStatus(ticket.worktree)
    switch (status._tag) {
      case "Clean":
        return false
      case "Dirty":
        yield* aside(ticket, Tag.dirtyWorktree, why, text(status.files))
        return true
      case "Unknown":
        yield* aside(
          ticket,
          Tag.gitFailed,
          "git could not read its worktree",
          ticketLine(
            Tag.gitFailed,
          )`${ticket.id} closed, but git could not read the status of ${ticket.worktree} (${gitTries} tries): ${gitWhy(status.error)}, so it can't be shown to have no uncommitted changes; ${ticket.branch} is not merged, its worktree left for review`,
        )
        return true
    }
  })

/**
 * Sets the ticket aside, DIRTY_WORKTREE, when its setup or check, having passed, left uncommitted
 * changes to tracked files in its worktree, as an install that rewrites its lockfile or a check that
 * formats files does: the check passed on files that won't merge, and git would refuse to remove the
 * worktree after the merge (CLEANUP_FAILED). True when it did, or when git couldn't read the
 * status (GIT_FAILED), as setAsideDirty has it.
 */
const setAsideLeftDirty = (ticket: FinishedTicket) =>
  setAsideDirty(
    ticket,
    (files) =>
      ticketLine(
        Tag.dirtyWorktree,
      )`${ticket.id} closed, but its setup or check left uncommitted changes to ${files} in ${ticket.worktree}, so ${ticket.branch} passed with changes that would not merge; worktree left for review (have the setup and check leave tracked files as they are, as a frozen-lockfile install does; undo the changes, check, merge)`,
    "its setup or check changed tracked files",
  )

/**
 * What came of a rebase, setup and check in a merge's pass: the ticket set aside or blocked, the
 * merge over (Aside); checked, its check passed on commit `at` (Checked); changing nothing beyond
 * the base (Unchanged); the rebase stopped on conflicts to hand back to its worker (Conflict); the
 * check, or the setup before it, failed in a way its worker can take (CheckFailed).
 */
type CheckOutcome =
  | { readonly _tag: "Aside" }
  | { readonly _tag: "Checked"; readonly at: string }
  | Unchanged
  | { readonly _tag: "Conflict"; readonly stop: RebaseStop }
  | { readonly _tag: "CheckFailed"; readonly stop: CheckStop }

const setAsideOutcome = { _tag: "Aside" } as const satisfies CheckOutcome

/**
 * Rebases the ticket, its branch off the base at `fork`, onto the base, which moved on to `onto`,
 * sets it up if need be and checks it: Checked, on the commit its check passed on, when it is on
 * top of the base, checked; Aside when any of them set it aside; Unchanged when the rebase left it
 * changing nothing, as when git dropped its commits, the base having their changes already;
 * Conflict when its conflicts are to be handed back to its worker; CheckFailed when its failure
 * is. An interrupted rebase is aborted here too, whichever Git it ran on. `waived`: you handed its
 * conflict over, so its worker, steered, takes the hand-back (§ 4.3). `carried`: what a hand-back
 * left for this check (checkback.ts).
 */
const rebaseAndCheck = (
  ticket: FinishedTicket,
  options: MergeOptions,
  memory: MergeMemory,
  fork: string,
  onto: string,
  waived: boolean,
  carried: Carried | undefined,
): Effect.Effect<CheckOutcome, never, MergeEnv> =>
  Effect.gen(function* () {
    const { git, ledger, log } = yield* services
    const { id, branch, worktree } = ticket
    const { repo, base } = options
    const dirty = yield* setAsideDirty(
      ticket,
      (files) =>
        ticketLine(
          Tag.dirtyWorktree,
        )`${id} closed, but ${worktree} has uncommitted changes to ${files}, so ${branch} can't be rebased onto ${base}, which moved on while it ran; worktree left for review (commit or undo them, rebase onto ${base}, check, merge)`,
    )
    if (dirty) return setAsideOutcome
    yield* ledger.refine(id, Detail.Step({ step: "rebase" }))
    // Where the branch was and what it had, for a hand-back to verify its worker's resolution by.
    const before = yield* Effect.result(
      Effect.all({ head: git.revParse(repo, branch), own: git.log(repo, onto, branch) }),
    )
    // Marked before git touches the branch: a quit before its check passes leaves the mark.
    yield* markUnchecked(id, {
      fork,
      head: Result.isSuccess(before) ? before.success.head : "",
    })
    // Onto the commit read as `onto`, not the base's name: one committed to the base since lands in
    // the next pass, so the stop, the setup's diff and the hand-back's check agree with the rebase.
    const rebased = yield* Effect.result(
      git.rebase(worktree, onto).pipe(Effect.onInterrupt(() => abandonRebase(worktree))),
    )
    if (Result.isFailure(rebased)) {
      const error = rebased.failure
      if (error._tag === "RebaseConflict") {
        const stop: RebaseStop = {
          ticket,
          onto,
          fork,
          head: Result.isSuccess(before) ? before.success.head : "",
          own: Result.isSuccess(before) ? before.success.own.length : -1,
          files: error.files,
        }
        // A fix carried here goes unchecked: what its worker resolves is checked with it.
        if (carried !== undefined) {
          const overtaken =
            carried.fixed === undefined
              ? []
              : [
                  `its worker committed ${committed(carried.fixed)}, but rebasing it onto ${base}, which moved on meanwhile, stopped on conflicts`,
                ]
          const tries = [...carried.tries, ...overtaken]
          if (tries.length > 0) yield* memory.fixes.carry(id, { tries })
        }
        const not = yield* whyNotHandBack(stop, yield* memory.handBacks.count(id), waived)
        if (not === undefined) return { _tag: "Conflict", stop } satisfies CheckOutcome
        yield* notHandedBack(stop, options, not, memory.handBacks)
        return setAsideOutcome
      }
      yield* aside(
        ticket,
        Tag.rebaseFailed,
        "rebase failed",
        ticketLine(
          Tag.rebaseFailed,
        )`${id} closed, but git could not rebase ${branch} onto ${base}, which moved on while it ran: ${gitWhy(error)}; worktree ${worktree} left for review`,
      )
      return setAsideOutcome
    }
    const dropped = yield* unchanged(
      ticket,
      options,
      () => `rebased onto ${base}, which has its changes already, ${branch} changes nothing`,
    )
    if (dropped !== undefined) return dropped
    yield* log.write(detail`rebased ${branch} onto ${base}, which moved on while it ran`)
    return yield* setUpAndCheck(
      ticket,
      options,
      memory,
      fork,
      onto,
      Result.isSuccess(before) ? before.success.head : "",
      false,
      carried,
    )
  })

/**
 * Sets up the ticket, its branch rebased from `fork` (its commit `head` then; "" when git couldn't
 * say) onto the base at `onto`, or `onTop` of it already (`fork` is then `onto`, and `head` the
 * branch's own commit), if need be, and checks it: Checked, on the commit the check passed on when
 * it passed, the branch's as the setup started, kept in the memory's passes too; Aside when either
 * set it aside, or git couldn't say where the branch is; CheckFailed when its failure is to be
 * handed back to its worker. `carried`: what a hand-back left for this check, its
 * worker's fix or resolution made while the base moved on: the check says whether the fix fixed it,
 * as checkback.ts's fixCheck would have, and the setup counts its worker's own changes.
 */
const setUpAndCheck = (
  ticket: FinishedTicket,
  options: MergeOptions,
  memory: MergeMemory,
  fork: string,
  onto: string,
  head: string,
  onTop = false,
  carried?: Carried,
): Effect.Effect<
  Extract<CheckOutcome, { _tag: "Aside" | "Checked" | "CheckFailed" }>,
  never,
  MergeEnv
> =>
  Effect.gen(function* () {
    const { git, ledger, log } = yield* services
    const { id, branch } = ticket
    const tries = carried?.tries ?? []
    // The commit checked: one made while the setup and check run is checked before it merges.
    const read = yield* Effect.result(steering(git.revParse(options.repo, branch)))
    if (Result.isFailure(read)) {
      yield* aside(
        ticket,
        Tag.gitFailed,
        "git could not read its branch",
        ticketLine(
          Tag.gitFailed,
        )`${id} closed, but git could not tell where ${branch} is (${gitTries} tries): ${gitWhy(read.failure)}, so it can't be checked as it would merge; worktree ${ticket.worktree} left for review`,
      )
      return setAsideOutcome
    }
    const at = read.success
    const handBack = (stop: CheckStop) => ({ _tag: "CheckFailed", stop }) satisfies CheckOutcome
    const passed = { _tag: "Checked", at } satisfies CheckOutcome
    const failed = (error: CheckError, output: string) =>
      Effect.gen(function* () {
        const stop: CheckStop = {
          ticket,
          onto,
          fork,
          head,
          at,
          error,
          output,
          onTop,
          ...(tries.length === 0 ? {} : { tried: tries }),
        }
        if (carried?.fixed !== undefined) {
          const after = yield* fixFailed(
            stop,
            carried.fixed,
            error,
            output,
            tries,
            options,
            memory,
            at,
          )
          return after === "aside" ? setAsideOutcome : handBack(after)
        }
        const not = yield* whyNotFix(stop, options, yield* memory.fixes.count(id))
        if (not === undefined) return handBack(stop)
        if (tries.length > 0) {
          yield* setAside(stop, options, memory, tries, not)
          return setAsideOutcome
        }
        const tried = not === "" ? "" : line`; not handed back to its worker: ${not}`
        yield* checksFailed(ticket, options, memory.rechecks, onto, error, output, tried, onTop)
        return setAsideOutcome
      })
    // The tickets behind it may be checked ahead of their turn meanwhile, on top of its branch.
    const train = memory.train
    if (train !== undefined) yield* train.starts(ticket, at)
    const ends = (passed: boolean) => (train === undefined ? Effect.void : train.ends(passed))
    const setup = yield* setUp(ticket, options, memory.setUps, fork, onto, carried?.fix)
    if (setup._tag === "Failed") {
      yield* ends(false)
      return yield* failed(setup.error, setup.output)
    }
    yield* ledger.refine(id, Detail.Step({ step: "check" }))
    // A ticket checked once more after a failed check (recheck.ts) has its check recorded so.
    const rechecking = (yield* ledger.current).tickets.get(id)?.rechecking === true
    const checked = yield* runMergeCheck(ticket, rechecking ? "recheck" : "merge")
    // What merges is the commit checked: changes the setup or check left would pass unmerged.
    const dirty = checked._tag !== "Failed" && (yield* setAsideLeftDirty(ticket))
    yield* ends(checked._tag !== "Failed" && !dirty)
    if (dirty) return setAsideOutcome
    switch (checked._tag) {
      case "Unchecked":
        yield* log.write(
          detail`no check command in .tutti/settings.json: merging ${branch} without checking the rebased code`,
        )
        yield* notePass(ticket, memory.passes, at)
        return passed
      case "Passed":
        if (carried?.fixed !== undefined) yield* fixPassed(ticket, carried.fixed)
        else {
          yield* log.write(
            onTop
              ? detail`'${checked.command}' passes on ${branchOn(branch, options.base, true)}`
              : detail`'${checked.command}' passes on the rebased ${branch}`,
          )
        }
        yield* notePass(ticket, memory.passes, at)
        return passed
      case "Failed":
        return yield* failed(checked.error, checked.output)
    }
  })

/** The short why of a ticket set aside as its check, or the setup before it, failed. */
export const checksFailedDetail = (error: CheckError): string => {
  const what = error.check === "setup" ? "setup" : "checks"
  return `${what} ${error._tag === "CheckTimedOut" ? "timed out" : "failed"}`
}

/**
 * Sets the ticket aside as its check, or the setup before it, failed on its branch rebased onto the
 * base at `onto`, or `onTop` of it already, kept to be checked once more once the base moves on,
 * unless this was that once (recheck.ts), and what the check said kept for the report
 * (reportEvidence.ts). `tried` says what came of handing it back to its worker, if anything.
 */
export const checksFailed = (
  ticket: FinishedTicket,
  options: MergeOptions,
  rechecks: Rechecks,
  onto: string,
  error: CheckError,
  output: string,
  tried = "",
  onTop = false,
): Effect.Effect<void, never, MergeEnv> =>
  Effect.gen(function* () {
    const { log } = yield* services
    const where = error._tag === "CheckNotRun" ? "" : line` (output is in ${output})`
    const again = (yield* rechecks.rechecked(ticket.id)) ? " again" : ""
    const later = yield* keepForRecheck(ticket, options, rechecks, onto, error)
    yield* aside(
      ticket,
      Tag.checksFailed,
      `${checksFailedDetail(error)}${again}`,
      ticketLine(
        Tag.checksFailed,
      )`${ticket.id} closed, but ${failedHow(error)}${again} on ${branchOn(ticket.branch, options.base, onTop)}${tried}; worktree ${ticket.worktree} left for review${where}${later}`,
    )
    const said = saidOf(error)
    if (said.length > 0) yield* log.write(...said.map((each) => detail`  ${each}`))
    yield* noteFailedCheck(ticket, options, rechecks, onto, error, output, onTop)
  })

/**
 * Blocks the ticket, MERGE_CONFLICT, as `what` (its base, or its branch) kept changing while its
 * checks ran, each check overtaken by a commit.
 */
const keptChanging = (ticket: FinishedTicket, what: string) =>
  Effect.gen(function* () {
    const text = ticketLine(
      Tag.mergeConflict,
    )`${ticket.id} closed, but ${what} while its checks ran (commits made by hand?); worktree ${ticket.worktree} left for review`
    yield* block(
      ticket,
      Tag.mergeConflict,
      {
        kind: "warn",
        ticket: ticket.id,
        aside: true,
        detail: what,
        blocked: what,
        text,
      },
      text,
    )
    return { _tag: "Over" } satisfies Prepared
  })

/**
 * The part of the merge that may be interrupted: the ticket's worktree checked to be on its branch,
 * and, each time the base has moved on, rebased onto it, set up if need be and checked; a branch on
 * top of the base already is set up if need be and checked too, as orchestra 0.8.5 has it, unless
 * the check passed on it as it is in this run (the memory's passes), and so is one still marked as
 * rebased and unchecked (check.ts), as a quit leaves one, its log line saying so. A branch whose
 * commits change nothing needs no check. Ready once its branch is on top of the base, checked; over
 * when it was set aside (kept in the memory's rechecks when its check failed), blocked or stopped
 * the merges; HandBack when its rebase stopped on conflicts its worker can take; FixBack when its
 * check failed in a way its worker can take; Unchanged when its branch changes nothing beyond the
 * base, as when git's rebase dropped every commit.
 */
export const prepare = (
  ticket: FinishedTicket,
  options: MergeOptions,
  memory: MergeMemory,
): Effect.Effect<Prepared, never, MergeEnv> =>
  Effect.gen(function* () {
    const { config, git, log } = yield* services
    const { id, branch, worktree } = ticket
    const { repo, base } = options
    // A conflict you handed over is handed back to its steered worker in this merge only (§ 4.3).
    const waived = yield* memory.handBacks.waived(id)
    // What a hand-back left for this merge's check, as the base moved on while its worker worked:
    // the first check takes it.
    let carried = yield* memory.fixes.carried(id)
    const taken = () => {
      const was = carried
      carried = undefined
      return was
    }
    const on = yield* onBranch(ticket)
    if (on._tag === "OffBranch") {
      yield* aside(
        ticket,
        Tag.offBranch,
        `worktree not on ${branch}`,
        ticketLine(
          Tag.offBranch,
        )`${id} closed, but its worktree ${worktree} has ${on.on}, not ${branch}; worktree left for review`,
      )
      return { _tag: "Over" } satisfies Prepared
    }
    // Only its worktree can't be read: the ticket is set aside, the other merges going on.
    if (on._tag === "Unknown") {
      yield* aside(
        ticket,
        Tag.gitFailed,
        "git could not read its worktree",
        ticketLine(
          Tag.gitFailed,
        )`${id} closed, but git could not tell what its worktree ${worktree} has checked out (${gitTries} tries): ${gitWhy(on.error)}; ${branch} is not merged, its worktree left for review`,
      )
      return { _tag: "Over" } satisfies Prepared
    }
    // Where its branch is, git can't tell: the merges hold.
    const lost = (error: GitError) =>
      Effect.map(
        stopOver(
          ticket,
          "GIT_FAILED",
          "git failed",
          line`could not tell where ${branch} is (${gitTries} tries): ${gitWhy(error)}; ${branch} is not merged, its worktree ${worktree} left for review`,
        ),
        (stop) => ({ _tag: "Over", stop }) satisfies Prepared,
      )
    // Still marked as rebased by a train onto the branch ahead, which git couldn't put back (as on
    // a quit, or as the run started): it may have that branch's commits, and would merge them with
    // its own. One back where its worker left it merges as any other.
    const metadata = yield* (yield* Store).metadata(id)
    const mark = rebasedAheadOf(Object.hasOwn(metadata, aheadKey) ? metadata[aheadKey] : undefined)
    if (mark !== undefined) {
      const at = yield* Effect.result(steering(git.revParse(repo, branch)))
      if (Result.isFailure(at)) return yield* lost(at.failure)
      if (at.success !== mark.orig) {
        yield* aside(
          ticket,
          Tag.rebaseFailed,
          "rebase failed",
          ticketLine(
            Tag.rebaseFailed,
          )`${id} closed, but ${branch} was rebased onto ${mark.behind} to be checked ahead of its turn and could not be put back as its worker left it, at ${mark.orig.slice(0, 7)}, so it may have the commits of ${mark.behind}; worktree ${worktree} left for review`,
        )
        return { _tag: "Over" } satisfies Prepared
      }
    }
    if (Object.hasOwn(metadata, aheadKey)) yield* clearAhead(id)
    // The commit checked in this merge, on top of the base: a mark found isn't checked again, even
    // when the Store kept it.
    let checked: string | undefined
    // How many times its branch moved on while its check ran, as its worker committed meanwhile.
    let moved = 0
    for (let pass = 0; ; pass++) {
      const where = yield* Effect.result(
        Effect.all({
          onto: steering(git.revParse(repo, base)),
          fork: steering(git.mergeBase(repo, base, branch)),
        }),
      )
      if (Result.isFailure(where)) {
        const stop = yield* stopOver(
          ticket,
          "GIT_FAILED",
          "git failed",
          line`could not tell where ${branch} left ${base} (${gitTries} tries): ${gitWhy(where.failure)}; ${branch} is not merged, its worktree ${worktree} left for review`,
        )
        return { _tag: "Over", stop } satisfies Prepared
      }
      const { onto, fork } = where.success
      // Its commits may undo each other, or a hand-back's rebase may have skipped them all.
      const nothing = yield* unchanged(ticket, options, (own) =>
        own
          ? `the commits on ${branch}, taken together, change nothing`
          : `${branch} has no commits beyond ${base} and its worktree is clean`,
      )
      if (nothing !== undefined) return nothing
      let result: CheckOutcome
      if (fork === onto) {
        if (checked !== undefined) {
          const now = yield* Effect.result(steering(git.revParse(repo, branch)))
          if (Result.isFailure(now)) return yield* lost(now.failure)
          if (now.success === checked)
            return { _tag: "Ready", onto, at: checked } satisfies Prepared
          // Only the commit checked merges: one made while it ran is checked first.
          if (moved === maxPasses) return yield* keptChanging(ticket, `${branch} kept changing`)
          moved++
          yield* log.write(
            detail`${branch} moved on to ${now.success.slice(0, 7)} while its check ran on ${checked.slice(0, 7)}: checking it again`,
          )
          checked = undefined
        }
        const unchecked = yield* uncheckedMark(id)
        const command = config.settings.checks.fast.command
        // The check runs in its worktree, but only its commits merge: changes left uncommitted
        // there would be checked with them and never reach the base.
        const dirty = (files: ReadonlyArray<string>) =>
          ticketLine(
            Tag.dirtyWorktree,
          )`${id} closed, but ${worktree} has uncommitted changes to ${files}, so ${branch}, on top of ${base}, can't be checked as it would merge; worktree left for review (commit or undo them, check, merge)`
        if (unchecked !== undefined) {
          if (yield* setAsideDirty(ticket, dirty)) return { _tag: "Over" } satisfies Prepared
          yield* log.write(
            detail`${branch} is on top of ${base}, but its check didn't finish after tutti rebased it; checking it now`,
          )
          result = yield* setUpAndCheck(
            ticket,
            options,
            memory,
            unchecked.fork === "" ? onto : unchecked.fork,
            onto,
            unchecked.head,
            false,
            taken(),
          )
        } else {
          // Every merge is checked, a branch on top of the base already too, unless the check
          // passed on it as it is in this run: as its worker fixed it, or resolved its rebase.
          const at = yield* Effect.result(steering(git.revParse(repo, branch)))
          if (Result.isFailure(at)) return yield* lost(at.failure)
          const head = at.success
          if (command === null) return { _tag: "Ready", onto, at: head } satisfies Prepared
          // That check, ahead of its turn (mergetrain.ts) or on its worker's fix or resolution
          // (checkback.ts, handback.ts), ran in its worktree too.
          if ((yield* memory.passes.at(id)) === head) {
            if (yield* setAsideLeftDirty(ticket)) return { _tag: "Over" } satisfies Prepared
            return { _tag: "Ready", onto, at: head } satisfies Prepared
          }
          if (yield* setAsideDirty(ticket, dirty)) return { _tag: "Over" } satisfies Prepared
          yield* log.write(
            detail`${branch} is on top of ${base} already: checking it with '${command}' before it merges`,
          )
          result = yield* setUpAndCheck(ticket, options, memory, onto, onto, head, true, taken())
        }
      } else {
        if (pass >= maxPasses) return yield* keptChanging(ticket, `${base} kept changing`)
        result = yield* rebaseAndCheck(ticket, options, memory, fork, onto, waived, taken())
      }
      switch (result._tag) {
        case "Aside":
          return { _tag: "Over" } satisfies Prepared
        case "Checked":
          checked = result.at
          continue
        case "Unchanged":
          return result
        case "Conflict":
          return { _tag: "HandBack", stop: result.stop } satisfies Prepared
        case "CheckFailed":
          return { _tag: "FixBack", stop: result.stop } satisfies Prepared
        default:
          return absurd(result)
      }
    }
  })

/**
 * The protected step for a ticket with nothing of its own left to merge, as `unchanged` says: its
 * worktree and branch removed (a branch with commits of its own moved to the base first, so git
 * deletes it as merged; its reflog keeps them), the ticket Done{noChange} and forgotten in
 * state.json, the `unmerged` label an earlier run gave it removed, and the epics above it closed.
 */
export const closeUnchanged = (
  ticket: FinishedTicket,
  options: MergeOptions,
  unchanged: Unchanged,
): Effect.Effect<void, never, MergeEnv> =>
  Effect.gen(function* () {
    const { worktrees, beads, ledger } = yield* services
    const { id, title, branch, worktree } = ticket
    if (unchanged.own) yield* restoreBranch(ticket, options.base, 1)
    const cleanup = yield* Effect.result(worktrees.remove(id))
    const left = Result.isSuccess(cleanup)
      ? line`worktree and branch removed`
      : line`but ${Tag.cleanupFailed} for ${worktree} / ${branch}: ${
          cleanup.failure._tag === "BadTicketId" ? cleanup.failure.why : gitWhy(cleanup.failure)
        }`
    const text = detail`${id} closed with no change: ${unchanged.why}, so there is nothing to merge; ${left}`
    yield* ledger.transition(id, Cause.NoChange(), {
      beside: [{ kind: "closed", ticket: id, title, detail: "no change to merge", text }],
      lines: [text],
    })
    // Done, it has nothing left for a later run: its record in state.json goes, its marks with it.
    yield* Effect.ignore((yield* Store).remove(id))
    const shown = yield* Effect.result(beads.show(id))
    if (Result.isSuccess(shown) && shown.success.labels.includes(unmergedLabel)) yield* unlabel(id)
    yield* closeEpics(id)
  })

/** The epics `id` was the last subticket to merge under, closed, each then its own parent's. */
export const closeEpics = (id: string) =>
  Effect.gen(function* () {
    const { config, beads, ledger, log, events } = yield* services
    const say = (text: Line, ticket: string) =>
      log.writeWith([text], events.emit({ kind: "info", ticket, text }))
    const shown = yield* Effect.result(beads.show(id))
    let parent = Result.isSuccess(shown) ? shown.success.parent : undefined
    while (parent !== undefined) {
      const epic = parent
      const read = yield* Effect.result(
        Effect.all({ issue: beads.show(epic), children: beads.list({ parent: epic, all: true }) }),
      )
      if (Result.isFailure(read)) {
        yield* say(
          detail`bd could not say whether the subtickets of ${epic} are all merged: ${beadsWhy(read.failure)}; it is left open`,
          epic,
        )
        return
      }
      const { issue, children } = read.success
      // A type the run never takes, epics whatever exclude_types holds, is tutti's to close.
      const left = excludedTypes({ excludeTypes: config.settings.queue.exclude_types })
      if (issue.status === "closed" || !left.includes(issue.type)) return
      const state = yield* ledger.current
      const merged = children.every(
        (child) =>
          child.status === "closed" &&
          !child.labels.includes(unmergedLabel) &&
          (state.tickets.get(child.id)?.phase._tag ?? "Done") === "Done",
      )
      if (!merged) return
      const all = allMerged(children.length)
      const closed = yield* Effect.result(beads.close(epic, epicCloseReason(children.length, id)))
      if (Result.isFailure(closed)) {
        yield* say(
          detail`${all}, but bd could not close ${epic}: ${beadsWhy(closed.failure)}; close it with: bd close ${epic}`,
          epic,
        )
        return
      }
      yield* say(detail`closed epic ${epic}: ${all}`, epic)
      parent = issue.parent
    }
  })

/**
 * The protected step: the base fast-forwarded to `at`, the commit the ticket's merge check passed
 * on, its branch on top of the base at `onto`, in the main checkout, then the worktree and branch
 * removed, the ticket Done and forgotten in state.json, the `unmerged` label an earlier run gave it
 * removed, and the epics above it closed. Merged when it merged; Stopped, with the stop, when the
 * main checkout or git kept it from merging; Moved, nothing merged, when its branch is no longer at
 * `at`, as when its worker committed after its check passed: the merge checks it again. A
 * fast-forward git refuses is BaseMoved when the base is no longer at `onto` (a commit made on it
 * by hand), for the merge to rebase and check the branch again; tried again, up to gitTries in
 * all, while the branch still fast-forwards onto it (as with another's .git/index.lock), then
 * GIT_FAILED; MERGE_FAILED only when it doesn't.
 */
export const fastForward = (
  ticket: FinishedTicket,
  options: MergeOptions,
  onto: string,
  at: string,
): Effect.Effect<FastForward, never, MergeEnv> =>
  Effect.gen(function* () {
    const { git, worktrees, beads, ledger, log } = yield* services
    const { id, title, branch, worktree } = ticket
    const { repo, base } = options
    yield* ledger.refine(id, Detail.Step({ step: "fast-forward" }))
    const left = line`${branch} is not merged, its worktree ${worktree} left for review`
    const checkout = yield* Effect.result(
      Effect.all({
        status: steering(git.status(repo)),
        on: steering(git.currentBranch(repo)),
      }),
    )
    if (Result.isFailure(checkout)) {
      return yield* stopped(
        ticket,
        "GIT_FAILED",
        "git failed",
        line`could not read the state of ${repo} (${gitTries} tries): ${gitWhy(checkout.failure)}; ${left}`,
      )
    }
    if (checkoutChanges(checkout.success.status).length > 0) {
      return yield* stopped(
        ticket,
        "DIRTY_TREE",
        "main checkout has uncommitted changes",
        line`uncommitted changes in ${repo}; ${left}. Inspect with: git status`,
      )
    }
    const on = checkout.success.on
    if (on._tag === "None" || on.value !== base) {
      return yield* stopped(
        ticket,
        "DIRTY_TREE",
        `main checkout is not on ${base}`,
        line`${repo} is no longer on ${base}; ${left}. Check it out again to continue`,
      )
    }
    // Read last, just before the merge: only the commit checked merges.
    const head = yield* Effect.result(steering(git.revParse(repo, branch)))
    if (Result.isFailure(head)) {
      return yield* stopped(
        ticket,
        "GIT_FAILED",
        "git failed",
        line`could not tell where ${branch} is (${gitTries} tries): ${gitWhy(head.failure)}; ${left}`,
      )
    }
    if (head.success !== at) {
      yield* log.write(
        detail`${branch} moved on to ${head.success.slice(0, 7)} after its check passed on ${at.slice(0, 7)}: checking it again before it merges`,
      )
      return FastForward.Moved({ to: head.success })
    }
    let merged = yield* Effect.result(git.fastForward(repo, at))
    for (let tries = 1; Result.isFailure(merged); tries++) {
      // Changes git leaves out of a clean tree (.beads/, .tutti/run/) can be in the way too.
      const local = new Set(checkout.success.status.map((entry) => entry.path))
      const changed = yield* Effect.result(steering(git.changedFiles(repo, base, at)))
      const inTheWay = Result.isSuccess(changed)
        ? changed.success.filter((path) => local.has(path)).sort()
        : []
      if (inTheWay.length > 0) {
        return yield* stopped(
          ticket,
          "DIRTY_TREE",
          "main checkout has uncommitted changes",
          line`uncommitted changes in ${repo} to ${inTheWay}, which ${branch} changes; ${left}. Commit or undo them, then run again`,
        )
      }
      // Not every failure is a branch that doesn't fast-forward: the base may have moved on since
      // prepare read it, or git may have been kept from writing, as by another's index.lock.
      const now = yield* Effect.result(
        Effect.all({
          base: steering(git.revParse(repo, base)),
          fork: steering(git.mergeBase(repo, base, at)),
        }),
      )
      if (Result.isFailure(now)) {
        return yield* stopped(
          ticket,
          "GIT_FAILED",
          "git failed",
          line`could not fast-forward ${base} to ${branch} (${gitWhy(merged.failure)}), nor tell where ${base} is now (${gitTries} tries): ${gitWhy(now.failure)}; ${left}`,
        )
      }
      if (now.success.base !== onto) {
        yield* log.write(
          detail`${base} moved on to ${now.success.base.slice(0, 7)} before ${branch} fast-forwarded onto ${onto.slice(0, 7)}: rebasing and checking it again before it merges`,
        )
        return FastForward.BaseMoved({ to: now.success.base })
      }
      if (now.success.fork !== now.success.base) {
        return yield* stopped(
          ticket,
          "MERGE_FAILED",
          `does not fast-forward onto ${base}`,
          line`${branch} does not fast-forward onto ${base}: ${gitWhy(merged.failure)}; its worktree ${worktree} left for review`,
        )
      }
      // It still fast-forwards: git was kept from merging it, which a few seconds may clear.
      if (tries >= gitTries) {
        return yield* stopped(
          ticket,
          "GIT_FAILED",
          "git failed",
          line`${branch} fast-forwards onto ${base}, but git could not merge it (${gitTries} tries): ${gitWhy(merged.failure)}; ${left}`,
        )
      }
      yield* Effect.sleep(gitAgainAfter)
      merged = yield* Effect.result(git.fastForward(repo, at))
    }
    const commits = yield* Effect.result(git.log(repo, onto, base))
    const own = Result.isSuccess(commits) ? commits.success : []
    const commit = own.find((each) => each.message.includes(id)) ?? own[0]
    let hash = commit?.hash
    if (hash === undefined) {
      const now = yield* Effect.result(git.revParse(repo, base))
      hash = Result.isSuccess(now) ? now.success : onto
    }
    const short = hash.slice(0, 7)
    const named = commit === undefined ? short : line`${short} ${commit.subject}`
    const cleanup = yield* Effect.result(worktrees.remove(id))
    const text = Result.isSuccess(cleanup)
      ? detail`${id} closed (${named}); merged into ${base}, worktree and branch removed`
      : detail`${id} closed (${named}); merged into ${base}, but ${Tag.cleanupFailed} for ${worktree} / ${branch}: ${
          cleanup.failure._tag === "BadTicketId" ? cleanup.failure.why : gitWhy(cleanup.failure)
        }`
    yield* ledger.transition(id, Cause.FastForwarded({ commit: hash }), {
      beside: [
        {
          kind: "closed",
          ticket: id,
          title,
          detail: Result.isSuccess(cleanup)
            ? `${short} merged into ${base}`
            : `${short} merged; cleanup failed`,
          text,
        },
      ],
      lines: [text],
    })
    // Done, it has nothing left for a later run: its record in state.json goes.
    yield* Effect.ignore((yield* Store).remove(id))
    // A carried-over ticket keeps its label until it merges: closeEpics takes a labelled
    // subticket for one not merged.
    const shown = yield* Effect.result(beads.show(id))
    if (Result.isSuccess(shown) && shown.success.labels.includes(unmergedLabel)) yield* unlabel(id)
    yield* closeEpics(id)
    return FastForward.Merged()
  })
