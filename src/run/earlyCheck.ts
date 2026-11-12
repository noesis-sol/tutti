// The early check (§ 5 item 7): a finished ticket's merge check starts only once its worker has
// settled, but its worker's last call to the verifier starts a median 84 s before that, and almost
// never has a commit after it. So when a worker calls the verifier (its hooks show the call,
// AgentHost's verifierCalls) with its ticket Working, its worktree clean and its branch ahead of the
// base, tutti checks the branch's commit rebased onto the base's head in a checkout of its own, on no
// branch, as the full check runs (never in the worker's worktree, nor in the main checkout), the
// setup first, and keeps a pass by the rebased tree and the base's commit. At the ticket's turn, a
// rebase that gives the same tree on the same base merges with no second check (merge.ts's Check
// step), waiting for the early check if it still runs, a line saying what it waits for, until the
// check has run twice the longest of the last early checks that passed, or its own time limit
// where that is sooner, or before any passed (waitBound): one still running then is stuck, or far
// slower than a fresh check, so it is cancelled, a miss, and the merge runs its own. Cancelling one
// sooner, at an estimate of a fresh check's time, lost about 2,000 s in ten days (tutti-kazz):
// check times fall in two groups, so the estimate fell short of the check running, and the fresh
// check cost the estimate again after the early check had done most of its work. The base moved on
// since, or a different tree, takes the merge check as ever (a miss). Its setup's and check's time
// limits leave out the time the machine is loaded, as a merge check's do.
//
// The check slot: checks run side by side slow each other 1.1x-2.3x, so an early check starts only
// while no other check runs (a merge's, a train's, a fix's, the checks gate's, another early check),
// and each of those takes the slot as it starts (claim), cancelling an early check under way at
// once, its process group killed; a merge waits for its own ticket's early check instead. An early
// check is cancelled too when its ticket's branch moves on (a new commit; not its turn's rebase onto
// the same base, to the tree it checks), its worker calls the verifier again (that round starts
// another), its ticket leaves Working other than for the merge queue (deferred, blocked, set aside),
// or the run winds down, quits or comes to its full check. A failed early check is dropped: its
// worker isn't told (its verifier reports to it, and the merge check decides), and its output is
// kept as a failed check's is (keptChecks.ts), as early-<n>.log. A pass that left uncommitted
// changes to tracked files in its worktree, a pass on files that won't merge, is dropped too, its
// record failed and saying why; the merge check judges it as ever.
//
// Each is measured in early_check records, with a line in the log: started, cancelled (why), not run
// (why), passed, failed, and at its ticket's turn hit (and how long the turn waited for it) or miss
// (why). The figures' Checks line and the run report count the hits, the misses, the check-seconds
// the hits saved and those spent on early checks thrown away. merge.early_check false runs none, as
// does a run with no merge check (Checks' now, which a merge may change), and none starts while the
// machine's memory is pressed (pressureGate.ts).
import {
  Clock,
  Data,
  Deferred,
  Duration,
  Effect,
  Fiber,
  FiberSet,
  Ref,
  Result,
  type Scope,
  Semaphore,
  Stream,
} from "effect"
import { AgentHost } from "../agent/AgentHost.ts"
import { AppConfig } from "../core/AppConfig.ts"
import { type Line, Log, line, ticketLine } from "../core/log.ts"
import { formatDuration } from "../project/configFile.ts"
import type { TicketId } from "../services/Beads.ts"
import {
  type CheckError,
  Checks,
  checkLogName,
  checksNow,
  setupLogName,
} from "../services/Checks.ts"
import type { EventStream } from "../services/EventStream.ts"
import { tenths } from "../services/events.ts"
import { Git, gitWhy, type Sha, shortHash } from "../services/Git.ts"
import { trackedChanges } from "../services/gitStatus.ts"
import { Store } from "../services/Store.ts"
import { sleepAwake } from "../services/Wake.ts"
import { branchOf, Worktrees } from "../services/Worktrees.ts"
import {
  failedHow,
  flakyWarnings,
  loadedOf,
  outputKept,
  outputTo,
  recordedKeeping,
} from "./check.ts"
import { RunFibers } from "./fibers.ts"
import { leftWarning, removeLeftWorktrees, worktreeWhy } from "./fullcheck.ts"
import { Ledger } from "./ledger.ts"
import { say, warn } from "./say.ts"

