// The check hand-back (§ 4.7, § 5 item 7's CHECKS_FAILED with hand-back, § 5.1's Merging → Fixing,
// Resolving → Fixing{afterResolution}, and Fixing → ToMerge, Fixing, Review, Blocked), as
// orchestra's checkback.go has it. A check that fails on a finished ticket's branch rebased onto
// the base, after a clean rebase or once its worker has resolved the rebase's conflicts, often
// fails where its change meets what landed meanwhile: a test another ticket added for the code as
// it was. A check that fails on a branch on top of the base already, as its worker left it, is
// handed back as well, its prompt saying only that the check fails before the branch merges. So the
// failure is handed back to the ticket's worker, which has the change in mind, when
// it can take it: hand-backs on (merge.check_hand_backs), attempts left of them, a failure to show
// it (the check finished), git able to say what the check failed on, the run neither holding nor winding down, and
// its worker Idle or Failed and not steered, or its session closed by tutti, which is resumed, or
// Gone with its ticket's one Gone resume of the run left, resumed too (handback.ts's give). A worker
// at the account's usage limit takes it too, though that limit holds the run: it is handed the
// failure once the limit lifts, as orchestra 0.8.0 has it.
//
// The hand-back is a client_composed message with orchestra's instructions: what failed, the lines
// that say so, what landed on the base since the branch was cut, and to commit a fix naming the
// ticket and nothing else. The ticket moves to Fixing{attempt, afterResolution} with the FIXING
// line, and the merge queue goes on with the tickets behind it meanwhile. Once the worker has
// settled, within resolve_timeout from the push, tutti looks at what it left without taking its
// word for it: no rebase in progress, the worktree clean and on its branch, and the branch as the
// check failed on it with new commits on top, each naming the ticket. When the base moved on
// meanwhile, the fix goes back in line unchecked, carried (Carried) to the merge's check on the
// branch rebased onto the base, which says whether it fixed it, so that a hand-back costs one
// check, as orchestra 0.8.5 has it. Else tutti sets it up and checks it again: a check that passes
// puts the ticket back in the merge queue, ToMerge; one that fails again is handed back again while
// attempts are left, Fixing again. A worker that finds nothing to fix (a test timing out on a
// loaded machine, say) commits nothing: the check then runs a second time, as orchestra's does, a
// pass putting the ticket back in the merge queue and a failure setting it aside with no further
// hand-back, as its worker found nothing to fix. Each pass through Merging counts toward the
// attempts, which a run keeps per ticket.
//
// A fix that can't be accepted is undone, the branch reset to where the check failed, and nothing
// more is handed back. Then, as when the attempts are used up, the ticket is set aside: Review with
// CHECKS_FAILED after a clean rebase (kept to be checked once more, recheck.ts), Blocked with
// MERGE_CONFLICT after a resolution (the branch put back as the ticket closed it), its line and
// notes saying what came of each attempt. A failure that can't be handed back is set aside at once,
// its line saying why.
import { Data, Effect, Ref, Result } from "effect"
import { AgentHost } from "../agent/AgentHost.ts"
import { AppConfig } from "../cli/AppConfig.ts"
import { formatDuration } from "../project/configFile.ts"
import { Beads } from "../services/Beads.ts"
import type { CheckError } from "../services/Checks.ts"
import { type Commit, Git, gitWhy, givenHash, shortHash } from "../services/Git.ts"
import { restoreBranch } from "./branch.ts"
import { failedHow, saidOf } from "./check.ts"
import {
  type Counts,
  carryIfBaseMoved,
  checkWithFix,
  failedResolved,
  give,
  leftClean,
  makeCounts,
  type RebaseStop,
  rejectResolution,
  workerAway,
} from "./handback.ts"
import { usageHolds } from "./holds.ts"
import { Ledger } from "./ledger.ts"
import { branchOn, detail, fixing, Log, line } from "./log.ts"
import {
  checksFailed,
  type FinishedTicket,
  type MergeEnv,
  type MergeMemory,
  type MergeOptions,
  type MergeTarget,
} from "./merge.ts"
import { Move } from "./phase.ts"
import { info } from "./say.ts"
import { namesTicket } from "./settle.ts"
import type { Fix } from "./setup.ts"

