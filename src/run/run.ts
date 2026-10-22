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
import { join } from "node:path"
import {
  Cause as Causes,
  Clock,
  Deferred,
  Duration,
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
import {
  type AgentGone,
  AgentHost,
  type AgentProtocol,
  type AgentStartFailed,
} from "../agent/AgentHost.ts"
import { Attention, blockedAfter } from "../agent/Attention.ts"
import { serve } from "../agent/attentionFiles.ts"
import type { Transcripts } from "../agent/Transcripts.ts"
import type { UsageLimits } from "../agent/UsageLimits.ts"
import { AppConfig } from "../cli/AppConfig.ts"
import { section } from "../organs/evidence.ts"
import { OrganCost } from "../organs/OrganCost.ts"
import { Organs } from "../organs/Organs.ts"
import { Ending, printSummary, type Summary } from "../print/summary.ts"
import { formatDuration } from "../project/configFile.ts"
import { checkCommands } from "../project/settings.ts"
import { Beads, type Issue } from "../services/Beads.ts"
import { Git } from "../services/Git.ts"
import { Notifier } from "../services/Notifier.ts"
import { Store } from "../services/Store.ts"
import { outputMode, Tty } from "../services/Tty.ts"
import { schemeNotices } from "../ui/theme.ts"
import { takeAnswers } from "./asked.ts"
import { carryOver, saveAsked, saveLeft } from "./carry.ts"
import { closedBranches } from "./closedBranches.ts"
import { resolve, type UiCommand } from "./commands.ts"
import { noteCompactions } from "./compactions.ts"
import { sayAtStart as sayDeferredFree } from "./deferredFree.ts"
import { type DrainRequest, drainedLine, hear } from "./drain.ts"
import { make as makeEnvironmentHold } from "./environment.ts"
import { EventStream } from "./eventstream.ts"
import { RunFibers } from "./fibers.ts"
import { fullCheck, fullCheckDue, fullCheckEvidence, fullCheckReport } from "./fullcheck.ts"
import {
  blockedAt,
  blockedLifted,
  blockedStop,
  blockedTickets,
  changeStops,
  exitCodeOf,
  exitCodes,
  extendFirst,
  type Holds,
  liftBlocked,
  noHolds,
  noMoreWork,
  pastTicketLimit,
  putFirst,
  raiseStop,
  type StopReason,
  shownHolds,
  showUsage,
  stopFor,
  stopOfLine,
  stopsLine,
  swapStop,
  withMachineHold,
} from "./holds.ts"
import { type Entry, handBackWaits, Ledger, type State } from "./ledger.ts"
import { Load, pressing, watchLoad } from "./load.ts"
import { detail, hold, type Line, Log, line, tagged } from "./log.ts"
import {
  holdLine as machineHoldLine,
  machinePoll,
  make as makeMachine,
  OtherWorkers,
} from "./machine.ts"
import { beadsWhy, closedAfter, gitWhy } from "./merge.ts"
import { isSettled, make as makeQueue, type QueueState } from "./mergequeue.ts"
import { putBackLeft } from "./mergetrain.ts"
import { finished } from "./notices.ts"
import { Cause, type PhaseTag, stopsAtEnd, type TicketPhase } from "./phase.ts"
import { make as makePredictor } from "./predict.ts"
import {
  type Awaited,
  atOnceText,
  fromDashboard,
  heard,
  interruptedText,
  interruptWorkers,
  panicLines,
  type QuitRequest,
  quitLine,
  quittingText,
  stillQuittingLine,
  unansweredLine,
  underWayLine,
} from "./quit.ts"
import { dropRechecks } from "./recheck.ts"
import { type ReportOut, type ReportRun, runReport } from "./report.ts"
import { failedChecksSection, followUpsSection } from "./reportEvidence.ts"
import { runRequires } from "./requires.ts"
import { emptyStatus, project, type Row, type Status, same, type Totals } from "./runView.ts"
import { footprintsOf, make as makeScheduler, readyPoll, type Scheduler } from "./schedule.ts"
import * as scope from "./scope.ts"
import { type Dashboard, Screen, show } from "./screen.ts"
import { makeSetUps, retrySetups, setupWaiting, setupWaitsPart } from "./setup.ts"
import { endRecord } from "./spending.ts"
import { handBackNow, interrupt, releaseAndHandOver, sendMessage } from "./steer.ts"
import { make as makeTriage, off as triageOff } from "./triage.ts"
import { labelAtEnd, loadUnmerged } from "./unmerged.ts"
import { make as makeUsageHold, neverHanded } from "./usageLimit.ts"
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
  | Notifier
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner

/** The errors the Agent SDK fails with. */
type AgentError = AgentStartFailed | AgentGone | AgentProtocol

/** The phases of a ticket the run is still at: the HOLD line counts them as running. */
const running: ReadonlySet<PhaseTag> = new Set([
  "Working",
  "ToMerge",
  "Merging",
  "Resolving",
  "Fixing",
])

/**
 * Whether the ticket `entry` is one the run waits for: running, and not a worker it stopped for
 * TICKET_LIMIT (`over`) still at it, which goes on until the run ends.
 */
const waitedFor = (
  entry: { readonly ticket: string; readonly phase: TicketPhase },
  over: ReadonlySet<string>,
) => running.has(entry.phase._tag) && !(entry.phase._tag === "Working" && over.has(entry.ticket))

/** How many of the run's tickets are still running, those over their ticket limit left out. */
const runningIn = (state: State, over: ReadonlySet<string>): number =>
  [...state.tickets.values()].filter((entry) => waitedFor(entry, over)).length

/** The stop a ticket's fiber failing with `error` stops the run for (§ 5 item 10). */
export const errorStop = (ticket: string, error: WorkError | AgentError): StopReason => {
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
    case "AgentStartFailed":
    case "AgentGone":
    case "AgentProtocol":
      return stopFor("AGENT_FAILED", `${ticket}'s worker: ${error.message}`, { ticket })
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

/** Why the run quits: a request to quit now, or a panic in one of its fibers (§ 4.8, § 7.4). */
type Quitting = { readonly request: QuitRequest } | { readonly panic: StopReason }

/** The stop a ticket's fiber ending with `cause` stops the run for, if any. */
const causeStop = (ticket: string, cause: Causes.Cause<WorkError>): StopReason | undefined => {
  if (Causes.hasInterruptsOnly(cause)) return undefined
  const error = Causes.findError(cause)
  if (Result.isSuccess(error)) return errorStop(ticket, error.success)
  const defect = Causes.findDefect(cause)
  return panicStop(ticket, Result.isSuccess(defect) ? defect.success : Causes.pretty(cause))
}

/** The time a run took, to the second: `2m5s`, `45s`, `1h12m`. */
export const runTime = (millis: number): string => {
  const seconds = Math.floor(Math.max(0, millis) / 1000)
  return seconds === 0 ? "0s" : formatDuration(Duration.seconds(seconds))
}

/** The run's summary as plain lines (§ 7.1): its title, its totals and every ticket's row. */
export const summaryLines = (s: {
  readonly version: string
  readonly base: string
  readonly scope: string | null
  readonly took: number
  readonly totals: Totals
  readonly rows: ReadonlyArray<Row>
}): ReadonlyArray<Line> => {
  const scoped = s.scope === null ? "" : line` · ticket ${s.scope}`
  const { totals } = s
  return [
    line`tutti ${s.version} on ${s.base}${scoped} · ${runTime(s.took)}`,
    detail`Completed ${totals.completed} · Set aside ${totals.deferred + totals.review} · Needs you ${totals.needsYou}`,
    ...s.rows.map((row) => detail`${row.mark} ${row.ticket} ${row.word}: ${row.note}`),
  ]
}

/** The done line of a run that ended by itself, before a scoped run's SCOPE_ part. */
export const doneLine = (n: number, how: "drained" | "limit" | "empty"): Line =>
  how === "drained"
    ? drainedLine(n)
    : how === "limit"
      ? line`LIMIT_REACHED at ${n} tickets`
      : line`READY_EMPTY after ${n} tickets`

/**
 * `root`, when the run closed it, an epic whose last subticket merged in this run: its close reason
 * names a ticket the run merged. None when it didn't, or bd can't show it.
 */
const closedByRun = (
  beads: Beads["Service"],
  root: string,
  state: State,
): Effect.Effect<ReadonlySet<string>> =>
  beads.show(root).pipe(
    Effect.map((issue): ReadonlySet<string> => {
      const after = issue.status === "closed" ? closedAfter(issue.closeReason) : undefined
      return after !== undefined && state.tickets.get(after)?.phase._tag === "Done"
        ? new Set([root])
        : new Set()
    }),
    Effect.orElseSucceed((): ReadonlySet<string> => new Set()),
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
    const notifier = yield* Notifier
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
    // The end-of-run box (D19): the workers waiting on you it names, or null for none.
    const showEndOfRun = (tickets: ReadonlyArray<string> | null) =>
      Effect.gen(function* () {
        const now = yield* SubscriptionRef.get(status)
        if (!same(now.endOfRun, tickets)) {
          yield* SubscriptionRef.set(status, { ...now, endOfRun: tickets })
        }
      })
    // Set by the end-of-run box's `q`, taken by the run's next look.
    const endAsked = yield* Ref.make(false)

    // What holds the run (holds.ts): its stops, the tickets past --ticket-limit, the machine's hold
    // and the usage limit's view, changed one change at a time, each shown on the dashboard as it
    // comes: `· stopping` while a stop holds the run, the banners, the usage line and its notice.
    // A change gives the holds it found.
    const holds = yield* SubscriptionRef.make<Holds>(noHolds)
    const oneChange = yield* Semaphore.make(1)
    const changeHolds = (change: (now: Holds) => Holds) =>
      oneChange.withPermits(1)(
        Effect.gen(function* () {
          const before = yield* SubscriptionRef.get(holds)
          const after = change(before)
          if (after === before) return before
          yield* SubscriptionRef.set(holds, after)
          const { notice, ...shown } = shownHolds(after)
          const next = { ...shown, warnings: [...notices, ...(notice === null ? [] : [notice])] }
          const { stopping, holds: banners, usage, warnings } = yield* SubscriptionRef.get(status)
          if (!same({ stopping, holds: banners, usage, warnings }, next)) {
            yield* SubscriptionRef.update(status, (now) => ({ ...now, ...next }))
          }
          return before
        }),
      )
    const currentStops = Effect.map(SubscriptionRef.get(holds), (now) => now.stops)
    // Set once the run ends, so that nothing starts after it.
    const ending = yield* Ref.make(false)
    // The screen's commands that act on the run act one at a time under `acting`, each counted in
    // `acted`; the run's end is set under it too, once its last look saw every command acted on, so
    // that none acts after the end (a hand-back merged, a worker steered, after the summary).
    const acting = yield* Semaphore.make(1)
    const acted = yield* Ref.make(0)
    // Wakes the run to look again: a merge, a stop, a drain request, the ready poll.
    const wake = yield* Queue.sliding<void>(1)
    const wakeUp = Queue.offer(wake, undefined)
    // The first request to quit, or a panic, ends the loop below, and the run quits (quit.ts).
    const quitting = yield* Deferred.make<Quitting>()
    // What quitting waits for, for a second request to say.
    const awaiting = yield* Ref.make<ReadonlyArray<Awaited>>([])
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

    // A stop holds the run: said as it comes while tickets still run, unless its line was. A worker
    // past its ticket limit goes on, so its hold is said even with nothing else running. `raise`
    // puts the stop among the holds.
    const stopped = (
      stop: StopReason,
      raise: (now: Holds) => Holds = (now) => raiseStop(now, stop),
    ) =>
      Effect.gen(function* () {
        yield* changeHolds(raise)
        const now = runningIn(yield* ledger.current, (yield* SubscriptionRef.get(holds)).overLimit)
        if (!stop.held && (now > 0 || stop.why === "TICKET_LIMIT")) {
          const text = hold(stop.text, now)
          yield* logs.writeWith(
            [text],
            events.emit({
              kind: "hold",
              ...(stop.ticket === undefined ? {} : { ticket: stop.ticket }),
              ...(stop.blocked === undefined ? {} : { blocked: stop.blocked }),
              text,
            }),
          )
        }
        yield* wakeUp
      })

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
    // Whether the run holds at --machine-workers (below): no ticket is checked ahead of its turn to
    // merge then (mergetrain.ts).
    const machineFull = Effect.map(SubscriptionRef.get(holds), (now) => now.machine)
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

    const taking = Effect.map(
      Effect.all([currentStops, Ref.get(ending), usage.held]),
      ([all, ended, held]) => all.first === null && !ended && !held,
    )

    // The machine's other tutti and orchestra runs (machine.ts): the run registers among them, says
    // once of each that it is going (SHARED_MACHINE), and that it has ended. With --machine-workers,
    // the ticket about to start waits while the workers across them, this run's included, are at
    // that cap, with one of this run's among them (HOLD: MACHINE, said once a hold): a run with no
    // worker of its own running never waits, so one at the cap with others' workers alone gets on.
    const machine = yield* makeMachine({
      dir: config.runs,
      repo: config.repo,
      concurrent: config.settings.concurrent,
      cannot: (why) => logs.write(detail`${why}`),
    })
    // The other runs' workers, as each look reads them: a worker's share of the cores counts them.
    const otherWorkers = yield* OtherWorkers
    // The run's workers the others count, and the cap: the slots the scheduler, made after the
    // cap's hold it asks, counts taken (slotsTaken). Tickets merging or waiting to merge take none
    // up to concurrent of them, so they hold the run at no cap; none is taken before it is made.
    const schedulerSlots = yield* Ref.make<Effect.Effect<number>>(Effect.succeed(0))
    const ownWorkers = Effect.flatten(Ref.get(schedulerSlots))
    // The scheduler's queue record, once it is made: the hold's start and end each write one.
    const queueRecord = yield* Ref.make<Effect.Effect<void>>(Effect.void)
    const atCap = Effect.gen(function* () {
      const own = yield* ownWorkers
      const cap = config.machineWorkers
      return cap > 0 && own > 0 && own + (yield* machine.others) >= cap
    })
    // Sets whether the run holds a free slot at the cap, its word on the title line meanwhile, and
    // says whether the hold began.
    const holdMachine = (full: boolean) =>
      Effect.gen(function* () {
        if ((yield* changeHolds((now) => withMachineHold(now, full))).machine === full) return false
        if (!full) yield* Effect.flatten(Ref.get(queueRecord))
        return full
      })
    // Writes how many of the run's workers run, reads the other runs, saying which started and
    // ended and keeping how many workers they run (OtherWorkers) and how many runs share the machine
    // (the title line's `· shared with 1 run`), and lifts the hold once the machine is under the cap.
    const lookAround = Effect.gen(function* () {
      yield* machine.running(yield* ownWorkers)
      const seen = yield* machine.look
      for (const each of seen) {
        yield* logs.writeWith(
          [each.text],
          events.emit({ kind: "shared_machine", shared: each.shared, text: each.text }),
        )
      }
      const last = seen.at(-1)
      if (last !== undefined) {
        yield* SubscriptionRef.update(status, (now) =>
          now.shared === last.shared ? now : { ...now, shared: last.shared },
        )
      }
      yield* otherWorkers.set(yield* machine.others)
      if (!(yield* atCap)) yield* holdMachine(false)
    })
    // Whether the machine has room for the ticket about to start.
    const machineRoom = Effect.gen(function* () {
      if (!(yield* atCap)) {
        yield* holdMachine(false)
        return true
      }
      if (yield* holdMachine(true)) {
        const own = yield* ownWorkers
        const text = machineHoldLine(own + (yield* machine.others), own, config.machineWorkers)
        yield* logs.writeWith([text], events.emit({ kind: "machine_hold", text }))
        yield* Effect.flatten(Ref.get(queueRecord))
      }
      return false
    })
    // With the queue's footprint on (§ 8.4), a ticket overlapping a running one's files is held back:
    // the checks' scripts count as no ticket's. A ticket works in the worktree the Store saved for
    // it, wherever git had it (a reused one, or one an earlier run's --worktrees put elsewhere), or
    // else in <worktrees>/<id>.
    const footprints = config.settings.queue.footprint
      ? yield* footprintsOf({
          repo: config.repo,
          base,
          checkCommands: checkCommands(config.settings),
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
    const scheduler = yield* makeScheduler({
      concurrent: config.settings.concurrent,
      limit: config.limit,
      scope: config.ticket,
      excludeTypes: config.settings.queue.exclude_types,
      start: { start: ticketFiber },
      taking: Effect.flatMap(taking, (yes) => (yes ? machineRoom : Effect.succeed(false))),
      machineFull,
      ...(footprints === undefined ? {} : { footprints }),
      ...(predictor === undefined ? {} : { predictor }),
      closedBranches: branches,
      show: ({ solo, unclosed }) =>
        SubscriptionRef.update(status, (now) => ({ ...now, solo, unclosed })),
    })
    yield* Ref.set(slots, scheduler.recheckSlot)
    yield* Ref.set(queueRecord, scheduler.recordQueue)
    yield* Ref.set(schedulerSlots, scheduler.slots)

    // The project's requirements, checked before the first dispatch and before any worker is
    // carried over (requires.ts): what is still missing stops the run, REQUIREMENTS_MISSING, exit 2,
    // and nothing starts or resumes; the workers the last run left stay for the next. A request to
    // quit cuts an install short: it is heard once the run listens for them, below, and the run
    // quits with nothing resumed.
    const quitEarly = yield* Ref.make<QuitRequest | null>(null)
    const checking = runRequires(config.settings.requires, {
      repo: config.repo,
      installLimit: config.settings.checks.fast.timeout,
    })
    const quitsNow = options.quits
    const missing =
      quitsNow === undefined
        ? yield* checking
        : yield* Effect.raceFirst(
            checking,
            Effect.flatMap(Queue.take(quitsNow), (request) =>
              Effect.as(Ref.set(quitEarly, request), ""),
            ),
          )
    if (missing !== "") yield* stopped(stopFor("REQUIREMENTS_MISSING", missing))

    // The tickets earlier runs left unmerged, checked before the first dispatch: one merged by hand
    // since loses its label, so the tickets it blocks can start.
    const loaded = yield* Effect.result(loadUnmerged({ repo: config.repo, base }))
    if (Result.isFailure(loaded)) {
      yield* stopped(
        stopFor(
          "BEADS_FAILED",
          `could not read the tickets left unmerged: ${beadsWhy(loaded.failure)}`,
        ),
      )
    }

    // The branches a killed run's trains left rebased onto the branch ahead, put back before their
    // tickets are carried over to merge (mergetrain.ts).
    yield* putBackLeft(config.repo, setUps)

    // The workers the last run left (carry.ts), taken up before the first dispatch: each resumed
    // takes a slot, counting toward no limit, its ticket limit counted afresh.
    const carried =
      missing !== "" || (yield* Ref.get(quitEarly)) !== null
        ? new Map()
        : yield* carryOver({
            base,
            queue,
            triage,
            closedBranches: branches,
            onTicketLimit: (stop) =>
              stop.ticket === undefined ? stopped(stop) : onTicketLimit(stop.ticket)(stop),
            carry: (ticket, worked, issue) =>
              scheduler.carry(ticket, outcomeOf(ticket, worked), issue),
          }).pipe(Effect.provideContext(context))

    // The deferred tickets in the run's scope whose blockers have all merged, each a DEFERRED_FREE
    // line of the START block (deferredFree.ts); not when bd can't list those left unmerged.
    if (Result.isSuccess(loaded)) {
      yield* sayDeferredFree({
        repo: config.repo,
        base,
        filter: { excludeTypes: config.settings.queue.exclude_types },
        root: config.ticket,
        carried,
        unmerged: new Set(loaded.success.map((left) => left.issue.id)),
        closedBranches: branches,
      })
    }

    // The ready poll, the merge queue's changes and drain requests each wake the run. A watcher that
    // dies panics the run.
    const watchers = yield* fibers.make("run")
    const watch = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      FiberSet.run(
        watchers,
        Effect.catchDefect(effect, (defect) =>
          panicked("the run", stopFor("PANIC", `the run's fiber: ${firstLine(defect)}`), defect),
        ),
      )
    // Held at --machine-workers, the run reads the other runs every machinePoll, and looks again once
    // one of their workers has finished, so that the slot it freed is filled within seconds; it
    // doesn't read bd ready meanwhile.
    if (config.runs !== null && config.machineWorkers > 0) {
      yield* watch(
        Effect.forever(
          Effect.gen(function* () {
            yield* Effect.sleep(machinePoll)
            if (!(yield* machineFull)) return
            yield* lookAround
            if (!(yield* machineFull)) yield* wakeUp
          }),
        ),
      )
    }
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
    // The hand-backs waiting on steered workers, for their views' notices (§ 4.3).
    if (screen !== null) {
      yield* watch(
        Stream.runForEach(queue.handBacks.changes, (stops) =>
          SubscriptionRef.set(
            screen.handBacks,
            stops.map((stop) => stop.ticket.id),
          ),
        ),
      )
    }
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

    // Requests to quit (quit.ts): the first quits, the second says what is under way and how to
    // abandon it, and the third ends tutti at once, saving the workers not merged or dropped.
    const atOnce = (request: QuitRequest) =>
      Effect.gen(function* () {
        const merging = (yield* queue.state).merging
        const saved: Array<string> = []
        for (const entry of (yield* ledger.current).tickets.values()) {
          const phase = entry.phase
          if (!stopsAtEnd(phase) && phase._tag !== "Merging" && phase._tag !== "Stopped") continue
          if ((yield* store.ticket(entry.ticket))?.session === undefined) continue
          const why = phase._tag === "Stopped" ? phase.why : "quit"
          yield* Effect.ignore(store.suspend(entry.ticket, why, "Stopped"))
          saved.push(entry.ticket)
        }
        yield* saveAsked
        yield* saveLeft
        const stop = stopFor("INTERRUPTED", atOnceText(request.how, saved, merging))
        yield* logs.writeWith(
          [stop.text],
          events.emit({ kind: "stop", detail: stop.why, text: stop.text }),
        )
        yield* Effect.flatMap(endRecord(stop.code), events.emit)
        if (options.exitNow !== undefined) yield* options.exitNow(stop.code, [stop.text])
      })
    let asked = 0
    const hearQuit = (request: QuitRequest) =>
      Effect.gen(function* () {
        asked += 1
        switch (heard(asked)) {
          case "quit":
            yield* Deferred.succeed(quitting, { request })
            return
          case "warn": {
            const merging = (yield* queue.state).merging
            const text =
              merging === null
                ? stillQuittingLine(yield* Ref.get(awaiting), request)
                : underWayLine(merging, request)
            yield* logs.writeWith(
              [text],
              events.emit({
                kind: "warn",
                ...(merging === null ? {} : { ticket: merging }),
                text,
              }),
            )
            return
          }
          case "exit":
            yield* atOnce(request)
        }
      })
    const quits = options.quits
    if (quits !== undefined) {
      const early = yield* Ref.get(quitEarly)
      if (early !== null) yield* hearQuit(early)
      yield* watch(Effect.forever(Effect.flatMap(Queue.take(quits), hearQuit)))
    }
    // The screen's commands, each resolved against the ledger and the open requests as it is taken:
    // one that no longer names anything (the worker finished, the request was answered) is dropped.
    // The end-of-run box's `q` (EndRun) ends the run. Quit without `now` is the quit box's to ask.
    // Steering's commands (SendMessage, Interrupt, Release, HandBackNow) go to steer.ts. Once the
    // run ends, only moving between the views and quitting act: the others are dropped.
    if (screen !== null) {
      // A command that acts on the run, once resolved.
      const act = (command: UiCommand) =>
        Effect.gen(function* () {
          switch (command._tag) {
            case "OpenWorker":
            case "CloseWorker":
            case "Quit":
              return
            case "Answer":
              return yield* attention
                .answer(command.requestId, command.answer, "screen")
                .pipe(Effect.catch((error) => Effect.logDebug(`dropped Answer: ${error.message}`)))
            case "Drain":
            case "Undrain":
              yield* hear({ on: command._tag === "Drain", how: fromDashboard.how }, queue.rechecks)
              return yield* wakeUp
            case "EndRun":
              yield* Ref.set(endAsked, true)
              return yield* wakeUp
            case "SendMessage":
              return yield* sendMessage(command.ticket, command.text, command.uuid)
            case "Interrupt":
              return yield* interrupt(command.ticket)
            case "Release":
              if (yield* releaseAndHandOver(command.ticket, queue, { repo: config.repo, base })) {
                yield* wakeUp
              }
              return
            case "HandBackNow":
              yield* handBackNow(command.ticket, queue, { repo: config.repo, base })
              return yield* wakeUp
          }
        })
      const take = (command: UiCommand) =>
        Effect.gen(function* () {
          const resolved = resolve(command, {
            ledger: yield* ledger.current,
            requests: yield* attention.current,
          })
          if (Result.isFailure(resolved)) {
            yield* Effect.logDebug(`dropped ${resolved.failure.message}`)
            return
          }
          switch (command._tag) {
            case "OpenWorker":
              return yield* SubscriptionRef.set(
                screen.screen,
                Screen.Worker({ ticket: command.ticket }),
              )
            case "CloseWorker":
              return yield* SubscriptionRef.set(screen.screen, Screen.Dashboard())
            case "Quit":
              if (command.now) yield* hearQuit(fromDashboard)
              return
          }
          yield* acting.withPermits(1)(
            Effect.gen(function* () {
              if (yield* Ref.get(ending)) {
                yield* Effect.logDebug(`dropped ${command._tag}: the run has ended`)
                return
              }
              yield* act(command)
              yield* Ref.update(acted, (n) => n + 1)
            }),
          )
        })
      yield* watch(Effect.forever(Effect.flatMap(Queue.take(screen.commands), take)))
    }

    // A request unanswered for blockedAfter holds the run with BLOCKED, for its ticket; once that
    // ticket has none open, the hold is lifted (holds.ts). Each request is looked at again as it
    // reaches its time, and every request open at each change, which wakes the run too: a worker
    // that asks, or is answered, may end it or keep it open (D19).
    const oneLook = yield* Semaphore.make(1)
    const lookBlocked = oneLook.withPermits(1)(
      Effect.gen(function* () {
        if (yield* Ref.get(ending)) return
        const held = blockedTickets(yield* SubscriptionRef.get(holds))
        const now = yield* Clock.currentTimeMillis
        const { trips, lifts } = blockedAt(yield* attention.current, held, now, blockedAfter)
        if (trips.length === 0 && lifts.length === 0) return
        for (const ticket of lifts) {
          yield* changeHolds((now) => liftBlocked(now, ticket))
          const text = blockedLifted(ticket)
          yield* logs.writeWith([text], events.emit({ kind: "hold", ticket, lifted: true, text }))
        }
        for (const trip of trips) yield* stopped(blockedStop(trip.ticket, trip.what))
        yield* wakeUp
      }),
    )
    const timed = new Set<string>()
    yield* watch(
      Stream.runForEach(attention.open, (requests) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          for (const request of requests) {
            if (timed.has(request.id)) continue
            timed.add(request.id)
            const left = request.createdAt + Duration.toMillis(blockedAfter) - now
            yield* watch(
              Effect.andThen(Effect.sleep(Duration.millis(Math.max(0, left))), lookBlocked),
            )
          }
          yield* lookBlocked
          yield* wakeUp
        }),
      ),
    )

    // Whether the run would take a ticket now, given a free slot.
    const canTake = Effect.gen(function* () {
      const winding = (yield* ledger.current).windDown !== null
      return (yield* taking) && !winding && !(yield* scheduler.limitReached)
    })
    // Fills the free slots, then says whether nothing else runs, waits to merge or could start, and
    // which workers wait on you (an open request) besides, oldest request first: those past their
    // ticket limit left out, as the run doesn't wait for them; then, with a dashboard, those a
    // conflict hand-back waits for.
    const nothingLeft = Effect.gen(function* () {
      // A merge that ends during this look frees what it held back after the look has read it: the
      // run is done only when nothing was merging as the look began, and its wake has it look again.
      const mergedBefore = isSettled(yield* queue.state)
      yield* lookAround
      yield* requeueWaiting(branches)
      // A ticket merged, which may bring what a setup that failed in a ticket's worktree needed.
      yield* retrySetups(setUps)
      // The tickets set aside for a failed check whose base has moved on are checked once more
      // first, each in a slot: each is done but for its merge, and others may wait on it. One left
      // for a hold, a solo ticket or a slot is due again at a later look (recheck.ts).
      yield* queue.recheck
      // A merge that changed the requires list has it checked again before the next ticket starts
      // (requires.ts): what is still missing stops the run as at its start, the running tickets
      // finishing first.
      if (yield* setUps.requiresDue) {
        const missing = yield* runRequires(yield* setUps.requires, {
          repo: config.repo,
          installLimit: config.settings.checks.fast.timeout,
        })
        if (missing !== "") yield* stopped(stopFor("REQUIREMENTS_MISSING", missing))
      }
      // The answered tickets come back before new ones start, each in a slot of its own and
      // counting toward no limit (asked.ts); not while the run holds or winds down, which takes up
      // only what is running: the next run resumes them.
      if ((yield* taking) && (yield* ledger.current).windDown === null) {
        yield* takeAnswers({
          base,
          queue,
          triage,
          closedBranches: branches,
          carry: (ticket, fiber, issue) => scheduler.carry(ticket, outcomeOf(ticket, fiber), issue),
        })
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
      yield* machine.running(yield* ownWorkers)
      const now = yield* ledger.current
      const over = (yield* SubscriptionRef.get(holds)).overLimit
      const requests = yield* attention.current
      const asking = new Set(requests.map((request) => request.ticket))
      const aside = new Set<string>()
      const busy = [...(yield* scheduler.running)].filter((ticket) => {
        const entry = now.tickets.get(ticket)
        if (entry === undefined || entry.phase._tag !== "Working") return true
        if (asking.has(ticket) && !over.has(ticket)) aside.add(ticket)
        return !over.has(ticket) && !asking.has(ticket)
      })
      const waiting = [...new Set(requests.map((request) => request.ticket))].filter((ticket) =>
        aside.has(ticket),
      )
      // With a worker waiting on you in its slot, a ticket queued for a slot is still to start.
      const queued = [...now.tickets.values()].some((entry) => entry.phase._tag === "Queued")
      const toStart = waiting.length > 0 && queued && (yield* canTake)
      // A ticket held back for a running one's footprint, when that one ended after the fill read
      // it, is to start too: the next look fills again.
      const overlapped =
        (yield* scheduler.running).size === 0 &&
        [...now.tickets.values()].some(
          (entry) => entry.phase._tag === "HeldBack" && entry.phase.why === "overlap",
        ) &&
        (yield* canTake)
      const done =
        !overlapped &&
        busy.length === 0 &&
        !toStart &&
        mergedBefore &&
        isSettled(yield* queue.state) &&
        (yield* triage.pending) === 0
      // With a dashboard, a conflict hand-back waiting for its steered worker keeps the run open as
      // a request does, until you hand it over from the worker's view or release it (§ 4.3).
      const conflicts =
        screen === null
          ? []
          : [...now.tickets.values()]
              .filter((entry) => handBackWaits(entry) && !waiting.includes(entry.ticket))
              .map((entry) => entry.ticket)
      return { done, waiting: [...waiting, ...conflicts] }
    })
    // Whether nothing runs but workers waiting for the usage limit.
    // A worker at the limit on a hand-back (Resolving, Fixing) waits for it as one on its ticket
    // does, once its hand-back waits for it: kept for the reset, or on its turn that ended on it, not
    // while it is handed over or what it left is checked.
    const limitedOnly = Effect.gen(function* () {
      const limited = yield* usage.limited
      const handBacks = yield* usage.handBacks
      const over = (yield* SubscriptionRef.get(holds)).overLimit
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
        const seen = yield* Ref.get(acted)
        const { done, waiting } = yield* nothingLeft
        const limit = yield* usage.look(yield* limitedOnly)
        if (limit !== null) {
          yield* scheduler.interrupt
          // The hand-backs under way, all of workers at the limit, stop as quitting's do.
          yield* queue.hold
          yield* stopped(limit)
          return { limited: true, asked: false, seen }
        }
        const held = (yield* currentStops).first !== null
        const boxed = done && waiting.length > 0 && screen !== null
        yield* showEndOfRun(boxed ? waiting : null)
        const endNow = yield* Ref.getAndSet(endAsked, false)
        if (done) {
          if (waiting.length === 0 && (held || !(yield* usage.held)))
            return { limited: false, asked: false, seen }
          if (waiting.length > 0 && (screen === null ? held : endNow))
            return { limited: false, asked: endNow, seen }
        }
        yield* Effect.raceFirst(Queue.take(wake), scheduler.freed)
      }
    })
    // The run ends, with nothing acting after it, unless one of the screen's commands acted since
    // the look that saw `seen` of them (the usage limit's end, null, doesn't look again).
    const endAfter = (seen: number | null) =>
      acting.withPermits(1)(
        Effect.gen(function* () {
          if (seen !== null && (yield* Ref.get(acted)) !== seen) return false
          yield* Ref.set(ending, true)
          return true
        }),
      )
    // Nothing left: a hold for the environment probes the machine, and goes on or ends the run. A
    // command acted on meanwhile (a hand-back handed over, an answer) has the run look again, the
    // box's `q` it ended on still asked.
    const loop = Effect.gen(function* () {
      for (;;) {
        const { limited, asked, seen } = yield* settle
        if (limited) {
          yield* endAfter(null)
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
        if (yield* endAfter(seen)) break
        if (asked) yield* Ref.set(endAsked, true)
      }
    })

    // Quitting's first four steps (§ 4.8, quit.ts), once the loop has stopped scheduling: the
    // dashboard says what it waits for; every worker is interrupted at once, its result waited for
    // quitWait at most; a merge in its protected step finishes, one before it is cut short; the
    // organ calls are aborted. The tickets' fibers and the hand-backs stop before the interrupts, so
    // that none acts on an interrupted turn.
    const say = (awaited: ReadonlyArray<Awaited>) =>
      Effect.andThen(
        Ref.set(awaiting, awaited),
        SubscriptionRef.update(status, (now) => ({ ...now, quitting: quittingText(awaited) })),
      )
    const openWorkers = Effect.gen(function* () {
      const known = Option.getOrElse(yield* Stream.runHead(host.workers), () => new Set<string>())
      const open: Array<string> = []
      for (const ticket of known) {
        const state = yield* Effect.result(host.current(ticket))
        if (Result.isFailure(state)) continue
        if (state.success._tag !== "Closed" && state.success._tag !== "Gone") open.push(ticket)
      }
      return open.sort()
    })
    const quitNow = (quit: Quitting) =>
      Effect.gen(function* () {
        const workers = yield* openWorkers
        yield* say(workers.map((ticket) => ({ ticket, what: "worker" as const })))
        if ("request" in quit) {
          const text = quitLine(quit.request, workers)
          yield* logs.writeWith([text], events.emit({ kind: "warn", text }))
        }
        yield* scheduler.interrupt
        yield* queue.hold
        const unanswered = yield* interruptWorkers(workers)
        if (unanswered.length > 0) yield* logs.write(unansweredLine(unanswered))
        const merging = (yield* queue.state).merging
        yield* say(merging === null ? [] : [{ ticket: merging, what: "merge" as const }])
        yield* queue.stopMerges
        yield* triage.interrupt
        yield* say([])
      })

    // A panic in the loop quits the run as one in its other fibers does.
    const guardedLoop = Effect.catchDefect(Effect.as(loop, null), (defect) =>
      Effect.andThen(
        panicked("the run", stopFor("PANIC", `the run's loop: ${firstLine(defect)}`), defect),
        Effect.never,
      ),
    )
    // A quit heard before the loop, during the check of the requirements, starts no ticket.
    const quit = (yield* Deferred.isDone(quitting))
      ? yield* Deferred.await(quitting)
      : yield* Effect.raceFirst(guardedLoop, Deferred.await(quitting))
    // The loop's end set it already, under `acting`; a quit sets it at once, without waiting for a
    // command acting now: quitting holds the merges and interrupts the workers.
    yield* Ref.set(ending, true)
    // No ticket is taken any more: the guess under way is aborted.
    if (predictor !== undefined) yield* predictor.interrupt
    // A worker past its ticket limit, or waiting on you, is still at it: every ticket's fiber is
    // stopped now, before anything else of the end, so that an answer through `tutti answer`, which
    // the loop's end doesn't wait for, can't run a worker on into the end's steps. Quitting stops
    // them in its own order (quitNow).
    const over = (yield* SubscriptionRef.get(holds)).overLimit
    const asking =
      quit === null
        ? new Set((yield* attention.current).map((request) => request.ticket))
        : new Set<string>()
    if (quit === null) yield* scheduler.interrupt
    yield* showEndOfRun(null)
    if (quit !== null) yield* quitNow(quit)
    yield* mergeStop(yield* queue.state)
    // A ticket set aside and merged by hand since the base last moved counts closed, for the end
    // line and the report (handMerged.ts).
    if (quit === null) yield* queue.mergedByHand

    // The end: the tickets a run can't end in Stopped, and every stopped ticket's session suspended.
    // Quitting's steps 5 and 6 are any end's: the sessions are closed, every open one when
    // quitting, then state.json says why each was suspended.
    const before = yield* currentStops
    const ended = quit === null ? null : "panic" in quit ? quit.panic.why : "quit"
    const whyOf = (entry: { readonly ticket: string; readonly phase: TicketPhase }) =>
      entry.phase._tag === "Working" && over.has(entry.ticket)
        ? "TICKET_LIMIT"
        : entry.phase._tag === "Working" && asking.has(entry.ticket)
          ? "waiting on you"
          : (ended ?? before.first?.why ?? "run ended")
    // The hand-backs kept for the usage limit's reset and never sent, the run ending first
    // (usageLimit.ts): the rebase whose conflicts the worker never saw is aborted, so that the next
    // run merges its ticket again rather than set it aside mid-rebase, and the closing line says so.
    const git = yield* Git
    const neverSent: Array<string> = []
    const unsent = [...(yield* usage.unsent)].sort(([a], [b]) => a.localeCompare(b))
    for (const [ticket, mode] of unsent) {
      const worktree = (yield* store.ticket(ticket))?.worktree
      if (mode === "fixing" || worktree === undefined) {
        neverSent.push(neverHanded(ticket, mode))
        continue
      }
      const rebasing = git.rebaseInProgress(worktree)
      yield* Effect.ignore(
        Effect.flatMap(rebasing, (on) => (on ? git.abortRebase(worktree) : Effect.void)),
      )
      const stuck = yield* Effect.result(rebasing)
      neverSent.push(
        neverHanded(ticket, mode, Result.isSuccess(stuck) && !stuck.success ? undefined : worktree),
      )
    }
    const suspended: Array<{ readonly ticket: string; readonly because: string }> = []
    const saved: Array<string> = []
    const handedBack: Array<string> = []
    for (const entry of (yield* ledger.current).tickets.values()) {
      const { ticket, phase } = entry
      const move = stopsAtEnd(phase)
      if (!move && phase._tag !== "Stopped") continue
      const because = phase._tag === "Stopped" ? phase.why : whyOf(entry)
      const session = (yield* store.ticket(ticket))?.session
      const records =
        session === undefined ? [] : [{ kind: "suspended" as const, ticket, session, why: because }]
      if (move)
        yield* ledger.transition(ticket, Cause.RunEnded({ why: because }), { beside: records })
      else yield* Effect.forEach(records, (record) => events.emit(record), { discard: true })
      suspended.push({ ticket, because })
      if (session !== undefined) saved.push(ticket)
      const handed = phase._tag === "Resolving" || phase._tag === "Fixing"
      if (handed && !unsent.some(([each]) => each === ticket)) handedBack.push(ticket)
    }
    for (const each of suspended) yield* host.close(each.ticket)
    if (quit !== null) yield* Effect.forEach(yield* openWorkers, host.close, { discard: true })
    // One whose worker never began has no session to resume: bd ready gives it to the next run.
    for (const each of suspended) {
      if (!saved.includes(each.ticket)) continue
      yield* Effect.ignore(store.suspend(each.ticket, each.because, "Stopped"))
    }
    yield* saveAsked
    yield* saveLeft
    yield* labelAtEnd({ repo: config.repo, base })

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

    const state = yield* ledger.current
    const view = project({
      ledger: state,
      workers: new Map(),
      requests: [],
      status: { ...emptyStatus, branch: base, concurrency: config.settings.concurrent },
    })
    const now = yield* Clock.currentTimeMillis
    const summarised: Summary = {
      version: options.version,
      branch: base,
      scope: config.ticket,
      took: now - begun,
      totals: view.totals,
      rows: view.rows,
    }
    const summary = summaryLines({ ...summarised, base })
    yield* logs.write(...summary)
    let closing: Line
    let closed: Ending
    // A scoped run's part of the closing line: `; SCOPE_DONE: …` or `; SCOPE_OPEN: …`.
    const scopePart = Effect.gen(function* () {
      const root = config.ticket
      if (root === null) return ""
      const view = scope.ledgerView(
        state,
        yield* closedByRun(beads, root, state),
        new Map(setupWaiting(state, yield* setUps.failures)),
      )
      const end = yield* scope.end(beads, root, view, {
        excludeTypes: config.settings.queue.exclude_types,
      })
      return `; ${scope.line(end)}`
    })

    // The closing line: the stops', or how the run ended by itself, with its scope's part.
    if (all.first !== null) {
      const first = all.first
      const text = stopsLine(all)
      closing = text
      closed = Ending.Stopped({ text: `${text}${yield* scopePart}` })
      const record =
        !first.recorded || all.others.length > 0
          ? events.emit({
              kind: "stop",
              detail: first.why,
              ...(first.ticket === undefined ? {} : { ticket: first.ticket }),
              ...(first.blocked === undefined ? {} : { blocked: first.blocked }),
              text,
            })
          : Effect.void
      yield* logs.writeWith([text], record)
    } else {
      const n = yield* scheduler.started
      const how =
        state.windDown !== null ? "drained" : (yield* scheduler.limitReached) ? "limit" : "empty"
      const waits = setupWaitsPart(setupWaiting(state, yield* setUps.failures))
      const text = line`${doneLine(n, how)}${waits}${yield* scopePart}`
      closing = text
      closed = Ending.Done({ text, tickets: n, limit: config.limit, took: now - begun })
      yield* logs.writeWith([text], events.emit({ kind: "done", text }))
      yield* notifier.notify(finished([...state.tickets.values()].map((entry) => entry.phase)))
    }

    // The full check, after a run that ended by itself and merged a ticket (fullcheck.ts).
    const phases: Record<string, TicketPhase> = {}
    for (const entry of state.tickets.values()) phases[entry.ticket] = entry.phase
    const said = [...summary, closing]
    // The report's evidence beside the log, in orchestra's order: the failed checks, the full
    // check, the follow-ups filed outside the scope, the feature request.
    const sections = [...failedChecksSection(state.tickets, yield* queue.rechecks.failures)]
    const command = config.settings.checks.full.command
    // What the report says after the reviewer's text: a failed full check, the end of its output.
    let after = ""
    let exitCode = exitCodeOf(all)
    // The stop of a quit, or a panic, after the loop: `when` it came.
    const lateStop = (late: Quitting, when: string): StopReason =>
      "panic" in late ? late.panic : stopFor("INTERRUPTED", `quit ${late.request.how} ${when}`)
    // A request to quit, or a panic, while it runs stops it (FULL_CHECK_SKIPPED), and the run ends
    // INTERRUPTED (130), or PANIC (4), after all.
    if (fullCheckDue(command, all.first !== null, Object.values(phases))) {
      const checked = yield* Effect.raceFirst(
        Effect.map(
          Effect.flatMap(setUps.now, (setup) =>
            fullCheck({ base, started: begun, setup: setup.command }),
          ),
          (done) => ({ done }),
        ),
        Effect.map(Deferred.await(quitting), (quit) => ({ quit })),
      )
      if ("done" in checked) {
        said.push(checked.done.text)
        sections.push(section("The full check", fullCheckEvidence(checked.done)))
        after = fullCheckReport(checked.done, command ?? "")
      } else {
        const stop = lateStop(checked.quit, "during the full check")
        yield* logs.writeWith(
          [stop.text],
          events.emit({ kind: "stop", detail: stop.why, text: stop.text }),
        )
        said.push(stop.text)
        exitCode = stop.code
      }
    } else if (quit === null && (yield* Deferred.isDone(quitting))) {
      // Asked to quit as the run ended: it ended all the same, INTERRUPTED.
      const stop = lateStop(yield* Deferred.await(quitting), "as the run ended")
      yield* logs.writeWith(
        [stop.text],
        events.emit({ kind: "stop", detail: stop.why, text: stop.text }),
      )
      said.push(stop.text)
      exitCode = stop.code
    }

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
      ...(after === "" ? {} : { after }),
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
      summary: summarised,
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