/** How the early check's worktrees' folder names start, under the worktrees' folder. */
export const earlyFolderPrefix = "early-check-"

/** Whose worktrees they are, for a line. */
const whose = "an early check's"

/** How often an early check under way looks whether its ticket's branch has moved on. */
export const branchPoll = "5 seconds"

/** How many of the last early checks that passed bound the wait for one at its turn (waitBound). */
export const recentOf = 5

/** How many times the longest of the recent passes an early check may run before its turn gives it up. */
export const beyondLongest = 2

/** The phases a ticket keeps its early check in: Working, and on its way through the merge queue. */
const keptIn: ReadonlySet<string> = new Set(["Working", "ToMerge", "Merging"])

/** The tag the early check's lines start with, as `EARLY_CHECK: t-1: …`. */
export const earlyTag = "EARLY_CHECK"

/** A ticket's early check line: `  EARLY_CHECK: <id>: …`. */
const earlyLine = (id: TicketId, text: Line): Line => ticketLine(earlyTag)`${id}: ${text}`

/** A time to the second, for a line: `1m20s`, `0s`. */
const took = (seconds: number): string =>
  seconds < 1 ? "0s" : formatDuration(Duration.seconds(Math.floor(seconds)))

/** How long an early check may have run at its ticket's turn before the turn gives it up. */
export interface WaitBound {
  readonly seconds: number
  /** The bound in words, for the lines: `twice the longest of the last 3 passes (4m20s)`. */
  readonly why: string
}

/**
 * How long, in seconds, an early check may have run at its ticket's turn before the turn gives it
 * up: beyondLongest times the longest of `times`, the last early checks that passed, in seconds,
 * but no longer than `timeLimit`, the check's own time limit in seconds, which alone bounds it
 * before any passed. One still running then is stuck, or far slower than a fresh check would be.
 */
export const waitBound = (times: ReadonlyArray<number>, timeLimit: number): WaitBound => {
  const longest = times.length === 0 ? undefined : Math.max(...times)
  const beyond = longest === undefined ? undefined : longest * beyondLongest
  if (longest === undefined || beyond === undefined || beyond >= timeLimit) {
    return { seconds: timeLimit, why: `the check's time limit (${took(timeLimit)})` }
  }
  const of = times.length === 1 ? "the last pass" : `the last ${times.length} passes`
  return { seconds: beyond, why: `twice the longest of ${of} (${took(longest)})` }
}

/** How an early check ended. */
export type Ended = Data.TaggedEnum<{
  /** `seconds` from its start to its end. */
  Passed: { readonly seconds: number }
  Failed: { readonly seconds: number }
  Cancelled: { readonly why: string; readonly seconds: number }
  /** It couldn't be run: `why`. */
  NotRun: { readonly why: string }
}>

export const Ended = Data.taggedEnum<Ended>()

/** A ticket's early check: what it checks, and how it goes. */
interface Early {
  readonly ticket: TicketId
  readonly branch: string
  /** The branch's commit it checks, rebased onto `onto`. */
  readonly head: Sha
  /** The base's commit it rebases onto. */
  readonly onto: Sha
  /** The merge check it runs, as the run had it as it started (Checks' now). */
  readonly command: string
  /** The merge check's time limit, as the run had it as it started (Checks' now). */
  readonly timeLimit: Duration.Duration
  /** When it started, in epoch milliseconds. */
  readonly began: number
  /** Its rebased tree, once it is rebased; undefined when it never was. */
  readonly tree: Deferred.Deferred<Sha | undefined>
  readonly ended: Deferred.Deferred<Ended>
  /** Why it is cancelled, set before it is interrupted. */
  readonly why: Ref.Ref<string | undefined>
  /** Its fiber, set as it starts. */
  readonly fiber: Ref.Ref<Fiber.Fiber<void> | undefined>
}

