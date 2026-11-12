// What the merge's modules share (§ 5 item 7, § 5.1's Merging): a finished ticket, where the merges
// land and what they read of the run, how a ticket's turn ends, what a merge keeps for the run, the
// rechecks, and the small steps over them (someFiles, unchanged, notePass, closedBut). The merge
// (merge.ts), the hand-backs (handback.ts, checkback.ts), the recheck (recheck.ts), the report's
// evidence (reportEvidence.ts) and a ticket taken back (takenBack.ts) import it, none of them each
// other in a circle.
import { posix } from "node:path"
import { Data, Effect, Result } from "effect"
import type { AgentHost } from "../agent/AgentHost.ts"
import type { AppConfig } from "../core/AppConfig.ts"
import { type Arg, type Line, type Log, line, ticketLine } from "../core/log.ts"
import type { Beads, TicketId } from "../services/Beads.ts"
import type { Checks } from "../services/Checks.ts"
import type { EventStream } from "../services/EventStream.ts"
import { Git, type Sha, type StatusEntry } from "../services/Git.ts"
import type { Store } from "../services/Store.ts"
import type { Worktrees } from "../services/Worktrees.ts"
import { leaveForReview } from "./aside.ts"
import { gitReads, statusOf, type WorktreeStatus } from "./branch.ts"
import type { Passes } from "./check.ts"
import type { Fixes, HandedCheck } from "./checkback.ts"
import type { MergedWork } from "./critic.ts"
import type { EarlyChecks } from "./earlyCheck.ts"
import type { AtReset, HandBacks, HandedRebase } from "./handback.ts"
import type { Ledger } from "./ledger.ts"
import type { OvernightAside } from "./overnightAside.ts"
import type { Records } from "./playbookRun.ts"
import { shownChanges } from "./settle.ts"
import type { SetUps } from "./setup.ts"
import type { Trash } from "./trash.ts"

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
   * has it pressed (load.ts's pressing). A hand-back's time limit, and a check's or setup's, leave
   * out the time it is, up to the limit again (handback.ts's give, Checks' RunOptions). Without it,
   * the machine is never loaded.
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
   * Whether the run holds at the machine's cap on workers, or the machine's memory is pressed
   * (pressureGate.ts): no check ahead starts then (mergetrain.ts). Never without it.
   */
  readonly machineFull: Effect.Effect<boolean>
  /**
   * The run's early checks (earlyCheck.ts): each check of a merge takes their check slot, and a
   * ticket's turn merges with no second check where its early check passed on the same tree on the
   * same base. None without them.
   */
  readonly early?: EarlyChecks
  /**
   * Told of each ticket merged: its base's commit before and the commit the merge put the base at,
   * for the critic (critic.ts), which may review it. Nothing is told without it.
   */
  readonly merged?: (work: MergedWork) => Effect.Effect<void>
  /**
   * What a failed check's hand-back to `ticket`'s worker carries after its prompt (checkback.ts):
   * the playbook's records for a worker that struggles (playbookRun.ts's `record`), once, marked
   * told once the hand-back has reached it. Nothing without it.
   */
  readonly struggled?: (ticket: TicketId) => Effect.Effect<Records | undefined>
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

/** The first `shownChanges` of `files`, and how many more there are, as a line names them. */
export const someFiles = (files: ReadonlyArray<string>): string => {
  const more = files.length - shownChanges
  return `${files.slice(0, shownChanges).join(", ")}${more > 0 ? ` and ${more} more` : ""}`
}

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
export const closedButLine =
  (ticket: FinishedTicket, tag: string) =>
  (strings: TemplateStringsArray, ...args: ReadonlyArray<Arg>): Line =>
    ticketLine(tag)`${ticket.id} closed, but ${line(strings, ...args)}`

/**
 * Sets the ticket aside for review, Merging → Review{tag}, `short` its warn record's detail, with
 * its note and the line `<tag>: <id> closed, but …`; `checkLog` where its failed check's output is.
 */
export const closedBut =
  (ticket: FinishedTicket, tag: string, short: string, checkLog?: string) =>
  (strings: TemplateStringsArray, ...args: ReadonlyArray<Arg>) =>
    leaveForReview(ticket.id, {
      why: tag,
      detail: short,
      text: closedButLine(ticket, tag)(strings, ...args),
      ...(checkLog === undefined ? {} : { checkLog }),
    })

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

/** A ticket set aside for a failed check, to be checked once more once the base moves on. */
export interface Recheck {
  readonly ticket: FinishedTicket
  /** The commit of the base its check failed on. */
  readonly onto: string
  /** Its branch's commit then. */
  readonly head: string
}

/**
 * The tickets of a run waiting to be checked once more, and those taken up to be; and what the
 * check said of each ticket it set aside, for the run report.
 */
export interface Rechecks {
  /** The tickets waiting to be checked once more, in the order they were set aside. */
  readonly waiting: Effect.Effect<ReadonlyArray<Recheck>>
  /** Whether the ticket has been taken up to be checked once more in this run. */
  rechecked(id: TicketId): Effect.Effect<boolean>
  /** Keeps the ticket to be checked once more. */
  keep(recheck: Recheck): Effect.Effect<void>
  /** Takes the ticket out of those waiting, as checked once more; false when it wasn't waiting. */
  take(id: TicketId): Effect.Effect<boolean>
  /** Takes the ticket out of those waiting, not checked once more; false when it wasn't waiting. */
  drop(id: TicketId): Effect.Effect<boolean>
  /** Takes every ticket out of those waiting, not checked once more: those that were. */
  readonly dropAll: Effect.Effect<ReadonlyArray<Recheck>>
  /** Keeps what the ticket's check said as it set the ticket aside, in place of what it said before. */
  noteFailure(id: TicketId, evidence: string): Effect.Effect<void>
  /** What the check said of each ticket it set aside, by ticket, in the order they were first. */
  readonly failures: Effect.Effect<ReadonlyMap<string, string>>
}

/** The folders of `files` (`.` for the top level), each once, sorted. */
export const foldersOf = (files: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(files.map((file) => posix.dirname(file)))].sort()
