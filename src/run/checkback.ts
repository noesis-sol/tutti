// The check hand-back (§ 4.7, § 5 item 7's CHECKS_FAILED with hand-back, § 5.1's Merging → Fixing,
// Resolving → Fixing{afterResolution}, and Fixing → ToMerge, Fixing, Review, Blocked), as
// orchestra's checkback.go has it. A check that fails on a finished ticket's branch rebased onto
// the base, after a clean rebase or once its worker has resolved the rebase's conflicts, often
// fails where its change meets what landed meanwhile: a test another ticket added for the code as
// it was. So the failure is handed back to the ticket's worker, which has the change in mind, when
// it can take it: hand-backs on (merge.check_hand_backs), attempts left of them, a failure to show
// it (the check finished), git able to say what the check failed on, the run neither holding nor winding down, and
// its worker Idle or Failed and not steered, or its session closed by tutti, which is resumed, or
// Gone with its ticket's one Gone resume of the run left, resumed too (handback.ts's give).
//
// The hand-back is a client_composed message with orchestra's instructions: what failed, the lines
// that say so, what landed on the base since the branch was cut, and to commit a fix naming the
// ticket and nothing else. The ticket moves to Fixing{attempt, afterResolution} with the FIXING
// line, and the merge queue goes on with the tickets behind it meanwhile. Once the worker has
// settled, within resolve_timeout from the push, tutti looks at what it left without taking its word
// for it: no rebase in progress, the worktree clean and on its branch, and the branch as the check
// failed on it with new commits on top, each naming the ticket. Then it sets up and checks it again:
// a check that passes puts the ticket back in the merge queue, ToMerge; one that fails again is
// handed back again while attempts are left, Fixing again. Each pass through Merging counts toward
// the attempts, which a run keeps per ticket.
//
// A fix that can't be accepted is undone, the branch reset to where the check failed, and nothing
// more is handed back. Then, as when the attempts are used up, the ticket is set aside: Review with
// CHECKS_FAILED after a clean rebase (kept to be checked once more, recheck.ts), Blocked with
// MERGE_CONFLICT after a resolution (the branch put back as the ticket closed it), its line and
// notes saying what came of each attempt. A failure that can't be handed back is set aside at once,
// its line saying why.
import { Effect, Ref, Result } from "effect"
import { AppConfig } from "../cli/AppConfig.ts"
import { formatDuration } from "../project/configFile.ts"
import { Beads } from "../services/Beads.ts"
import type { CheckError } from "../services/Checks.ts"
import { type Commit, Git } from "../services/Git.ts"
import { failedHow, runMergeCheck, saidOf } from "./check.ts"
import { EventStream } from "./eventstream.ts"
import { failedResolved, give, type RebaseStop, rejectResolution, workerAway } from "./handback.ts"
import { Ledger } from "./ledger.ts"
import { detail, fixing, Log, line } from "./log.ts"
import {
  checksFailed,
  type FinishedTicket,
  gitWhy,
  type MergeEnv,
  type MergeMemory,
  type MergeOptions,
  offBranch,
  uncommitted,
} from "./merge.ts"
import { Cause } from "./phase.ts"
import { namesTicket } from "./settle.ts"
import { setUp } from "./setup.ts"

/** A check that failed on a finished ticket's branch rebased onto the base, as the merge found it. */
export interface CheckStop {
  readonly ticket: FinishedTicket
  /** The base's commit the branch was rebased onto. */
  readonly onto: string
  /** Where the branch left the base before the rebase, for the setup (setup.ts). */
  readonly fork: string
  /** The branch's commit before the rebase; "" when git couldn't say. */
  readonly head: string
  /** The branch's commit the check failed on; "" when git couldn't say. */
  readonly at: string
  /** How the check, or the setup before it, failed. */
  readonly error: CheckError
  /** Where its whole output is. */
  readonly output: string
  /** The rebase its worker resolved, when the check failed on the resolution. */
  readonly resolved?: RebaseStop
}