/** The check slot and the early checks, as their decisions read and change them, one at a time. */
interface Slot {
  /** How many checks hold the slot: merges, trains, fixes, the checks gate. */
  readonly busy: number
  /** Set once no early check starts again: the run winds down, quits or ends. */
  readonly stopped: boolean
  /** Each ticket's early check, under way or ended, until its turn takes it or it is dropped. */
  readonly checks: ReadonlyMap<TicketId, Early>
}

/** The run's early checks (earlyCheck.ts), as the merges and the run use them. */
export interface EarlyChecks {
  /** `ticket`'s worker called the verifier: an early check of its branch starts, if it may. */
  called(ticket: TicketId): Effect.Effect<void>
  /**
   * Runs `work`, a check `what` names (`tutti/a's merge check`), holding the check slot: every early
   * check under way is cancelled as it starts, but `own`'s, which its merge waits for, and none
   * starts until it ends.
   */
  claim<A, E, R>(what: string, work: Effect.Effect<A, E, R>, own?: TicketId): Effect.Effect<A, E, R>
  /**
   * At the ticket's turn, its branch at `tree` on the base at `onto`: true when its early check
   * passed on the same tree on the same base, waited for if it still runs (a hit); false when it
   * has none, or it doesn't match or didn't pass (a miss). Either way the turn takes it.
   */
  passed(ticket: TicketId, tree: Sha | undefined, onto: Sha): Effect.Effect<boolean>
  /** The ticket's turn is over: an early check of it the turn didn't take is dropped, a miss. */
  over(ticket: TicketId): Effect.Effect<void>
  /** Cancels every early check under way, `why`, and starts none from now on. */
  stop(why: string): Effect.Effect<void>
}

/** A run with no early checks: merge.early_check false. */
export const noEarlyChecks: EarlyChecks = {
  called: () => Effect.void,
  claim: (_what, work) => work,
  passed: () => Effect.succeed(false),
  over: () => Effect.void,
  stop: () => Effect.void,
}

/** `work`, holding the check slot of `early` where the run has early checks (claim). */
export const holdingSlot = <A, E, R>(
  early: EarlyChecks | undefined,
  what: string,
  work: Effect.Effect<A, E, R>,
  own?: TicketId,
): Effect.Effect<A, E, R> => (early === undefined ? work : early.claim(what, work, own))

/** What the early checks are given by the run. */
export interface EarlyOptions {
  /** The main checkout. */
  readonly repo: string
  /** The branch the run merges into. */
  readonly base: string
  /** The setup command as the run has it now, a merge's settings taken (setup.ts). */
  readonly setup: Effect.Effect<string | null>
  /**
   * Whether the machine's memory is pressed now (pressureGate.ts): no early check starts meanwhile,
   * as one is optional. Never without it.
   */
  readonly held?: Effect.Effect<boolean>
  /**
   * Whether the machine is loaded now: the time it is doesn't count toward an early check's time
   * limit, up to the limit again, as a merge check's (Checks' RunOptions). Never without it.
   */
  readonly loaded?: Effect.Effect<boolean>
}

type Env =
  | AppConfig
  | AgentHost
  | Checks
  | Git
  | Worktrees
  | Store
  | Ledger
  | Log
  | EventStream
  | RunFibers

/**
 * The run's early checks: none with merge.early_check false. It removes the early checks'
 * worktrees a killed run left, starts one on each call to the verifier that may have one, while
 * the run has a merge check (Checks' now: a merge may set one, or take it away), and cancels those whose tickets leave Working, or all of them as the run winds down.
 */
