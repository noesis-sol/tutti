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
//
// A run killed outright (SIGKILL, a crash, a power cut) puts nothing back, and a branch it left
// rebased onto the branch ahead would merge with that branch's commits. So before a train rebases
// a branch, the ticket is marked in state.json (`checked_ahead`) with the branch's commit as its
// worker left it, and then with the commit it was rebased to; boarding the train or putting the
// branch back clears the mark. As the next run starts (putBackLeft), a branch still marked and at
// the commit it was rebased to is put back as its worker left it. One git could not put back, on a
// quit or as the run starts, keeps its mark, and its turn sets it aside (merge.ts's prepare).
import {
  Data,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Option,
  Ref,
  Result,
  type Scope,
  Semaphore,
  type Stream,
  SubscriptionRef,
} from "effect"
import { AppConfig } from "../cli/AppConfig.ts"
import { Git, gitWhy, shortHash } from "../services/Git.ts"
import { trackedChanges } from "../services/gitStatus.ts"
import { Store } from "../services/Store.ts"
import { branchOf } from "../services/Worktrees.ts"
import { aheadKey, clearAhead, markAhead, rebasedAheadOf } from "./ahead.ts"
import { leaveForReview } from "./aside.ts"
import { gitReads, onBranch, type Restored, restoreBranch } from "./branch.ts"
import { Checked, checkOnce, clearUnchecked, failedHow } from "./check.ts"
import { RunFibers } from "./fibers.ts"
import { detail, type Line, Log, line, Tag, ticketLine } from "./log.ts"
import {
  type CheckWatch,
  type FinishedTicket,
  type MergeEnv,
  type MergeMemory,
  type MergeOptions,
  Prepared,
  stopOver,
} from "./merge.ts"
import { type SetUps, setUp } from "./setup.ts"

export { aheadKey, type RebasedAhead, rebasedAheadOf } from "./ahead.ts"

/**
 * How the check of a ticket ahead of its turn goes, for the dashboard (orchestra's
 * mergeTrain.activity): rebased onto the branch ahead, checked on top of it, passed, or failed.
 */
export interface CheckAhead {
  readonly step: "rebase" | "check" | "passed" | "failed"
  /** The branch of the ticket ahead of it, which it is rebased onto. */
  readonly behind: string
}

/**
 * Where a train is: rebasing its branch onto the branch ahead; not rebased, as it doesn't rebase
 * cleanly or changes nothing on top of it; rebased and being checked; passed; failed; or stopped
 * before its check ended. `head` is its branch's commit after the rebase: "" when git couldn't say,
 * and, NotRebased, when its branch is as its worker left it (one git could not put back keeps it).
 * `setUp`: the setup may have run in its worktree, on top of the branch ahead. Only a train
 * Checking or Passed has trains behind it, on its `head`.
 */
type Step = Data.TaggedEnum<{
  Rebasing: Record<never, never>
  NotRebased: { readonly head: string }
  Checking: { readonly head: string; readonly setUp: boolean }
  Passed: { readonly head: string; readonly setUp: boolean }
  /** `why`: what failed on it and how, and where the output is. */
  Failed: { readonly head: string; readonly setUp: boolean; readonly why: Line }
  Stopped: { readonly head: string; readonly setUp: boolean }
}>

const Step = Data.taggedEnum<Step>()

/** Its branch's commit after the rebase, "" when there is none (Step). */
const headOf = (step: Step): string => (step._tag === "Rebasing" ? "" : step.head)

/** Whether the setup may have run on top of the branch ahead. */
const setUpOf = (step: Step): boolean =>
  step._tag === "Rebasing" || step._tag === "NotRebased" ? false : step.setUp

/** The commit trains behind it are rebased onto, or undefined when none starts behind it. */
const aheadOf: (step: Step) => string | undefined = Step.$match({
  Rebasing: () => undefined,
  NotRebased: () => undefined,
  Checking: ({ head }) => head,
  Passed: ({ head }) => head,
  Failed: () => undefined,
  Stopped: () => undefined,
})

/** Where a train stopped before its check ended is: Stopped, unless it had got past its check. */
const stoppedStep = (step: Step): Step =>
  step._tag === "Rebasing" || step._tag === "Checking"
    ? Step.Stopped({ head: headOf(step), setUp: setUpOf(step) })
    : step

