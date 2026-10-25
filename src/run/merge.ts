// A finished ticket's merge (§ 5 item 7, § 5.1's Merging), one at a time from the merge queue: a
// machine of steps (Step) that mergeTurn drives, each giving the next or how the merge ends
// (Prepared). All but the fast-forward may be interrupted:
//
// - Enter, Locate, Rebase, Check and Confirm: a worktree off its branch (OFF_BRANCH) is set aside
//   before anything is done, and so is a branch a merge train rebased onto the branch ahead and git
//   could not put back as its worker left it (REBASE_FAILED, mergetrain.ts's checked_ahead); when
//   the base moved on while the ticket ran, a worktree with uncommitted changes (DIRTY_WORKTREE) is
//   set aside, and the branch is rebased (a refusal is REBASE_FAILED, conflicts MERGE_CONFLICT), set
//   up when the rebase changed a dependency file (setup.ts), and checked again (CHECKS_FAILED, a
//   failing setup too). A branch on top of the base already, as when nothing merged while its
//   ticket ran, is checked too (set up first if a dependency file changed since its last setup; a
//   worktree with uncommitted changes set aside, DIRTY_WORKTREE, as they would be checked but not
//   merged), so that no ticket reaches the base unchecked, as orchestra 0.8.5 has it; one whose
//   commits change nothing needs none. A rebase interrupted is aborted, putting the branch back; a
//   setup or check interrupted is killed. The commit checked is the branch's as its setup starts:
//   one made meanwhile, as its worker's, is checked too before the merge goes on. A setup or check
//   that passes but leaves uncommitted changes to tracked files (a lockfile rewritten, files
//   formatted) sets the ticket aside, DIRTY_WORKTREE: it passed on files that won't merge, and git
//   would refuse to remove the worktree after the merge. With no check command, a branch on top of
//   the base merges unchecked, but a worktree with uncommitted changes is still set aside,
//   DIRTY_WORKTREE.
// - FastForward (fastForward), the step from the fast-forward to the end of its notes, which the
//   merge queue runs protected from interruption (§ 3.4): the main checkout ready (DIRTY_TREE,
//   GIT_FAILED), the base fast-forwarded to the commit checked, the branch still at it
//   (MERGE_FAILED; Moved, entered again and checked, when it is not; BaseMoved, the same, when the
//   base moved on before it; a fast-forward git was kept from tried again, then GIT_FAILED), the
//   worktree and branch removed (the worktree with --force when its only changes are untracked
//   files tutti's setups and checks wrote there, checkWrote.ts), the epics the ticket was the last
//   to merge under closed, up the tree. exec's time limits kill a command themselves, without
//   interrupting its fiber, so each git command's limit holds in there too.
// - closeUnchanged, its stand-in when the branch has no change of its own left to merge: git's
//   rebase dropped every commit, the base having their changes already, or its commits together
//   change nothing. The ticket is Done{noChange}, cleaned up as after a merge. A hand-back's
//   resolution that skipped every commit is closed so at once too (handback.ts).
//
// A commit made meanwhile that overtakes a check is checked first, each way up to its budget
// (budgets) over the ticket's whole turn; then the ticket is blocked, keptChanging.
//
// The git reads that steer a merge (what the worktree has checked out, its status, where the branch
// left the base, the main checkout's state) are made again a few seconds later while they fail, up
// to gitTries reads (branch.ts's steering), and give a tagged result whose failure is Unknown: never
// on its branch, clean or the base not moved. A worktree git can't read sets its ticket aside (GIT_FAILED),
// the other merges going on; the main repository git can't read stops them (GIT_FAILED).
//
// A rebase that stops on conflicts is handed back to the ticket's worker when it can take it
// (handback.ts): the merge is then over with the rebase left in progress, for the merge queue to
// hand it over; one that can't be handed back is Blocked. So is a check, or the setup before it,
// that fails on the branch, rebased or on top of the base already (checkback.ts): one that can't be
// handed back is set aside for review, kept to be checked once more once the base moves on
// (recheck.ts).
import { Data, Effect, Result } from "effect"
import type { AgentHost } from "../agent/AgentHost.ts"
import { AppConfig } from "../cli/AppConfig.ts"
import { Beads, type BeadsError, beadsWhy, type Issue, type TicketId } from "../services/Beads.ts"
import type { CheckError, Checks } from "../services/Checks.ts"
import {
  Git,
  type GitError,
  gitWhy,
  type Sha,
  type StatusEntry,
  shortHash,
} from "../services/Git.ts"
import { allChanges, checkoutChanges } from "../services/gitStatus.ts"
import { Store } from "../services/Store.ts"
import { Worktrees } from "../services/Worktrees.ts"
import { retrying } from "./again.ts"
import { aheadKey, clearAhead, rebasedAheadOf } from "./ahead.ts"
import { leaveForReview } from "./aside.ts"
import {
  gitAgain,
  gitReads,
  gitTries,
  onBranch,
  restoreBranch,
  statusOf,
  steering,
  type WorktreeStatus,
  worktreeStatus,
} from "./branch.ts"
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
  type HandedCheck,
  refusalWhy,
  setAside,
  toFix,
} from "./checkback.ts"
import { writtenOnly } from "./checkWrote.ts"
import type { EventStream } from "./eventstream.ts"
import {
  type AtReset,
  type HandBacks,
  type HandedRebase,
  notHandedBack,
  type RebaseStop,
  toHandBack,
} from "./handback.ts"
import { Ledger } from "./ledger.ts"
import { type Arg, branchOn, detail, type Line, Log, line, Tag, tagged, ticketLine } from "./log.ts"
import type { OvernightAside } from "./overnightAside.ts"
import { Detail, Move } from "./phase.ts"
import { keepForRecheck, type Rechecks } from "./recheck.ts"
import { noteFailedCheck } from "./reportEvidence.ts"
import { info, type Said } from "./say.ts"
import { excludedTypes, unmergedLabel } from "./scope.ts"
import { shownChanges } from "./settle.ts"
import { fileList, type SetUps, setUp } from "./setup.ts"
import { Trash } from "./trash.ts"
import { unlabel } from "./unmerged.ts"

/** A ticket its worker finished: closed, committed, its worktree clean and on its branch. */
export interface FinishedTicket {
  readonly id: TicketId
  /** Its title as Beads gave it. */
  readonly title: string
  /** `tutti/<id>`. */
  readonly branch: string
  /** Its worktree's folder, absolute. */
  readonly worktree: string
}

/**
 * What the merges read of the run, resolved once by mergequeue.make from what the run gave it
 * (GivenMergeOptions): each "without it" is the default it puts in its place.
 */
