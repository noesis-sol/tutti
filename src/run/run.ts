// The run (§ 5, § 3.4): what follows the startup checks and the run lock, from the START block to
// the end record. It is a scoped Effect. It forks the ready poll, the merge queue's consumer, the
// watchers of the merge queue and of drain requests, and one fiber per running ticket, each into a
// FiberSet of the run's scope (§ 3.4), and drives the scheduler itself: it fills the free slots as
// the run starts, whenever a ticket's fiber ends or a merge finishes, and on each ready poll.
//
// Holds and stops (§ 5 item 10): a stop holds the run (no new tickets, the running ones finish and
// merge), and the run ends once nothing runs or waits to merge, with the stops' line and the first
// one's exit code (holds.ts). A drain (drain.ts) does the same without a stop, and the run ends
// DRAINED with exit 0.
//
// The end (§ 5 item 14): nothing left to start or merge. The tickets still in a phase a run can't
// end in are Stopped and their sessions suspended (§ 4.8), as are the sessions of those that
// stopped the run; then the summary lines, the closing line (the stops', or READY_EMPTY,
// LIMIT_REACHED or DRAINED, with a scoped run's SCOPE_ part), the full check when the run ended by
// itself having merged a ticket (fullcheck.ts), and the end record. In plain mode
// (§ 7.6) every line goes to stdout as the Log writes it; a worker's attention request is a
// PERMISSION or QUESTION line naming the `tutti answer` command, served from the attention files.
// When Tty says the terminal can draw the dashboard and main gave the run one, the run shows it
// (screen.ts) from its start to its end instead, and hands back the summary and closing lines for
// main to print once the renderer is gone (§ 7.1).
import {
  Cause as Causes,
  Clock,
  Duration,
  Effect,
  FiberSet,
  Queue,
  Ref,
  Result,
  type Scope,
  Stream,
} from "effect"
import {
  type AgentGone,
  AgentHost,
  type AgentProtocol,
  type AgentStartFailed,
} from "../agent/AgentHost.ts"
import type { Attention } from "../agent/Attention.ts"
import { serve } from "../agent/attentionFiles.ts"
import { AppConfig } from "../cli/AppConfig.ts"
import { formatDuration } from "../project/configFile.ts"
import { Beads, type Issue } from "../services/Beads.ts"
import { Store } from "../services/Store.ts"
import { outputMode, Tty } from "../services/Tty.ts"
import { schemeNotices } from "../ui/theme.ts"
import { type DrainRequest, drainedLine, hear } from "./drain.ts"
import { EventStream } from "./eventstream.ts"
import { RunFibers } from "./fibers.ts"
import { fullCheck, fullCheckDue } from "./fullcheck.ts"
import {
  addStop,
  exitCodeOf,
  noStops,
  type StopReason,
  type Stops,
  stopFor,
  stopOfLine,
  stopsLine,
} from "./holds.ts"
import { Ledger, type State } from "./ledger.ts"
import { detail, hold, type Line, Log, line } from "./log.ts"
import { beadsWhy, gitWhy } from "./merge.ts"
import { isSettled, make as makeQueue, type QueueState } from "./mergequeue.ts"
import { Cause, type PhaseTag, stopsAtEnd, type TicketPhase } from "./phase.ts"
import { emptyStatus, project, type Row, type Totals } from "./runView.ts"
import { make as makeScheduler, readyPoll } from "./schedule.ts"
import * as scope from "./scope.ts"
import { type Dashboard, show } from "./screen.ts"
import { requeueWaiting, type WorkEnv, type WorkError, work } from "./work.ts"

/** How a run ended: its exit code, and each ticket's phase then. */
export interface Outcome {
  readonly exitCode: number
  readonly phases: Readonly<Record<string, TicketPhase>>
  /** The summary and closing lines the run wrote at its end. */
  readonly ending: ReadonlyArray<Line>
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
  /** The dashboard to show when Tty says the terminal can draw one; the run is plain without it. */
  readonly dashboard?: Dashboard
}

/** Every service the run uses; it makes its own Ledger. */
export type RunEnv = Exclude<WorkEnv, Ledger> | Attention | RunFibers | Tty

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

/** How many of the run's tickets are still running. */
const runningIn = (state: State): number =>
  [...state.tickets.values()].filter((entry) => running.has(entry.phase._tag)).length

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