/** How many times each ticket's failed check has been handed back to its worker in a run. */
export interface Fixes {
  /** How many times the ticket's failed check has been handed back in this run. */
  count(id: string): Effect.Effect<number>
  /** Counts one more hand-back of the ticket's failed check: this one's number. */
  next(id: string): Effect.Effect<number>
}

/** A run's check hand-backs: none yet. */
export const makeFixes: Effect.Effect<Fixes> = Effect.gen(function* () {
  const ref = yield* Ref.make<ReadonlyMap<string, number>>(new Map())
  return {
    count: (id) => Effect.map(Ref.get(ref), (counts) => counts.get(id) ?? 0),
    next: (id) =>
      Ref.modify(ref, (counts) => {
        const n = (counts.get(id) ?? 0) + 1
        return [n, new Map([...counts, [id, n]])]
      }),
  } satisfies Fixes
})

/** How many times something was done, as in `twice`. */
export const times = (n: number): string => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`)

const short = (hash: string) => hash.slice(0, 10)

/**
 * Why `stop`'s failure can't be handed back to the ticket's worker, the `fixed`th time so far:
 * undefined when it can, "" when check hand-backs are turned off (nothing to say). While the run
 * holds or winds down it takes on no more work, as `options.noMore` says.
 */
export const whyNotFix = (
  stop: CheckStop,
  options: MergeOptions,
  fixed: number,
): Effect.Effect<string | undefined, never, MergeEnv> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const ledger = yield* Ledger
    const { id } = stop.ticket
    const most = config.settings.merge.check_hand_backs
    if (most === 0) return ""
    if (fixed >= most) return `it was handed back to its worker ${times(fixed)} already`
    if (stop.error._tag === "CheckTimedOut") {
      return "it did not finish, so there is no failure to show its worker"
    }
    if (stop.error._tag === "CheckNotRun") {
      return "it could not be run, so there is no failure to show its worker"
    }
    if (stop.at === "" || stop.head === "") return "git could not say what the check failed on"
    const noMore = options.noMore === undefined ? undefined : yield* options.noMore
    if (noMore !== undefined) return noMore
    const state = yield* ledger.current
    if (state.windDown !== null) return "the run is winding down"
    if (state.tickets.get(id)?.steered === true) return "you have steered its worker"
    return yield* workerAway(id)
  })

/** The most commits a check hand-back lists of those that landed on the base. */
export const maxLanded = 30

/**
 * What the worker is asked to do with the failure on its rebased branch, as orchestra asks it: what
 * failed, what the output says, and what the rebase brought in from the base (`landed`, newest
 * first; undefined when git couldn't list it).
 */
export const fixPrompt = (
  stop: CheckStop,
  base: string,
  check: string,
  landed: ReadonlyArray<Commit> | undefined,
): string => {
  const { id, branch } = stop.ticket
  const lines = saidOf(stop.error)
  const said =
    lines.length === 0
      ? "it printed nothing"
      : `${stop.error._tag !== "CheckNotRun" && stop.error.failingLines.length > 0 ? "these lines say what failed:" : "it ends:"}\n${lines.join("\n")}`
  const listed = (landed ?? []).map((commit) => `${commit.hash.slice(0, 7)} ${commit.subject}`)
  const shown =
    landed === undefined || listed.length === 0
      ? "(git could not list them)"
      : listed.length > maxLanded
        ? [...listed.slice(0, maxLanded), `… and ${listed.length - maxLanded} more`].join("\n")
        : listed.join("\n")
  return (
    `tutti: ${base} moved on while you worked, and ${branch} was rebased onto it; now ` +
    `${failedHow(stop.error)} on it. Its whole output is in ${stop.output}; ${said}\n\n` +
    `What landed on ${base} since your branch was cut (git log --oneline ` +
    `${stop.head.slice(0, 7)}..${stop.onto.slice(0, 7)}):\n${shown}\n\n` +
    `Fix ${branch} so that the check passes, keeping the intent of both your change and what ` +
    `landed on ${base}. Run '${check}' in the foreground until it passes, then commit the fix on ` +
    `${branch} with ${id} in the commit message. ` +
    "Don't do anything else: no rebase, no amending or rewriting of commits, no merge, no push, " +
    "no ticket changes, and no uncommitted changes left. Say DONE when the fix is committed."
  )
}

/**
 * Hands `stop`'s failure back: the ticket Merging, Resolving or Fixing → Fixing, its attempt
 * counted, and the FIXING line. False when the ledger refused (PHASE_BUG).
 */
export const handOverFix = (
  stop: CheckStop,
  options: MergeOptions,
  fixes: Fixes,
): Effect.Effect<boolean, never, MergeEnv> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const ledger = yield* Ledger
    const logs = yield* Log
    const events = yield* EventStream
    const { id } = stop.ticket
    const attempt = (yield* fixes.count(id)) + 1
    const moved = yield* ledger.transition(id, Cause.CheckHandedBack({ attempt }))
    if (Result.isFailure(moved)) return false
    yield* fixes.next(id)
    const text = fixing({
      id,
      base: options.base,
      failure: failedHow(stop.error),
      attempt,
      attempts: config.settings.merge.check_hand_backs,
      limit: formatDuration(config.settings.merge.resolve_timeout),
    })
    yield* events.emit({ kind: "info", ticket: id, text })
    yield* logs.write(text)
    return true
  })

/** What the worker left after a check hand-back: its fix, or why it is rejected. */
export type Verified =
  | { readonly _tag: "Fixed"; readonly commits: string }
  | { readonly _tag: "Rejected"; readonly why: string }

/**
 * Looks at what the worker left after `stop`'s failure was handed back, without taking its word for
 * it: no rebase in progress, the worktree clean and on its branch, and the branch at `stop.at` with
 * new commits on top, each naming the ticket. The check runs next on what the worktree has checked
 * out, and the merge then brings in the branch: they must be the same.
 */
export const verifyFixed = (
  stop: CheckStop,
  options: MergeOptions,
): Effect.Effect<Verified, never, MergeEnv> =>
  Effect.gen(function* () {
    const git = yield* Git
    const { id, branch, worktree } = stop.ticket
    const reject = (why: string) => ({ _tag: "Rejected", why }) satisfies Verified
    const read = yield* Effect.result(
      Effect.gen(function* () {
        if (yield* git.rebaseInProgress(worktree)) {
          return reject(line`its worker left a rebase in progress in ${worktree}`)
        }
        if (uncommitted(yield* git.status(worktree)).length > 0) {
          return reject(line`its worker left uncommitted changes in ${worktree}`)
        }
        const on = yield* offBranch(stop.ticket)
        if (on !== undefined)
          return reject(line`its worker left ${worktree} with ${on}, not ${branch}`)
        if ((yield* git.mergeBase(options.repo, stop.at, branch)) !== stop.at) {
          return reject(line`its worker rewrote the commits on ${branch} rather than add to them`)
        }
        const commits = yield* git.log(options.repo, stop.at, branch)
        if (commits.length === 0) return reject("its worker committed nothing")
        const other = commits.find((commit) => !namesTicket(commit.message, id))
        if (other !== undefined) {
          return reject(line`its worker's commit ${short(other.hash)} does not name ${id}`)
        }
        const n = commits.length
        return { _tag: "Fixed", commits: n === 1 ? "1 commit" : `${n} commits` } satisfies Verified
      }),
    )
    return Result.isSuccess(read)
      ? read.success
      : reject(line`git could not say what its worker committed: ${gitWhy(read.failure)}`)
  })