export interface MergeOptions {
  /** The main checkout. */
  readonly repo: string
  /** The branch finished tickets land on. */
  readonly base: string
  /**
   * Why the run takes on no more work, as the merges say it (holds.ts's noMoreWork): undefined when
   * it does. A failed check isn't handed back to its worker then. Without it, only a drain counts.
   */
  readonly noMore: Effect.Effect<string | undefined>
  /**
   * Where a hand-back due to a worker at the account's usage limit waits for the limit to lift: the
   * usage-limit hold, which sends it at the reset (handback.ts's give). Without it, it is sent at once (noReset).
   */
  readonly atReset: AtReset
  /**
   * Whether the machine is loaded now: the run holds at --machine-workers, or its last load reading
   * has it pressed (load.ts's pressing). A hand-back's time limit leaves out the time it is, up to
   * the limit again (handback.ts's give). Without it, the machine is never loaded.
   */
  readonly loaded: Effect.Effect<boolean>
  /**
   * An overnight run's register (overnightAside.ts): with it, a worker on a hand-back left blocked on
   * a request for blockedAfter ends its hand-back, set aside as the hand-back's own failure, rather
   * than hold the run (handback.ts's give).
   */
  readonly overnight?: OvernightAside
  /**
   * Takes a slot for a ticket checked once more (recheck.ts) and runs `work` in it, as a running
   * ticket's: false, taking none, while a solo ticket runs or is next, no slot is free, or the
   * ticket holds one still (the scheduler's recheckSlot). Without it, a recheck takes no slot.
   */
  readonly recheckSlot: (ticket: TicketId, work: Effect.Effect<void>) => Effect.Effect<boolean>
  /** The run's setups (setup.ts), which starting a ticket shares; the queue's own without it. */
  readonly setUps: SetUps
  /**
   * Whether the run holds at the machine's cap on workers: no check ahead starts then
   * (mergetrain.ts). Never without it.
   */
  readonly machineFull: Effect.Effect<boolean>
}

/** Where the merges land: the main checkout and the base, all that most of their steps read. */
export type MergeTarget = Pick<MergeOptions, "repo" | "base">

/** What the run gives the merge queue: where the merges land, and any of the others. */
export type GivenMergeOptions = MergeTarget & Partial<Omit<MergeOptions, "repo" | "base">>

/** What stops the merges, and the exit code the run ends with for it (§ 5 item 10). */
export const stopCodes = { DIRTY_TREE: 5, GIT_FAILED: 4, MERGE_FAILED: 6 } as const
export type StopWhy = keyof typeof stopCodes

/** A merge that stopped the merges: its ticket is Blocked, and the run holds or stops. */
export interface MergeStop {
  readonly why: StopWhy
  readonly code: number
  readonly ticket: TicketId
  /** The line the log has for it. */
  readonly line: Line
}

/**
 * How a ticket's merge in its turn ends (mergeTurn): over (set aside, blocked or stopped), merged,
 * with nothing of its own left to merge, its rebase stopped on conflicts its worker can take, or its
 * check failed in a way its worker can take, to be handed back.
 */
export type Prepared = Data.TaggedEnum<{
  /** Set aside or blocked, or, with `stop`, stopping the merges. */
  Over: { readonly stop?: MergeStop }
  /** Its branch, checked at `at`, fast-forwarded onto the base from `onto`. */
  Merged: { readonly onto: Sha; readonly at: Sha }
  /**
   * The branch, its worktree clean, changes nothing beyond the base: `why` says which way, and
   * `own` whether it has commits of its own still, which keep git from deleting it as merged.
   */
  Unchanged: { readonly why: string; readonly own: boolean }
  HandBack: { readonly stop: HandedRebase }
  FixBack: { readonly stop: HandedCheck }
}>

export const Prepared = Data.taggedEnum<Prepared>()

/** Prepared's Unchanged: the branch changes nothing beyond the base. */
export type Unchanged = Data.TaggedEnum.Value<Prepared, "Unchanged">

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
 * How many times a merge checks a ticket's branch again in its turn, each way a commit made
 * meanwhile overtook its check (§ 5 item 7), before it blocks the ticket, MERGE_CONFLICT, the base
 * or its branch having kept changing (keptChanging): the base moved on while a check ran, so the
 * branch is rebased onto it and checked again (baseDuringCheck); its branch moved on while its
 * check ran (branchDuringCheck); or either moved on after its check passed, before its
 * fast-forward, so the merge enters again (beforeFastForward). Each counts over the whole turn: a
 * merge entered again keeps what it spent. Only merges move the base during a run, and they queue;
 * these cover commits made by hand.
 */
export const budgets = { baseDuringCheck: 3, branchDuringCheck: 3, beforeFastForward: 3 } as const

export type Budget = keyof typeof budgets

/** The first `shownChanges` of `files`, and how many more there are, as a line names them. */
export const someFiles = (files: ReadonlyArray<string>): string => {
  const more = files.length - shownChanges
  return `${files.slice(0, shownChanges).join(", ")}${more > 0 ? ` and ${more} more` : ""}`
}

/** `n` subtickets are merged, as the epic's line says. */
export const allMerged = (n: number): string =>
  n === 1 ? "its 1 subticket is merged" : `all ${n} subtickets are merged`

/** The reason an epic is closed with, as `after`, its last subticket, merged. */
export const epicCloseReason = (n: number, after: TicketId): string => {
  const all = allMerged(n)
  return `${all[0]?.toUpperCase()}${all.slice(1)}; closed by tutti after ${after}`
}

/** The ticket whose merge closed the epic its close reason is, or undefined when tutti didn't. */
export const closedAfter = (reason: string): TicketId | undefined =>
  /; closed by tutti after (\S+)$/.exec(reason)?.[1] as TicketId | undefined

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
  | Trash

/** `<tag>: <id> closed, but …`, the line of a ticket its merge sets aside or blocks. */
const closedButLine =
  (ticket: FinishedTicket, tag: string) =>
  (strings: TemplateStringsArray, ...args: ReadonlyArray<Arg>): Line =>
    ticketLine(tag)`${ticket.id} closed, but ${line(strings, ...args)}`

/**
 * Sets the ticket aside for review, Merging → Review{tag}, `short` its warn record's detail, with
 * its note and the line `<tag>: <id> closed, but …`.
 */
const closedBut =
  (ticket: FinishedTicket, tag: string, short: string) =>
  (strings: TemplateStringsArray, ...args: ReadonlyArray<Arg>) =>
    leaveForReview(ticket.id, {
      why: tag,
      detail: short,
      text: closedButLine(ticket, tag)(strings, ...args),
    })

/** The ticket can't merge until you act: Merging → Blocked, with `record` and its line beside it. */
const block = (ticket: FinishedTicket, why: string, record: Said) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    yield* ledger.transition(ticket.id, Move.Block({ why }), { said: [record] })
  })

/** A merge that stops the merges: DIRTY_TREE and GIT_FAILED hold the run, MERGE_FAILED stops it. */
export const stopOver = (ticket: FinishedTicket, why: StopWhy, blocked: string, reason: string) =>
  Effect.gen(function* () {
    const text =
      why === "MERGE_FAILED" ? tagged(why)`${reason}` : tagged(Tag.hold)`${line`${why}: ${reason}`}`
    const record: Said =
      why === "MERGE_FAILED"
        ? { kind: "stop", detail: why, ticket: ticket.id, blocked, text }
        : { kind: "hold", ticket: ticket.id, blocked, text }
    yield* block(ticket, why, record)
    return { why, code: stopCodes[why], ticket: ticket.id, line: text } satisfies MergeStop
  })

/** A stop of the merges, as fastForward's result. */
const stopped = (...stop: Parameters<typeof stopOver>) =>
  Effect.map(stopOver(...stop), (made) => FastForward.Stopped({ stop: made }))

/**
 * A branch with a change of its own beyond the base, or one git couldn't rule out: `status` is its
 * worktree's, as `unchanged` read it once, for the merge's next steps, and `entries` the status as
 * git read it, for the setup's and check's (noteWritten); undefined when git couldn't.
 */
export interface Changed {
  readonly _tag: "Changed"
  readonly status: WorktreeStatus | undefined
  readonly entries: ReadonlyArray<StatusEntry> | undefined
}

/**
 * The ticket's branch, its worktree clean, with no change of its own beyond where it left the base:
 * `why(own)` says why, given whether it has commits beyond the base. Changed, with the worktree's
 * status it read, when it has a change, or git can't say: the merge's next steps find out.
 */