/**
 * A check that failed on a finished ticket's branch rebased onto the base, or on top of it already
 * (`onTop`), as the merge found it.
 */
export interface CheckStop {
  readonly ticket: FinishedTicket
  /** The base's commit the branch was rebased onto, or is on top of. */
  readonly onto: string
  /** Where the branch left the base before the rebase, for the setup (setup.ts); `onto` on top. */
  readonly fork: string
  /** The branch's commit before the rebase, its own on top; "" when git couldn't say. */
  readonly head: string
  /** The branch's commit the check failed on; "" when git couldn't say. */
  readonly at: string
  /** How the check, or the setup before it, failed. */
  readonly error: CheckError
  /** Where its whole output is. */
  readonly output: string
  /** The rebase its worker resolved, when the check failed on the resolution. */
  readonly resolved?: RebaseStop
  /** The branch was on top of the base already, as its worker left it, not rebased. */
  readonly onTop?: boolean
  /** What came of its earlier hand-backs in this merge, when a fix was carried to its check. */
  readonly tried?: ReadonlyArray<string>
}

/**
 * What a hand-back leaves for the merge's check when the base moved on while its worker worked, as
 * orchestra's fixes has it: the branch is rebased onto the base and checked once there, rather than
 * checked where it was, then rebased and checked again.
 */
export interface Carried {
  /** Its worker's fix or resolution, whose own changes to a setup file count before that check. */
  readonly fix?: Fix
  /**
   * What its worker left on its last check hand-back, not checked yet: the check says whether it
   * fixed it. Undefined after a resolution.
   */
  readonly fixed?: Left
  /** What came of the hand-backs before it, for the notes. */
  readonly tries: ReadonlyArray<string>
}

/**
 * A run's check hand-backs: how many times each ticket's failed check has been handed back to its
 * worker (Counts), and what each leaves for its merge's check.
 */
export interface Fixes extends Counts {
  /** Keeps what the ticket's hand-back leaves for its next merge's check, in place of any. */
  carry(id: string, carried: Carried): Effect.Effect<void>
  /** Takes what the ticket's hand-back left for its merge's check; undefined when nothing. */
  carried(id: string): Effect.Effect<Carried | undefined>
}

/** A run's check hand-backs: none yet. */
export const makeFixes: Effect.Effect<Fixes> = Effect.gen(function* () {
  const counts = yield* makeCounts
  const kept = yield* Ref.make<ReadonlyMap<string, Carried>>(new Map())
  return {
    ...counts,
    carry: (id, carried) => Ref.update(kept, (all) => new Map([...all, [id, carried]])),
    carried: (id) =>
      Ref.modify(kept, (all) => {
        const found = all.get(id)
        if (found === undefined) return [undefined, all]
        return [found, new Map([...all].filter(([each]) => each !== id))]
      }),
  } satisfies Fixes
})

