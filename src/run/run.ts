// The run (§ 5, § 3.4): what follows the startup checks and the run lock, from the START block to
// the end record. It is a scoped Effect. It forks the ready poll, the merge queue's consumer, the
// watchers of the merge queue and of drain requests, and one fiber per running ticket, each into a
// FiberSet of the run's scope (§ 3.4), and drives the scheduler itself: it fills the free slots as
// the run starts, whenever a ticket's fiber ends or a merge finishes, and on each ready poll. Each
// such look first puts back the Waiting tickets whose blockers merged, checks once more in a slot
// each ticket set aside for a failed check whose base has moved on (recheck.ts), and resumes the
// Asked ones whose questions are answered (asked.ts), unless the run holds or winds down.
//
// Holds and stops (§ 5 item 10): a stop holds the run (no new tickets, the running ones finish and
// merge), and the run ends once nothing runs or waits to merge, with the stops' line and the first
// one's exit code (holds.ts). A drain (drain.ts) does the same without a stop, and the run ends
// DRAINED with exit 0. Workers failing at once hold the run with ENVIRONMENT (environment.ts): once
// nothing runs, the probe either lifts that stop, and the run takes tickets again, or ends the run.
// Given Organs, the run triages each ticket set aside in the background (triage.ts), its verdicts
// counting toward that hold, and doesn't end while a ticket waits for its verdict. With the queue's
// footprint on and more than one slot, the predictor (predict.ts) guesses in the background the
// files of the ready tickets naming nothing, until the loop ends.
// The holds that come with time (holds.ts): a worker past --ticket-limit stops the run with
// TICKET_LIMIT and goes on, and the run neither waits for it nor drains it: the end suspends it. A
// request unanswered for 4 minutes stops the run with BLOCKED, lifted once its ticket has no request
// open; its banner is on the title line while it holds.
//
// Quitting (§ 4.8, quit.ts): the first request to quit (SIGINT, SIGTERM, SIGHUP, the quit box's
// `q`), or a panic in one of the run's fibers, cuts the loop short: the workers are interrupted at
// once and their results waited for, the merges and hand-backs stopped, triage aborted, then the end
// below suspends every session and the run ends INTERRUPTED (130), or PANIC (4). A second request
// says what is under way; a third ends tutti at once, through RunOptions.exitNow.
//
// Before its first dispatch the run checks the tickets earlier runs left labelled `unmerged`
// (unmerged.ts): one merged since by hand loses its label; bd failing to list them stops the run,
// BEADS_FAILED. Then it takes up the workers the last run left in state.json (carry.ts): each
// suspended one resumed in a slot, counting toward no limit; and as it ends, it saves the asked
// tickets beside the suspended ones. Then the START block lists, each a DEFERRED_FREE line, the
// deferred tickets in the run's scope whose blockers have all merged (deferredFree.ts).
//
// The end (§ 5 item 14): nothing left to start or merge. Workers waiting on you (an open request)
// keep it open with a dashboard (D19): it shows the end-of-run box until you answer them, and they
// carry on, or end the run with the box's `q`. Plain, the run waits for them only until a stop holds
// it, BLOCKED at the latest; then it ends as usual. Those past their ticket limit never keep it
// open. A run not quit looks once more for tickets merged by hand (handMerged.ts). The tickets still
// in a phase a run can't end in are Stopped and their sessions suspended (§ 4.8), as are the
// sessions of those that stopped the run, a worker still waiting on you suspended so (`waiting on
// you`); each ticket closed and not merged is labelled `unmerged`; a stopped run names the tickets
// it leaves without their promised check once more (recheck.ts); then
// the summary lines, the closing line (the stops', or READY_EMPTY, LIMIT_REACHED or DRAINED, with
// a scoped run's SCOPE_ part), the full check when the run ended by itself having merged a ticket
// (fullcheck.ts), and the end record. In plain mode (§ 7.6) every line goes to stdout as the Log writes it; a worker's attention request is a
// PERMISSION or QUESTION line naming the `tutti answer` command, served from the attention files.
// When Tty says the terminal can draw the dashboard and main gave the run one, the run shows it
// (screen.ts) from its start to its end instead, its status kept live: the stops (`· stopping`),
// the scheduler's solo ticket and tickets not closed, the probe's card, triage's verdicts, the
// holds' banners. It hands back the summary and closing lines for
// main to print once the renderer is gone (§ 7.1). Given RunOptions.endLater, the run leaves the
// report and the end record to `finish`, which main runs on the main screen once the renderer is
// gone: the styled summary and closing line after a dashboard, then the report (report.ts), then
// the end record (§ 5 item 14 "Then").
//
// The run's parts each have a module: its holds (holdsGate.ts), its place among the machine's runs
// (machineGate.ts), the screen's commands and the run's end they act until (screenCommands.ts),
// BLOCKED (blockedWatch.ts), quitting (quitting.ts) and the end's steps (endOfRun.ts).
import { join } from "node:path"
import {
  Cause as Causes,
  Clock,
  Deferred,
  Effect,
  FiberSet,
  type FileSystem,
  Option,
  Queue,
  Ref,
  Result,
  type Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { AgentHost } from "../agent/AgentHost.ts"
import { Attention } from "../agent/Attention.ts"
import { serve } from "../agent/attentionFiles.ts"
import type { Transcripts } from "../agent/Transcripts.ts"
import type { UsageLimits } from "../agent/UsageLimits.ts"
import type { UsageProbe } from "../agent/UsageProbe.ts"
import { AppConfig } from "../cli/AppConfig.ts"
import { section } from "../organs/evidence.ts"
import { OrganCost } from "../organs/OrganCost.ts"
import { Organs } from "../organs/Organs.ts"
import { type Ending, printSummary, type Summary } from "../print/summary.ts"
import { checkCommands } from "../project/settings.ts"
import { Beads, type Issue } from "../services/Beads.ts"
import { Git } from "../services/Git.ts"
import type { Notifier } from "../services/Notifier.ts"
import { Store } from "../services/Store.ts"
import { outputMode, Tty } from "../services/Tty.ts"
import { schemeNotices } from "../ui/theme.ts"
import { takeAnswers } from "./asked.ts"
import { make as makeBlockedWatch } from "./blockedWatch.ts"
import { type Carried, type CarryOptions, carryOver, carryWaiting } from "./carry.ts"
import { closedBranches } from "./closedBranches.ts"
import { noteCompactions } from "./compactions.ts"
import { sayAtStart as sayDeferredFree } from "./deferredFree.ts"
import { type DrainRequest, hear } from "./drain.ts"
import { make as makeEndOfRun } from "./endOfRun.ts"
import { make as makeEnvironmentHold } from "./environment.ts"
import { EventStream } from "./eventstream.ts"
import { RunFibers } from "./fibers.ts"
import { removeLeftFullChecks } from "./fullcheck.ts"
import {
  changeStops,
  exitCodeOf,
  exitCodes,
  extendFirst,
  noMoreWork,
  pastTicketLimit,
  putFirst,
  type StopReason,
  showUsage,
  stopFor,
  stopOfLine,
  swapStop,
} from "./holds.ts"
import { make as makeHoldsGate, waitedFor } from "./holdsGate.ts"
import { type Entry, Ledger } from "./ledger.ts"
import { Load, pressing, watchLoad } from "./load.ts"
import { type Line, Log, tagged } from "./log.ts"
import { make as makeMachineGate } from "./machineGate.ts"
import { beadsWhy, gitWhy } from "./merge.ts"
import { isSettled, make as makeQueue, type QueueState } from "./mergequeue.ts"
import { putBackLeft } from "./mergetrain.ts"
import type { TicketPhase } from "./phase.ts"
import { make as makePredictor } from "./predict.ts"
import { interruptedText, panicLines, type QuitRequest } from "./quit.ts"
import { make as makeQuits, type Quitting } from "./quitting.ts"
import { dropRechecks } from "./recheck.ts"
import { type ReportOut, type ReportRun, runReport } from "./report.ts"
import { failedChecksSection, followUpsSection } from "./reportEvidence.ts"
import { runRequires } from "./requires.ts"
import { decide, endOfRunBox, type Look } from "./runEnd.ts"
import { emptyStatus, type Status, same } from "./runView.ts"
import { footprintsOf, make as makeScheduler, readyPoll, type Scheduler } from "./schedule.ts"
import { type Dashboard, show } from "./screen.ts"
import { make as makeScreenCommands } from "./screenCommands.ts"
import { makeSetUps, retrySetups } from "./setup.ts"
import { endRecord } from "./spending.ts"
import { make as makeTriage, off as triageOff } from "./triage.ts"
import { loadUnmerged } from "./unmerged.ts"
import { make as makeUsageHold } from "./usageLimit.ts"
import { make as watchUsageWindows } from "./usageWindows.ts"
import { requeueWaiting, type WorkEnv, type WorkError, type Worked, work } from "./work.ts"

/** How a run ended: its exit code, and each ticket's phase then. */
export interface Outcome {
  readonly exitCode: number
  readonly phases: Readonly<Record<string, TicketPhase>>
  /** The summary and closing lines the run wrote at its end. */
  readonly ending: ReadonlyArray<Line>
  /** What the styled summary is made from (§ 7.1). */
  readonly summary: Summary
  /** How the run ended, for the styled closing line and the report: a scoped run's part included. */
  readonly closing: Ending
  /** The lines the run wrote after its closing line: the full check's, a quit's as it ended. */
  readonly after: ReadonlyArray<Line>
  /**
   * The run report on the `out` made (report.ts), which `finish` runs; nothing without organs, and
   * `out` made only when the report prints.
   */
  readonly report: (out: Effect.Effect<ReportOut>) => Effect.Effect<void>
}

export interface RunOptions {
  /** tutti's version, for the summary's title. */
  readonly version: string
  /** Where finished tickets land: the branch the main checkout is on. */
  readonly base: string
  /**
   * Whether its workers bill a subscription login: the summary's dollars are then the API-price
   * estimate, and it gives the account's usage windows. Not, by default.
   */
  readonly subscription?: boolean
  /** What the run says first: the START block, and why the output is plain if it is. */
  readonly start?: ReadonlyArray<Line>
  /** Requests to wind down or to take tickets again, such as SIGUSR1's. */
  readonly drains?: Queue.Dequeue<DrainRequest>
  /**
   * Requests to quit now (§ 4.8): SIGINT's, SIGTERM's and SIGHUP's, the quit box's `q`. The first
   * quits, the second says what is under way, the third ends tutti at once through `exitNow`.
   */
  readonly quits?: Queue.Dequeue<QuitRequest>
  /** Ends tutti at once with `code`, `said` the lines to print once the screen has gone. */
  readonly exitNow?: (code: number, said: ReadonlyArray<Line>) => Effect.Effect<void>
  /** The dashboard to show when Tty says the terminal can draw one; the run is plain without it. */
  readonly dashboard?: Dashboard
  /**
   * Whether the --keep-awake command holds the machine awake (keepAwake.ts), as it changes: the
   * title line's badge. None for a run that doesn't keep the machine awake.
   */
  readonly keepingAwake?: Stream.Stream<boolean>
  /**
   * Leaves the report and the end record to `finish`, run once the dashboard's renderer is gone,
   * so that they follow the summary on the main screen (§ 5 item 14 "Then", § 7.1).
   */
  readonly endLater?: boolean
}

/**
 * Every service the run uses; it makes its own Ledger. Given Organs as well, it triages the tickets
 * set aside (triage.ts), unless triage is off.
 */
export type RunEnv =
  | Exclude<WorkEnv, Ledger>
  | Attention
  | RunFibers
  | Transcripts
  | Tty
  | UsageLimits
  | UsageProbe
  | Notifier
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner

/** The stop a ticket's fiber failing with `error` stops the run for (§ 5 item 10). */
export const errorStop = (ticket: string, error: WorkError): StopReason => {
  switch (error._tag) {
    case "GitFailed":
    case "GitTimedOut":
      return stopFor("GIT_FAILED", `git failed on ${ticket}: ${gitWhy(error)}`, { ticket })
    case "BeadsFailed":
    case "BeadsTimedOut":
    case "BeadsUnreadable":
      return stopFor("BEADS_FAILED", `bd failed on ${ticket}: ${beadsWhy(error)}`, { ticket })
    case "ExcludeUnwritable":
      return stopFor("WORKTREE_FAILED", `${ticket}'s worktree: ${error.message}`, { ticket })
    case "StoreWriteFailed":
      return stopFor("STATE_UNWRITABLE", `${ticket}: ${error.message}`, { ticket })
  }
}

/** The first line of what `defect` says. */
const firstLine = (defect: unknown): string => {
  const said = defect instanceof Error ? defect.message : String(defect)
  return said.split("\n")[0] ?? ""
}

/** The PANIC stop of a ticket's fiber that died with `defect`. */
export const panicStop = (ticket: string, defect: unknown): StopReason =>
  stopFor("PANIC", `${ticket}'s fiber: ${firstLine(defect)}`, { ticket })

/** What a fiber that died with `cause` died of: its defect, or the cause told. */
const defectOf = (cause: Causes.Cause<unknown>): unknown => {
  const defect = Causes.findDefect(cause)
  return Result.isSuccess(defect) ? defect.success : Causes.pretty(cause)
}

/** The stop a ticket's fiber ending with `cause` stops the run for, if any. */
const causeStop = (ticket: string, cause: Causes.Cause<WorkError>): StopReason | undefined => {
  if (Causes.hasInterruptsOnly(cause)) return undefined
  const error = Causes.findError(cause)
  if (Result.isSuccess(error)) return errorStop(ticket, error.success)
  const defect = Causes.findDefect(cause)
  return panicStop(ticket, Result.isSuccess(defect) ? defect.success : Causes.pretty(cause))
}

/**
 * Shows the end-of-run box (D19) on `status`: the workers waiting on you it names, or null for
 * none. It reads and sets the status in one step, so that another fiber's change in between isn't
 * lost, and publishes nothing when the box is the same.
 */
export const showEndOfRun = (
  status: SubscriptionRef.SubscriptionRef<Status>,
  tickets: ReadonlyArray<string> | null,
): Effect.Effect<void> =>
  SubscriptionRef.updateSome(status, (now) =>
    same(now.endOfRun, tickets) ? Option.none() : Option.some({ ...now, endOfRun: tickets }),
  )

/**
 * The run, from its START block to its end record, in the run's scope: it hands back its exit
 * code and each ticket's phase. It never fails: what goes wrong stops it, with an exit code.
 */
export const run = (options: RunOptions): Effect.Effect<Outcome, never, RunEnv | Scope.Scope> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const beads = yield* Beads
    const host = yield* AgentHost
    const store = yield* Store
    const attention = yield* Attention
    const ledger = yield* Ledger
    const logs = yield* Log
    const events = yield* EventStream
    const fibers = yield* RunFibers
    const context = yield* Effect.context<WorkEnv>()
    const { base } = options
    const begun = yield* Clock.currentTimeMillis
    // The base's commit as the run starts, for the report's commits merged.
    const startHead = yield* (yield* Git)
      .revParse(config.repo, base)
      .pipe(Effect.orElseSucceed(() => base))

    if (options.start !== undefined && options.start.length > 0) yield* logs.write(...options.start)
    yield* serve({ repo: config.repo })
    // What the dashboard says of the run, beside its tickets: the holds change it as they come.
    const notices = schemeNotices(config.scheme)
    const status = yield* SubscriptionRef.make<Status>({
      ...emptyStatus,
      version: options.version,
      branch: base,
      scope: config.ticket,
      began: begun,
      concurrency: config.settings.concurrent,
      warnings: notices,
    })
    const dashboard = options.dashboard
    const screen =
      dashboard !== undefined && outputMode(yield* Tty, config.plain)._tag === "Dashboard"
        ? yield* show(dashboard, SubscriptionRef.changes(status))
        : null
    // The run's end, set once nothing is to start or act after it, and the screen's commands that
    // act on the run until then (screenCommands.ts).
    const commands = yield* makeScreenCommands({ repo: config.repo, base })

    // Wakes the run to look again: a merge, a stop, a drain request, the ready poll.
    const wake = yield* Queue.sliding<void>(1)
    const wakeUp = Queue.offer(wake, undefined)
    // What holds the run (holdsGate.ts): its stops, the tickets past --ticket-limit, the machine's
    // hold and the usage limit's view, each shown on the dashboard as it comes. A stop holds the
    // run, said as it comes while tickets still run, and wakes it.
    const holds = yield* makeHoldsGate({ status, notices, wakeUp })
    const { changeHolds, currentStops, stopped } = holds
    // The first request to quit, or a panic, ends the loop below, and the run quits (quitting.ts).
    const quitting = yield* Deferred.make<Quitting>()
    // A panic in one of the run's fibers (`where`), logged with its stack, quits the run: PANIC.
    const panicked = (where: string, stop: StopReason, defect: unknown) =>
      Effect.andThen(
        logs.write(...panicLines(where, defect)),
        Deferred.succeed(quitting, { panic: stop }),
      )
    // Each worker's compactions are counted and logged (compactions.ts), from before any worker
    // starts or is carried over; a watcher that dies panics the run.
    yield* FiberSet.run(
      yield* fibers.make("compactions"),
      Effect.catchDefect(noteCompactions, (defect) =>
        panicked("the run", stopFor("PANIC", `the run's fiber: ${firstLine(defect)}`), defect),
      ),
    )

    // The run's setups (setup.ts): the setup before each worker and before each check, and the
    // tickets whose setup failed, which the merge queue and the tickets' starts share.
    const setUps = yield* makeSetUps
    // Workers failing at once, or setups failing, hold the run, as a stop does, until the probe
    // (environment.ts).
    const environment = yield* makeEnvironmentHold({
      onHold: stopped,
      setup: Effect.map(setUps.now, (setup) => setup.command),
    })

    // The account's usage limit holds the run until it resets, without a stop (usageLimit.ts).
    const usage = yield* makeUsageHold({
      base,
      wakeUp,
      show: (view) => changeHolds((now) => showUsage(now, view)),
    })
    // The account's windows on the title line all the time, each figure recorded (usageWindows.ts).
    yield* watchUsageWindows({
      show: (windows) =>
        SubscriptionRef.update(status, (now) =>
          same(now.windows, windows) ? now : { ...now, windows },
        ),
    })

    // Triage in the background, when the run has organs: each verdict wakes the run, which doesn't
    // end while a ticket waits for one.
    const organs = yield* Effect.serviceOption(Organs)
    const triage = Option.isNone(organs)
      ? triageOff
      : yield* makeTriage({ base, hold: environment, done: wakeUp }).pipe(
          Effect.provideService(Organs, organs.value),
        )

    // Why the run takes on no more work, for the merges: no failed check is handed back then.
    const noMore = Effect.map(
      Effect.all([currentStops, usage.held, ledger.current]),
      ([all, held, state]) => noMoreWork(all, held, state.windDown !== null),
    )
    // A ticket checked once more takes a slot from the scheduler, made after the queue it starts
    // tickets with: none before it is.
    const slots = yield* Ref.make<Scheduler["recheckSlot"] | undefined>(undefined)
    const recheckSlot = (ticket: string, work: Effect.Effect<void>) =>
      Effect.flatMap(Ref.get(slots), (take) =>
        take === undefined ? Effect.succeed(false) : take(ticket, work),
      )
    // Whether the run holds at --machine-workers (machineGate.ts): no ticket is checked ahead of
    // its turn to merge then (mergetrain.ts).
    const machineFull = Effect.map(holds.now, (now) => now.machine)
    // Whether the machine's last load reading has it pressed (load.ts's pressing), read with the
    // dashboard alone: with machineFull, the time a hand-back's limit leaves out (handback.ts).
    const pressed = yield* Ref.make(false)
    const queue = yield* makeQueue(
      {
        repo: config.repo,
        base,
        noMore,
        atReset: usage.atReset,
        recheckSlot,
        setUps,
        machineFull,
        loaded: Effect.map(
          Effect.all([machineFull, Ref.get(pressed)]),
          ([full, hard]) => full || hard,
        ),
      },
      (where, defect) =>
        panicked(where, stopFor("PANIC", `${where}: ${firstLine(defect)}`), defect),
    )
    // The merge that stopped the merges, taken up once, by its watcher or by the end.
    const mergeStopSeen = yield* Ref.make(false)
    const mergeStop = (state: QueueState) =>
      Effect.gen(function* () {
        const stop = state.stop
        if (stop === null || (yield* Ref.getAndSet(mergeStopSeen, true))) return
        yield* stopped(
          stopOfLine(stop, {
            ticket: stop.ticket,
            recorded: stop.why === "MERGE_FAILED",
            held: true,
          }),
        )
      })

    // A closed blocker the run knows nothing of hasn't merged while git finds its work only on its
    // branch (closedBranches.ts): the holds, WAITS_FOR_MERGE and DEFERRED_FREE all count it so.
    const branches = yield* closedBranches({ repo: config.repo, base })

    // A ticket's fiber, dispatched or carried over: its work, and the stop it ended with, if any.
    const onTicketLimit = (ticket: string) => (stop: StopReason) =>
      stopped(stop, (now) => pastTicketLimit(now, ticket, stop))
    // The same, for workers resumed by carry-over or an answer, each stop naming its ticket.
    const onResumedLimit = (stop: StopReason) =>
      stop.ticket === undefined ? stopped(stop) : onTicketLimit(stop.ticket)(stop)
    const outcomeOf = <R>(ticket: string, worked: Effect.Effect<Worked, WorkError, R>) =>
      worked.pipe(
        Effect.matchCauseEffect({
          onSuccess: (worked) =>
            Effect.andThen(
              environment.settled(ticket, worked.settling ?? "other"),
              worked.stop === null
                ? Effect.void
                : stopped(stopOfLine(worked.stop, { ticket, recorded: true })),
            ),
          onFailure: (cause) => {
            const stop = causeStop(ticket, cause)
            if (stop === undefined) return Effect.void
            return stop.why === "PANIC"
              ? panicked(`${ticket}'s fiber`, stop, defectOf(cause))
              : stopped(stop)
          },
        }),
      )
    const ticketFiber = (issue: Issue): Effect.Effect<void> =>
      outcomeOf(
        issue.id,
        work(issue, {
          base,
          queue,
          triage,
          setUps,
          closedBranches: branches,
          onTicketLimit: onTicketLimit(issue.id),
        }),
      ).pipe(Effect.provideContext(context))

    // A merge that changed the requires list has it checked again before the next ticket starts
    // (requires.ts): what is still missing stops the run as at its start, the running tickets
    // finishing first. Each ask whether the run takes a ticket checks it first, so that a merge
    // during a look's fill is checked before the fill starts another; one check at a time, so that
    // an ask while one runs waits for its answer.
    const requiresChecking = yield* Semaphore.make(1)
    const requiresContext = yield* Effect.context<
      WorkEnv | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
    >()
    const requiresChecked = requiresChecking
      .withPermit(
        Effect.gen(function* () {
          if (!(yield* setUps.requiresDue)) return
          const missing = yield* runRequires(yield* setUps.requires, {
            repo: config.repo,
            installLimit: config.settings.checks.fast.timeout,
          })
          if (missing !== "") yield* stopped(stopFor("REQUIREMENTS_MISSING", missing))
        }),
      )
      .pipe(Effect.provideContext(requiresContext))
    const taking = Effect.andThen(
      requiresChecked,
      Effect.map(
        Effect.all([currentStops, commands.ended, usage.held]),
        ([all, ended, held]) => all.first === null && !ended && !held,
      ),
    )

    // The machine's other tutti and orchestra runs (machineGate.ts): with --machine-workers, the
    // ticket about to start waits while the workers across them are at that cap.
    const machine = yield* makeMachineGate({ holds, status, wakeUp })
    // With the queue's footprint on (§ 8.4), a ticket overlapping a running one's files is held back:
    // the checks' scripts count as no ticket's, and the queue's shared files hold none apart. A ticket works in the worktree the Store saved for
    // it, wherever git had it (a reused one, or one an earlier run's --worktrees put elsewhere), or
    // else in <worktrees>/<id>.
    const footprints = config.settings.queue.footprint
      ? yield* footprintsOf({
          repo: config.repo,
          base,
          checkCommands: checkCommands(config.settings),
          sharedFiles: config.settings.queue.shared_files,
          worktree: (ticket) =>
            Effect.map(
              store.ticket(ticket),
              (saved) => saved?.worktree ?? join(config.worktrees, ticket),
            ),
        })
      : undefined
    // The predictor (predict.ts), as orchestra starts it: with organs, the queue's footprint on and
    // more than one slot, it guesses the files of the ready tickets naming nothing, one ticket at a
    // time in the background, so that a ticket naming nothing doesn't run beside anything.
    const predictor =
      Option.isSome(organs) && footprints !== undefined && config.settings.concurrent > 1
        ? yield* makePredictor({ repo: config.repo }).pipe(
            Effect.provideService(Organs, organs.value),
          )
        : undefined
    // The tickets the last run left whose workers wait for a slot to be resumed (carry.ts): the
    // scheduler dispatches none of them afresh.
    const carrying = yield* Ref.make<ReadonlySet<string>>(new Set())
    const scheduler = yield* makeScheduler({
      concurrent: config.settings.concurrent,
      limit: config.limit,
      scope: config.ticket,
      excludeTypes: config.settings.queue.exclude_types,
      start: { start: ticketFiber },
      taking: Effect.flatMap(taking, (yes) => (yes ? machine.room : Effect.succeed(false))),
      holding: Effect.map(taking, (yes) => !yes),
      machineFull,
      carrying: Ref.get(carrying),
      ...(footprints === undefined ? {} : { footprints }),
      ...(predictor === undefined ? {} : { predictor }),
      closedBranches: branches,
      show: ({ solo, unclosed }) =>
        SubscriptionRef.update(status, (now) => ({ ...now, solo, unclosed })),
    })
    yield* Ref.set(slots, scheduler.recheckSlot)
    yield* machine.attach(scheduler)

    // The run's watchers: one that dies panics the run.
    const watchers = yield* fibers.make("run")
    const watch = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      FiberSet.run(
        watchers,
        Effect.catchDefect(effect, (defect) =>
          panicked("the run", stopFor("PANIC", `the run's fiber: ${firstLine(defect)}`), defect),
        ),
      )
    // The title line's badge while the --keep-awake command holds the machine awake.
    if (options.keepingAwake !== undefined) {
      yield* watch(
        Stream.runForEach(options.keepingAwake, (keepAwake) =>
          SubscriptionRef.update(status, (now) =>
            now.keepAwake === keepAwake ? now : { ...now, keepAwake },
          ),
        ),
      )
    }

    // Requests to quit (quitting.ts): the first quits, the second says what is under way and how to
    // abandon it, and the third ends tutti at once, saving the workers not merged or dropped.
    const quits = yield* makeQuits({
      quitting,
      queue,
      scheduler,
      triage,
      status,
      ...(options.exitNow === undefined ? {} : { exitNow: options.exitNow }),
    })
    // Heard from before the requirements check: a quit during the start's steps cuts the step under
    // way short and skips the rest (untilQuit), so that no worker the last run left is resumed.
    if (options.quits !== undefined) {
      yield* watch(Effect.forever(Effect.flatMap(Queue.take(options.quits), quits.hearQuit)))
    }
    // One of the start's steps, cut short by a quit, `cut` then; not begun once the run quits.
    const untilQuit = <A, E, R>(step: Effect.Effect<A, E, R>, cut: A) =>
      Effect.flatMap(Deferred.isDone(quitting), (done) =>
        done
          ? Effect.succeed(cut)
          : Effect.raceFirst(step, Effect.as(Deferred.await(quitting), cut)),
      )

    // The project's requirements, checked before the first dispatch and before any worker is
    // carried over (requires.ts): what is still missing stops the run, REQUIREMENTS_MISSING, exit 2,
    // and nothing starts or resumes; the workers the last run left stay for the next. A quit cuts an
    // install short, and the run quits with nothing resumed.
    const missing = yield* untilQuit(
      runRequires(config.settings.requires, {
        repo: config.repo,
        installLimit: config.settings.checks.fast.timeout,
      }),
      "",
    )
    if (missing !== "") yield* stopped(stopFor("REQUIREMENTS_MISSING", missing))

    // The tickets earlier runs left unmerged, checked before the first dispatch: one merged by hand
    // since loses its label, so the tickets it blocks can start.
    const loaded = yield* untilQuit(
      Effect.result(loadUnmerged({ repo: config.repo, base })),
      undefined,
    )
    if (loaded !== undefined && Result.isFailure(loaded)) {
      yield* stopped(
        stopFor(
          "BEADS_FAILED",
          `could not read the tickets left unmerged: ${beadsWhy(loaded.failure)}`,
        ),
      )
    }

    // The branches a killed run's trains left rebased onto the branch ahead, put back before their
    // tickets are carried over to merge (mergetrain.ts). One cut short by a quit keeps its mark in
    // state.json, for the next run to put back.
    yield* untilQuit(putBackLeft(config.repo, setUps), undefined)

    // The full check's worktrees a run killed while its full check ran left, removed (fullcheck.ts).
    yield* untilQuit(removeLeftFullChecks, undefined)

    // The workers the last run left (carry.ts), taken up before the first dispatch: each resumed
    // takes a slot, counting toward no limit, its ticket limit counted afresh; one with no slot
    // for it waits for a later look. A quit takes up no more of them: those not yet taken stay in
    // state.json as they were, for the next run.
    // The workers to be resumed that found no slot since the look began, for its end (runEnd.ts).
    const unslotted = yield* Ref.make<ReadonlySet<string>>(new Set())
    const carryOptions: CarryOptions = {
      base,
      queue,
      triage,
      closedBranches: branches,
      onTicketLimit: onResumedLimit,
      carry: (ticket, start, issue) =>
        Effect.tap(
          scheduler.carry(
            ticket,
            Effect.map(start, (worked) =>
              worked === undefined ? undefined : outcomeOf(ticket, worked),
            ),
            issue,
          ),
          (took) =>
            took ? Effect.void : Ref.update(unslotted, (all) => new Set([...all, ticket])),
        ),
    }
    const waitingOf = (carried: ReadonlyMap<string, Carried>) =>
      new Set([...carried].flatMap(([id, what]) => (what === "waiting" ? [id] : [])))
    const carried: ReadonlyMap<string, Carried> =
      missing !== ""
        ? new Map()
        : yield* untilQuit(carryOver(carryOptions).pipe(Effect.provideContext(context)), new Map())
    yield* Ref.set(carrying, waitingOf(carried))

    // The deferred tickets in the run's scope whose blockers have all merged, each a DEFERRED_FREE
    // line of the START block (deferredFree.ts); not when bd can't list those left unmerged.
    if (loaded !== undefined && Result.isSuccess(loaded)) {
      yield* untilQuit(
        sayDeferredFree({
          repo: config.repo,
          base,
          filter: { excludeTypes: config.settings.queue.exclude_types },
          root: config.ticket,
          carried,
          unmerged: new Set(loaded.success.map((left) => left.issue.id)),
          closedBranches: branches,
        }),
        undefined,
      )
    }

    // Held at --machine-workers, the run reads the other runs every machinePoll, and looks again once
    // one of their workers has finished; it doesn't read bd ready meanwhile.
    if (machine.poll !== undefined) yield* watch(machine.poll)
    // Triage's verdicts go on their tickets' rows as they come in.
    yield* watch(
      Stream.runForEach(triage.verdicts, (verdicts) =>
        SubscriptionRef.update(status, (now) => ({ ...now, verdicts })),
      ),
    )
    // How the checks ahead of their turn to merge go shows on their tickets' cards (mergetrain.ts).
    yield* watch(
      Stream.runForEach(queue.checksAhead, (checksAhead) =>
        SubscriptionRef.update(status, (now) => ({ ...now, checksAhead })),
      ),
    )
    // The environment probe's session shows as a card while it runs.
    yield* watch(
      Stream.runForEach(environment.probing, (probe) =>
        SubscriptionRef.update(status, (now) => ({ ...now, probe })),
      ),
    )
    // With the dashboard shown, the machine's load (load.ts), for its load line and each worker's
    // memory in Current. A reading that fails stops the reading, not the run: the line stays as it
    // was last read.
    const loadSource = yield* Load
    if (screen !== null && loadSource !== null) {
      yield* watch(
        watchLoad({
          source: loadSource,
          roots: host.processes,
          self: process.pid,
          show: (load) =>
            Effect.andThen(
              Ref.set(pressed, pressing(load.levels)),
              SubscriptionRef.update(status, (now) => ({ ...now, load })),
            ),
        }).pipe(
          Effect.catchDefect((defect) =>
            Effect.andThen(
              // No longer read: the machine's hold alone counts.
              Ref.set(pressed, false),
              logs.write(
                tagged(
                  "LOAD_FAILED",
                )`${firstLine(defect)}; the machine's load is not shown for the rest of the run`,
              ),
            ),
          ),
        ),
      )
    }
    // The screen's commands, and the hand-backs waiting on steered workers for their views' notices
    // (screenCommands.ts, § 4.3).
    if (screen !== null) {
      yield* commands.listen(screen, { queue, hearQuit: quits.hearQuit, watch, wakeUp })
    }
    // The ready poll, the merge queue's changes and drain requests each wake the run.
    yield* watch(Effect.forever(Effect.andThen(Effect.sleep(readyPoll), wakeUp)))
    yield* watch(
      Stream.runForEach(queue.changes, (state) => Effect.andThen(mergeStop(state), wakeUp)),
    )
    const drains = options.drains
    if (drains !== undefined) {
      yield* watch(
        Effect.forever(
          Effect.andThen(
            Effect.flatMap(Queue.take(drains), (request) => hear(request, queue.rechecks)),
            wakeUp,
          ),
        ),
      )
    }

    // A request unanswered for blockedAfter holds the run with BLOCKED, for its ticket, until its
    // ticket has none open (blockedWatch.ts).
    yield* makeBlockedWatch({ holds, ended: commands.ended, wakeUp, watch })

    // Whether the run would take a ticket now, given a free slot.
    const canTake = Effect.gen(function* () {
      const winding = (yield* ledger.current).windDown !== null
      return (yield* taking) && !winding && !(yield* scheduler.limitReached)
    })
    // Fills the free slots, after the look's other effects, then reads what they left for the end's
    // decision (runEnd.ts).
    const nothingLeft = Effect.gen(function* () {
      // A merge that ends during this look frees what it held back after the look has read it: the
      // run is done only when nothing was merging as the look began, and its wake has it look again.
      const mergedBefore = isSettled(yield* queue.state)
      yield* machine.lookAround
      yield* requeueWaiting(branches)
      // A ticket merged, which may bring what a setup that failed in a ticket's worktree needed.
      yield* retrySetups(setUps)
      // The tickets set aside for a failed check whose base has moved on are checked once more
      // first, each in a slot: each is done but for its merge, and others may wait on it. One left
      // for a hold, a solo ticket or a slot is due again at a later look (recheck.ts).
      yield* queue.recheck
      // The requires list a merge changed, checked before anything starts (requiresChecked).
      yield* requiresChecked
      // The workers carried over that waited for a slot, then the answered tickets, come back
      // before new ones start, each in a slot of its own and counting toward no limit (carry.ts,
      // asked.ts); one with no slot for it waits for a later look. Not while the run holds or
      // winds down, which takes up only what is running: the next run resumes them.
      yield* Ref.set(unslotted, new Set())
      if ((yield* taking) && (yield* ledger.current).windDown === null) {
        const left = yield* carryWaiting(carryOptions, yield* Ref.get(carrying)).pipe(
          Effect.provideContext(context),
        )
        yield* Ref.set(carrying, waitingOf(left))
        yield* takeAnswers(carryOptions)
      }
      if (yield* canTake) {
        const filled = yield* Effect.result(scheduler.fillTrying)
        if (Result.isFailure(filled)) {
          yield* stopped(
            stopFor("BEADS_FAILED", `could not read the queue: ${beadsWhy(filled.failure)}`),
          )
        }
      }
      // For the other runs to count before this one next looks around.
      yield* machine.sayRunning
      const look: Look = {
        mergedBefore,
        tickets: (yield* ledger.current).tickets,
        overLimit: (yield* holds.now).overLimit,
        asking: (yield* attention.current).map((request) => request.ticket),
        running: yield* scheduler.running,
        canTake: yield* canTake,
        resuming: (yield* Ref.get(unslotted)).size > 0,
        settled: isSettled(yield* queue.state),
        triagePending: yield* triage.pending,
        dashboard: screen !== null,
      }
      return look
    })
    // Whether nothing runs but workers waiting for the usage limit.
    // A worker at the limit on a hand-back (Resolving, Fixing) waits for it as one on its ticket
    // does, once its hand-back waits for it: kept for the reset, or on its turn that ended on it, not
    // while it is handed over or what it left is checked.
    const limitedOnly = Effect.gen(function* () {
      const limited = yield* usage.limited
      const handBacks = yield* usage.handBacks
      const over = (yield* holds.now).overLimit
      const waits = (entry: Entry) =>
        limited.has(entry.ticket) &&
        (entry.phase._tag === "Working" ||
          ((entry.phase._tag === "Resolving" || entry.phase._tag === "Fixing") &&
            handBacks.has(entry.ticket)))
      const others = [...(yield* ledger.current).tickets.values()].some(
        (entry) => waitedFor(entry, over) && !waits(entry),
      )
      const merges = yield* queue.state
      return (
        !others &&
        isSettled({ ...merges, resolving: merges.resolving.filter((id) => !handBacks.has(id)) })
      )
    })
    // Waits until nothing is left. With the usage-limit hold on, the run waits for its reset
    // instead, unless a stop ends it anyway; it ends USAGE_LIMIT when it can't wait for it: whether
    // it does. With everything else done and workers waiting on you (D19), a dashboard shows the
    // end-of-run box and waits, until they are answered, their conflicts handed over (§ 4.3), or the
    // box's `q` ends the run; plain, the run waits only until a stop holds it. Gives whether the
    // usage limit ends it, whether the box's `q` did, and the count of the screen's commands acted
    // on before its last look.
    const settle = Effect.gen(function* () {
      for (;;) {
        const seen = yield* commands.acted
        const look = yield* nothingLeft
        const limit = yield* usage.look(yield* limitedOnly)
        if (limit !== null) {
          yield* scheduler.interrupt
          // The hand-backs under way, all of workers at the limit, stop as quitting's do.
          yield* queue.hold
          yield* stopped(limit)
          return { limited: true, asked: false, seen }
        }
        const held = (yield* currentStops).first !== null
        yield* showEndOfRun(status, endOfRunBox(look))
        const endAsked = yield* commands.endAsked
        const end = decide({ ...look, held, usageHeld: yield* usage.held, endAsked })
        if (end._tag === "Done") return { limited: false, asked: end.asked, seen }
        yield* Effect.raceFirst(Queue.take(wake), scheduler.freed)
      }
    })
    // Nothing left: a hold for the environment probes the machine, and goes on or ends the run. A
    // command acted on meanwhile (a hand-back handed over, an answer) has the run look again, the
    // box's `q` it ended on still asked.
    const loop = Effect.gen(function* () {
      for (;;) {
        const { limited, asked, seen } = yield* settle
        if (limited) {
          yield* commands.endAfter(null)
          break
        }
        // The probe runs only with its hold's stop alone, the first; it lifts or replaces only
        // that one, those raised while it waited (BLOCKED, TICKET_LIMIT, PAUSED) kept.
        const before = yield* currentStops
        const probed = yield* environment.probe(before)
        const held = before.first
        if (probed._tag === "Resumed" && held !== null) {
          yield* changeHolds((now) => changeStops(now, (all) => swapStop(all, held, null)))
          continue
        }
        if (probed._tag === "Failed" && held !== null) {
          yield* changeHolds((now) => changeStops(now, (all) => swapStop(all, held, probed.stop)))
        }
        if (yield* commands.endAfter(seen)) break
        if (asked) yield* commands.askEnd
      }
    })

    // A panic in the loop quits the run as one in its other fibers does.
    const guardedLoop = Effect.catchDefect(Effect.as(loop, null), (defect) =>
      Effect.andThen(
        panicked("the run", stopFor("PANIC", `the run's loop: ${firstLine(defect)}`), defect),
        Effect.never,
      ),
    )
    // A quit heard before the loop, during the start's steps, starts no ticket.
    const quit = (yield* Deferred.isDone(quitting))
      ? yield* Deferred.await(quitting)
      : yield* Effect.raceFirst(guardedLoop, Deferred.await(quitting))
    // The loop's end set it already, under the commands' lock; a quit sets it at once, without
    // waiting for a command acting now: quitting holds the merges and interrupts the workers.
    yield* commands.end
    // No ticket is taken any more: the guess under way is aborted.
    if (predictor !== undefined) yield* predictor.interrupt
    // A worker past its ticket limit, or waiting on you, is still at it: every ticket's fiber is
    // stopped now, before anything else of the end, so that an answer through `tutti answer`, which
    // the loop's end doesn't wait for, can't run a worker on into the end's steps; the answers are
    // refused from then on. Quitting stops them in its own order (quitNow).
    const over = (yield* holds.now).overLimit
    const asking =
      quit === null
        ? new Set((yield* attention.current).map((request) => request.ticket))
        : new Set<string>()
    if (quit === null) yield* Effect.andThen(scheduler.interrupt, quits.refuseAnswers)
    yield* showEndOfRun(status, null)
    if (quit !== null) yield* quits.quitNow(quit)
    yield* mergeStop(yield* queue.state)
    // A ticket set aside and merged by hand since the base last moved counts closed, for the end
    // line and the report (handMerged.ts).
    if (quit === null) yield* queue.mergedByHand

    // The end (endOfRun.ts): the tickets a run can't end in Stopped, and every stopped ticket's
    // session suspended.
    const end = yield* makeEndOfRun({
      version: options.version,
      base,
      begun,
      subscription: options.subscription ?? false,
      usage,
      setUps,
      scheduler,
      quitting,
    })
    const { saved, handedBack, neverSent } = yield* end.suspend({
      quit,
      over,
      asking,
      stops: yield* currentStops,
      open: quits.openWorkers,
    })

    // Quitting's last step: the run ends INTERRUPTED (exit 130), or PANIC (exit 4), before any
    // stop the run had.
    if (quit !== null) {
      const stop =
        "panic" in quit
          ? quit.panic
          : stopFor("INTERRUPTED", interruptedText(quit.request.how, saved, handedBack))
      yield* changeHolds((now) => changeStops(now, (all) => putFirst(all, stop)))
    }
    yield* changeHolds((now) => changeStops(now, (all) => extendFirst(all, neverSent)))
    const all = yield* currentStops
    // A stopped run names the tickets it leaves without the check once more it promised them.
    if (quit === null && all.first !== null) yield* dropRechecks(queue.rechecks, "the run stopped")

    // The summary lines, then the closing line: the stops', or how the run ended by itself.
    const state = yield* ledger.current
    const { lines: summary, summary: summarised } = yield* end.summary(state)
    const { line: closing, ending: closed } = yield* end.closing(state, all, summarised.took)

    // The full check, after a run that ended by itself and merged a ticket (fullcheck.ts).
    const phases: Record<string, TicketPhase> = {}
    for (const entry of state.tickets.values()) phases[entry.ticket] = entry.phase
    // The report's evidence beside the log, in orchestra's order: the failed checks, the full
    // check, the follow-ups filed outside the scope, the feature request.
    const sections = [...failedChecksSection(state.tickets, yield* queue.rechecks.failures)]
    const checked = yield* end.fullCheck(Object.values(phases), all.first !== null, quit)
    const said = [...summary, closing, ...checked.said]
    sections.push(...checked.sections)
    const exitCode = checked.code ?? exitCodeOf(all)

    // Gathered only for a report, which a quit skips: bd lists the scope's tickets level by level.
    const quitted = quit !== null || (yield* Deferred.isDone(quitting))
    const reviews = Option.isSome(organs) && config.settings.organs.review && !quitted
    if (config.ticket !== null && reviews) {
      sections.push(...(yield* followUpsSection(beads, config.ticket, begun)))
    }
    if (config.feature !== null) sections.push(section("The feature request", config.feature))

    // The report, over the run's services, when it has organs: skipped once the run was quit.
    const reportRun: ReportRun = {
      started: begun,
      base,
      startHead,
      ending: closed,
      exitCode,
      quit: quitted,
      sections,
      ...(checked.after === "" ? {} : { after: checked.after }),
    }
    const reportContext = yield* Effect.context<RunEnv | Ledger>()
    const cost = yield* Effect.serviceOption(OrganCost)
    const report = (out: Effect.Effect<ReportOut>): Effect.Effect<void> =>
      Option.isNone(organs) || Option.isNone(cost)
        ? Effect.void
        : runReport(reportRun, out).pipe(
            Effect.provideService(Organs, organs.value),
            Effect.provideService(OrganCost, cost.value),
            Effect.provideContext(reportContext),
          )
    const outcome: Outcome = {
      exitCode,
      phases,
      ending: said,
      // The styled summary, printed after the full check, counts it in its figures.
      summary: { ...summarised, figures: yield* end.figures },
      closing: closed,
      after: said.slice(summary.length + 1),
      report,
    }
    if (options.endLater) return outcome
    yield* Effect.flatMap(endRecord(exitCode), events.emit)
    return outcome
  }).pipe(Effect.provide(Ledger.layer))