export const unchanged = (
  ticket: FinishedTicket,
  options: MergeTarget,
  why: (own: boolean) => string,
): Effect.Effect<Unchanged | Changed, never, Git> =>
  Effect.gen(function* () {
    const git = yield* Git
    const { repo, base } = options
    const read = yield* Effect.all(
      {
        status: Effect.result(git.status(ticket.worktree)),
        changed: Effect.result(git.changedFiles(repo, base, ticket.branch)),
      },
      gitReads,
    )
    const entries = Result.isSuccess(read.status) ? read.status.success : undefined
    const status = entries === undefined ? undefined : statusOf(entries)
    const changed = { _tag: "Changed", status, entries } satisfies Changed
    if (status?._tag !== "Clean" || Result.isFailure(read.changed)) return changed
    if (read.changed.success.length > 0) return changed
    const commits = yield* Effect.result(git.log(repo, base, ticket.branch))
    const own = Result.isFailure(commits) || commits.success.length > 0
    return Prepared.Unchanged({ why: why(own), own })
  })

/**
 * What the merge train (mergetrain.ts) is told of the merge check of the ticket whose turn it is:
 * the tickets behind it may be checked ahead of their turn, on top of its branch, while it runs.
 */
export interface CheckWatch {
  /** Its check, the setup first if need be, starts on its branch at commit `at`. */
  starts(ticket: FinishedTicket, at: Sha | undefined): Effect.Effect<void>
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
 * Keeps `at`, the commit the ticket's branch was at as its setup and check started (branchHead), as
 * one its merge check passed on; nothing when git couldn't say what it was.
 */
export const notePass = (
  ticket: FinishedTicket,
  passes: Passes,
  at: Sha | undefined,
): Effect.Effect<void> => (at === undefined ? Effect.void : passes.set(ticket.id, at))

/**
 * Sets the ticket aside, DIRTY_WORKTREE, when its worktree has uncommitted changes to tracked files,
 * `text` saying so of them after `<id> closed, but`, `why` in short: neither a rebase nor a check
 * can go on with them there, as only the branch's commits reach the base. A status git can't read,
 * asked gitTries times, can't show them not there: the ticket is set aside, GIT_FAILED, the other
 * merges going on. True when it did. `read`: the status the merge read already, nothing having run
 * in the worktree since; it is read here without one.
 */
const setAsideDirty = (
  ticket: FinishedTicket,
  text: (files: ReadonlyArray<string>) => Line,
  why = "uncommitted changes in its worktree",
  read?: WorktreeStatus,
) =>
  Effect.gen(function* () {
    const status = read ?? (yield* worktreeStatus(ticket.worktree))
    switch (status._tag) {
      case "Clean":
        return false
      case "Dirty":
        yield* closedBut(ticket, Tag.dirtyWorktree, why)`${text(status.files)}`
        return true
      case "Unknown":
        yield* closedBut(
          ticket,
          Tag.gitFailed,
          "git could not read its worktree",
        )`git could not read the status of ${ticket.worktree} (${gitTries} tries): ${gitWhy(status.error)}, so it can't be shown to have no uncommitted changes; ${ticket.branch} is not merged, its worktree left for review`
        return true
    }
  })

/**
 * Sets the ticket aside, DIRTY_WORKTREE, when its setup or check, having passed, left uncommitted
 * changes to tracked files in its worktree, as an install that rewrites its lockfile or a check that
 * formats files does: the check passed on files that won't merge, and git would refuse to remove the
 * worktree after the merge (CLEANUP_FAILED). True when it did, or when git couldn't read the
 * status (GIT_FAILED), as setAsideDirty has it. `read`: the status read after them, if one was.
 */
const setAsideLeftDirty = (ticket: FinishedTicket, read?: WorktreeStatus) =>
  setAsideDirty(
    ticket,
    (files) =>
      line`its setup or check left uncommitted changes to ${files} in ${ticket.worktree}, so ${ticket.branch} passed with changes that would not merge; worktree left for review (have the setup and check leave tracked files as they are, as a frozen-lockfile install does; undo the changes, check, merge)`,
    "its setup or check changed tracked files",
    read,
  )

/**
 * A step of a ticket's merge in its turn, each with its handler, which gives the next step or how
 * the merge ends, a Prepared (mergeTurn drives them):
 * - Enter: its worktree checked to be on its branch, and its branch to be where its worker left it
 *   when a train rebased it onto the branch ahead (mergetrain.ts), then Locate. The merge enters
 *   again here when its fast-forward finds its branch or the base moved on.
 * - Locate: where its branch left the base, read: rebased when the base moved on (Rebase), checked
 *   when on top of it (Check), unless its check passed on it as it is (FastForward); set aside with
 *   uncommitted changes, or closed changing nothing. `carried`: what a hand-back left for the
 *   merge's first check (checkback.ts). `checked`: the commit checked, on top of the base at its
 *   `onto`, when the base moved on during that check. `afterCheck`: a check ran since the merge
 *   entered, so a base found moved on moved on during it.
 * - Rebase: its branch, off the base at `fork`, rebased onto it at `onto`, then Check. `status`: its
 *   worktree's, as Locate read it, if it could.
 * - Check: set up if need be and checked, then Confirm.
 * - Confirm: the base and its branch read again, its check having passed on `at`, on top of the base
 *   at `onto`: neither moved, FastForward; only its branch did, Locate to check it again; the base
 *   did, Locate to rebase it.
 * - FastForward: the base fast-forwarded to `at` (fastForward), the one step the merge queue runs
 *   protected from interruption.
 */
export type Step = Data.TaggedEnum<{
  Enter: Record<never, never>
  Locate: {
    readonly carried: Carried | undefined
    readonly checked: { readonly onto: Sha; readonly at: Sha } | undefined
    readonly afterCheck: boolean
  }
  Rebase: {
    readonly fork: Sha
    readonly onto: Sha
    readonly carried: Carried | undefined
    readonly status: WorktreeStatus | undefined
  }
  Check: {
    /** Where its branch left the base: `onto` when it is on top of it already. */
    readonly fork: Sha
    readonly onto: Sha
    /**
     * Its commit before the rebase (undefined when git couldn't say), or its own when on top of the
     * base already.
     */
    readonly head: Sha | undefined
    /** On top of the base already, as its worker left it, not rebased. */
    readonly onTop: boolean
    readonly carried: Carried | undefined
    /** The commit its branch is at, as the merge read it just before; read again without it. */
    readonly now: Sha | undefined
    /** Its worktree's status as the merge read it just before, nothing having run in it since. */
    readonly before: ReadonlyArray<StatusEntry> | undefined
  }
  Confirm: { readonly onto: Sha; readonly at: Sha }
  FastForward: { readonly onto: Sha; readonly at: Sha }
}>

export const Step = Data.taggedEnum<Step>()

type StepOf<Tag extends Step["_tag"]> = Data.TaggedEnum.Value<Step, Tag>

/** What a step gives: the next step, or how the merge ends. */
type Next = Effect.Effect<Step | Prepared, never, MergeEnv>

const stepTags: Record<Step["_tag"], true> = {
  Enter: true,
  Locate: true,
  Rebase: true,
  Check: true,
  Confirm: true,
  FastForward: true,
}

const isStep = (next: Step | Prepared): next is Step => Object.hasOwn(stepTags, next._tag)

/** What the steps of a ticket's merge in its turn share. */
interface Turn {
  readonly ticket: FinishedTicket
  readonly options: MergeOptions
  readonly memory: MergeMemory
  /**
   * You handed its conflict over, so its steered worker is handed it back, in this merge only
   * (§ 4.3).
   */
  readonly waived: boolean
  /**
   * Spends one of `budget`'s checks again; with none left, the ticket is blocked as `what` kept
   * changing, and the merge is Over.
   */
  readonly again: (
    budget: Budget,
    what: string,
  ) => Effect.Effect<Prepared | undefined, never, MergeEnv>
}

/** Where its branch is, git can't tell: the merges hold. */
const lost = (ticket: FinishedTicket, error: GitError) =>
  Effect.map(
    stopOver(
      ticket,
      "GIT_FAILED",
      "git failed",
      line`could not tell where ${ticket.branch} is (${gitTries} tries): ${gitWhy(error)}; ${ticket.branch} is not merged, its worktree ${ticket.worktree} left for review`,
    ),
    (stop) => Prepared.Over({ stop }),
  )

/** Where its branch left the base, git can't tell: the merges hold. */
const unplaced = (ticket: FinishedTicket, base: string, error: GitError) =>
  Effect.map(
    stopOver(
      ticket,
      "GIT_FAILED",
      "git failed",
      line`could not tell where ${ticket.branch} left ${base} (${gitTries} tries): ${gitWhy(error)}; ${ticket.branch} is not merged, its worktree ${ticket.worktree} left for review`,
    ),
    (stop) => Prepared.Over({ stop }),
  )

/**
 * Only the commit checked merges: one its branch moved on to, `to`, while its check ran on `from`
 * is checked first, the budget allowing. Over when it doesn't.
 */
const movedOn = (turn: Turn, to: string, from: string) =>
  Effect.gen(function* () {
    const { branch } = turn.ticket
    const kept = yield* turn.again("branchDuringCheck", branch)
    if (kept !== undefined) return kept
    yield* (yield* Log).write(
      detail`${branch} moved on to ${shortHash(to)} while its check ran on ${shortHash(from)}: checking it again`,
    )
    return undefined
  })

const enter = (turn: Turn): Next =>
  Effect.gen(function* () {
    const git = yield* Git
    const { ticket, options, memory } = turn
    const { id, branch, worktree } = ticket
    // What a hand-back left for this merge's check, as the base moved on while its worker worked:
    // the first check takes it.
    const carried = yield* memory.fixes.carried(id)
    const on = yield* onBranch(ticket)
    if (on._tag === "OffBranch") {
      yield* closedBut(
        ticket,
        Tag.offBranch,
        `worktree not on ${branch}`,
      )`its worktree ${worktree} has ${on.on}, not ${branch}; worktree left for review`
      return Prepared.Over({})
    }
    // Only its worktree can't be read: the ticket is set aside, the other merges going on.
    if (on._tag === "Unknown") {
      yield* closedBut(
        ticket,
        Tag.gitFailed,
        "git could not read its worktree",
      )`git could not tell what its worktree ${worktree} has checked out (${gitTries} tries): ${gitWhy(on.error)}; ${branch} is not merged, its worktree left for review`
      return Prepared.Over({})
    }
    // Still marked as rebased by a train onto the branch ahead, which git couldn't put back (as on
    // a quit, or as the run started): it may have that branch's commits, and would merge them with
    // its own. One back where its worker left it merges as any other.
    const metadata = yield* (yield* Store).metadata(id)
    const mark = rebasedAheadOf(Object.hasOwn(metadata, aheadKey) ? metadata[aheadKey] : undefined)
    if (mark !== undefined) {
      const at = yield* Effect.result(steering(git.revParse(options.repo, branch)))
      if (Result.isFailure(at)) return yield* lost(ticket, at.failure)
      if (at.success !== mark.orig) {
        yield* closedBut(
          ticket,
          Tag.rebaseFailed,
          "rebase failed",
        )`${branch} was rebased onto ${mark.behind} to be checked ahead of its turn and could not be put back as its worker left it, at ${shortHash(mark.orig)}, so it may have the commits of ${mark.behind}; worktree ${worktree} left for review`
        return Prepared.Over({})
      }
    }
    if (Object.hasOwn(metadata, aheadKey)) yield* clearAhead(id)
    return Step.Locate({ carried, checked: undefined, afterCheck: false })
  })

const locate = (turn: Turn, { carried, checked, afterCheck }: StepOf<"Locate">): Next =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const git = yield* Git
    const log = yield* Log
    const { ticket, options, memory } = turn
    const { id, branch, worktree } = ticket
    const { repo, base } = options
    const where = yield* Effect.result(
      Effect.all(
        {
          onto: steering(git.revParse(repo, base)),
          fork: steering(git.mergeBase(repo, base, branch)),
        },
        gitReads,
      ),
    )
    if (Result.isFailure(where)) return yield* unplaced(ticket, base, where.failure)
    const { onto, fork } = where.success
    // Its commits may undo each other, or a hand-back's rebase may have skipped them all.
    const nothing = yield* unchanged(ticket, options, (own) =>
      own
        ? `the commits on ${branch}, taken together, change nothing`
        : `${branch} has no commits beyond ${base} and its worktree is clean`,
    )
    if (nothing._tag === "Unchanged") return nothing
    // Its worktree's status as read just now, which nothing has run in since.
    const { status, entries } = nothing
    if (fork !== onto) {
      // The base moved on while a check of this merge ran: rebased and checked again.
      if (afterCheck) {
        const kept = yield* turn.again("baseDuringCheck", base)
        if (kept !== undefined) return kept
      }
      return Step.Rebase({ fork, onto, carried, status })
    }
    // The base moved on to where its branch, checked, is on top of it still.
    if (checked !== undefined) {
      const now = yield* Effect.result(steering(git.revParse(repo, branch)))
      if (Result.isFailure(now)) return yield* lost(ticket, now.failure)
      if (now.success === checked.at) return Step.FastForward({ onto, at: checked.at })
      const kept = yield* movedOn(turn, now.success, checked.at)
      if (kept !== undefined) return kept
    }
    const unchecked = yield* uncheckedMark(id)
    const command = config.settings.checks.fast.command
    // The check runs in its worktree, but only its commits merge: changes left uncommitted there
    // would be checked with them and never reach the base.
    const dirty = (files: ReadonlyArray<string>) =>
      line`${worktree} has uncommitted changes to ${files}, so ${branch}, on top of ${base}, can't be checked as it would merge; worktree left for review (commit or undo them, check, merge)`
    if (unchecked !== undefined) {
      if (yield* setAsideDirty(ticket, dirty, undefined, status)) return Prepared.Over({})
      yield* log.write(
        detail`${branch} is on top of ${base}, but its check didn't finish after tutti rebased it; checking it now`,
      )
      return Step.Check({
        fork: unchecked.fork ?? onto,
        onto,
        head: unchecked.head,
        onTop: false,
        carried,
        now: undefined,
        before: entries,
      })
    }
    // Every merge is checked, a branch on top of the base already too, unless the check passed on
    // it as it is in this run: as its worker fixed it, or resolved its rebase.
    const at = yield* Effect.result(steering(git.revParse(repo, branch)))
    if (Result.isFailure(at)) return yield* lost(ticket, at.failure)
    const head = at.success
    if (command === null) {
      // Unchecked, it merges as committed: changes left uncommitted would never reach the base,
      // and git would refuse to remove the worktree after the merge.
      const left = (files: ReadonlyArray<string>) =>
        line`${worktree} has uncommitted changes to ${files}, which would not merge with ${branch}; worktree left for review (commit or undo them, merge)`
      if (yield* setAsideDirty(ticket, left, undefined, status)) return Prepared.Over({})
      return Step.FastForward({ onto, at: head })
    }
    // That check, ahead of its turn (mergetrain.ts) or on its worker's fix or resolution
    // (checkback.ts, handback.ts), ran in its worktree too.
    if ((yield* memory.passes.at(id)) === head) {
      if (yield* setAsideLeftDirty(ticket, status)) return Prepared.Over({})
      return Step.FastForward({ onto, at: head })
    }
    if (yield* setAsideDirty(ticket, dirty, undefined, status)) return Prepared.Over({})
    yield* log.write(
      detail`${branch} is on top of ${base} already: checking it with '${command}' before it merges`,
    )
    return Step.Check({
      fork: onto,
      onto,
      head,
      onTop: true,
      carried,
      now: head,
      before: entries,
    })
  })