/** How many times something was done, as in `twice`. */
export const times = (n: number): string => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`)

/** Whether the ticket's worker is at the account's usage limit. */
const atLimit = (id: string): Effect.Effect<boolean, never, AgentHost> =>
  Effect.gen(function* () {
    const state = yield* Effect.result((yield* AgentHost).current(id))
    return Result.isSuccess(state) && state.success._tag === "UsageLimited"
  })

/**
 * Why a failed check isn't handed back to the ticket's worker: check hand-backs are turned off,
 * which leaves nothing to say (Off), or as `why` says (Not).
 */
export type FixRefusal = Data.TaggedEnum<{
  Off: Record<never, never>
  Not: { readonly why: string }
}>

export const FixRefusal = Data.taggedEnum<FixRefusal>()

/** What `refusal` says of why its failure isn't handed back: nothing when hand-backs are off. */
export const refusalWhy = (refusal: FixRefusal): string | undefined =>
  FixRefusal.$match(refusal, { Off: () => undefined, Not: ({ why }) => why })

/**
 * Why `stop`'s failure can't be handed back to the ticket's worker, the `fixed`th time so far:
 * undefined when it can. While the run holds or winds down it takes on no more work, as
 * `options.noMore` says, but for a worker at the account's usage limit while that limit alone holds
 * the run: it is handed the failure once the limit lifts.
 */
export const whyNotFix = (
  stop: CheckStop,
  options: MergeOptions,
  fixed: number,
): Effect.Effect<FixRefusal | undefined, never, MergeEnv> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const ledger = yield* Ledger
    const { id } = stop.ticket
    const not = (why: string) => FixRefusal.Not({ why })
    const most = config.settings.merge.check_hand_backs
    if (most === 0) return FixRefusal.Off()
    if (fixed >= most) return not(`it was handed back to its worker ${times(fixed)} already`)
    if (stop.error._tag === "CheckTimedOut") {
      return not("it did not finish, so there is no failure to show its worker")
    }
    if (stop.error._tag === "CheckNotRun") {
      return not("it could not be run, so there is no failure to show its worker")
    }
    if (stop.at === "" || stop.head === "") return not("git could not say what the check failed on")
    const noMore = yield* options.noMore
    // A worker at the usage limit takes it once the limit lifts (handback.ts's give).
    if (noMore !== undefined && !(noMore === usageHolds && (yield* atLimit(id)))) {
      return not(noMore)
    }
    const state = yield* ledger.current
    if (state.windDown !== null) return not("the run is winding down")
    if (state.tickets.get(id)?.steered === true) return not("you have steered its worker")
    const away = yield* workerAway(id)
    return away === undefined ? undefined : not(away)
  })

/** The most commits a check hand-back lists of those that landed on the base. */
export const maxLanded = 30

/**
 * What the worker is asked to do with the failure on its rebased branch, as orchestra asks it: what
 * failed, what the output says, and what the rebase brought in from the base (`landed`, newest
 * first; undefined when git couldn't list it). On a branch on top of the base already, nothing
 * landed, and the prompt says only that the check fails before it merges.
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
  const listed = (landed ?? []).map((commit) => `${shortHash(commit.hash)} ${commit.subject}`)
  const shown =
    landed === undefined || listed.length === 0
      ? "(git could not list them)"
      : listed.length > maxLanded
        ? [...listed.slice(0, maxLanded), `… and ${listed.length - maxLanded} more`].join("\n")
        : listed.join("\n")
  // What failed and the tests of its change: the whole check is tutti's, run next (orchestra
  // 0.8.5).
  const steps =
    "Run what failed (the tests or other checks the output names) and the tests of the code you " +
    `changed in the foreground until they pass, then commit the fix on ${branch} with ${id} in ` +
    `the commit message. Leave the whole check, '${check}', to tutti: it runs it on the branch ` +
    "next. " +
    "Don't do anything else: no rebase, no amending or rewriting of commits, no merge, no push, " +
    "no ticket changes, and no uncommitted changes left. Say DONE when the fix is committed. " +
    `If what failed passes without a change, the failure not coming from ${branch}, commit ` +
    "nothing and say DONE: tutti runs the check again."
  if (stop.onTop === true) {
    return (
      `tutti: Before ${branch} merges into ${base}, ${failedHow(stop.error)} on it. ` +
      `Its whole output is in ${stop.output}; ${said}\n\n` +
      `Fix ${branch} so that the check passes. ${steps}`
    )
  }
  return (
    `tutti: ${base} moved on while you worked, and ${branch} was rebased onto it; now ` +
    `${failedHow(stop.error)} on it. Its whole output is in ${stop.output}; ${said}\n\n` +
    `What landed on ${base} since your branch was cut (git log --oneline ` +
    `${shortHash(stop.head)}..${shortHash(stop.onto)}):\n${shown}\n\n` +
    `Fix ${branch} so that the check passes, keeping the intent of both your change and what ` +
    `landed on ${base}. ${steps}`
  )
}

/**
 * Hands `stop`'s failure back: the ticket Merging, Resolving or Fixing → Fixing, its attempt
 * counted, and the FIXING line. False when the ledger refused (PHASE_BUG).
 */
export const handOverFix = (
  stop: CheckStop,
  options: MergeTarget,
  fixes: Fixes,
): Effect.Effect<boolean, never, MergeEnv> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const ledger = yield* Ledger
    const { id } = stop.ticket
    const attempt = (yield* fixes.count(id)) + 1
    const moved = yield* ledger.transition(id, Move.CheckHandedBack({ attempt }))
    if (Result.isFailure(moved)) return false
    yield* fixes.next(id)
    const text = fixing({
      id,
      base: options.base,
      failure: failedHow(stop.error),
      attempt,
      attempts: config.settings.merge.check_hand_backs,
      limit: formatDuration(config.settings.merge.resolve_timeout),
      onTop: stop.onTop === true,
    })
    yield* info(text, id)
    return true
  })

/**
 * What the worker left after a check hand-back: its fix, the branch as the check failed on it (it
 * found nothing to fix), or why it is rejected.
 */
export type Verified = Data.TaggedEnum<{
  Fixed: { readonly commits: string }
  Unchanged: Record<never, never>
  Rejected: { readonly why: string }
}>

export const Verified = Data.taggedEnum<Verified>()

/**
 * Looks at what the worker left after `stop`'s failure was handed back, without taking its word for
 * it: the worktree clean and on its branch (handback.ts's leftClean), and the branch at `stop.at`
 * with new commits on top, each naming the ticket, or with none (Unchanged).
 */
export const verifyFixed = (
  stop: CheckStop,
  options: MergeTarget,
): Effect.Effect<Verified, never, Git> =>
  Effect.gen(function* () {
    const git = yield* Git
    const { id, branch } = stop.ticket
    const reject = (why: string) => Verified.Rejected({ why })
    const read = yield* Effect.result(
      Effect.gen(function* () {
        const dirty = yield* leftClean(stop.ticket, "fixing")
        if (dirty !== undefined) return reject(dirty)
        if ((yield* git.mergeBase(options.repo, stop.at, branch)) !== stop.at) {
          return reject(line`its worker rewrote the commits on ${branch} rather than add to them`)
        }
        const commits = yield* git.log(options.repo, stop.at, branch)
        if (commits.length === 0) return Verified.Unchanged()
        const other = commits.find((commit) => !namesTicket(commit.message, id))
        if (other !== undefined) {
          return reject(line`its worker's commit ${givenHash(other.hash)} does not name ${id}`)
        }
        const n = commits.length
        return Verified.Fixed({ commits: n === 1 ? "1 commit" : `${n} commits` })
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
export const undoFix = (stop: CheckStop): Effect.Effect<string, never, Git> =>
  Effect.gen(function* () {
    const { branch, worktree } = stop.ticket
    const to = stop.at
    const restored = yield* restoreBranch(stop.ticket, to)
    switch (restored._tag) {
      case "AbortFailed":
        return line`; its rebase could not be aborted, so ${worktree} is left mid-rebase`
      case "AlreadyThere":
        return ""
      case "Dirty":
        return line`; ${worktree} is left as its worker left it`
      case "OffBranch":
        return line`; ${branch} is left at ${givenHash(restored.at)}, as ${worktree} has ${restored.on}`
      case "Unknown":
        return line`; ${branch} is left at ${givenHash(restored.at)}, as git could not tell what ${worktree} has checked out: ${gitWhy(restored.error)}`
      case "ResetFailed":
        return line`; ${branch} could not be reset to ${givenHash(to)}, where the check failed, and is left at ${givenHash(restored.at)}`
      case "Reset":
        return line`; ${branch} was reset to ${givenHash(to)}, where the check failed (its worker's attempt is ${givenHash(restored.from)})`
    }
  })