/**
 * Puts the branch back at `stop.at`, where its check failed, after a rejected fix: a rebase in
 * progress aborted, and the branch reset when it is elsewhere and the worktree is clean and on it.
 * What it did, as words to add to why the fix was rejected: "" when the branch is there already.
 */
export const undoFix = (stop: CheckStop): Effect.Effect<string, never, MergeEnv> =>
  Effect.gen(function* () {
    const git = yield* Git
    const { branch, worktree } = stop.ticket
    const to = stop.at
    const rebasing = yield* Effect.result(git.rebaseInProgress(worktree))
    if (Result.isFailure(rebasing) || rebasing.success) {
      const abort = yield* Effect.result(git.abortRebase(worktree))
      if (Result.isFailure(abort)) {
        return line`; its rebase could not be aborted, so ${worktree} is left mid-rebase`
      }
    }
    const status = yield* Effect.result(git.status(worktree))
    if (Result.isFailure(status) || uncommitted(status.success).length > 0) {
      return line`; ${worktree} is left as its worker left it`
    }
    const at = yield* Effect.result(git.revParse(worktree, branch))
    const now = Result.isSuccess(at) ? at.success : ""
    const on = yield* offBranch(stop.ticket)
    if (on !== undefined)
      return line`; ${branch} is left at ${short(now)}, as ${worktree} has ${on}`
    if (now === to) return ""
    const reset = yield* Effect.result(git.resetBranch(worktree, to))
    if (Result.isFailure(reset)) {
      return line`; ${branch} could not be reset to ${short(to)}, where the check failed, and is left at ${short(now)}`
    }
    return line`; ${branch} was reset to ${short(to)}, where the check failed (its worker's attempt is ${short(now)})`
  })

