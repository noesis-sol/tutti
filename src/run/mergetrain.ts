// The merge train (orchestra 0.8.6's train.go, with 0.9.0's blame): while the ticket whose turn it
// is in the merge queue is checked, the next in line, waiting for its first turn in its merge, is
// rebased onto that ticket's branch as it is checked, in its own worktree, and checked there beside
// it, outside the queue (merge.train of them, each on the branch of the one before it). Merges go one
// at a time, each holding the queue through its check, so without it the queue bounds how many
// tickets an hour merge.
//
// When the ticket ahead merges as it was checked, the next one's branch is on top of the base exactly
// as it was checked, and it merges in its turn with no second check (board). When it doesn't (its
// check failed, it went back to its worker, the base moved another way), the next one's branch is put
// back as its worker left it, and rebased and checked in its turn as any merge is; so is one whose
// check failed ahead of its turn, its turn saying which it was: a failure ahead of its turn says
// nothing of the ticket, and is neither handed back to its worker nor sets it aside. A branch that
// doesn't rebase cleanly onto the one ahead isn't checked ahead: its turn rebases it onto the base,
// handing back its conflict if it has one. The setup runs first when a dependency file changed, as
// before any merge check.
//
// Each check ahead competes with the workers' for the CPU, so none starts without a check command,
// nor while the run holds at the machine's cap on workers (HOLD: MACHINE), and a ticket put back in
// line after a hand-back to its worker, a recheck or a conflict you handed over is checked in its
// turn. Quitting, or the merges stopping, stops the trains and puts back the branches they rebased:
// the tickets are left waiting to merge, for the next run to merge as any other.
import { Effect, Exit, Fiber, FiberSet, Result, type Scope, Semaphore } from "effect"
import { AppConfig } from "../cli/AppConfig.ts"
import { Git } from "../services/Git.ts"
import { leaveForReview } from "./aside.ts"
import { checkOnce, clearUnchecked, failedHow } from "./check.ts"
import { RunFibers } from "./fibers.ts"
import { detail, type Line, Log, line, Tag, ticketLine } from "./log.ts"
import {
  abandonRebase,
  type CheckWatch,
  type FinishedTicket,
  gitWhy,
  type MergeEnv,
  type MergeMemory,
  type MergeOptions,
  offBranch,
  type Prepared,
  stopOver,
  uncommitted,
} from "./merge.ts"
import { setUp } from "./setup.ts"

/** A ticket checked ahead of its turn: where it was rebased, and how its check went. */
interface Run {
  readonly ticket: FinishedTicket
  /** The branch of the ticket ahead of it, which it was rebased onto. */
  readonly behind: string
  /** The commit it was rebased onto: `behind` as it is checked. */
  readonly onto: string
  fiber: Fiber.Fiber<void> | undefined
  /** Its branch's commit before the rebase, as its worker left it; "" until it is read. */
  orig: string
  /** Where its branch left the base before the rebase, for the setup. */
  fork: string
  /** Its branch's commit after the rebase; "" until it is rebased, or when it wasn't, or is back. */
  head: string
  /** The commit its check passed on; "" when it didn't, or hasn't yet. */
  passed: string
  /** It wasn't rebased, or its check failed or was stopped: none behind it starts. */
  failed: boolean
  /** The setup may have run in its worktree, on top of the branch ahead. */
  setUp: boolean
  /** What failed on it and how, and where the output is, when its check failed. */
  why: Line | ""
}

export interface MergeTrain extends CheckWatch {
  /** The ticket, in line for its first turn in its merge, may be checked ahead of its turn. */
  mayCheckAhead(ticket: FinishedTicket): Effect.Effect<void>
  /** Starts checking ahead of their turn the tickets the line allows now. */
  readonly start: Effect.Effect<void>
  /** The ticket whose turn it was is done with it: the next one's check is another. */
  readonly holderDone: Effect.Effect<void>
  /**
   * Takes the ticket's train as its turn comes, if it was checked ahead of it, waiting for its check
   * to end: undefined when its merge goes on, its branch on top of the base as checked (its pass
   * kept, so that it merges with no further check) or as its worker left it; Over when git could
   * not put it back, the ticket set aside, or can't say where its branch is, the merges stopped.
   * Interrupted while it waits, the train is stopped and the branch put back.
   */
  board(ticket: FinishedTicket): Effect.Effect<Prepared | undefined>
  /**
   * Stops every train, for good, and puts back the branches they rebased as their workers left
   * them: quitting, or the merges stopping, before their turns.
   */
  readonly leave: Effect.Effect<void>
}