/**
 * Rebases the ticket, its branch off the base at `fork`, onto the base, which moved on to `onto`,
 * then Check: Over when it set it aside; Unchanged when the rebase left it changing nothing, as
 * when git dropped its commits, the base having their changes already; HandBack when its conflicts
 * are to be handed back to its worker, whom the merge's waiver lets take them steered (§ 4.3). An
 * interrupted rebase is aborted by git.rebase itself. `carried`: what a hand-back left for this
 * check (checkback.ts).
 */
const rebase = (turn: Turn, { fork, onto, carried, status }: StepOf<"Rebase">): Next =>
  Effect.gen(function* () {
    const git = yield* Git
    const ledger = yield* Ledger
    const log = yield* Log
    const { ticket, options, memory } = turn
    const { id, branch, worktree } = ticket
    const { repo, base } = options
    const dirty = yield* setAsideDirty(
      ticket,
      (files) =>
        line`${worktree} has uncommitted changes to ${files}, so ${branch} can't be rebased onto ${base}, which moved on while it ran; worktree left for review (commit or undo them, rebase onto ${base}, check, merge)`,
      undefined,
      status,
    )
    if (dirty) return Prepared.Over({})
    yield* ledger.refine(id, Detail.Step({ step: "rebase" }))
    // Where the branch was and what it had, for a hand-back to verify its worker's resolution by.
    const before = yield* Effect.result(
      Effect.all({ head: git.revParse(repo, branch), own: git.log(repo, onto, branch) }, gitReads),
    )
    const head = Result.isSuccess(before) ? before.success.head : undefined
    // Marked before git touches the branch: a quit before its check passes leaves the mark.
    yield* markUnchecked(id, { fork, head })
    // Onto the commit read as `onto`, not the base's name: one committed to the base since lands in
    // the next pass, so the stop, the setup's diff and the hand-back's check agree with the rebase.
    const rebased = yield* Effect.result(git.rebase(worktree, onto))
    if (Result.isFailure(rebased)) {
      const error = rebased.failure
      if (error._tag === "RebaseConflict") {
        const stop: RebaseStop = {
          ticket,
          onto,
          fork,
          head,
          own: Result.isSuccess(before) ? before.success.own.length : undefined,
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
        const handed = yield* toHandBack(stop, yield* memory.handBacks.count(id), turn.waived)
        if (Result.isSuccess(handed)) return Prepared.HandBack({ stop: handed.success })
        yield* notHandedBack(stop, options, handed.failure, memory.handBacks)
        return Prepared.Over({})
      }
      yield* closedBut(
        ticket,
        Tag.rebaseFailed,
        "rebase failed",
      )`git could not rebase ${branch} onto ${base}, which moved on while it ran: ${gitWhy(error)}; worktree ${worktree} left for review`
      return Prepared.Over({})
    }
    const dropped = yield* unchanged(
      ticket,
      options,
      () => `rebased onto ${base}, which has its changes already, ${branch} changes nothing`,
    )
    if (dropped._tag === "Unchanged") return dropped
    yield* log.write(detail`rebased ${branch} onto ${base}, which moved on while it ran`)
    return Step.Check({
      fork,
      onto,
      head,
      onTop: false,
      carried,
      now: undefined,
      before: dropped.entries,
    })
  })

/**
 * Sets up the ticket, its branch rebased from `fork` (its commit `head` then; undefined when git
 * couldn't say) onto the base at `onto`, or `onTop` of it already (`fork` is then `onto`, and `head`
 * the branch's own commit), if need be, and checks it: Confirm, on the commit the check passed on when
 * it passed, the branch's as the setup started, kept in the memory's passes too; Over when either
 * set it aside, or git couldn't say where the branch is; FixBack when its failure is to be handed
 * back to its worker. `carried`: what a hand-back left for this check, its worker's fix or
 * resolution made while the base moved on: the check says whether the fix fixed it, as
 * checkback.ts's fixCheck would have, and the setup counts its worker's own changes. `now`: the
 * commit the branch is at, as the merge read it just before; it is read here without it. `before`:
 * its worktree's status as the merge read it just before, nothing having run in it since, for the
 * setup, or the check when no setup runs, to start from (noteWritten).
 */
const check = (
  turn: Turn,
  { fork, onto, head, onTop, carried, now, before }: StepOf<"Check">,
): Next =>
  Effect.gen(function* () {
    const git = yield* Git
    const ledger = yield* Ledger
    const log = yield* Log
    const { ticket, options, memory } = turn
    const { id, branch } = ticket
    const tries = carried?.tries ?? []
    // The commit checked: one made while the setup and check run is checked before it merges.
    const read =
      now === undefined
        ? yield* Effect.result(steering(git.revParse(options.repo, branch)))
        : Result.succeed(now)
    if (Result.isFailure(read)) {
      yield* closedBut(
        ticket,
        Tag.gitFailed,
        "git could not read its branch",
      )`git could not tell where ${branch} is (${gitTries} tries): ${gitWhy(read.failure)}, so it can't be checked as it would merge; worktree ${ticket.worktree} left for review`
      return Prepared.Over({})
    }
    const at = read.success
    const handBack = (stop: HandedCheck) => Prepared.FixBack({ stop })
    const passed = Step.Confirm({ onto, at })
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
          return after._tag === "Aside" ? Prepared.Over({}) : handBack(after.stop)
        }
        const fix = yield* toFix(stop, options, yield* memory.fixes.count(id))
        if (Result.isSuccess(fix)) return handBack(fix.success)
        const said = refusalWhy(fix.failure)
        if (tries.length > 0) {
          yield* setAside(stop, options, memory, tries, said)
          return Prepared.Over({})
        }
        const tried = said === undefined ? "" : line`; not handed back to its worker: ${said}`
        yield* checksFailed(ticket, options, memory.rechecks, {
          onto,
          error,
          output,
          tried,
          onTop,
        })
        return Prepared.Over({})
      })
    // The tickets behind it may be checked ahead of their turn meanwhile, on top of its branch.
    const train = memory.train
    if (train !== undefined) yield* train.starts(ticket, at)
    const ends = (passed: boolean) => (train === undefined ? Effect.void : train.ends(passed))
    const setup = yield* setUp(ticket, options, memory.setUps, {
      fork,
      onto,
      fix: carried?.fix,
      at,
      before,
    })
    if (setup._tag === "Failed") {
      yield* ends(false)
      return yield* failed(setup.error, setup.output)
    }
    yield* ledger.refine(id, Detail.Step({ step: "check" }))
    // A ticket checked once more after a failed check (recheck.ts) has its check recorded so.
    const rechecking = (yield* ledger.current).tickets.get(id)?.rechecking === true
    // The worktree as the setup left it, or as read before it when none ran.
    const start = setup._tag === "Passed" ? setup.after : before
    const checked = yield* runMergeCheck(ticket, rechecking ? "recheck" : "merge", start)
    // What merges is the commit checked: changes the setup or check left would pass unmerged.
    const dirty =
      checked._tag !== "Failed" &&
      (yield* setAsideLeftDirty(
        ticket,
        checked.after === undefined ? undefined : statusOf(checked.after),
      ))
    yield* ends(checked._tag !== "Failed" && !dirty)
    if (dirty) return Prepared.Over({})
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