/** The PANIC stop of a ticket's fiber that died with `defect`. */
export const panicStop = (ticket: string, defect: unknown): StopReason => {
  const said = defect instanceof Error ? defect.message : String(defect)
  return stopFor("PANIC", `${ticket}'s fiber: ${said.split("\n")[0] ?? ""}`, { ticket })
}

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
    const ledger = yield* Ledger
    const logs = yield* Log
    const events = yield* EventStream
    const fibers = yield* RunFibers
    const context = yield* Effect.context<WorkEnv>()
    const { base } = options
    const begun = yield* Clock.currentTimeMillis

    if (options.start !== undefined && options.start.length > 0) yield* logs.write(...options.start)
    yield* serve({ repo: config.repo })
    const dashboard = options.dashboard
    if (dashboard !== undefined && outputMode(yield* Tty, config.plain)._tag === "Dashboard") {
      yield* show(dashboard, {
        ...emptyStatus,
        version: options.version,
        branch: base,
        scope: config.ticket,
        began: begun,
        concurrency: config.settings.concurrent,
        warnings: schemeNotices(config.scheme),
      })
    }

    const stops = yield* Ref.make<Stops>(noStops)
    // Set once the run ends, so that nothing starts after it.
    const ending = yield* Ref.make(false)
    // Wakes the run to look again: a merge, a stop, a drain request, the ready poll.
    const wake = yield* Queue.sliding<void>(1)
    const wakeUp = Queue.offer(wake, undefined)

    // A stop holds the run: said as it comes while tickets still run, unless its line was.
    const stopped = (stop: StopReason) =>
      Effect.gen(function* () {
        yield* Ref.update(stops, (all) => addStop(all, stop))
        const now = runningIn(yield* ledger.current)
        if (!stop.held && now > 0) {
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

    const queue = yield* makeQueue({ repo: config.repo, base })
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

    // A ticket's fiber: its work, and the stop it ended with, if any.
    const ticketFiber = (issue: Issue): Effect.Effect<void> =>
      work(issue, { base, queue }).pipe(
        Effect.matchCauseEffect({
          onSuccess: (worked) =>
            worked.stop === null
              ? Effect.void
              : stopped(stopOfLine(worked.stop, { ticket: issue.id, recorded: true, held: true })),
          onFailure: (cause) => {
            const stop = causeStop(issue.id, cause)
            return stop === undefined ? Effect.void : stopped(stop)
          },
        }),
        Effect.provideContext(context),
      )

    const taking = Effect.map(
      Effect.all([Ref.get(stops), Ref.get(ending)]),
      ([all, ended]) => all.first === null && !ended,
    )
    const scheduler = yield* makeScheduler({
      concurrent: config.settings.concurrent,
      limit: config.limit,
      scope: config.ticket,
      excludeTypes: config.settings.queue.exclude_types,
      start: { start: ticketFiber },
      taking,
    })

    // The ready poll, the merge queue's changes and drain requests each wake the run.
    const watchers = yield* fibers.make("run")
    yield* FiberSet.run(watchers, Effect.forever(Effect.andThen(Effect.sleep(readyPoll), wakeUp)))
    yield* FiberSet.run(
      watchers,
      Stream.runForEach(queue.changes, (state) => Effect.andThen(mergeStop(state), wakeUp)),
    )
    const drains = options.drains
    if (drains !== undefined) {
      yield* FiberSet.run(
        watchers,
        Effect.forever(Effect.andThen(Effect.flatMap(Queue.take(drains), hear), wakeUp)),
      )
    }

    // Fills the free slots, then says whether nothing runs or waits to merge.
    const nothingLeft = Effect.gen(function* () {
      yield* requeueWaiting
      const winding = (yield* ledger.current).windDown !== null
      if ((yield* taking) && !winding && !(yield* scheduler.limitReached)) {
        const filled = yield* Effect.result(scheduler.fillTrying)
        if (Result.isFailure(filled)) {
          yield* stopped(
            stopFor("BEADS_FAILED", `could not read the queue: ${beadsWhy(filled.failure)}`),
          )
        }
      }
      return (yield* scheduler.running).size === 0 && isSettled(yield* queue.state)
    })
    while (!(yield* nothingLeft)) yield* Effect.raceFirst(Queue.take(wake), scheduler.freed)
    yield* Ref.set(ending, true)
    yield* mergeStop(yield* queue.state)

    // The end: the tickets a run can't end in Stopped, and every stopped ticket's session suspended.
    const all = yield* Ref.get(stops)
    const why = all.first?.why ?? "run ended"
    const suspend = (ticket: string, because: string, move: boolean) =>
      Effect.gen(function* () {
        const session = (yield* store.ticket(ticket))?.session
        const records =
          session === undefined
            ? []
            : [{ kind: "suspended" as const, ticket, session, why: because }]
        if (move)
          yield* ledger.transition(ticket, Cause.RunEnded({ why: because }), { beside: records })
        else yield* Effect.forEach(records, (record) => events.emit(record), { discard: true })
        yield* Effect.ignore(store.suspend(ticket, because, "Stopped"))
        yield* host.close(ticket)
      })
    for (const entry of (yield* ledger.current).tickets.values()) {
      if (stopsAtEnd(entry.phase)) yield* suspend(entry.ticket, why, true)
      else if (entry.phase._tag === "Stopped") yield* suspend(entry.ticket, entry.phase.why, false)
    }

    const state = yield* ledger.current
    const view = project({
      ledger: state,
      workers: new Map(),
      requests: [],
      status: { ...emptyStatus, branch: base, concurrency: config.settings.concurrent },
    })
    const now = yield* Clock.currentTimeMillis
    const summary = summaryLines({
      version: options.version,
      base,
      scope: config.ticket,
      took: now - begun,
      totals: view.totals,
      rows: view.rows,
    })
    yield* logs.write(...summary)
    let closing: Line

    // The closing line: the stops', or how the run ended by itself, with its scope's part.
    if (all.first !== null) {
      const first = all.first
      const text = stopsLine(all)
      closing = text
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
      const scoped =
        config.ticket === null
          ? ""
          : `; ${scope.line(yield* scope.end(beads, config.ticket, scope.ledgerView(state), { excludeTypes: config.settings.queue.exclude_types }))}`
      const text = line`${doneLine(n, how)}${scoped}`
      closing = text
      yield* events.emit({ kind: "done", text })
      yield* logs.write(text)
    }

    // The full check, after a run that ended by itself and merged a ticket (fullcheck.ts).
    const phases: Record<string, TicketPhase> = {}
    for (const entry of state.tickets.values()) phases[entry.ticket] = entry.phase
    const said = [...summary, closing]
    const command = config.settings.checks.full.command
    if (fullCheckDue(command, all.first !== null, Object.values(phases))) {
      said.push((yield* fullCheck({ base, started: begun })).text)
    }
    const exitCode = exitCodeOf(all)
    yield* events.emit({ kind: "end", code: exitCode })
    return { exitCode, phases, ending: said } satisfies Outcome
  }).pipe(Effect.provide(Ledger.layer))