/**
 * The merge queue's train: `waiting` is its line, next first; `machineFull`, whether the run holds
 * at the machine's cap on workers. A defect in a train goes to `guard`, naming where it came from.
 */
export const make = (
  options: MergeOptions & {
    readonly waiting: Effect.Effect<ReadonlyArray<string>>
    readonly machineFull?: Effect.Effect<boolean>
  },
  memory: MergeMemory,
  guard: (where: string, effect: Effect.Effect<void>) => Effect.Effect<void>,
): Effect.Effect<MergeTrain, never, MergeEnv | RunFibers | Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<MergeEnv>()
    const config = yield* AppConfig
    const git = yield* Git
    const log = yield* Log
    const { repo, base } = options
    const size = config.settings.merge.train
    const machineFull = options.machineFull ?? Effect.succeed(false)
    // The tickets waiting for their first turn, which may be checked ahead of it.
    const ahead = new Map<string, FinishedTicket>()
    // The tickets checked ahead of their turn.
    const runs = new Map<string, Run>()
    // The branch of the ticket whose turn it is, at the commit its check runs or passed on.
    let checking: { readonly branch: string; readonly at: string } | undefined
    // Set once the trains are left: none starts again.
    let stopped = false
    // Starting trains, and leaving them, one at a time.
    const lock = yield* Semaphore.make(1)
    const set = yield* (yield* RunFibers).make<void, never>("merge train")

    // Stops the train without waiting for it: its turn puts its branch back.
    const cancel = (run: Run) => Effect.sync(() => run.fiber?.interruptUnsafe())
    const cancelAll = Effect.suspend(() =>
      Effect.forEach([...runs.values()], cancel, { discard: true }),
    )

    // Rebases the ticket's branch onto run.onto in its worktree, as its turn would, and says whether
    // it is to be checked there: not when its worktree isn't ready for a rebase (its turn says why),
    // it doesn't rebase cleanly (the rebase is aborted), or its commits change nothing on top of the
    // branch ahead (it is put back, for its turn to close it as unchanged). Where git can't tell, it
    // is put back, or isn't rebased, and its turn asks again. Run with interruption off: once begun,
    // the rebase finishes, or is undone, and the branch's commits are known for its turn.
    const rebaseAhead = (run: Run) =>
      Effect.gen(function* () {
        const { id, branch, worktree } = run.ticket
        if ((yield* offBranch(run.ticket)) !== undefined) return false
        const status = yield* Effect.result(git.status(worktree))
        if (Result.isFailure(status) || uncommitted(status.success).length > 0) return false
        const before = yield* Effect.result(
          Effect.all({ orig: git.revParse(repo, branch), fork: git.mergeBase(repo, base, branch) }),
        )
        if (Result.isFailure(before)) return false
        run.orig = before.success.orig
        run.fork = before.success.fork
        const rebased = yield* Effect.result(git.rebase(worktree, run.onto))
        if (Result.isFailure(rebased)) {
          yield* abandonRebase(worktree)
          yield* log.write(
            detail`${branch} is not checked ahead of its turn: it does not rebase cleanly onto ${run.behind}`,
          )
          return false
        }
        const head = yield* Effect.result(git.revParse(repo, branch))
        if (Result.isFailure(head)) return false
        run.head = head.success
        const changed = yield* Effect.result(git.changedFiles(repo, run.onto, branch))
        if (Result.isSuccess(changed) && changed.success.length > 0) return true
        // Changing nothing on top of the branch ahead, or git can't tell: put back for its turn.
        const back = yield* Effect.result(git.resetBranch(worktree, run.orig))
        if (Result.isSuccess(back)) run.head = ""
        else yield* Effect.logDebug(`${id}: ${gitWhy(back.failure)}`)
        return false
      })

    // The trains behind the ticket in line are stopped: its own check failed ahead of its turn.
    const cancelBehind = (id: string) =>
      Effect.gen(function* () {
        const waiting = yield* options.waiting
        const at = waiting.indexOf(id)
        if (at < 0) return
        for (const behind of waiting.slice(at + 1)) {
          const run = runs.get(behind)
          if (run !== undefined) yield* cancel(run)
        }
      })

    // Rebases the ticket's branch onto run.onto and checks it there, the setup first when a
    // dependency file changed, as its turn would, and records how it went. A check that fails says
    // nothing of the ticket: it is checked again in its turn, on the base it merges onto.
    const runTrain = (run: Run) =>
      Effect.gen(function* () {
        const { branch } = run.ticket
        const rebased = yield* Effect.uninterruptible(rebaseAhead(run))
        if (!rebased) {
          run.failed = true
          return
        }
        yield* start
        yield* log.write(
          detail`checking ${branch} ahead of its turn to merge, rebased onto ${run.behind} as it is checked`,
        )
        run.setUp = true
        const setup = yield* setUp(
          run.ticket,
          options,
          memory.setUps,
          run.fork === "" ? run.onto : run.fork,
          run.onto,
          undefined,
          true,
        )
        if (setup._tag === "Unneeded") run.setUp = false
        const checked =
          setup._tag === "Failed"
            ? ({ _tag: "Failed", error: setup.error, output: setup.output } as const)
            : yield* checkOnce(run.ticket)
        if (checked._tag !== "Failed") {
          run.passed = run.head
          if (checked._tag === "Passed") {
            yield* log.write(
              detail`'${checked.command}' passes on ${branch} ahead of its turn, on top of ${run.behind}`,
            )
          }
          return
        }
        const where =
          checked.error._tag === "CheckNotRun" ? "" : line` (output is in ${checked.output})`
        run.failed = true
        run.why = line`${failedHow(checked.error)} on ${branch} on top of it${where}`
        yield* log.write(
          detail`${failedHow(checked.error)} on ${branch} ahead of its turn, on top of ${run.behind}${where}; it is checked again in its turn`,
        )
        yield* cancelBehind(run.ticket.id)
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            run.failed = true
          }),
        ),
      )

    // Starts checking ahead of their turn the first merge.train tickets in line that wait for their
    // first turn, each rebased onto the branch of the one ahead of it as that one is checked: the
    // branch whose turn it is, or the train's ahead of it once rebased. None starts while no turn's
    // check runs, nor once the trains are left or while the run holds at the machine's cap, and none
    // behind a ticket not checked ahead, or whose train failed.
    const start: Effect.Effect<void> = lock.withPermit(
      Effect.gen(function* () {
        if (stopped || size <= 0 || config.settings.checks.fast.command === null) return
        if (checking === undefined || (yield* machineFull)) return
        let { branch: behind, at: onto } = checking
        for (const id of (yield* options.waiting).slice(0, size)) {
          const ticket = ahead.get(id)
          if (ticket === undefined) break
          let run = runs.get(id)
          if (run === undefined) {
            const made: Run = {
              ticket,
              behind,
              onto,
              fiber: undefined,
              orig: "",
              fork: "",
              head: "",
              passed: "",
              failed: false,
              setUp: false,
              why: "",
            }
            runs.set(id, made)
            made.fiber = yield* FiberSet.run(
              set,
              guard(
                `${id}'s check ahead of its turn`,
                runTrain(made).pipe(Effect.provideContext(context)),
              ),
            )
            run = made
          }
          // On another commit than the one ahead as it is now, or not rebased onto it (yet).
          if (run.onto !== onto || run.head === "" || run.failed) break
          behind = ticket.branch
          onto = run.head
        }
      }),
    )

    // Puts the ticket's branch, at `head`, back as its worker left it when its train rebased it and
    // it hasn't moved since: whether it did, or git's error when it could not. Dependencies set up
    // on top of the branch ahead are set up again before its next check.
    const putBack = (run: Run, head: string) =>
      Effect.andThen(
        run.setUp
          ? memory.setUps.offBase(
              run.ticket.id,
              line`its dependencies were set up on top of ${run.behind}, ahead of its turn`,
            )
          : Effect.void,
        run.head === "" || head !== run.head
          ? Effect.succeed(false)
          : Effect.as(git.resetBranch(run.ticket.worktree, run.orig), true),
      )

    const watch: CheckWatch = {
      starts: (ticket, at) =>
        Effect.andThen(
          Effect.sync(() => {
            // The trains on another commit of its branch are stopped: it no longer merges so.
            const was = checking
            checking = { branch: ticket.branch, at }
            return was !== undefined && was.at !== at
          }),
          (moved) => Effect.andThen(moved ? cancelAll : Effect.void, start),
        ),
      // Those on top of a branch that fails are stopped; on one that passes, they go on.
      ends: (passed) =>
        passed
          ? Effect.void
          : Effect.andThen(
              Effect.sync(() => {
                checking = undefined
              }),
              cancelAll,
            ),
    }

    const leave: Effect.Effect<void> = lock
      .withPermit(
        Effect.gen(function* () {
          stopped = true
          checking = undefined
          const left = [...runs.values()]
          runs.clear()
          ahead.clear()
          for (const run of left) if (run.fiber !== undefined) yield* cancel(run)
          for (const run of left) {
            if (run.fiber !== undefined) yield* Fiber.await(run.fiber)
            const { id, branch, worktree } = run.ticket
            const at = yield* Effect.result(git.revParse(repo, branch))
            const back = Result.isSuccess(at)
              ? yield* Effect.result(putBack(run, at.success))
              : Result.fail(at.failure)
            if (Result.isSuccess(back)) {
              if (back.success) {
                yield* log.write(
                  detail`${branch} was rebased onto ${run.behind} to be checked ahead of its turn, but the run stopped before its turn: put back as its worker left it`,
                )
              }
              continue
            }
            yield* log.write(
              ticketLine(
                Tag.rebaseFailed,
              )`${id}: git could not put ${branch} back as its worker left it, at ${run.orig.slice(0, 7)}, after it was rebased onto ${run.behind} to be checked ahead of its turn: ${gitWhy(back.failure)}; check ${worktree} before it merges`,
            )
          }
        }),
      )
      .pipe(Effect.provideContext(context))

    // Put back on the run's end, should it come with trains under way.
    yield* Effect.addFinalizer(() => leave)

    const board = (ticket: FinishedTicket): Effect.Effect<Prepared | undefined> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const { id, branch, worktree } = ticket
          const run = runs.get(id)
          ahead.delete(id)
          if (run === undefined) return undefined
          runs.delete(id)
          // Where git can't say where the base is, the branch ahead is taken for one that didn't
          // merge.
          const merged = (at: Result.Result<string, unknown>) =>
            Result.isSuccess(at) && at.success === run.onto
          if (merged(yield* Effect.result(git.revParse(repo, base)))) {
            // While it is checked, the tickets behind it may be checked ahead on top of it, as on
            // the check of a ticket in its turn.
            if (run.head !== "" && !run.failed) {
              checking = { branch, at: run.head }
              yield* start
            }
          } else yield* cancel(run)
          const fiber = run.fiber as Fiber.Fiber<void>
          const waited = yield* Effect.exit(restore(Fiber.await(fiber)))
          const at = yield* Effect.result(git.revParse(repo, branch))
          if (Exit.isFailure(waited)) {
            // Quitting, before its turn's merge began: put back for the next run.
            yield* cancel(run)
            yield* Fiber.await(fiber)
            if (Result.isSuccess(at)) yield* Effect.ignore(putBack(run, at.success))
            return yield* Effect.interrupt
          }
          if (Result.isFailure(at)) {
            // The branch may have the commits of the branch ahead, which didn't merge.
            const stop = yield* stopOver(
              ticket,
              "GIT_FAILED",
              "git failed",
              line`could not tell where ${branch} is, after it was rebased to be checked ahead of its turn: ${gitWhy(at.failure)}; ${branch} is not merged, its worktree ${worktree} left for review`,
            )
            return { _tag: "Over", stop } satisfies Prepared
          }
          const now = merged(yield* Effect.result(git.revParse(repo, base)))
          if (run.passed !== "" && at.success === run.passed && now) {
            yield* memory.passes.set(id, run.passed)
            yield* clearUnchecked(id)
            yield* log.write(
              detail`${branch} was checked ahead of its turn on top of ${run.behind}, which merged as it was checked: merging it with no further check`,
            )
            return undefined
          }
          const back = yield* Effect.result(putBack(run, at.success))
          yield* watch.ends(false)
          if (Result.isFailure(back)) {
            yield* leaveForReview(id, {
              why: Tag.rebaseFailed,
              detail: "rebase failed",
              text: ticketLine(
                Tag.rebaseFailed,
              )`${id} closed, but git could not put ${branch} back as its worker left it, at ${run.orig.slice(0, 7)}, after it was rebased onto ${run.behind} to be checked ahead of its turn: ${gitWhy(back.failure)}; worktree ${worktree} left for review`,
            })
            return { _tag: "Over" } satisfies Prepared
          }
          if (!back.success) return undefined
          const which = !now
            ? "which did not merge as it was checked"
            : run.why !== ""
              ? line`which merged as it was checked, but ${run.why}`
              : "which merged as it was checked, but its check was stopped before it ended"
          yield* log.write(
            detail`${branch} was checked ahead of its turn on top of ${run.behind}, ${which}: put back as its worker left it`,
          )
          return undefined
        }),
      ).pipe(Effect.provideContext(context))

    return {
      ...watch,
      mayCheckAhead: (ticket) =>
        Effect.sync(() => {
          if (!stopped) ahead.set(ticket.id, ticket)
        }),
      start,
      holderDone: Effect.sync(() => {
        checking = undefined
      }),
      board,
      leave,
    } satisfies MergeTrain
  })