/** A ticket checked ahead of its turn: where it was rebased, and how its check goes. */
interface Run {
  readonly ticket: FinishedTicket
  /** The branch of the ticket ahead of it, which it was rebased onto. */
  readonly behind: string
  /** The commit it was rebased onto: `behind` as it is checked. */
  readonly onto: string
  /** Its branch's commit before the rebase, as its worker left it; "" until it is read. */
  readonly orig: string
  /** Where its branch left the base before the rebase, for the setup. */
  readonly fork: string
  readonly step: Step
}

/**
 * The trains, as the train fibers, the merge in its turn and the board share them: changed in one
 * step each, those that read and change more than one ticket under the train's lock.
 */
interface Trains {
  /** The tickets waiting for their first turn, which may be checked ahead of it. */
  readonly ahead: ReadonlyMap<string, FinishedTicket>
  /** The tickets checked ahead of their turn. */
  readonly runs: ReadonlyMap<string, Run>
  /** The fibers checking them, each added as its train starts, under the lock. */
  readonly fibers: ReadonlyMap<string, Fiber.Fiber<void>>
  /**
   * The tickets whose turn has taken their train, until it has ended: it is no longer stopped with
   * the others, nor left by the merges stopping, its turn putting its branch back.
   */
  readonly boarding: ReadonlySet<string>
  /** The branch of the ticket whose turn it is, at the commit its check runs or passed on. */
  readonly checking: { readonly branch: string; readonly at: string } | undefined
  /** Set once the trains are left: none starts again. */
  readonly stopped: boolean
}

const noTrains: Trains = {
  ahead: new Map(),
  runs: new Map(),
  fibers: new Map(),
  boarding: new Set(),
  checking: undefined,
  stopped: false,
}

/** The trains with the run of `id` changed by `change`; as they are when it has none. */
const withRun = (trains: Trains, id: string, change: (run: Run) => Run): Trains => {
  const run = trains.runs.get(id)
  return run === undefined ? trains : { ...trains, runs: new Map(trains.runs).set(id, change(run)) }
}

/** The trains with `ids`' runs, and their fibers, gone. */
const withoutRuns = (trains: Trains, ids: ReadonlyArray<string>): Trains => {
  const runs = new Map(trains.runs)
  const fibers = new Map(trains.fibers)
  const boarding = new Set(trains.boarding)
  for (const id of ids) {
    runs.delete(id)
    fibers.delete(id)
    boarding.delete(id)
  }
  return { ...trains, runs, fibers, boarding }
}

/** The fibers of the trains not boarding, which the line's changes stop. */
const unboarded = (trains: Trains): ReadonlyArray<Fiber.Fiber<void>> =>
  [...trains.fibers].flatMap(([id, fiber]) => (trains.boarding.has(id) ? [] : [fiber]))

/**
 * Why a branch the train rebased was not put back as restoreBranch says, for the lines that say so;
 * undefined once it is back.
 */
const notBack = (worktree: string, restored: Restored): Line | undefined => {
  switch (restored._tag) {
    case "AlreadyThere":
    case "Reset":
      return undefined
    case "Dirty":
      return line`${worktree} has uncommitted changes, or git can't say whether it has`
    case "OffBranch":
      return line`${worktree} has ${restored.on}`
    case "Unknown":
      return line`git could not tell what ${worktree} has checked out: ${gitWhy(restored.error)}`
    case "AbortFailed":
      return line`git could not abort the rebase in ${worktree}: ${gitWhy(restored.error)}`
    case "ResetFailed":
      return line`git reset failed: ${gitWhy(restored.error)}`
  }
}

/** Why a ticket's dependencies are set up again before its next check, after its train's setup. */
const setUpOnTop = (behind: string) =>
  line`its dependencies were set up on top of ${behind}, ahead of its turn`

/**
 * As the run starts, puts back each branch an earlier run's train left rebased onto the branch
 * ahead, that run killed before it could: one still marked and at the commit it was rebased to
 * (or, the rebase's end unrecorded, on top of the commit it was rebased onto) is reset to where
 * its worker left it, with a line saying so. One whose setup may have run on top of the branch
 * ahead is set up again before its next check. The mark is cleared, but kept where git fails, for
 * the next run to try again.
 */
