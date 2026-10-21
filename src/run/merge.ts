// A finished ticket's merge (§ 5 item 7, § 5.1's Merging), one at a time from the merge queue. It
// comes in two parts:
//
// - prepare, which may be interrupted: a worktree off its branch (OFF_BRANCH) is set aside before
//   anything is done; when the base moved on while the ticket ran, a worktree with uncommitted
//   changes (DIRTY_WORKTREE) is set aside, and the branch is rebased (a refusal is REBASE_FAILED,
//   conflicts MERGE_CONFLICT), set up when the rebase changed a dependency file (setup.ts), and
//   checked again (CHECKS_FAILED, a failing setup too). A branch on top of the base already, as
//   when nothing merged while its ticket ran, is checked too (set up first if a dependency file
//   changed since its last setup; a worktree with uncommitted changes set aside, DIRTY_WORKTREE, as
//   they would be checked but not merged), so that no ticket reaches the base unchecked, as
//   orchestra 0.8.5 has it; one whose commits change nothing needs none. A rebase interrupted is aborted, putting
//   the branch back; a setup or check interrupted is killed.
// - fastForward, the step from the fast-forward to the end of its notes, which the merge queue runs
//   protected from interruption (§ 3.4): the main checkout ready (DIRTY_TREE, GIT_FAILED), the base
//   fast-forwarded (MERGE_FAILED), the worktree and branch removed, the epics the ticket was the last
//   to merge under closed, up the tree. exec's time limits kill a command themselves, without
//   interrupting its fiber, so each git command's limit holds in there too.
// - closeUnchanged, its stand-in when the branch has no change of its own left to merge: git's
//   rebase dropped every commit, the base having their changes already, or its commits together
//   change nothing. The ticket is Done{noChange}, cleaned up as after a merge. A hand-back's
//   resolution that skipped every commit is closed so at once too (handback.ts).
//
// A rebase that stops on conflicts is handed back to the ticket's worker when it can take it
// (handback.ts): prepare is then over with the rebase left in progress, for the merge queue to hand
// it over; one that can't be handed back is Blocked. So is a check, or the setup before it, that
// fails on the branch, rebased or on top of the base already (checkback.ts): one that can't be
// handed back is set aside for review, kept to be checked once more once the base moves on
// (recheck.ts).
import { Effect, Result } from "effect"
import type { AgentHost } from "../agent/AgentHost.ts"
import { AppConfig } from "../cli/AppConfig.ts"
import { formatDuration } from "../project/configFile.ts"
import { Beads, beadsWhy } from "../services/Beads.ts"
import type { CheckError, Checks } from "../services/Checks.ts"
import { Git, type GitError, type StatusEntry } from "../services/Git.ts"
import { Store } from "../services/Store.ts"
import { runFolder, Worktrees } from "../services/Worktrees.ts"
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
  afterFix,
  type Carried,
  type CheckStop,
  committed,
  type Fixes,
  fixPassed,
  setAside,
  whyNotFix,
} from "./checkback.ts"
import type { Event } from "./events.ts"
import { EventStream } from "./eventstream.ts"
import { type HandBacks, notHandedBack, type RebaseStop, whyNotHandBack } from "./handback.ts"
import { Ledger } from "./ledger.ts"
import { branchOn, detail, type Line, Log, line, Tag, tagged, ticketLine } from "./log.ts"
import { Cause, Detail } from "./phase.ts"
import { keepForRecheck, type Rechecks } from "./recheck.ts"
import { noteFailedCheck } from "./reportEvidence.ts"
import { excludedTypes, unmergedLabel } from "./scope.ts"
import { type SetUps, setUp } from "./setup.ts"
import { ignoredFolders } from "./startup.ts"
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
  | { readonly _tag: "Ready"; readonly onto: string }
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

/** Whether `path` is `folder` or inside it. */
const under = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(`${folder}/`)