/** What came of the hand-backs, `tries` in turn, for a line or a note; `not`, why no more. */
const handedBack = (tries: ReadonlyArray<string>, not: string): string => {
  const each = tries.map((tried, i) => `(${i + 1}) ${tried}`).join("; ")
  const more = not === "" ? "" : `; not handed back again: ${not}`
  return `handed back to its worker to fix ${times(tries.length)}: ${each}${more}`
}

/**
 * Sets the ticket aside after its failure was handed back `tries.length` times, the last failure as
 * `stop` says and `not` saying why it went back no more: Fixing → Review with CHECKS_FAILED after a
 * clean rebase, Fixing{afterResolution} → Blocked with MERGE_CONFLICT after a resolution, its notes
 * saying what came of each attempt.
 */
const setAside = (
  stop: CheckStop,
  options: MergeOptions,
  memory: MergeMemory,
  tries: ReadonlyArray<string>,
  not: string,
) =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const { id, branch } = stop.ticket
    const { base } = options
    const tried = handedBack(tries, not)
    if (stop.resolved !== undefined) {
      const why = `${failedResolved(stop.resolved, stop.error, stop.output)}, and was ${tried}`
      return yield* rejectResolution(stop.resolved, options, why, "Aside")
    }
    yield* Effect.ignore(
      beads.update(id, {
        appendNotes: line`tutti: ${failedHow(stop.error)} on ${branch} rebased onto ${base} (output is in ${stop.output}); it was ${tried}; so ${id} was set aside for review.`,
      }),
    )
    yield* checksFailed(
      stop.ticket,
      options,
      memory.rechecks,
      stop.onto,
      stop.error,
      stop.output,
      `, after it was handed back to its worker to fix ${times(tries.length)} (see its notes)`,
    )
  })

/** The setup, if need be, and the check again on the fixed branch, in Fixing. */
const checkFix = (stop: CheckStop, options: MergeOptions, memory: MergeMemory) =>
  Effect.gen(function* () {
    const setup = yield* setUp(stop.ticket, options, memory.setUps, stop.fork, stop.onto, {
      what: "fix",
      from: stop.at,
    })
    if (setup._tag === "Failed") return setup
    return yield* runMergeCheck(stop.ticket)
  })

/** How a check hand-back ended: the fix verified and checked, or the ticket set aside. */
export type Fixed = "verified" | "aside"