/**
 * Checked: the base and its branch read again side by side. Neither moved, it is ready; only its
 * branch did, it is checked again; the base did, the merge locates its branch again, to rebase it.
 */
const confirm = (turn: Turn, { onto, at }: StepOf<"Confirm">): Next =>
  Effect.gen(function* () {
    const git = yield* Git
    const { ticket, options } = turn
    const { repo, base } = options
    const now = yield* Effect.all(
      {
        base: Effect.result(steering(git.revParse(repo, base))),
        head: Effect.result(steering(git.revParse(repo, ticket.branch))),
      },
      gitReads,
    )
    if (Result.isFailure(now.base)) return yield* unplaced(ticket, base, now.base.failure)
    if (now.base.success !== onto) {
      return Step.Locate({ carried: undefined, checked: { onto, at }, afterCheck: true })
    }
    if (Result.isFailure(now.head)) return yield* lost(ticket, now.head.failure)
    if (now.head.success === at) return Step.FastForward({ onto, at })
    const kept = yield* movedOn(turn, now.head.success, at)
    return kept ?? Step.Locate({ carried: undefined, checked: undefined, afterCheck: true })
  })

/**
 * The fast-forward (fastForward): Merged, or Over, with the stop when the main checkout or git kept
 * it from merging. Its branch moved on after its check passed, or the base before it merged, the
 * merge enters again, the budget allowing, to check the commit it is at now on the base as it is
 * now.
 */