/** The tracked files with uncommitted changes, outside .tutti/run/: git won't rebase over them. */
export const uncommitted = (status: ReadonlyArray<StatusEntry>): ReadonlyArray<string> =>
  status
    .filter((entry) => entry.code !== "??" && entry.code !== "!!" && !under(entry.path, runFolder))
    .map((entry) => entry.path)
    .sort()

/** The changed files in the main checkout outside the tools' folders, as the startup checks see them. */
export const changedOutsideTools = (status: ReadonlyArray<StatusEntry>): ReadonlyArray<string> =>
  status
    .map((entry) => entry.path)
    .filter((path) => !ignoredFolders.some((folder) => under(path, folder)))
    .sort()

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
    const { ledger, log } = yield* services
    yield* ledger.transition(ticket.id, Cause.Block({ why }), { beside: [record] })
    yield* log.write(text)
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

/** What the worktree has checked out when it isn't the ticket's branch; undefined when it is. */
export const offBranch = (ticket: FinishedTicket) =>
  Effect.gen(function* () {
    const { git } = yield* services
    const on = yield* Effect.result(git.currentBranch(ticket.worktree))
    // git's own errors set the ticket aside later, if need be.
    if (Result.isFailure(on)) return undefined
    if (on.success._tag === "Some") {
      return on.success.value === ticket.branch ? undefined : `${on.success.value} checked out`
    }
    const rebasing = yield* Effect.result(git.rebaseInProgress(ticket.worktree))
    return Result.isSuccess(rebasing) && rebasing.success
      ? "a rebase in progress, on a detached HEAD"
      : "a detached HEAD"
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
    if (read.success.changed.length > 0 || uncommitted(read.success.status).length > 0) {
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

/** Keeps the commit the ticket's branch is at as one its merge check passed on, if git can say. */
export const notePass = (
  ticket: FinishedTicket,
  options: MergeOptions,
  passes: Passes,
): Effect.Effect<void, never, Git> =>
  Effect.gen(function* () {
    const at = yield* Effect.result((yield* Git).revParse(options.repo, ticket.branch))
    if (Result.isSuccess(at)) yield* passes.set(ticket.id, at.success)
  })

/**
 * Whether the base has moved on from `onto`, the commit a branch was rebased onto or is on top of,
 * as when other tickets merged while its worker worked on a hand-back; false when git can't say,
 * the check then running on the branch as it is, and the merge rebasing it after if need be.
 */
export const baseMoved = (
  options: MergeOptions,
  onto: string,
): Effect.Effect<boolean, never, Git> =>
  Effect.gen(function* () {
    const now = yield* Effect.result((yield* Git).revParse(options.repo, options.base))
    return Result.isSuccess(now) && onto !== "" && now.success !== onto
  })

/**
 * Sets the ticket aside, DIRTY_WORKTREE, when its worktree has uncommitted changes to tracked files,
 * `text` saying so of them: neither a rebase nor a check can go on with them there, as only the
 * branch's commits reach the base. True when it did; a status git can't read counts as clean.
 */
const setAsideDirty = (ticket: FinishedTicket, text: (files: ReadonlyArray<string>) => Line) =>
  Effect.gen(function* () {
    const { git } = yield* services
    const status = yield* Effect.result(git.status(ticket.worktree))
    const dirty = Result.isSuccess(status) ? uncommitted(status.success) : []
    if (dirty.length === 0) return false
    yield* aside(ticket, Tag.dirtyWorktree, "uncommitted changes in its worktree", text(dirty))
    return true
  })

/**
 * Rebases the ticket, its branch off the base at `fork`, onto the base, which moved on to `onto`,
 * sets it up if need be and checks it: true when it is on top of the base, checked; false when any
 * of them set it aside; Unchanged when the rebase left it changing nothing, as when git dropped its
 * commits, the base having their changes already; the rebase stopped, when its conflicts are to be
 * handed back to its worker; the check stopped, when its failure is. An interrupted rebase is
 * aborted here too, whichever Git it ran on. `waived`: you handed its conflict over, so its worker,
 * steered, takes the hand-back (§ 4.3). `carried`: what a hand-back left for this check
 * (checkback.ts).
 */
const rebaseAndCheck = (
  ticket: FinishedTicket,
  options: MergeOptions,
  memory: MergeMemory,
  fork: string,
  onto: string,
  waived: boolean,
  carried: Carried | undefined,
) =>
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
    if (dirty) return false
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
    const rebased = yield* Effect.result(
      git.rebase(worktree, base).pipe(Effect.onInterrupt(() => abandonRebase(worktree))),
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
        if (not === undefined) return stop
        yield* notHandedBack(stop, options, not, memory.handBacks)
        return false
      }
      yield* aside(
        ticket,
        Tag.rebaseFailed,
        "rebase failed",
        ticketLine(
          Tag.rebaseFailed,
        )`${id} closed, but git could not rebase ${branch} onto ${base}, which moved on while it ran: ${gitWhy(error)}; worktree ${worktree} left for review`,
      )
      return false
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
 * branch's own commit), if need be, and checks it: true when the check passed, the commit it passed
 * on kept in the memory's passes; false when either set it aside; the check stopped, when its
 * failure is to be handed back to its worker. `carried`: what a hand-back left for this check, its
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
) =>
  Effect.gen(function* () {
    const { git, ledger, log } = yield* services
    const { id, branch } = ticket
    const tries = carried?.tries ?? []
    const failed = (error: CheckError, output: string) =>
      Effect.gen(function* () {
        const at = yield* Effect.result(git.revParse(options.repo, branch))
        const stop: CheckStop = {
          ticket,
          onto,
          fork,
          head,
          at: Result.isSuccess(at) ? at.success : "",
          error,
          output,
          onTop,
          ...(tries.length === 0 ? {} : { tried: tries }),
        }
        if (carried?.fixed !== undefined) {
          const after = yield* afterFix(
            stop,
            carried.fixed,
            { _tag: "Failed", error, output },
            tries,
            options,
            memory,
          )
          return after === "aside" || after === "verified" ? false : after
        }
        const not = yield* whyNotFix(stop, options, yield* memory.fixes.count(id))
        if (not === undefined) return stop
        if (tries.length > 0) {
          yield* setAside(stop, options, memory, tries, not)
          return false
        }
        const tried = not === "" ? "" : line`; not handed back to its worker: ${not}`
        yield* checksFailed(ticket, options, memory.rechecks, onto, error, output, tried, onTop)
        return false
      })
    // The tickets behind it may be checked ahead of their turn meanwhile, on top of its branch.
    const train = memory.train
    const at = yield* Effect.result(git.revParse(options.repo, branch))
    if (train !== undefined && Result.isSuccess(at)) yield* train.starts(ticket, at.success)
    const ends = (passed: boolean) => (train === undefined ? Effect.void : train.ends(passed))
    const setup = yield* setUp(ticket, options, memory.setUps, fork, onto, carried?.fix)
    if (setup._tag === "Failed") {
      yield* ends(false)
      return yield* failed(setup.error, setup.output)
    }
    yield* ledger.refine(id, Detail.Step({ step: "check" }))
    const checked = yield* runMergeCheck(ticket)
    yield* ends(checked._tag !== "Failed")
    switch (checked._tag) {
      case "Unchecked":
        yield* log.write(
          detail`no check command in .tutti/settings.json: merging ${branch} without checking the rebased code`,
        )
        yield* notePass(ticket, options, memory.passes)
        return true
      case "Passed":
        if (carried?.fixed !== undefined) yield* fixPassed(ticket, carried.fixed)
        else {
          yield* log.write(
            onTop
              ? detail`'${checked.command}' passes on ${branchOn(branch, options.base, true)}`
              : detail`'${checked.command}' passes on the rebased ${branch}`,
          )
        }
        yield* notePass(ticket, options, memory.passes)
        return true
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
    const on = yield* offBranch(ticket)
    if (on !== undefined) {
      yield* aside(
        ticket,
        Tag.offBranch,
        `worktree not on ${branch}`,
        ticketLine(
          Tag.offBranch,
        )`${id} closed, but its worktree ${worktree} has ${on}, not ${branch}; worktree left for review`,
      )
      return { _tag: "Over" } satisfies Prepared
    }
    // Checked in this merge, on top of the base: a mark found isn't checked again, even when the
    // Store kept it.
    let checked = false
    for (let pass = 0; ; pass++) {
      const where = yield* Effect.result(
        Effect.all({ onto: git.revParse(repo, base), fork: git.mergeBase(repo, base, branch) }),
      )
      if (Result.isFailure(where)) {
        const stop = yield* stopOver(
          ticket,
          "GIT_FAILED",
          "git failed",
          line`could not tell where ${branch} left ${base}: ${gitWhy(where.failure)}; ${branch} is not merged, its worktree ${worktree} left for review`,
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
      if (fork === onto) {
        if (checked) return { _tag: "Ready", onto } satisfies Prepared
        const unchecked = yield* uncheckedMark(id)
        const command = config.settings.checks.fast.command
        // The check runs in its worktree, but only its commits merge: changes left uncommitted
        // there would be checked with them and never reach the base.
        const dirty = (files: ReadonlyArray<string>) =>
          ticketLine(
            Tag.dirtyWorktree,
          )`${id} closed, but ${worktree} has uncommitted changes to ${files}, so ${branch}, on top of ${base}, can't be checked as it would merge; worktree left for review (commit or undo them, check, merge)`
        let result: boolean | CheckStop
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
          if (command === null) return { _tag: "Ready", onto } satisfies Prepared
          const at = yield* Effect.result(git.revParse(repo, branch))
          const head = Result.isSuccess(at) ? at.success : ""
          if (head !== "" && (yield* memory.passes.at(id)) === head) {
            return { _tag: "Ready", onto } satisfies Prepared
          }
          if (yield* setAsideDirty(ticket, dirty)) return { _tag: "Over" } satisfies Prepared
          yield* log.write(
            detail`${branch} is on top of ${base} already: checking it with '${command}' before it merges`,
          )
          result = yield* setUpAndCheck(ticket, options, memory, onto, onto, head, true, taken())
        }
        if (result === false) return { _tag: "Over" } satisfies Prepared
        if (result !== true) return { _tag: "FixBack", stop: result } satisfies Prepared
        checked = true
        continue
      }
      if (pass === maxPasses) {
        const text = ticketLine(
          Tag.mergeConflict,
        )`${id} closed, but ${base} kept changing while its checks ran (commits made by hand?); worktree ${worktree} left for review`
        yield* block(
          ticket,
          Tag.mergeConflict,
          {
            kind: "warn",
            ticket: id,
            aside: true,
            detail: `${base} kept changing`,
            blocked: `${base} kept changing`,
            text,
          },
          text,
        )
        return { _tag: "Over" } satisfies Prepared
      }
      const rebased = yield* rebaseAndCheck(ticket, options, memory, fork, onto, waived, taken())
      if (rebased === false) return { _tag: "Over" } satisfies Prepared
      if (rebased === true) {
        checked = true
        continue
      }
      if ("_tag" in rebased) return rebased
      if ("files" in rebased) return { _tag: "HandBack", stop: rebased } satisfies Prepared
      return { _tag: "FixBack", stop: rebased } satisfies Prepared
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
    const { git, worktrees, beads, ledger, log } = yield* services
    const { id, title, branch, worktree } = ticket
    if (unchanged.own) yield* Effect.ignore(git.resetBranch(worktree, options.base))
    const cleanup = yield* Effect.result(worktrees.remove(id))
    const left = Result.isSuccess(cleanup)
      ? line`worktree and branch removed`
      : line`but ${Tag.cleanupFailed} for ${worktree} / ${branch}: ${
          cleanup.failure._tag === "BadTicketId" ? cleanup.failure.why : gitWhy(cleanup.failure)
        }`
    const text = detail`${id} closed with no change: ${unchanged.why}, so there is nothing to merge; ${left}`
    yield* ledger.transition(id, Cause.NoChange(), {
      beside: [{ kind: "closed", ticket: id, title, detail: "no change to merge", text }],
    })
    yield* log.write(text)
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
      Effect.andThen(log.write(text), events.emit({ kind: "info", ticket, text }))
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
 * The protected step: the base fast-forwarded to the ticket's branch, on top of it at `onto`, in
 * the main checkout, then the worktree and branch removed, the ticket Done and forgotten in
 * state.json, the `unmerged` label an earlier run gave it removed, and the epics above it closed. Undefined when it merged; the stop when the main checkout or git kept it from merging.
 */
export const fastForward = (
  ticket: FinishedTicket,
  options: MergeOptions,
  onto: string,
): Effect.Effect<MergeStop | undefined, never, MergeEnv> =>
  Effect.gen(function* () {
    const { git, worktrees, beads, ledger, log } = yield* services
    const { id, title, branch, worktree } = ticket
    const { repo, base } = options
    yield* ledger.refine(id, Detail.Step({ step: "fast-forward" }))
    const left = line`${branch} is not merged, its worktree ${worktree} left for review`
    const checkout = yield* Effect.result(
      Effect.all({ status: git.status(repo), on: git.currentBranch(repo) }),
    )
    if (Result.isFailure(checkout)) {
      return yield* stopOver(
        ticket,
        "GIT_FAILED",
        "git failed",
        line`could not read the state of ${repo}: ${gitWhy(checkout.failure)}; ${left}`,
      )
    }
    if (changedOutsideTools(checkout.success.status).length > 0) {
      return yield* stopOver(
        ticket,
        "DIRTY_TREE",
        "main checkout has uncommitted changes",
        line`uncommitted changes in ${repo}; ${left}. Inspect with: git status`,
      )
    }
    const on = checkout.success.on
    if (on._tag === "None" || on.value !== base) {
      return yield* stopOver(
        ticket,
        "DIRTY_TREE",
        `main checkout is not on ${base}`,
        line`${repo} is no longer on ${base}; ${left}. Check it out again to continue`,
      )
    }
    const merged = yield* Effect.result(git.fastForward(repo, branch))
    if (Result.isFailure(merged)) {
      // Changes git leaves out of a clean tree (.beads/, .tutti/run/) can be in the way too.
      const local = new Set(checkout.success.status.map((entry) => entry.path))
      const changed = yield* Effect.result(git.changedFiles(repo, base, branch))
      const inTheWay = Result.isSuccess(changed)
        ? changed.success.filter((path) => local.has(path)).sort()
        : []
      if (inTheWay.length > 0) {
        return yield* stopOver(
          ticket,
          "DIRTY_TREE",
          "main checkout has uncommitted changes",
          line`uncommitted changes in ${repo} to ${inTheWay}, which ${branch} changes; ${left}. Commit or undo them, then run again`,
        )
      }
      return yield* stopOver(
        ticket,
        "MERGE_FAILED",
        `does not fast-forward onto ${base}`,
        line`${branch} does not fast-forward onto ${base}: ${gitWhy(merged.failure)}; its worktree ${worktree} left for review`,
      )
    }
    const commits = yield* Effect.result(git.log(repo, onto, base))
    const own = Result.isSuccess(commits) ? commits.success : []
    const commit = own.find((each) => each.message.includes(id)) ?? own[0]
    let hash = commit?.hash
    if (hash === undefined) {
      const head = yield* Effect.result(git.revParse(repo, base))
      hash = Result.isSuccess(head) ? head.success : onto
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
    })
    yield* log.write(text)
    // Done, it has nothing left for a later run: its record in state.json goes.
    yield* Effect.ignore((yield* Store).remove(id))
    // A carried-over ticket keeps its label until it merges: closeEpics takes a labelled
    // subticket for one not merged.
    const shown = yield* Effect.result(beads.show(id))
    if (Result.isSuccess(shown) && shown.success.labels.includes(unmergedLabel)) yield* unlabel(id)
    yield* closeEpics(id)
    return undefined
  })