export const putBackLeft = (
  repo: string,
  setUps: SetUps,
): Effect.Effect<void, never, Git | Store | Log> =>
  Effect.gen(function* () {
    const git = yield* Git
    const store = yield* Store
    const log = yield* Log
    for (const [id, record] of Object.entries((yield* store.state).tickets)) {
      if (!Object.hasOwn(record.metadata, aheadKey)) continue
      const mark = rebasedAheadOf(record.metadata[aheadKey])
      const worktree = record.worktree ?? ""
      if (mark === undefined || worktree === "") {
        yield* clearAhead(id)
        continue
      }
      const branch = record.branch ?? branchOf(id)
      if (mark.setUp) yield* setUps.offBase(id, setUpOnTop(mark.behind))
      // Killed during the rebase: it is undone, the branch where its worker left it.
      if (mark.head === "") {
        yield* Effect.ignore(
          Effect.flatMap(git.rebaseInProgress(worktree), (rebasing) =>
            rebasing ? git.abortRebase(worktree) : Effect.void,
          ),
        )
      }
      const at = yield* Effect.result(git.revParse(repo, branch))
      if (Result.isFailure(at)) {
        yield* Effect.logDebug(`${id}: ${gitWhy(at.failure)}`)
        continue
      }
      if (at.success === mark.orig) {
        yield* clearAhead(id)
        continue
      }
      const fork =
        mark.head === "" && mark.onto !== ""
          ? yield* Effect.result(git.mergeBase(repo, mark.onto, at.success))
          : undefined
      const rebased =
        mark.head !== ""
          ? at.success === mark.head
          : fork !== undefined && Result.isSuccess(fork) && fork.success === mark.onto
      if (!rebased) {
        yield* clearAhead(id)
        yield* log.write(
          detail`${branch} was rebased onto ${mark.behind} to be checked ahead of its turn by a run that was killed before its turn, but has moved since: left as it is`,
        )
        continue
      }
      const why = notBack(worktree, yield* restoreBranch({ branch, worktree }, mark.orig, 1))
      if (why !== undefined) {
        yield* log.write(
          ticketLine(
            Tag.rebaseFailed,
          )`${id}: ${branch} could not be put back as its worker left it, at ${shortHash(mark.orig)}, after a run that was killed left it rebased onto ${mark.behind} to be checked ahead of its turn: ${why}; check ${worktree} before it merges`,
        )
        continue
      }
      yield* clearAhead(id)
      yield* log.write(
        detail`${branch} was rebased onto ${mark.behind} to be checked ahead of its turn by a run that was killed before its turn: put back as its worker left it, at ${shortHash(mark.orig)}`,
      )
    }
  })

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
  /**
   * How the checks ahead of their turn go, by ticket, now and on each change: from its rebase onto
   * the branch ahead to its turn, or until its train is stopped before its check ends.
   */
  readonly checksAhead: Stream.Stream<ReadonlyMap<string, CheckAhead>>
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
    // The trains (Trains), each change one step.
    const trains = yield* Ref.make(noTrains)
    const update = (change: (now: Trains) => Trains) => Ref.update(trains, change)
    const runOf = (id: string) => Effect.map(Ref.get(trains), (now) => now.runs.get(id))
    // How the checks ahead of their turn go, by ticket, for the dashboard.
    const shown = yield* SubscriptionRef.make<ReadonlyMap<string, CheckAhead>>(new Map())
    const show = (run: Run, step: CheckAhead["step"] | undefined) =>
      SubscriptionRef.updateSome(shown, (all) => {
        const id = run.ticket.id
        if (step === undefined && !all.has(id)) return Option.none()
        const next = new Map(all)
        if (step === undefined) next.delete(id)
        else next.set(id, { step, behind: run.behind })
        return Option.some(next)
      })
    // Starting trains, stopping them as the line changes, and leaving them, one at a time: a train
    // started is never missed by a stop.
    const lock = yield* Semaphore.make(1)
    const set = yield* (yield* RunFibers).make<void, never>("merge train")

    // The ticket's mark in state.json, as its train has it now, or at `head` once rebased.
    const mark = (run: Run, head = headOf(run.step)) =>
      markAhead(run.ticket.id, {
        orig: run.orig,
        onto: run.onto,
        head,
        behind: run.behind,
        setUp: setUpOf(run.step),
      })

    // The train's run, saved for the others to read as it is now.
    const save = (run: Run) =>
      Effect.as(
        update((now) => withRun(now, run.ticket.id, () => run)),
        run,
      )

    // Stops the trains without waiting for them: their turns put their branches back.
    const cancel = (fibers: ReadonlyArray<Fiber.Fiber<void>>) =>
      Effect.sync(() => {
        for (const fiber of fibers) fiber.interruptUnsafe()
      })

    // Rebases the ticket's branch onto run.onto in its worktree, as its turn would, and gives the run
    // with its branch's commits read and its step: Checking, to be checked there, or NotRebased: not
    // when its worktree isn't ready for a rebase (its turn says why), it doesn't rebase cleanly (the
    // rebase is aborted), or its commits change nothing on top of the branch ahead (it is put back,
    // for its turn to close it as unchanged). Where git can't tell, it is put back, or isn't
    // rebased, and its turn asks again. Run with interruption off: once begun, the rebase finishes,
    // or is undone, and the branch's commits are known for its turn.
    const rebaseAhead = (run: Run): Effect.Effect<Run, never, MergeEnv> =>
      Effect.gen(function* () {
        const { id, branch, worktree } = run.ticket
        const notRebased = (from: Run, head = ""): Run => ({
          ...from,
          step: Step.NotRebased({ head }),
        })
        // Asked once: its turn asks again, and this step can't be interrupted.
        if ((yield* onBranch(run.ticket, 1))._tag !== "OnBranch") return notRebased(run)
        const status = yield* Effect.result(git.status(worktree))
        if (Result.isFailure(status) || trackedChanges(status.success).length > 0) {
          return notRebased(run)
        }
        const before = yield* Effect.result(
          Effect.all(
            { orig: git.revParse(repo, branch), fork: git.mergeBase(repo, base, branch) },
            gitReads,
          ),
        )
        if (Result.isFailure(before)) return notRebased(run)
        const read: Run = { ...run, orig: before.success.orig, fork: before.success.fork }
        // Marked before git touches the branch: a run killed before it is put back leaves the mark.
        yield* mark(read)
        const rebased = yield* Effect.result(git.rebase(worktree, read.onto))
        if (Result.isFailure(rebased)) {
          yield* git.abandonRebase(worktree)
          yield* clearAhead(id)
          yield* log.write(
            detail`${branch} is not checked ahead of its turn: it does not rebase cleanly onto ${read.behind}`,
          )
          return notRebased(read)
        }
        const head = yield* Effect.result(git.revParse(repo, branch))
        if (Result.isFailure(head)) return notRebased(read)
        yield* mark(read, head.success)
        const changed = yield* Effect.result(git.changedFiles(repo, read.onto, branch))
        if (Result.isSuccess(changed) && changed.success.length > 0) {
          return { ...read, step: Step.Checking({ head: head.success, setUp: false }) }
        }
        // Changing nothing on top of the branch ahead, or git can't tell: put back for its turn.
        const why = notBack(worktree, yield* restoreBranch(read.ticket, read.orig, 1))
        if (why === undefined) {
          yield* clearAhead(id)
          return notRebased(read)
        }
        yield* Effect.logDebug(`${id}: ${why}`)
        return notRebased(read, head.success)
      })

    // The trains behind the ticket in line are stopped: its own check failed ahead of its turn.
    const cancelBehind = (id: string) =>
      lock.withPermit(
        Effect.gen(function* () {
          const waiting = yield* options.waiting
          const at = waiting.indexOf(id)
          if (at < 0) return
          const now = yield* Ref.get(trains)
          const behind = new Set(waiting.slice(at + 1))
          yield* cancel(
            [...now.fibers].flatMap(([each, fiber]) =>
              behind.has(each) && !now.boarding.has(each) ? [fiber] : [],
            ),
          )
        }),
      )

    // Rebases the ticket's branch onto run.onto and checks it there, the setup first when a
    // dependency file changed, as its turn would, and records how it went. A check that fails says
    // nothing of the ticket: it is checked again in its turn, on the base it merges onto.
    const runTrain = (first: Run) =>
      Effect.gen(function* () {
        const { branch } = first.ticket
        yield* show(first, "rebase")
        const rebased = yield* Effect.uninterruptible(Effect.flatMap(rebaseAhead(first), save))
        if (rebased.step._tag !== "Checking") return yield* show(rebased, undefined)
        const { head } = rebased.step
        yield* show(rebased, "check")
        yield* start
        yield* log.write(
          detail`checking ${branch} ahead of its turn to merge, rebased onto ${rebased.behind} as it is checked`,
        )
        const setting = yield* save({ ...rebased, step: Step.Checking({ head, setUp: true }) })
        yield* mark(setting)
        const setup = yield* setUp(
          setting.ticket,
          options,
          memory.setUps,
          setting.fork === "" ? setting.onto : setting.fork,
          setting.onto,
          undefined,
          true,
        )
        const ranSetUp = setup._tag !== "Unneeded"
        const checking = ranSetUp
          ? setting
          : yield* save({ ...setting, step: Step.Checking({ head, setUp: false }) })
        if (!ranSetUp) yield* mark(checking)
        const checked =
          setup._tag === "Failed"
            ? Checked.Failed({ error: setup.error, output: setup.output })
            : yield* checkOnce(checking.ticket, { suite: "merge", train: true })
        if (checked._tag !== "Failed") {
          const passed = yield* save({ ...checking, step: Step.Passed({ head, setUp: ranSetUp }) })
          yield* show(passed, "passed")
          if (checked._tag === "Passed") {
            yield* log.write(
              detail`'${checked.command}' passes on ${branch} ahead of its turn, on top of ${passed.behind}`,
            )
          }
          return
        }
        const where =
          checked.error._tag === "CheckNotRun" ? "" : line` (output is in ${checked.output})`
        const failed = yield* save({
          ...checking,
          step: Step.Failed({
            head,
            setUp: ranSetUp,
            why: line`${failedHow(checked.error)} on ${branch} on top of it${where}`,
          }),
        })
        yield* show(failed, "failed")
        yield* log.write(
          detail`${failedHow(checked.error)} on ${branch} ahead of its turn, on top of ${failed.behind}${where}; it is checked again in its turn`,
        )
        yield* cancelBehind(failed.ticket.id)
      }).pipe(
        // Stopped before its check ended: it shows no more. One past its check keeps how it went.
        Effect.onInterrupt(() =>
          Effect.andThen(
            update((now) =>
              withRun(now, first.ticket.id, (run) => ({ ...run, step: stoppedStep(run.step) })),
            ),
            show(first, undefined),
          ),
        ),
      )

    // Starts checking ahead of their turn the first merge.train tickets in line that wait for their
    // first turn, each rebased onto the branch of the one ahead of it as that one is checked: the
    // branch whose turn it is, or the train's ahead of it once rebased. None starts while no turn's
    // check runs, nor once the trains are left or while the run holds at the machine's cap, and none
    // behind a ticket not checked ahead, or whose train failed.
    const start: Effect.Effect<void> = lock.withPermit(
      Effect.gen(function* () {
        const { stopped, checking } = yield* Ref.get(trains)
        if (stopped || size <= 0 || config.settings.checks.fast.command === null) return
        if (checking === undefined || (yield* machineFull)) return
        let { branch: behind, at: onto } = checking
        for (const id of (yield* options.waiting).slice(0, size)) {
          const ticket = (yield* Ref.get(trains)).ahead.get(id)
          if (ticket === undefined) break
          if ((yield* runOf(id)) === undefined) {
            const made: Run = { ticket, behind, onto, orig: "", fork: "", step: Step.Rebasing() }
            yield* update((now) => ({ ...now, runs: new Map(now.runs).set(id, made) }))
            const fiber = yield* FiberSet.run(
              set,
              guard(
                `${id}'s check ahead of its turn`,
                runTrain(made).pipe(Effect.provideContext(context)),
              ),
            )
            yield* update((now) => ({ ...now, fibers: new Map(now.fibers).set(id, fiber) }))
          }
          const run = yield* runOf(id)
          // On another commit than the one ahead as it is now, or not rebased onto it (yet).
          const next = run === undefined ? undefined : aheadOf(run.step)
          if (run?.onto !== onto || next === undefined) break
          behind = ticket.branch
          onto = next
        }
      }),
    )

    // Puts the ticket's branch, at `head`, back as its worker left it when its train rebased it and
    // it hasn't moved since: what restoreBranch said, or undefined when it was not the train's to
    // put back. Dependencies set up on top of the branch ahead are set up again before its next
    // check. Its mark is cleared once its branch is back, or was not the train's to put back.
    const putBack = (run: Run, head: string) =>
      Effect.gen(function* () {
        if (setUpOf(run.step)) yield* memory.setUps.offBase(run.ticket.id, setUpOnTop(run.behind))
        const restored =
          headOf(run.step) === "" || head !== headOf(run.step)
            ? undefined
            : yield* restoreBranch(run.ticket, run.orig, 1)
        if (restored === undefined || notBack(run.ticket.worktree, restored) === undefined) {
          yield* clearAhead(run.ticket.id)
        }
        return restored
      })

    const watch: CheckWatch = {
      starts: (ticket, at) =>
        Effect.andThen(
          lock.withPermit(
            Effect.gen(function* () {
              const was = yield* Ref.getAndUpdate(trains, (now) => ({
                ...now,
                checking: { branch: ticket.branch, at },
              }))
              // The trains on another commit of its branch are stopped: it no longer merges so.
              if (was.checking !== undefined && was.checking.at !== at) {
                yield* cancel(unboarded(was))
              }
            }),
          ),
          start,
        ),
      // Those on top of a branch that fails are stopped; on one that passes, they go on.
      ends: (passed) =>
        passed
          ? Effect.void
          : lock.withPermit(
              Effect.flatMap(
                Ref.updateAndGet(trains, (now) => ({ ...now, checking: undefined })),
                (now) => cancel(unboarded(now)),
              ),
            ),
    }

    const leave: Effect.Effect<void> = lock
      .withPermit(
        Effect.gen(function* () {
          const was = yield* Ref.getAndUpdate(trains, (now) => ({
            ...now,
            stopped: true,
            checking: undefined,
            ahead: new Map(),
          }))
          const left = [...was.runs.keys()].filter((id) => !was.boarding.has(id))
          yield* cancel(unboarded(was))
          for (const id of left) {
            const fiber = was.fibers.get(id)
            if (fiber !== undefined) yield* Fiber.await(fiber)
            // As its train left it.
            const run = yield* runOf(id)
            if (run === undefined) continue
            const { branch, worktree } = run.ticket
            const at = yield* Effect.result(git.revParse(repo, branch))
            const back = Result.isSuccess(at) ? yield* putBack(run, at.success) : undefined
            const why = Result.isFailure(at)
              ? line`git could not tell where ${branch} is: ${gitWhy(at.failure)}`
              : back === undefined
                ? undefined
                : notBack(worktree, back)
            if (why === undefined) {
              if (back !== undefined) {
                yield* log.write(
                  detail`${branch} was rebased onto ${run.behind} to be checked ahead of its turn, but the run stopped before its turn: put back as its worker left it`,
                )
              }
              continue
            }
            yield* log.write(
              ticketLine(
                Tag.rebaseFailed,
              )`${id}: ${branch} could not be put back as its worker left it, at ${shortHash(run.orig)}, after it was rebased onto ${run.behind} to be checked ahead of its turn: ${why}; check ${worktree} before it merges`,
            )
          }
          yield* update((now) => withoutRuns(now, left))
          // Each stopped, or ended before it was: none shows.
          yield* SubscriptionRef.set(shown, new Map())
        }),
      )
      .pipe(Effect.provideContext(context))

    // Put back on the run's end, should it come with trains under way.
    yield* Effect.addFinalizer(() => leave)

    // Why a train put back as its turn came didn't board, the branch ahead merged as it was checked.
    const blame = (step: Step): Line | string => {
      switch (step._tag) {
        case "Failed":
          return step.why
        case "NotRebased":
          return "it changes nothing on top of it"
        // One that passed boards where it passed: put back, it ended before its check did, as a
        // train that died does.
        case "Rebasing":
        case "Checking":
        case "Passed":
        case "Stopped":
          return "its check was stopped before it ended"
      }
    }

    // The ticket's train, taken by its turn, once it has ended: `run` as it was taken.
    const boarded = (
      run: Run,
      fiber: Fiber.Fiber<void>,
      restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
    ): Effect.Effect<Prepared | undefined, never, MergeEnv> =>
      Effect.gen(function* () {
        const { ticket } = run
        const { id, branch, worktree } = ticket
        // Where git can't say where the base is, the branch ahead is taken for one that didn't
        // merge.
        const merged = (at: Result.Result<string, unknown>) =>
          Result.isSuccess(at) && at.success === run.onto
        if (merged(yield* Effect.result(git.revParse(repo, base)))) {
          // While it is checked, the tickets behind it may be checked ahead on top of it, as on
          // the check of a ticket in its turn.
          const next = aheadOf(((yield* runOf(id)) ?? run).step)
          if (next !== undefined) {
            yield* update((now) => ({ ...now, checking: { branch, at: next } }))
            yield* start
          }
        } else yield* cancel([fiber])
        const waited = yield* Effect.exit(restore(Fiber.await(fiber)))
        yield* show(run, undefined)
        if (Exit.isFailure(waited)) {
          // Quitting, before its turn's merge began: put back for the next run. Its branch is read
          // once its train has ended, as a rebase under way finishes first and moves it.
          yield* cancel([fiber])
          yield* Fiber.await(fiber)
          const left = yield* Effect.result(git.revParse(repo, branch))
          if (Result.isSuccess(left)) yield* putBack((yield* runOf(id)) ?? run, left.success)
          return yield* Effect.interrupt
        }
        // As its train left it.
        const ended = (yield* runOf(id)) ?? run
        const at = yield* Effect.result(git.revParse(repo, branch))
        if (Result.isFailure(at)) {
          // The branch may have the commits of the branch ahead, which didn't merge.
          const stop = yield* stopOver(
            ticket,
            "GIT_FAILED",
            "git failed",
            line`could not tell where ${branch} is, after it was rebased to be checked ahead of its turn: ${gitWhy(at.failure)}; ${branch} is not merged, its worktree ${worktree} left for review`,
          )
          return Prepared.Over({ stop })
        }
        const now = merged(yield* Effect.result(git.revParse(repo, base)))
        const step = ended.step
        if (step._tag === "Passed" && at.success === step.head && now) {
          yield* memory.passes.set(id, step.head)
          yield* clearUnchecked(id)
          yield* clearAhead(id)
          yield* log.write(
            detail`${branch} was checked ahead of its turn on top of ${ended.behind}, which merged as it was checked: merging it with no further check`,
          )
          return undefined
        }
        const back = yield* putBack(ended, at.success)
        yield* watch.ends(false)
        const why = back === undefined ? undefined : notBack(worktree, back)
        if (why !== undefined) {
          yield* leaveForReview(id, {
            why: Tag.rebaseFailed,
            detail: "rebase failed",
            text: ticketLine(
              Tag.rebaseFailed,
            )`${id} closed, but ${branch} could not be put back as its worker left it, at ${shortHash(ended.orig)}, after it was rebased onto ${ended.behind} to be checked ahead of its turn: ${why}; worktree ${worktree} left for review`,
          })
          return Prepared.Over({})
        }
        if (back === undefined) return undefined
        const which = now
          ? line`which merged as it was checked, but ${blame(step)}`
          : "which did not merge as it was checked"
        yield* log.write(
          detail`${branch} was checked ahead of its turn on top of ${ended.behind}, ${which}: put back as its worker left it`,
        )
        return undefined
      })

    const board = (ticket: FinishedTicket): Effect.Effect<Prepared | undefined> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const { id } = ticket
          // Taken under the lock, so that no train is started or left meanwhile: it is no longer in
          // line, and its train, if it has one, is its turn's from then on.
          const taken = yield* lock.withPermit(
            Ref.modify(trains, (now): [readonly [Run, Fiber.Fiber<void>] | undefined, Trains] => {
              const ahead = new Map(now.ahead)
              ahead.delete(id)
              const run = now.runs.get(id)
              const fiber = now.fibers.get(id)
              if (run === undefined || fiber === undefined) {
                return [undefined, withoutRuns({ ...now, ahead }, [id])]
              }
              return [[run, fiber], { ...now, ahead, boarding: new Set(now.boarding).add(id) }]
            }),
          )
          if (taken === undefined) return undefined
          return yield* boarded(taken[0], taken[1], restore).pipe(
            Effect.ensuring(update((now) => withoutRuns(now, [id]))),
          )
        }),
      ).pipe(Effect.provideContext(context))

    return {
      ...watch,
      mayCheckAhead: (ticket) =>
        update((now) =>
          now.stopped ? now : { ...now, ahead: new Map(now.ahead).set(ticket.id, ticket) },
        ),
      start,
      holderDone: update((now) => ({ ...now, checking: undefined })),
      board,
      leave,
      checksAhead: SubscriptionRef.changes(shown),
    } satisfies MergeTrain
  })
