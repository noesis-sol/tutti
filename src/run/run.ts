// The run (§ 5, § 3.4): what follows the startup checks and the run lock, from the START block to
// the end record. It is a scoped Effect. It forks the ready poll, the merge queue's consumer, the
// watchers of the merge queue and of drain requests, and one fiber per running ticket, each into a
// FiberSet of the run's scope (§ 3.4), and drives the scheduler itself: it fills the free slots as
// the run starts, whenever a ticket's fiber ends or a merge finishes, and on each ready poll. Each
// such look first puts back the Waiting tickets whose blockers merged and resumes the Asked ones
// whose questions are answered (asked.ts), unless the run holds or winds down.
//
// Holds and stops (§ 5 item 10): a stop holds the run (no new tickets, the running ones finish and
// merge), and the run ends once nothing runs or waits to merge, with the stops' line and the first
// one's exit code (holds.ts). A drain (drain.ts) does the same without a stop, and the run ends
// DRAINED with exit 0. Workers failing at once hold the run with ENVIRONMENT (environment.ts): once
// nothing runs, the probe either lifts that stop, and the run takes tickets again, or ends the run.
// Given Organs, the run triages each ticket set aside in the background (triage.ts), its verdicts
// counting toward that hold, and doesn't end while a ticket waits for its verdict.
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
// tickets beside the suspended ones.
//
// The end (§ 5 item 14): nothing left to start or merge. Workers waiting on you (an open request)
// keep it open with a dashboard (D19): it shows the end-of-run box until you answer them, and they
// carry on, or end the run with the box's `q`. Plain, the run waits for them only until a stop holds
// it, BLOCKED at the latest; then it ends as usual. Those past their ticket limit never keep it
// open. The tickets still in a phase a run can't end in are Stopped and their sessions suspended
// (§ 4.8), as are the sessions of those that stopped the run, a worker still waiting on you
// suspended so (`waiting on you`); each ticket closed and not merged is labelled `unmerged`; then
// the summary lines, the closing line (the stops', or READY_EMPTY, LIMIT_REACHED or DRAINED, with
// a scoped run's SCOPE_ part), the full check when the run ended by itself having merged a ticket
// (fullcheck.ts), and the end record. In plain mode (§ 7.6) every line goes to stdout as the Log writes it; a worker's attention request is a
// PERMISSION or QUESTION line naming the `tutti answer` command, served from the attention files.
// When Tty says the terminal can draw the dashboard and main gave the run one, the run shows it
// (screen.ts) from its start to its end instead, and hands back the summary and closing lines for
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
import { Beads, type Issue } from "../services/Beads.ts"
import { Git } from "../services/Git.ts"
import type { Notifier } from "../services/Notifier.ts"
import { Store } from "../services/Store.ts"
import { outputMode, Tty } from "../services/Tty.ts"
import { schemeNotices } from "../ui/theme.ts"
import { takeAnswers } from "./asked.ts"
import { carryOver, saveAsked, saveLeft } from "./carry.ts"
import { resolve, type UiCommand } from "./commands.ts"
import { type DrainRequest, drainedLine, hear } from "./drain.ts"
import { make as makeEnvironmentHold } from "./environment.ts"
import { EventStream } from "./eventstream.ts"
import { RunFibers } from "./fibers.ts"
import { fullCheck, fullCheckDue } from "./fullcheck.ts"
import {
  addStop,
  blockedAt,
  blockedLifted,
  blockedStop,
  exitCodeOf,
  exitCodes,
  isBlockedOn,
  liftStops,
  noStops,
  type StopReason,
  type Stops,
  stopFor,
  stopOfLine,
  stopsLine,
} from "./holds.ts"
import { Ledger, type State } from "./ledger.ts"
import { detail, hold, type Line, Log, line, Tag } from "./log.ts"
import { beadsWhy, gitWhy } from "./merge.ts"
import { isSettled, make as makeQueue, type QueueState } from "./mergequeue.ts"
import { Cause, type PhaseTag, stopsAtEnd, type TicketPhase } from "./phase.ts"
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
import { type ReportOut, type ReportRun, runReport } from "./report.ts"
import { emptyStatus, project, type Row, type Status, same, type Totals } from "./runView.ts"
import { footprintsOf, make as makeScheduler, readyPoll } from "./schedule.ts"
import * as scope from "./scope.ts"
import { type Dashboard, Screen, show } from "./screen.ts"
import { make as makeTriage, off as triageOff } from "./triage.ts"
import { labelAtEnd, loadUnmerged } from "./unmerged.ts"
import { make as makeUsageHold, holdWord as usageHoldWord } from "./usageLimit.ts"
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
  /** The run report on `out` (report.ts), which `finish` runs; nothing without organs. */
  readonly report: (out: ReportOut) => Effect.Effect<void>
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

    const stops = yield* Ref.make<Stops>(noStops)
    // The tickets whose workers went on past --ticket-limit: the run doesn't wait for them.
    const overLimit = yield* Ref.make<ReadonlySet<string>>(new Set())
    // Set once the run ends, so that nothing starts after it.
    const ending = yield* Ref.make(false)
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

    // A stop holds the run: said as it comes while tickets still run, unless its line was. A worker
    // past its ticket limit goes on, so its hold is said even with nothing else running.
    const stopped = (stop: StopReason) =>
      Effect.gen(function* () {
        yield* Ref.update(stops, (all) => addStop(all, stop))
        const now = runningIn(yield* ledger.current, yield* Ref.get(overLimit))
        if (!stop.held && (now > 0 || stop.why === "TICKET_LIMIT")) {
          const text = hold(stop.text, now)
          yield* events.emit({
            kind: "hold",
            ...(stop.ticket === undefined ? {} : { ticket: stop.ticket }),
            ...(stop.blocked === undefined ? {} : { blocked: stop.blocked }),
            text,
          })
          yield* logs.write(text)
        }
        yield* wakeUp
      })

    // Workers failing at once hold the run, as a stop does, until the probe (environment.ts).
    const environment = yield* makeEnvironmentHold({ onHold: stopped })

    // The account's usage limit holds the run until it resets, without a stop (usageLimit.ts).
    const usage = yield* makeUsageHold({
      wakeUp,
      show: (view) =>
        SubscriptionRef.update(status, (now) => ({
          ...now,
          usage: view.usage,
          holds: [
            ...now.holds.filter((each) => each.word !== usageHoldWord),
            ...(view.hold === null ? [] : [view.hold]),
          ],
          warnings: [...notices, ...(view.notice === null ? [] : [view.notice])],
        })),
    })

    // Triage in the background, when the run has organs: each verdict wakes the run, which doesn't
    // end while a ticket waits for one.
    const organs = yield* Effect.serviceOption(Organs)
    const triage = Option.isNone(organs)
      ? triageOff
      : yield* makeTriage({ base, hold: environment, done: wakeUp }).pipe(
          Effect.provideService(Organs, organs.value),
        )

    const queue = yield* makeQueue({ repo: config.repo, base }, (where, defect) =>
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

    // A ticket's fiber, dispatched or carried over: its work, and the stop it ended with, if any.
    const onTicketLimit = (ticket: string) => (stop: StopReason) =>
      Effect.andThen(
        Ref.update(overLimit, (over) => new Set([...over, ticket])),
        stopped(stop),
      )
    const outcomeOf = <R>(ticket: string, worked: Effect.Effect<Worked, WorkError, R>) =>
      worked.pipe(
        Effect.matchCauseEffect({
          onSuccess: (worked) =>
            Effect.andThen(
              environment.settled(ticket, worked.settling ?? "other"),
              worked.stop === null
                ? Effect.void
                : stopped(stopOfLine(worked.stop, { ticket, recorded: true, held: true })),
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
        work(issue, { base, queue, triage, onTicketLimit: onTicketLimit(issue.id) }),
      ).pipe(Effect.provideContext(context))

    const taking = Effect.map(
      Effect.all([Ref.get(stops), Ref.get(ending), usage.held]),
      ([all, ended, held]) => all.first === null && !ended && !held,
    )
    // With the queue's footprint on (§ 8.4), a ticket overlapping a running one's files is held back:
    // the checks' scripts count as no ticket's, and each ticket works in <worktrees>/<id>.
    const checks = config.settings.checks
    const footprints = config.settings.queue.footprint
      ? yield* footprintsOf({
          repo: config.repo,
          base,
          checkCommands: [checks.fast.command, checks.full.command].filter(
            (command): command is string => command !== null,
          ),
          worktree: (ticket) => join(config.worktrees, ticket),
        })
      : undefined
    const scheduler = yield* makeScheduler({
      concurrent: config.settings.concurrent,
      limit: config.limit,
      scope: config.ticket,
      excludeTypes: config.settings.queue.exclude_types,
      start: { start: ticketFiber },
      taking,
      ...(footprints === undefined ? {} : { footprints }),
    })

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

    // The workers the last run left (carry.ts), taken up before the first dispatch: each resumed
    // takes a slot, counting toward no limit, its ticket limit counted afresh.
    yield* carryOver({
      base,
      queue,
      triage,
      onTicketLimit: (stop) =>
        stop.ticket === undefined ? stopped(stop) : onTicketLimit(stop.ticket)(stop),
      carry: (ticket, worked, issue) => scheduler.carry(ticket, outcomeOf(ticket, worked), issue),
    }).pipe(Effect.provideContext(context))

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
    // Triage's verdicts go on their tickets' rows as they come in.
    yield* watch(
      Stream.runForEach(triage.verdicts, (verdicts) =>
        SubscriptionRef.update(status, (now) => ({ ...now, verdicts })),
      ),
    )
    yield* watch(Effect.forever(Effect.andThen(Effect.sleep(readyPoll), wakeUp)))
    yield* watch(
      Stream.runForEach(queue.changes, (state) => Effect.andThen(mergeStop(state), wakeUp)),
    )
    const drains = options.drains
    if (drains !== undefined) {
      yield* watch(Effect.forever(Effect.andThen(Effect.flatMap(Queue.take(drains), hear), wakeUp)))
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
        yield* events.emit({ kind: "stop", detail: stop.why, text: stop.text })
        yield* logs.write(stop.text)
        yield* events.emit({ kind: "end", code: stop.code })
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
            yield* events.emit({
              kind: "warn",
              ...(merging === null ? {} : { ticket: merging }),
              text,
            })
            yield* logs.write(text)
            return
          }
          case "exit":
            yield* atOnce(request)
        }
      })
    const quits = options.quits
    if (quits !== undefined) {
      yield* watch(Effect.forever(Effect.flatMap(Queue.take(quits), hearQuit)))
    }
    // The screen's commands, each resolved against the ledger and the open requests as it is taken:
    // one that no longer names anything (the worker finished, the request was answered) is dropped.
    // The end-of-run box's `q` (EndRun) ends the run. Quit without `now` is the quit box's to ask.
    // Steering's commands (SendMessage, Interrupt, Release, HandBackNow) are steer.ts's to take.
    if (screen !== null) {
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
                Screen.Worker({ worker: command.worker }),
              )
            case "CloseWorker":
              return yield* SubscriptionRef.set(screen.screen, Screen.Dashboard())
            case "Answer":
              return yield* attention
                .answer(command.requestId, command.answer, "screen")
                .pipe(Effect.catch((error) => Effect.logDebug(`dropped Answer: ${error.message}`)))
            case "Drain":
            case "Undrain":
              yield* hear({ on: command._tag === "Drain", how: fromDashboard.how })
              return yield* wakeUp
            case "Quit":
              if (command.now) yield* hearQuit(fromDashboard)
              return
            case "EndRun":
              yield* Ref.set(endAsked, true)
              return yield* wakeUp
          }
        })
      yield* watch(Effect.forever(Effect.flatMap(Queue.take(screen.commands), take)))
    }

    // A request unanswered for blockedAfter holds the run with BLOCKED, for its ticket; once that
    // ticket has none open, the hold is lifted (holds.ts). Each request is looked at again as it
    // reaches its time, and every request open at each change, which wakes the run too: a worker
    // that asks, or is answered, may end it or keep it open (D19).
    const blocked = yield* Ref.make<ReadonlySet<string>>(new Set())
    const oneLook = yield* Semaphore.make(1)
    const lookBlocked = oneLook.withPermits(1)(
      Effect.gen(function* () {
        if (yield* Ref.get(ending)) return
        const held = yield* Ref.get(blocked)
        const now = yield* Clock.currentTimeMillis
        const { trips, lifts } = blockedAt(yield* attention.current, held, now, blockedAfter)
        if (trips.length === 0 && lifts.length === 0) return
        yield* Ref.set(
          blocked,
          new Set([
            ...[...held].filter((ticket) => !lifts.includes(ticket)),
            ...trips.map((trip) => trip.ticket),
          ]),
        )
        const holding = (yield* Ref.get(blocked)).size > 0
        yield* SubscriptionRef.update(status, (was) => ({
          ...was,
          holds: [
            ...was.holds.filter((each) => each.word !== Tag.blocked),
            ...(holding ? [{ word: Tag.blocked, resetsAt: null }] : []),
          ],
        }))
        for (const ticket of lifts) {
          yield* Ref.update(stops, (all) => liftStops(all, (stop) => isBlockedOn(stop, ticket)))
          const text = blockedLifted(ticket)
          yield* events.emit({ kind: "hold", ticket, lifted: true, text })
          yield* logs.write(text)
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
    // ticket limit left out, as the run doesn't wait for them.
    const nothingLeft = Effect.gen(function* () {
      yield* requeueWaiting
      // The answered tickets come back before new ones start, each in a slot of its own and
      // counting toward no limit (asked.ts); not while the run holds or winds down, which takes up
      // only what is running: the next run resumes them.
      if ((yield* taking) && (yield* ledger.current).windDown === null) {
        yield* takeAnswers({
          base,
          queue,
          triage,
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
      const now = yield* ledger.current
      const over = yield* Ref.get(overLimit)
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
        isSettled(yield* queue.state) &&
        (yield* triage.pending) === 0
      return { done, waiting }
    })
    // Whether nothing runs but workers waiting for the usage limit.
    const limitedOnly = Effect.gen(function* () {
      const limited = yield* usage.limited
      const over = yield* Ref.get(overLimit)
      const others = [...(yield* ledger.current).tickets.values()].some(
        (entry) =>
          waitedFor(entry, over) && !(entry.phase._tag === "Working" && limited.has(entry.ticket)),
      )
      return !others && isSettled(yield* queue.state)
    })
    // Waits until nothing is left. With the usage-limit hold on, the run waits for its reset
    // instead, unless a stop ends it anyway; it ends USAGE_LIMIT when it can't wait for it: whether
    // it does. With everything else done and workers waiting on you (D19), a dashboard shows the
    // end-of-run box and waits, until they are answered or the box's `q` ends the run; plain, the
    // run waits only until a stop holds it.
    const settle = Effect.gen(function* () {
      for (;;) {
        const { done, waiting } = yield* nothingLeft
        const limit = yield* usage.look(yield* limitedOnly)
        if (limit !== null) {
          yield* scheduler.interrupt
          yield* stopped(limit)
          return true
        }
        const held = (yield* Ref.get(stops)).first !== null
        const boxed = done && waiting.length > 0 && screen !== null
        yield* showEndOfRun(boxed ? waiting : null)
        const endNow = yield* Ref.getAndSet(endAsked, false)
        if (done) {
          if (waiting.length === 0 && (held || !(yield* usage.held))) return false
          if (waiting.length > 0 && (screen === null ? held : endNow)) return false
        }
        yield* Effect.raceFirst(Queue.take(wake), scheduler.freed)
      }
    })
    // Nothing left: a hold for the environment probes the machine, and goes on or ends the run.
    const loop = Effect.gen(function* () {
      for (;;) {
        if (yield* settle) break
        const probed = yield* environment.probe(yield* Ref.get(stops))
        if (probed._tag === "Ends") break
        if (probed._tag === "Failed") {
          yield* Ref.update(stops, (all) => ({ ...all, first: probed.stop }))
          break
        }
        yield* Ref.set(stops, noStops)
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
          yield* events.emit({ kind: "warn", text })
          yield* logs.write(text)
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
    const quit = yield* Effect.raceFirst(guardedLoop, Deferred.await(quitting))
    yield* Ref.set(ending, true)
    yield* showEndOfRun(null)
    if (quit !== null) yield* quitNow(quit)
    yield* mergeStop(yield* queue.state)

    // The end: the tickets a run can't end in Stopped, and every stopped ticket's session suspended;
    // a worker past its ticket limit, or waiting on you, is still at it, its fiber stopped first.
    // Quitting's steps 5 and 6 are any end's: the sessions are closed, every open one when
    // quitting, then state.json says why each was suspended.
    const over = yield* Ref.get(overLimit)
    const asking =
      quit === null
        ? new Set((yield* attention.current).map((request) => request.ticket))
        : new Set<string>()
    if (over.size > 0 || asking.size > 0) yield* scheduler.interrupt
    const before = yield* Ref.get(stops)
    const ended = quit === null ? null : "panic" in quit ? quit.panic.why : "quit"
    const whyOf = (entry: { readonly ticket: string; readonly phase: TicketPhase }) =>
      entry.phase._tag === "Working" && over.has(entry.ticket)
        ? "TICKET_LIMIT"
        : entry.phase._tag === "Working" && asking.has(entry.ticket)
          ? "waiting on you"
          : (ended ?? before.first?.why ?? "run ended")
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
      if (phase._tag === "Resolving" || phase._tag === "Fixing") handedBack.push(ticket)
    }
    for (const each of suspended) yield* host.close(each.ticket)
    if (quit !== null) yield* Effect.forEach(yield* openWorkers, host.close, { discard: true })
    for (const each of suspended) {
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
      yield* Ref.update(stops, (now) => ({
        first: stop,
        others: [now.first, ...now.others].flatMap((other) => (other === null ? [] : [other])),
      }))
    }
    const all = yield* Ref.get(stops)

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
    const scopePart = Effect.suspend(() =>
      config.ticket === null
        ? Effect.succeed("")
        : Effect.map(
            scope.end(beads, config.ticket, scope.ledgerView(state), {
              excludeTypes: config.settings.queue.exclude_types,
            }),
            (end) => `; ${scope.line(end)}`,
          ),
    )

    // The closing line: the stops', or how the run ended by itself, with its scope's part.
    if (all.first !== null) {
      const first = all.first
      const text = stopsLine(all)
      closing = text
      closed = Ending.Stopped({ text: `${text}${yield* scopePart}` })
      if (!first.recorded || all.others.length > 0) {
        yield* events.emit({
          kind: "stop",
          detail: first.why,
          ...(first.ticket === undefined ? {} : { ticket: first.ticket }),
          ...(first.blocked === undefined ? {} : { blocked: first.blocked }),
          text,
        })
      }
      yield* logs.write(text)
    } else {
      const n = yield* scheduler.started
      const how =
        state.windDown !== null ? "drained" : (yield* scheduler.limitReached) ? "limit" : "empty"
      const text = line`${doneLine(n, how)}${yield* scopePart}`
      closing = text
      closed = Ending.Done({ text, tickets: n, limit: config.limit, took: now - begun })
      yield* events.emit({ kind: "done", text })
      yield* logs.write(text)
    }

    // The full check, after a run that ended by itself and merged a ticket (fullcheck.ts).
    const phases: Record<string, TicketPhase> = {}
    for (const entry of state.tickets.values()) phases[entry.ticket] = entry.phase
    const said = [...summary, closing]
    const sections = config.feature === null ? [] : [section("The feature request", config.feature)]
    const command = config.settings.checks.full.command
    let exitCode = exitCodeOf(all)
    // The stop of a quit, or a panic, after the loop: `when` it came.
    const lateStop = (late: Quitting, when: string): StopReason =>
      "panic" in late ? late.panic : stopFor("INTERRUPTED", `quit ${late.request.how} ${when}`)
    // A request to quit, or a panic, while it runs stops it (FULL_CHECK_SKIPPED), and the run ends
    // INTERRUPTED (130), or PANIC (4), after all.
    if (fullCheckDue(command, all.first !== null, Object.values(phases))) {
      const checked = yield* Effect.raceFirst(
        Effect.map(fullCheck({ base, started: begun }), (done) => ({ done })),
        Effect.map(Deferred.await(quitting), (quit) => ({ quit })),
      )
      if ("done" in checked) {
        said.push(checked.done.text)
        sections.push(section("The full check", checked.done.text))
      } else {
        const stop = lateStop(checked.quit, "during the full check")
        yield* events.emit({ kind: "stop", detail: stop.why, text: stop.text })
        yield* logs.write(stop.text)
        said.push(stop.text)
        exitCode = stop.code
      }
    } else if (quit === null && (yield* Deferred.isDone(quitting))) {
      // Asked to quit as the run ended: it ended all the same, INTERRUPTED.
      const stop = lateStop(yield* Deferred.await(quitting), "as the run ended")
      yield* events.emit({ kind: "stop", detail: stop.why, text: stop.text })
      yield* logs.write(stop.text)
      said.push(stop.text)
      exitCode = stop.code
    }

    // The report, over the run's services, when it has organs: skipped once the run was quit.
    const reportRun: ReportRun = {
      started: begun,
      base,
      startHead,
      ending: closed,
      exitCode,
      quit: quit !== null || (yield* Deferred.isDone(quitting)),
      sections,
    }
    const reportContext = yield* Effect.context<RunEnv | Ledger>()
    const cost = yield* Effect.serviceOption(OrganCost)
    const report = (out: ReportOut): Effect.Effect<void> =>
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
    yield* events.emit({ kind: "end", code: exitCode })
    return outcome
  }).pipe(Effect.provide(Ledger.layer))

/**
 * What follows a run that left it to its caller (RunOptions.endLater), on the main screen once the
 * dashboard's renderer is gone (§ 5 item 14 "Then", § 7.1): when `styled`, the summary, the
 * closing and scope lines and the lines after them, in `out`'s theme, as a plain run's log has
 * already said them; then the report, and the end record. Ctrl+C interrupting it ends the run
 * INTERRUPTED. Gives the run's exit code.
 */
export const finish = (
  outcome: Outcome,
  out: ReportOut,
  styled: boolean,
): Effect.Effect<number, never, EventStream> =>
  Effect.gen(function* () {
    const events = yield* EventStream
    if (styled) {
      yield* printSummary(out.printer, outcome.summary, outcome.closing, out.theme, out.width)
      if (outcome.after.length > 0) yield* out.printer.print(outcome.after.join("\n"))
    }
    yield* outcome
      .report(out)
      .pipe(Effect.onInterrupt(() => events.emit({ kind: "end", code: exitCodes.interrupted })))
    yield* events.emit({ kind: "end", code: outcome.exitCode })
    return outcome.exitCode
  })