const forward = (turn: Turn, { onto, at }: StepOf<"FastForward">): Next =>
  Effect.gen(function* () {
    const { ticket, options } = turn
    const ended = yield* fastForward(ticket, options, onto, at)
    switch (ended._tag) {
      case "Merged":
        return Prepared.Merged({ onto, at })
      case "Stopped":
        return Prepared.Over({ stop: ended.stop })
      case "Moved":
      case "BaseMoved": {
        const what = ended._tag === "Moved" ? ticket.branch : options.base
        return (yield* turn.again("beforeFastForward", what)) ?? Step.Enter()
      }
    }
  })

const step = (turn: Turn, next: Step): Next =>
  Step.$match(next, {
    Enter: () => enter(turn),
    Locate: (at) => locate(turn, at),
    Rebase: (at) => rebase(turn, at),
    Check: (at) => check(turn, at),
    Confirm: (at) => confirm(turn, at),
    FastForward: (at) => forward(turn, at),
  })

/** The short why of a ticket set aside as its check, or the setup before it, failed. */
export const checksFailedDetail = (error: CheckError): string => {
  const what = error.check === "setup" ? "setup" : "checks"
  return `${what} ${error._tag === "CheckTimedOut" ? "timed out" : "failed"}`
}

/** How a check, or the setup before it, failed on a ticket's branch, for checksFailed. */
export interface FailedCheck {
  /** The base's commit its branch was rebased onto, or is on top of. */
  readonly onto: string
  readonly error: CheckError
  /** Where its whole output is. */
  readonly output: string
  /** What came of handing it back to its worker, if anything, as its line says it. */
  readonly tried?: Line | string
  /** On top of the base already, not rebased. */
  readonly onTop?: boolean
}

/**
 * Sets the ticket aside as its check, or the setup before it, failed on its branch rebased onto the
 * base at `onto`, or `onTop` of it already, kept to be checked once more once the base moves on,
 * unless this was that once (recheck.ts), and what the check said kept for the report
 * (reportEvidence.ts).
 */
export const checksFailed = (
  ticket: FinishedTicket,
  options: MergeOptions,
  rechecks: Rechecks,
  { onto, error, output, tried = "", onTop = false }: FailedCheck,
): Effect.Effect<void, never, MergeEnv> =>
  Effect.gen(function* () {
    const log = yield* Log
    const where = error._tag === "CheckNotRun" ? "" : line` (output is in ${output})`
    const again = (yield* rechecks.rechecked(ticket.id)) ? " again" : ""
    const later = yield* keepForRecheck(ticket, options, rechecks, onto, error)
    yield* closedBut(
      ticket,
      Tag.checksFailed,
      `${checksFailedDetail(error)}${again}`,
    )`${failedHow(error)}${again} on ${branchOn(ticket.branch, options.base, onTop)}${tried}; worktree ${ticket.worktree} left for review${where}${later}`
    const said = saidOf(error)
    if (said.length > 0) yield* log.write(...said.map((each) => detail`  ${each}`))
    yield* noteFailedCheck(ticket, options, rechecks, onto, error, output, onTop)
  })

/**
 * Blocks the ticket, MERGE_CONFLICT, as `what` (its base, or its branch) kept changing while its
 * checks ran, each check overtaken by a commit.
 */
export const keptChanging = (ticket: FinishedTicket, what: string) =>
  Effect.gen(function* () {
    const text = closedButLine(
      ticket,
      Tag.mergeConflict,
    )`${what} while its checks ran (commits made by hand?); worktree ${ticket.worktree} left for review`
    yield* block(ticket, Tag.mergeConflict, {
      kind: "warn",
      ticket: ticket.id,
      aside: true,
      detail: what,
      blocked: what,
      text,
    })
    return Prepared.Over({})
  })

/**
 * A ticket's merge in its turn: its steps (Step) driven from Enter to how the merge ends, each but
 * the fast-forward through `interruptible`, the fast-forward under the merge queue's mask, and the
 * budgets spent over the whole turn. Merged once its branch, on top of the base and checked as
 * orchestra 0.8.5 has it (unless the check passed on it as it is in this run, the memory's passes,
 * or its commits change nothing), is fast-forwarded onto it; Over when it was set aside (kept in the
 * memory's rechecks when its check failed), blocked or stopped the merges; HandBack when its rebase
 * stopped on conflicts its worker can take; FixBack when its check failed in a way its worker can
 * take; Unchanged when its branch changes nothing beyond the base, as when git's rebase dropped
 * every commit.
 */
export const mergeTurn = (
  ticket: FinishedTicket,
  options: MergeOptions,
  memory: MergeMemory,
  interruptible: (next: Next) => Next,
): Effect.Effect<Prepared, never, MergeEnv> =>
  Effect.gen(function* () {
    const spent: Record<Budget, number> = {
      baseDuringCheck: 0,
      branchDuringCheck: 0,
      beforeFastForward: 0,
    }
    const turn: Turn = {
      ticket,
      options,
      memory,
      waived: yield* memory.handBacks.waived(ticket.id),
      again: (budget, what) =>
        Effect.suspend(() => {
          if (spent[budget] === budgets[budget]) {
            return keptChanging(ticket, `${what} kept changing`)
          }
          spent[budget]++
          return Effect.succeed(undefined)
        }),
    }
    const run = (at: Step) =>
      at._tag === "FastForward" ? step(turn, at) : interruptible(step(turn, at))
    let next: Step | Prepared = Step.Enter()
    while (isStep(next)) next = yield* run(next)
    return next
  })

/**
 * What removing a done ticket's worktree and branch came to (removeMerged): both gone (Removed);
 * left as they are, as its worktree has uncommitted changes to `files` (Changed) or git can't say
 * whether it has (Unreadable), which only `leaveChanged` asks; or git kept them (Failed,
 * CLEANUP_FAILED).
 */