export const make = (options: EarlyOptions): Effect.Effect<EarlyChecks, never, Env | Scope.Scope> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    if (!config.settings.merge.early_check) return noEarlyChecks
    const held = options.held ?? Effect.succeed(false)
    yield* removeLeftWorktrees(earlyFolderPrefix, whose)
    const context = yield* Effect.context<Env>()
    const logs = yield* Log
    const git = yield* Git
    const worktrees = yield* Worktrees
    const ledger = yield* Ledger
    const host = yield* AgentHost
    const fibers = yield* RunFibers
    const { repo, base } = options
    const slot = yield* Ref.make<Slot>({ busy: 0, stopped: false, checks: new Map() })
    // The slot's decisions, one at a time; no early check's own fiber takes it, so a decision may
    // wait for one it cancels.
    const lock = yield* Semaphore.make(1)
    // How long, in seconds, each of the last recentOf early checks that passed took.
    const passTimes = yield* Ref.make<ReadonlyArray<number>>([])
    const runs = yield* fibers.make<void, never>("early checks")
    const cleanups = yield* fibers.make<void, never>("early checks' worktrees")

    const running = (early: Early) => Effect.map(Deferred.isDone(early.ended), (done) => !done)

    // Cancels it, `why`, waiting until it has ended (its process group killed); nothing once ended.
    const cancel = (early: Early, why: string) =>
      Effect.gen(function* () {
        if (!(yield* running(early))) return
        yield* Ref.update(early.why, (was) => was ?? why)
        const fiber = yield* Ref.get(early.fiber)
        if (fiber !== undefined) yield* Fiber.interrupt(fiber)
      })

    // Takes the ticket's early check out of the slot, the one given or any.
    const take = (id: TicketId, only?: Early) =>
      Ref.modify(slot, (now): [Early | undefined, Slot] => {
        const early = now.checks.get(id)
        if (early === undefined || (only !== undefined && early !== only)) return [undefined, now]
        const checks = new Map(now.checks)
        checks.delete(id)
        return [early, { ...now, checks }]
      })

    // Removes its worktree in the background, so that a check taking the slot doesn't wait on it.
    const removeLater = (path: string) =>
      Effect.asVoid(
        FiberSet.run(
          cleanups,
          Effect.uninterruptible(
            Effect.catch(worktrees.removeDetached(path), (error) =>
              leftWarning(path, error, whose),
            ).pipe(Effect.provideContext(context)),
          ),
        ),
      )

    // Its rebase and check in its own worktree, with how it ended.
    const inside = (early: Early, path: string) =>
      Effect.gen(function* () {
        const { ticket: id } = early
        const checks = yield* Checks
        const seconds = Effect.map(Clock.currentTimeMillis, (now) => tenths(now - early.began))
        const fork = yield* Effect.result(git.mergeBase(repo, early.onto, early.head))
        if (Result.isFailure(fork) || fork.success !== early.onto) {
          const rebased = yield* Effect.result(git.rebase(path, early.onto))
          if (Result.isFailure(rebased)) {
            const error = rebased.failure
            return Ended.NotRun({
              why:
                error._tag === "RebaseConflict"
                  ? line`${early.branch} does not rebase cleanly onto ${base}`
                  : line`git could not rebase ${early.branch} onto ${base}: ${gitWhy(error)}`,
            })
          }
        }
        const tree = yield* Effect.result(git.revParse(path, "HEAD^{tree}"))
        if (Result.isFailure(tree)) {
          return Ended.NotRun({
            why: line`git could not read the rebased tree: ${gitWhy(tree.failure)}`,
          })
        }
        yield* Deferred.succeed(early.tree, tree.success)
        const setup = yield* options.setup
        if (setup !== null) {
          const set = yield* Effect.scoped(
            Effect.flatMap(outputTo({ id, worktree: path }, setupLogName, whose), (to) =>
              Effect.map(
                recordedKeeping(
                  "setup",
                  id,
                  checks.setup({
                    cwd: path,
                    ...to,
                    before: "fast",
                    command: setup,
                    ...loadedOf(options.loaded),
                  }),
                  { early: true, keep: { worktree: path, name: setupLogName } },
                ),
                (ran) => ({ ...ran, output: to.outputFile }),
              ),
            ),
          )
          if (Result.isFailure(set.ran)) {
            return yield* failed(early, set.ran.failure, outputKept(set), seconds)
          }
        }
        const checked = yield* Effect.scoped(
          Effect.flatMap(outputTo({ id, worktree: path }, checkLogName, whose), (to) =>
            Effect.map(
              recordedKeeping(
                "early",
                id,
                checks.fast({
                  cwd: path,
                  ...to,
                  command: early.command,
                  ...loadedOf(options.loaded),
                }),
                {
                  keep: { worktree: path, name: checkLogName },
                },
              ),
              (ran) => ({ ...ran, output: to.outputFile }),
            ),
          ),
        )
        if (Result.isFailure(checked.ran)) {
          return yield* failed(early, checked.ran.failure, outputKept(checked), seconds)
        }
        // A pass on tracked files the setup or check changed is a pass on what won't merge: the
        // merge check decides, and sets the ticket aside if it does the same (DIRTY_WORKTREE).
        const after = yield* Effect.result(git.status(path))
        const changed = Result.isSuccess(after) ? trackedChanges(after.success) : []
        if (Result.isFailure(after) || changed.length > 0) {
          const why = Result.isFailure(after)
            ? line`git could not read its worktree after its check: ${gitWhy(after.failure)}`
            : line`its setup or check left uncommitted changes to ${changed}, which would not merge`
          const ended = Ended.Failed({ seconds: yield* seconds })
          yield* say({
            kind: "early_check",
            ticket: id,
            detail: "failed",
            why,
            base: early.onto,
            seconds: ended.seconds,
            text: earlyLine(
              id,
              line`'${early.command}' passes on ${early.branch} rebased onto ${base}, but ${why}; dropped, its merge check decides`,
            ),
          })
          return ended
        }
        const result = checked.ran.success
        if (result._tag === "CheckPassed") {
          for (const warning of flakyWarnings(
            line`${id}'s early check '${early.command}'`,
            result,
          )) {
            yield* warn(warning, id)
          }
        }
        const ended = Ended.Passed({ seconds: yield* seconds })
        yield* say({
          kind: "early_check",
          ticket: id,
          detail: "passed",
          base: early.onto,
          tree: tree.success,
          seconds: ended.seconds,
          text: earlyLine(
            id,
            line`'${early.command}' passes on ${early.branch} rebased onto ${base} (${took(ended.seconds)}): its turn merges it with no second check if neither moves on`,
          ),
        })
        return ended
      })

    // A failed early check, dropped: its worker isn't told, and its merge check decides.
    const failed = (
      early: Early,
      error: CheckError,
      output: string,
      seconds: Effect.Effect<number>,
    ) =>
      Effect.gen(function* () {
        const ended = Ended.Failed({ seconds: yield* seconds })
        const where = error._tag === "CheckNotRun" ? "" : line` (output is in ${output})`
        yield* say({
          kind: "early_check",
          ticket: early.ticket,
          detail: "failed",
          base: early.onto,
          seconds: ended.seconds,
          ...(where === "" ? {} : { output }),
          text: earlyLine(
            early.ticket,
            line`${failedHow(error)} on ${early.branch} rebased onto ${base}${where}; dropped, its merge check decides`,
          ),
        })
        return ended
      })

    // Whether `commit` is what it checks: its rebased tree, on top of the base's commit it rebased
    // onto, as the ticket's turn rebases the branch before it asks for the early check (passed).
    const checksAt = (early: Early, commit: Sha) =>
      Effect.gen(function* () {
        const tree = yield* Deferred.await(early.tree)
        if (tree === undefined) return false
        const read = yield* Effect.result(
          Effect.all(
            {
              tree: git.revParse(repo, `${commit}^{tree}`),
              fork: git.mergeBase(repo, early.onto, commit),
            },
            { concurrency: "unbounded" },
          ),
        )
        return (
          Result.isSuccess(read) && read.success.tree === tree && read.success.fork === early.onto
        )
      })

    // Looks every branchPoll whether the branch has moved on from what it checks: its cancellation.
    const watch = (early: Early) =>
      Effect.gen(function* () {
        let head = early.head
        for (;;) {
          yield* Effect.sleep(branchPoll)
          const now = yield* Effect.result(git.revParse(repo, early.branch))
          if (Result.isFailure(now) || now.success === head) continue
          if (!(yield* checksAt(early, now.success))) {
            return yield* cancelled(
              early,
              line`${early.branch} moved on to ${shortHash(now.success)}`,
            )
          }
          head = now.success
        }
      })

    // Says it was cancelled, `why`.
    const cancelled = (early: Early, why: string) =>
      Effect.gen(function* () {
        const seconds = tenths((yield* Clock.currentTimeMillis) - early.began)
        yield* say({
          kind: "early_check",
          ticket: early.ticket,
          detail: "cancelled",
          why,
          base: early.onto,
          seconds,
          text: earlyLine(early.ticket, line`cancelled after ${took(seconds)}: ${why}`),
        })
        return Ended.Cancelled({ why, seconds })
      })

    // The early check's fiber: its worktree made, rebased and checked, raced by the branch's watch,
    // and removed in the background; how it ended kept, whichever way it ends.
    const runEarly = (early: Early) =>
      Effect.gen(function* () {
        yield* say({
          kind: "early_check",
          ticket: early.ticket,
          detail: "started",
          base: early.onto,
          text: earlyLine(
            early.ticket,
            line`checking ${early.branch} at ${shortHash(early.head)} rebased onto ${base} at ${shortHash(early.onto)}, in a worktree of its own, while its worker's verifier runs`,
          ),
        })
        const made = yield* Effect.result(
          Effect.uninterruptible(worktrees.addDetached(earlyFolderPrefix, early.head)),
        )
        const ended = Result.isFailure(made)
          ? Ended.NotRun({
              why:
                made.failure._tag === "ExcludeUnwritable"
                  ? made.failure.message
                  : line`no worktree for it (${worktreeWhy(made.failure)})`,
            })
          : yield* Effect.raceFirst(inside(early, made.success), watch(early)).pipe(
              Effect.ensuring(removeLater(made.success)),
            )
        if (ended._tag === "NotRun") {
          yield* say({
            kind: "early_check",
            ticket: early.ticket,
            detail: "not run",
            why: ended.why,
            base: early.onto,
            text: earlyLine(early.ticket, line`not run: ${ended.why}`),
          })
        }
        if (ended._tag === "Passed") {
          yield* Ref.update(passTimes, (all) => [...all, ended.seconds].slice(-recentOf))
        }
        yield* Deferred.succeed(early.ended, ended)
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            const why = (yield* Ref.get(early.why)) ?? "the run ended"
            const ended = yield* cancelled(early, why)
            yield* Deferred.succeed(early.ended, ended)
          }),
        ),
        Effect.ensuring(Deferred.succeed(early.tree, undefined)),
        Effect.provideContext(context),
      )

    // Starts the ticket's early check of `head` on `onto` where the slot is free; false where not.
    const start = (
      id: TicketId,
      branch: string,
      head: Sha,
      onto: Sha,
      check: { readonly command: string; readonly timeLimit: Duration.Duration },
    ) =>
      lock.withPermit(
        Effect.gen(function* () {
          const now = yield* Ref.get(slot)
          if (now.stopped || now.busy > 0) return false
          for (const each of now.checks.values()) if (yield* running(each)) return false
          const early: Early = {
            ticket: id,
            branch,
            head,
            onto,
            command: check.command,
            timeLimit: check.timeLimit,
            began: yield* Clock.currentTimeMillis,
            tree: yield* Deferred.make<Sha | undefined>(),
            ended: yield* Deferred.make<Ended>(),
            why: yield* Ref.make<string | undefined>(undefined),
            fiber: yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined),
          }
          yield* Ref.update(slot, (was) => ({
            ...was,
            checks: new Map(was.checks).set(id, early),
          }))
          yield* Ref.set(early.fiber, yield* FiberSet.run(runs, runEarly(early)))
          return true
        }),
      )

    // Whether the ticket's ended early check passed on `head` on `onto` already: none starts again.
    const passedOn = (id: TicketId, head: Sha, onto: Sha) =>
      Effect.gen(function* () {
        const early = (yield* Ref.get(slot)).checks.get(id)
        if (early === undefined || early.head !== head || early.onto !== onto) return false
        if (!(yield* Deferred.isDone(early.ended))) return false
        return (yield* Deferred.await(early.ended))._tag === "Passed"
      })

    const called: EarlyChecks["called"] = (id) =>
      Effect.gen(function* () {
        const ticket = (yield* ledger.current).tickets.get(id)
        if (ticket?.phase._tag !== "Working" || (yield* Ref.get(slot)).stopped) return
        const { command, timeout: timeLimit } = (yield* checksNow).fast
        if (command === null) return
        // Its next round: the one under way checks what the worker may be changing.
        yield* lock.withPermit(
          Effect.gen(function* () {
            const early = (yield* Ref.get(slot)).checks.get(id)
            if (early === undefined || !(yield* running(early))) return
            yield* cancel(early, "its worker called the verifier again")
            yield* take(id, early)
          }),
        )
        const record = yield* (yield* Store).ticket(id)
        const worktree = record?.worktree
        if (worktree === undefined) return
        const branch = record?.branch ?? branchOf(id)
        const read = yield* Effect.result(
          Effect.all(
            {
              status: git.status(worktree),
              ahead: git.log(repo, base, branch),
              head: git.revParse(repo, branch),
              onto: git.revParse(repo, base),
            },
            { concurrency: "unbounded" },
          ),
        )
        if (Result.isFailure(read)) {
          return yield* Effect.logDebug(`${id}: no early check: ${gitWhy(read.failure)}`)
        }
        const { status, ahead, head, onto } = read.success
        // Its uncommitted changes wouldn't merge; a branch with no commits merges nothing.
        if (trackedChanges(status).length > 0 || ahead.length === 0) return
        if (yield* passedOn(id, head, onto)) return
        if (yield* held) {
          return yield* Effect.logDebug(`${id}: no early check: the machine's memory is pressed`)
        }
        const started = yield* start(id, branch, head, onto, { command, timeLimit })
        if (!started) yield* Effect.logDebug(`${id}: no early check: the check slot is taken`)
      }).pipe(Effect.provideContext(context))

    const claim: EarlyChecks["claim"] = (what, work, own) =>
      Effect.acquireUseRelease(
        lock.withPermit(
          Effect.gen(function* () {
            const now = yield* Ref.updateAndGet(slot, (was) => ({ ...was, busy: was.busy + 1 }))
            for (const early of now.checks.values()) {
              if (early.ticket !== own) yield* cancel(early, line`${what} took the check slot`)
            }
          }),
        ),
        () => work,
        () => Ref.update(slot, (was) => ({ ...was, busy: was.busy - 1 })),
      )

    // A miss at the ticket's turn: its early check isn't used, `why`.
    const miss = (early: Early, why: string) =>
      say({
        kind: "early_check",
        ticket: early.ticket,
        detail: "miss",
        why,
        base: early.onto,
        text: earlyLine(early.ticket, line`not used: ${why}`),
      })

    // Why an early check that ended other than passing isn't used.
    const unpassed = (ended: Ended): string => {
      switch (ended._tag) {
        case "Passed":
          return ""
        case "Failed":
          return "it failed"
        case "Cancelled":
          return line`it was cancelled (${ended.why})`
        case "NotRun":
          return line`it did not run (${ended.why})`
      }
    }

    const passed: EarlyChecks["passed"] = (id, tree, onto) =>
      Effect.gen(function* () {
        const early = yield* take(id)
        if (early === undefined) return false
        if (early.onto !== onto) {
          const why = line`${base} moved on to ${shortHash(onto)} since it was checked at ${shortHash(early.onto)}`
          yield* cancel(early, why)
          yield* miss(early, why)
          return false
        }
        const checked = yield* Deferred.await(early.tree)
        if (checked === undefined || checked !== tree) {
          if (checked === undefined) {
            yield* miss(early, unpassed(yield* Deferred.await(early.ended)))
            return false
          }
          const why =
            tree === undefined
              ? "git could not read the tree its turn rebased"
              : line`${early.branch} rebased in its turn has another tree than it checked`
          yield* cancel(early, why)
          yield* miss(early, why)
          return false
        }
        const waiting = yield* Clock.currentTimeMillis
        // Waited for until it has run the bound (waitBound): one still running then is stuck, or
        // far slower than a fresh check would be; cancelling one sooner only costs the check again.
        const bound = waitBound(yield* Ref.get(passTimes), Duration.toSeconds(early.timeLimit))
        const ended = yield* Effect.gen(function* () {
          if (!(yield* running(early))) return yield* Deferred.await(early.ended)
          const ran = tenths(waiting - early.began)
          const left = bound.seconds - ran
          if (left <= 0) return undefined
          yield* logs.write(
            earlyLine(
              id,
              line`still running after ${took(ran)}: its turn waits up to ${took(left)} more for it, until it has run ${bound.why}`,
            ),
          )
          return yield* Effect.raceFirst(
            Deferred.await(early.ended),
            Effect.as(sleepAwake(Duration.seconds(left)), undefined),
          )
        })
        if (ended === undefined) {
          const ran = tenths((yield* Clock.currentTimeMillis) - early.began)
          const why = line`it still ran after ${took(ran)}, ${bound.why}`
          yield* cancel(early, why)
          yield* miss(early, why)
          return false
        }
        const waited = tenths((yield* Clock.currentTimeMillis) - waiting)
        if (ended._tag !== "Passed") {
          yield* miss(early, unpassed(ended))
          return false
        }
        const after = waited > 0 ? line`, after waiting ${took(waited)} for it to end` : ""
        yield* say({
          kind: "early_check",
          ticket: id,
          detail: "hit",
          base: onto,
          tree: checked,
          seconds: ended.seconds,
          waited,
          text: earlyLine(
            id,
            line`passed on the same tree on ${base} at ${shortHash(onto)}${after}: ${early.branch} merges with no second check`,
          ),
        })
        return true
      }).pipe(Effect.provideContext(context))

    const over: EarlyChecks["over"] = (id) =>
      Effect.gen(function* () {
        const early = yield* take(id)
        if (early === undefined) return
        const why = "its turn did not check it"
        yield* cancel(early, why)
        yield* miss(early, why)
      }).pipe(Effect.provideContext(context))

    const stop: EarlyChecks["stop"] = (why) =>
      lock.withPermit(
        Effect.gen(function* () {
          const now = yield* Ref.updateAndGet(slot, (was) => ({ ...was, stopped: true }))
          for (const early of now.checks.values()) yield* cancel(early, why)
        }),
      )

    // Each call to the verifier may start one; a ticket that leaves Working other than for the
    // merge queue drops its own, and the run winding down cancels them all.
    const watching = yield* fibers.make<void, never>("early checks' watchers")
    yield* FiberSet.run(
      watching,
      Stream.runForEach(host.verifierCalls, (call) => called(call.ticket)),
    )
    yield* FiberSet.run(
      watching,
      Stream.runForEach(ledger.changes, (state) =>
        Effect.gen(function* () {
          if (state.windDown !== null && !(yield* Ref.get(slot)).stopped) {
            yield* stop("the run is winding down")
          }
          for (const [id, early] of (yield* Ref.get(slot)).checks) {
            const phase = state.tickets.get(id)?.phase._tag
            if (phase !== undefined && keptIn.has(phase)) continue
            yield* lock.withPermit(cancel(early, line`${id} left Working (${phase ?? "gone"})`))
            yield* take(id, early)
          }
        }),
      ),
    )
    // The run's end cancels what still runs, before its fibers are interrupted.
    yield* Effect.addFinalizer(() => stop("the run ended"))
    return { called, claim, passed, over, stop } satisfies EarlyChecks
  })