/** What came of the hand-backs, `tries` in turn, for a line or a note; `not`, why no more, if said. */
const handedBack = (tries: ReadonlyArray<string>, not?: string): string => {
  const each = tries.map((tried, i) => `(${i + 1}) ${tried}`).join("; ")
  const more = not === undefined ? "" : `; not handed back again: ${not}`
  return `handed back to its worker to fix ${times(tries.length)}: ${each}${more}`
}

/**
 * Sets the ticket aside after its failure was handed back `tries.length` times, the last failure as
 * `stop` says and `not` saying why it went back no more, unless the tries say it already: Fixing → Review with CHECKS_FAILED after a
 * clean rebase, or on a branch on top of the base already, Fixing{afterResolution} → Blocked with MERGE_CONFLICT after a resolution, its notes
 * saying what came of each attempt.
 */
export const setAside = (
  stop: CheckStop,
  options: MergeOptions,
  memory: MergeMemory,
  tries: ReadonlyArray<string>,
  not?: string,
) =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const { id, branch } = stop.ticket
    const { base } = options
    const tried = handedBack(tries, not)
    const onTop = stop.onTop === true
    if (stop.resolved !== undefined) {
      const why = `${failedResolved(stop.resolved, stop.error, stop.output)}, and was ${tried}`
      return yield* rejectResolution(stop.resolved, options, why, "Aside")
    }
    yield* Effect.ignore(
      beads.update(id, {
        appendNotes: line`tutti: ${failedHow(stop.error)} on ${branchOn(branch, base, onTop)} (output is in ${stop.output}); it was ${tried}; so ${id} was set aside for review.`,
      }),
    )
    yield* checksFailed(stop.ticket, options, memory.rechecks, {
      onto: stop.onto,
      error: stop.error,
      output: stop.output,
      tried: `, after it was handed back to its worker to fix ${times(tries.length)} (see its notes)`,
      onTop,
    })
  })