export type Cleanup = Data.TaggedEnum<{
  Removed: Record<never, never>
  Changed: { readonly files: ReadonlyArray<string> }
  Unreadable: { readonly error: GitError }
  Failed: { readonly error: GitError }
}>

export const Cleanup = Data.taggedEnum<Cleanup>()

/** A ticket done, as retire takes it: `worktree` is undefined when git has none on its branch. */
export interface DoneTicket {
  readonly id: TicketId
  readonly title: string
  readonly branch: string
  readonly worktree: string | undefined
}

/**
 * Removes the worktree and branch of a ticket done, its work on the base or none of its own left:
 * the worktree with --force when its only changes are untracked files tutti's setups or checks
 * wrote there (checkWrote.ts), as git refuses it otherwise (CLEANUP_FAILED), a detail line naming
 * them once they are gone. `moveToBase`: the branch moved to the base first, so that git deletes it
 * as merged when the base holds its changes without its commits (its reflog keeps them); "ahead"
 * when it has commits beyond the base, or git can't say. `leaveChanged`: a worktree with any
 * changes, tutti's files too, or one git can't read, is left with its branch rather than handed to
 * git, as one a person may be working in. Without a worktree, only the branch is removed. A worktree
 * with no changes, or only tutti's files, is set aside in the trash folder rather than deleted by
 * git, its files deleted in the background (trash.ts), so the merge queue doesn't wait on them.
 */
export const removeMerged = (
  ticket: Omit<DoneTicket, "title">,
  options: MergeTarget,
  how: { readonly moveToBase: boolean | "ahead"; readonly leaveChanged?: boolean },
): Effect.Effect<Cleanup, never, Git | Worktrees | Log | Trash> =>
  Effect.gen(function* () {
    const git = yield* Git
    const worktrees = yield* Worktrees
    const { id, branch, worktree: at } = ticket
    const failed = (error: GitError) => Cleanup.Failed({ error })
    if (at === undefined) {
      return yield* Effect.match(worktrees.remove(id), {
        onSuccess: () => Cleanup.Removed(),
        onFailure: failed,
      })
    }
    const status = yield* Effect.result(git.status(at))
    const written = Result.isSuccess(status) ? yield* writtenOnly(at, status.success) : undefined
    if (how.leaveChanged === true) {
      if (Result.isFailure(status)) return Cleanup.Unreadable({ error: status.failure })
      const files = allChanges(status.success)
      if (files.length > 0) return Cleanup.Changed({ files })
    }
    const ahead =
      how.moveToBase === "ahead"
        ? Effect.map(
            Effect.result(git.log(options.repo, options.base, branch)),
            (commits) => Result.isFailure(commits) || commits.success.length > 0,
          )
        : Effect.succeed(how.moveToBase)
    if (yield* ahead) yield* restoreBranch({ branch, worktree: at }, options.base, 1)
    const removal = written === undefined ? { at } : { at, untracked: true }
    // Nothing in it git would refuse to delete: its files go in the background.
    const aside =
      Result.isSuccess(status) && (written !== undefined || allChanges(status.success).length === 0)
    const removed = yield* Effect.result(worktrees.remove(id, { ...removal, aside }))
    if (Result.isFailure(removed)) return failed(removed.failure)
    if (removed.success !== undefined) yield* (yield* Trash).delete(removed.success, id)
    if (written !== undefined) {
      yield* (yield* Log).write(
        detail`${id}: its setup or check left ${fileList(written)} untracked in ${at}, removed with it`,
      )
    }
    return Cleanup.Removed()
  })

/**
 * `CLEANUP_FAILED for <worktree> / <branch>: <why>`, of a done ticket whose worktree and branch are
 * left: what git said, or the changes in its worktree that kept them.
 */
export const cleanupFailed = (
  ticket: Pick<DoneTicket, "branch" | "worktree">,
  cleanup: Exclude<Cleanup, { readonly _tag: "Removed" }>,
): Line => {
  const what =
    ticket.worktree === undefined ? ticket.branch : `${ticket.worktree} / ${ticket.branch}`
  const why =
    cleanup._tag === "Failed"
      ? gitWhy(cleanup.error)
      : cleanup._tag === "Changed"
        ? line`its worktree has uncommitted changes to ${cleanup.files}`
        : line`git can't say whether its worktree has uncommitted changes: ${gitWhy(cleanup.error)}`
  return line`${Tag.cleanupFailed} for ${what}: ${why}`
}

/**
 * A done ticket retired, as `how.move` says it is done (merged, closed with no change, merged by
 * hand): its worktree and branch removed as removeMerged does it, as `how` asks, the `unmerged`
 * label an earlier run gave it removed (a carried-over ticket keeps it until it merges, closeEpics
 * taking a labelled subticket for one not merged), Done with the `closed` record `how.closed` makes
 * of what came of them, forgotten in state.json, its marks with it, and the epics above it closed.
 * `how.issue`: what bd showed of it just before, if its caller asked; bd is asked here without it.
 */
export const retire = (
  ticket: DoneTicket,
  options: MergeTarget,
  how: {
    readonly move: Move
    readonly moveToBase: boolean | "ahead"
    readonly leaveChanged?: boolean
    readonly issue?: Issue
    /** The closed record's `detail` and line, of what came of the cleanup and the label. */
    readonly closed: (
      cleanup: Cleanup,
      unlabelled: boolean,
    ) => { readonly detail: string; readonly text: Line }
  },
): Effect.Effect<void, never, MergeEnv> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const ledger = yield* Ledger
    const { id, title } = ticket
    const cleanup = yield* removeMerged(ticket, options, how)
    const shown =
      how.issue === undefined ? yield* Effect.result(beads.show(id)) : Result.succeed(how.issue)
    const labelled = Result.isSuccess(shown) && shown.success.labels.includes(unmergedLabel)
    const unlabelled = labelled && (yield* unlabel(id))
    const said = how.closed(cleanup, unlabelled)
    yield* ledger.transition(id, how.move, {
      said: [{ kind: "closed", ticket: id, title, ...said }],
    })
    // Done, it has nothing left for a later run.
    yield* Effect.ignore((yield* Store).remove(id))
    yield* closeEpics(id, shown)
  })

/**
 * The protected step for a ticket with nothing of its own left to merge, as `unchanged` says: the
 * ticket retired, Done{noChange}, a branch with commits of its own moved to the base first.
 */
export const closeUnchanged = (
  ticket: FinishedTicket,
  options: MergeTarget,
  unchanged: Unchanged,
): Effect.Effect<void, never, MergeEnv> =>
  retire(ticket, options, {
    move: Move.NoChange(),
    moveToBase: unchanged.own,
    closed: (cleanup) => {
      const left =
        cleanup._tag === "Removed"
          ? line`worktree and branch removed`
          : line`but ${cleanupFailed(ticket, cleanup)}`
      return {
        detail: "no change to merge",
        text: detail`${ticket.id} closed with no change: ${unchanged.why}, so there is nothing to merge; ${left}`,
      }
    },
  })

/**
 * The epics `id` was the last subticket to merge under, closed, each then its own parent's. `read`:
 * what bd showed of it just before, if the caller asked; it is asked here without it.
 */