/**
 * What follows a run that left it to its caller (RunOptions.endLater), on the main screen once the
 * dashboard's renderer is gone (§ 5 item 14 "Then", § 7.1): when `styled`, the summary, the
 * closing and scope lines and the lines after them, in `out`'s theme, as a plain run's log has
 * already said them; then the report, its outcome said by the log alone when not `styled`, and
 * the end record. Ctrl+C interrupting it ends the run
 * INTERRUPTED. Gives the run's exit code. `out` is made only when something prints on it: a plain
 * run's report theme asks the terminal for its background (OSC 11).
 */
export const finish = (
  outcome: Outcome,
  made: Effect.Effect<ReportOut>,
  styled: boolean,
): Effect.Effect<number, never, EventStream> =>
  Effect.gen(function* () {
    const events = yield* EventStream
    // A plain run's log prints on stdout as the report does: what it says isn't said again.
    let out = styled ? made : Effect.map(made, (printed) => ({ ...printed, logged: true }))
    if (styled) {
      const printed = yield* made
      yield* printSummary(
        printed.printer,
        outcome.summary,
        outcome.closing,
        printed.theme,
        printed.width,
      )
      if (outcome.after.length > 0) yield* printed.printer.print(outcome.after.join("\n"))
      out = Effect.succeed(printed)
    }
    yield* outcome
      .report(out)
      .pipe(Effect.onInterrupt(() => Effect.flatMap(endRecord(exitCodes.interrupted), events.emit)))
    yield* Effect.flatMap(endRecord(outcome.exitCode), events.emit)
    return outcome.exitCode
  })