/**
 * How a check on what its worker left after a check hand-back ended: the fix verified and checked
 * (Verified), the ticket set aside (Aside), or the check failing on the fix, `stop`, to be handed
 * back again (Again).
 */
export type FixEnd = Data.TaggedEnum<{
  Verified: Record<never, never>
  Aside: Record<never, never>
  Again: { readonly stop: CheckStop }
}>

export const FixEnd = Data.taggedEnum<FixEnd>()

/** How a check hand-back ended: the fix verified and checked, or the ticket set aside. */
export type Fixed = Data.TaggedEnum.Value<FixEnd, "Verified" | "Aside">

/** What its worker left on a check hand-back that is to be checked: a fix, or nothing. */
export type Left = Data.TaggedEnum.Value<Verified, "Fixed" | "Unchanged">

/** What its worker left, `left`, in a few words: `1 commit`, or `nothing`. */
export const committed = (left: Left): string => (left._tag === "Fixed" ? left.commits : "nothing")

/** Says that the check passes on what its worker left after a check hand-back, `left`. */
export const fixPassed = (
  ticket: FinishedTicket,
  left: Left,
): Effect.Effect<void, never, AppConfig | Log> =>
  Effect.gen(function* () {
    const check = (yield* AppConfig).settings.checks.fast.command ?? ""
    const { branch } = ticket
    yield* (yield* Log).write(
      left._tag === "Unchanged"
        ? detail`'${check}' passes on ${branch} on a second run; its worker committed nothing`
        : detail`'${check}' passes on ${branch} as its worker fixed it`,
    )
  })

/**
 * What came of a check, or the setup before it, that failed (`error`, its output in `output`) on
 * what its worker left after `stop`'s failure was handed back, `left`, `tries` saying what came of
 * the hand-backs before it: Aside when its worker committed nothing, or no hand-back is left, the
 * ticket set aside; else Again, the failure on the fix, to be handed back again, its `tried` saying
 * what came of each hand-back so far. `at`: the commit checked, its branch's as the setup started
 * ("" when git couldn't say), where a failure stops.
 */
export const fixFailed = (
  stop: CheckStop,
  left: Left,
  error: CheckError,
  output: string,
  tries: ReadonlyArray<string>,
  options: MergeOptions,
  memory: MergeMemory,
  at: string,
): Effect.Effect<Data.TaggedEnum.Value<FixEnd, "Aside" | "Again">, never, MergeEnv> =>
  Effect.gen(function* () {
    const { id } = stop.ticket
    const how = failedHow(error)
    if (left._tag === "Unchanged") {
      const tried = [
        ...tries,
        line`its worker committed nothing, and ${how} again (output is in ${output})`,
      ]
      const again = { ...stop, error, output }
      yield* setAside(again, options, memory, tried, "its worker found nothing to fix")
      return FixEnd.Aside()
    }
    const tried = [
      ...tries,
      line`its worker committed ${left.commits}, but ${how} still (output is in ${output})`,
    ]
    const next: CheckStop = { ...stop, at, error, output, tried }
    const not = yield* whyNotFix(next, options, yield* memory.fixes.count(id))
    if (not === undefined) return FixEnd.Again({ stop: next })
    yield* setAside(next, options, memory, tried, refusalWhy(not))
    return FixEnd.Aside()
  })