export const closeEpics = (id: TicketId, read?: Result.Result<Issue, BeadsError>) =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const beads = yield* Beads
    const ledger = yield* Ledger
    const shown = read ?? (yield* Effect.result(beads.show(id)))
    let parent = Result.isSuccess(shown) ? shown.success.parent : undefined
    while (parent !== undefined) {
      const epic = parent
      const read = yield* Effect.result(
        Effect.all({ issue: beads.show(epic), children: beads.list({ parent: epic, all: true }) }),
      )
      if (Result.isFailure(read)) {
        yield* info(
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
        yield* info(
          detail`${all}, but bd could not close ${epic}: ${beadsWhy(closed.failure)}; close it with: bd close ${epic}`,
          epic,
        )
        return
      }
      yield* info(detail`closed epic ${epic}: ${all}`, epic)
      parent = issue.parent
    }
  })

/**
 * Why git refused to fast-forward the base to a branch's commit, `error` saying how it refused:
 * uncommitted changes in the main checkout to `files`, which the branch changes, are in the way
 * (InTheWay); the base moved on to `to` from the commit the branch is on top of, as with a commit
 * made on it by hand since the merge read it (BaseMoved); the branch doesn't fast-forward onto it
 * (NoFastForward); git can't say where the base is now, `read` its error (Unreadable); or the
 * branch still fast-forwards, git kept from writing, as by another's .git/index.lock, which a few
 * seconds may clear (Kept).
 */
export type Refused = Data.TaggedEnum<{
  InTheWay: { readonly files: ReadonlyArray<string> }
  BaseMoved: { readonly to: string }
  NoFastForward: { readonly error: GitError }
  Unreadable: { readonly error: GitError; readonly read: GitError }
  Kept: { readonly error: GitError }
}>

export const Refused = Data.taggedEnum<Refused>()

/**
 * Why git refused (`error`) to fast-forward the base to `at`, its branch on top of the base at
 * `onto`, as Refused has it: `status` is the main checkout's as read before, whose changes git
 * leaves out of a clean tree (.beads/, .tutti/run/) can be in the way too. Its git reads are made
 * as steering makes them.
 */
export const diagnose = (
  options: MergeTarget,
  onto: Sha,
  at: Sha,
  status: ReadonlyArray<StatusEntry>,
  error: GitError,
): Effect.Effect<Refused, never, Git> =>
  Effect.gen(function* () {
    const git = yield* Git
    const { repo, base } = options
    const local = new Set(status.map((entry) => entry.path))
    const changed = yield* Effect.result(steering(git.changedFiles(repo, base, at)))
    const files = Result.isSuccess(changed)
      ? changed.success.filter((path) => local.has(path)).sort()
      : []
    if (files.length > 0) return Refused.InTheWay({ files })
    // Not every failure is a branch that doesn't fast-forward: the base may have moved on since
    // the merge read it, or git may have been kept from writing.
    const now = yield* Effect.result(
      Effect.all(
        { base: steering(git.revParse(repo, base)), fork: steering(git.mergeBase(repo, base, at)) },
        gitReads,
      ),
    )
    if (Result.isFailure(now)) return Refused.Unreadable({ error, read: now.failure })
    if (now.success.base !== onto) return Refused.BaseMoved({ to: now.success.base })
    if (now.success.fork !== now.success.base) return Refused.NoFastForward({ error })
    return Refused.Kept({ error })
  })

/**
 * The protected step: the base fast-forwarded to `at`, the commit the ticket's merge check passed
 * on, its branch on top of the base at `onto`, in the main checkout, then the ticket retired
 * (retire), Done. Merged when it merged; Stopped, with the stop, when the
 * main checkout or git kept it from merging; Moved, nothing merged, when its branch is no longer at
 * `at`, as when its worker committed after its check passed: the merge checks it again. A
 * fast-forward git refuses is diagnosed (Refused): BaseMoved when the base is no longer at `onto`
 * (a commit made on it by hand), for the merge to rebase and check the branch again; tried again
 * as gitAgain says while the branch still fast-forwards onto it (Kept, as with another's
 * .git/index.lock), then GIT_FAILED; MERGE_FAILED only when it doesn't.
 */
export const fastForward = (
  ticket: FinishedTicket,
  options: MergeTarget,
  onto: Sha,
  at: Sha,
): Effect.Effect<FastForward, never, MergeEnv> =>
  Effect.gen(function* () {
    const git = yield* Git
    const ledger = yield* Ledger
    const log = yield* Log
    const { id, branch, worktree } = ticket
    const { repo, base } = options
    yield* ledger.refine(id, Detail.Step({ step: "fast-forward" }))
    const left = line`${branch} is not merged, its worktree ${worktree} left for review`
    const checkout = yield* Effect.result(
      Effect.all(
        { status: steering(git.status(repo)), on: steering(git.currentBranch(repo)) },
        gitReads,
      ),
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
        detail`${branch} moved on to ${shortHash(head.success)} after its check passed on ${shortHash(at)}: checking it again before it merges`,
      )
      return FastForward.Moved({ to: head.success })
    }
    // Tried again while the branch still fast-forwards, git kept from it.
    const merged = yield* Effect.result(
      retrying(
        Effect.catch(git.fastForward(repo, at), (error) =>
          Effect.flatMap(diagnose(options, onto, at, checkout.success.status, error), Effect.fail),
        ),
        gitAgain,
        { while: Refused.$is("Kept") },
      ),
    )
    if (Result.isFailure(merged)) {
      return yield* Refused.$match(merged.failure, {
        InTheWay: ({ files }) =>
          stopped(
            ticket,
            "DIRTY_TREE",
            "main checkout has uncommitted changes",
            line`uncommitted changes in ${repo} to ${files}, which ${branch} changes; ${left}. Commit or undo them, then run again`,
          ),
        Unreadable: ({ error, read }) =>
          stopped(
            ticket,
            "GIT_FAILED",
            "git failed",
            line`could not fast-forward ${base} to ${branch} (${gitWhy(error)}), nor tell where ${base} is now (${gitTries} tries): ${gitWhy(read)}; ${left}`,
          ),
        BaseMoved: ({ to }) =>
          Effect.as(
            log.write(
              detail`${base} moved on to ${shortHash(to)} before ${branch} fast-forwarded onto ${shortHash(onto)}: rebasing and checking it again before it merges`,
            ),
            FastForward.BaseMoved({ to }),
          ),
        NoFastForward: ({ error }) =>
          stopped(
            ticket,
            "MERGE_FAILED",
            `does not fast-forward onto ${base}`,
            line`${branch} does not fast-forward onto ${base}: ${gitWhy(error)}; its worktree ${worktree} left for review`,
          ),
        Kept: ({ error }) =>
          stopped(
            ticket,
            "GIT_FAILED",
            "git failed",
            line`${branch} fast-forwards onto ${base}, but git could not merge it (${gitTries} tries): ${gitWhy(error)}; ${left}`,
          ),
      })
    }
    const commits = yield* Effect.result(git.log(repo, onto, base))
    const own = Result.isSuccess(commits) ? commits.success : []
    const commit = own.find((each) => each.message.includes(id)) ?? own[0]
    let hash = commit?.hash
    if (hash === undefined) {
      const now = yield* Effect.result(git.revParse(repo, base))
      hash = Result.isSuccess(now) ? now.success : onto
    }
    const short = shortHash(hash)
    const named = commit === undefined ? short : line`${short} ${commit.subject}`
    yield* retire(ticket, options, {
      move: Move.FastForwarded({ commit: hash }),
      moveToBase: false,
      closed: (cleanup) =>
        cleanup._tag === "Removed"
          ? {
              detail: `${short} merged into ${base}`,
              text: detail`${id} closed (${named}); merged into ${base}, worktree and branch removed`,
            }
          : {
              detail: `${short} merged; cleanup failed`,
              text: detail`${id} closed (${named}); merged into ${base}, but ${cleanupFailed(ticket, cleanup)}`,
            },
    })
    return FastForward.Merged()
  })