/**
 * The hand-back of `stop`'s failure to the ticket's worker, its ticket Fixing already: the hand-back
 * given, what the worker left verified, set up and checked, and handed back again while the check
 * fails with attempts left. Verified: the caller puts it back in the merge queue. Else it is set
 * aside here, a rejected fix undone.
 */
export const fixCheck = (
  first: CheckStop,
  options: MergeOptions,
  memory: MergeMemory,
): Effect.Effect<Fixed, never, MergeEnv> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const git = yield* Git
    const logs = yield* Log
    const { id, branch } = first.ticket
    const check = config.settings.checks.fast.command ?? ""
    const limit = config.settings.merge.resolve_timeout
    const tries: Array<string> = []
    let stop = first
    for (;;) {
      const landed = yield* Effect.result(git.log(options.repo, stop.head, stop.onto))
      const prompt = fixPrompt(
        stop,
        options.base,
        check,
        Result.isSuccess(landed) ? landed.success : undefined,
      )
      const what = line`${id}'s failed check is handed back to its worker`
      const why = yield* give(stop.ticket, prompt, what, limit)
      const verified =
        why === undefined
          ? yield* verifyFixed(stop, options)
          : ({ _tag: "Rejected", why } satisfies Verified)
      if (verified._tag === "Rejected") {
        tries.push(`${verified.why}${yield* undoFix(stop)}`)
        yield* setAside(stop, options, memory, tries, "")
        return "aside"
      }
      const checked = yield* checkFix(stop, options, memory)
      if (checked._tag !== "Failed") {
        tries.push(`its worker committed ${verified.commits} and the check passes`)
        yield* logs.write(detail`'${check}' passes on ${branch} as its worker fixed it`)
        return "verified"
      }
      tries.push(
        line`its worker committed ${verified.commits}, but ${failedHow(checked.error)} still (output is in ${checked.output})`,
      )
      const at = yield* Effect.result(git.revParse(options.repo, branch))
      stop = {
        ...stop,
        at: Result.isSuccess(at) ? at.success : "",
        error: checked.error,
        output: checked.output,
      }
      const not = yield* whyNotFix(stop, options, yield* memory.fixes.count(id))
      if (not !== undefined) {
        yield* setAside(stop, options, memory, tries, not)
        return "aside"
      }
      if (!(yield* handOverFix(stop, options, memory.fixes))) return "aside"
    }
  })

/**
 * The resolution of `rebase`'s conflicts verified, but its check, or the setup before it, failing
 * (`error`, its output in `output`): handed back to the worker, Resolving → Fixing{afterResolution},
 * and the fix set up and checked as fixCheck does; or, when it can't be, the resolution rejected,
 * Blocked, the line saying why.
 */
export const fixResolution = (
  rebase: RebaseStop,
  error: CheckError,
  output: string,
  options: MergeOptions,
  memory: MergeMemory,
): Effect.Effect<Fixed, never, MergeEnv> =>
  Effect.gen(function* () {
    const git = yield* Git
    const at = yield* Effect.result(git.revParse(options.repo, rebase.ticket.branch))
    const stop: CheckStop = {
      ticket: rebase.ticket,
      onto: rebase.onto,
      fork: rebase.fork,
      head: rebase.head,
      at: Result.isSuccess(at) ? at.success : "",
      error,
      output,
      resolved: rebase,
    }
    const not = yield* whyNotFix(stop, options, yield* memory.fixes.count(rebase.ticket.id))
    if (not === undefined && (yield* handOverFix(stop, options, memory.fixes))) {
      return yield* fixCheck(stop, options, memory)
    }
    const why = failedResolved(rebase, error, output)
    const tail =
      not === undefined || not === "" ? "" : line`; not handed back to its worker: ${not}`
    yield* rejectResolution(rebase, options, `${why}${tail}`)
    return "aside"
  })