/**
 * The hand-back of `stop`'s failure to the ticket's worker, its ticket Fixing already: the
 * hand-back given, what the worker left verified, set up and checked, and handed back again while
 * the check fails on its fix with attempts left. A worker that committed nothing has the check run
 * once more, and is handed nothing again. When the base moved on while its worker worked, what it
 * left isn't checked here: it is carried to the merge's check on the branch rebased onto the base
 * (the memory's fixes), so that a hand-back costs one check, as orchestra 0.8.5 has it. Verified:
 * the caller puts it back in the merge queue. Else it is set aside here, a rejected fix undone.
 */
export const fixCheck = (
  first: CheckStop,
  options: MergeOptions,
  memory: MergeMemory,
): Effect.Effect<Fixed, never, MergeEnv> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const git = yield* Git
    const { id } = first.ticket
    const check = config.settings.checks.fast.command ?? ""
    const limit = config.settings.merge.resolve_timeout
    let tries: ReadonlyArray<string> = first.tried ?? []
    let stop = first
    for (;;) {
      // Nothing landed under a branch on top of the base already.
      const landed =
        stop.onTop === true
          ? undefined
          : yield* Effect.result(git.log(options.repo, stop.head, stop.onto))
      const prompt = fixPrompt(
        stop,
        options.base,
        check,
        landed !== undefined && Result.isSuccess(landed) ? landed.success : undefined,
      )
      const what = line`${id}'s failed check is handed back to its worker`
      const fixed = Effect.map(verifyFixed(stop, options), (left) => left._tag === "Fixed")
      const why = yield* give(
        {
          ticket: stop.ticket,
          mode: "fixing",
          prompt,
          what,
          onto: stop.onto,
          to: stop.at,
          done: fixed,
        },
        limit,
        options,
      )
      const verified =
        why === undefined ? yield* verifyFixed(stop, options) : Verified.Rejected({ why })
      if (verified._tag === "Rejected") {
        yield* setAside(stop, options, memory, [...tries, `${verified.why}${yield* undoFix(stop)}`])
        return FixEnd.Aside()
      }
      const fix: Fix = { what: "fix", from: stop.at }
      const did = line`committed ${committed(verified)}`
      const rest = Effect.succeed({ fixed: verified, tries })
      if (yield* carryIfBaseMoved(stop, did, fix, rest, options, memory)) return FixEnd.Verified()
      const { at, checked } = yield* checkWithFix(stop, fix, options, memory)
      // Verified when it passes; else what came of the failure on what its worker left.
      if (checked._tag !== "Failed") {
        yield* fixPassed(stop.ticket, verified)
        return FixEnd.Verified()
      }
      const after = yield* fixFailed(
        stop,
        verified,
        checked.error,
        checked.output,
        tries,
        options,
        memory,
        at,
      )
      if (after._tag !== "Again") return after
      if (!(yield* handOverFix(after.stop, options, memory.fixes))) return FixEnd.Aside()
      stop = after.stop
      tries = after.stop.tried ?? []
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
  at: string,
  options: MergeOptions,
  memory: MergeMemory,
): Effect.Effect<Fixed, never, MergeEnv> =>
  Effect.gen(function* () {
    // A fix whose rebase onto the moved base stopped on the conflicts resolved here.
    const tries = (yield* memory.fixes.carried(rebase.ticket.id))?.tries ?? []
    const stop: CheckStop = {
      ticket: rebase.ticket,
      onto: rebase.onto,
      fork: rebase.fork,
      head: rebase.head,
      at,
      error,
      output,
      resolved: rebase,
      ...(tries.length === 0 ? {} : { tried: tries }),
    }
    const not = yield* whyNotFix(stop, options, yield* memory.fixes.count(rebase.ticket.id))
    if (not === undefined && (yield* handOverFix(stop, options, memory.fixes))) {
      return yield* fixCheck(stop, options, memory)
    }
    const why = failedResolved(rebase, error, output)
    const said = not === undefined ? undefined : refusalWhy(not)
    const tail = said === undefined ? "" : line`; not handed back to its worker: ${said}`
    const before = tries.length === 0 ? "" : `; before that, it was ${handedBack(tries)}`
    yield* rejectResolution(rebase, options, `${why}${tail}${before}`)
    return FixEnd.Aside()
  })
