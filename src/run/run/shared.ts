// What the run's parts share (run.ts, src/run/run/): its options and outcome, the environment it
// runs in, the stop a ticket's fiber ends with, and the end-of-run box.

import type { FileSystem } from "effect"
import { Cause, type Effect, type Queue, Result, type Stream, type SubscriptionRef } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { Attention } from "../../agent/Attention.ts"
import type { Transcripts } from "../../agent/Transcripts.ts"
import type { UsageLimits } from "../../agent/UsageLimits.ts"
import type { Line } from "../../core/log.ts"
import type { UsageProbe } from "../../organs/UsageProbe.ts"
import { beadsWhy, type TicketId } from "../../services/Beads.ts"
import { gitWhy } from "../../services/Git.ts"
import type { Notifier } from "../../services/Notifier.ts"
import type { Tty } from "../../services/Tty.ts"
import type { GateAsk } from "../checksGate.ts"
import type { DrainRequest } from "../drain.ts"
import type { RunFibers } from "../fibers.ts"
import { type StopReason, stopFor } from "../holds.ts"
import type { Ledger } from "../ledger.ts"
import type { TicketPhase } from "../phase.ts"
import type { QuitRequest } from "../quit.ts"
import type { ReportOut } from "../report.ts"
import { type Status, showOn } from "../runView.ts"
import type { Dashboard } from "../screen.ts"
import type { Ending, Summary } from "../summary.ts"
import type { Trash } from "../trash.ts"
import type { WorkEnv, WorkError } from "../work.ts"

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
   * Whether the keep-awake command holds the machine awake (keepAwake.ts), as it changes: the
   * title line's badge. None for a run that doesn't keep the machine awake.
   */
  readonly keepingAwake?: Stream.Stream<boolean>
  /**
   * A spec's breakdown still filing the tickets of the run's scope, the run having started on its
   * environment ticket (§ 4.14, src/run/specRun.ts): what it has filed so far, which the title line
   * shows as a hold's banner, and the run waits for the rest rather than end, until it is null.
   */
  readonly filing?: SubscriptionRef.SubscriptionRef<string | null>
  /**
   * How a spec run's checks gate asks in a terminal (checksGate.ts): tutti checks' form in place
   * of the dashboard. Without it, a hold files a question for the maintainer.
   */
  readonly gateAsk?: GateAsk
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
  | Trash
  | Transcripts
  | Tty
  | UsageLimits
  | UsageProbe
  | Notifier
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner

/** The stop a ticket's fiber failing with `error` stops the run for (§ 5 item 10). */
export const errorStop = (ticket: TicketId, error: WorkError): StopReason => {
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
export const firstLine = (defect: unknown): string => {
  const said = defect instanceof Error ? defect.message : String(defect)
  return said.split("\n")[0] ?? ""
}

/** The PANIC stop of a ticket's fiber that died with `defect`. */
export const panicStop = (ticket: TicketId, defect: unknown): StopReason =>
  stopFor("PANIC", `${ticket}'s fiber: ${firstLine(defect)}`, { ticket })

/** What a fiber that died with `cause` died of: its defect, or the cause told. */
export const defectOf = (cause: Cause.Cause<unknown>): unknown => {
  const defect = Cause.findDefect(cause)
  return Result.isSuccess(defect) ? defect.success : Cause.pretty(cause)
}

/** The stop a ticket's fiber ending with `cause` stops the run for, if any. */
export const causeStop = (
  ticket: TicketId,
  cause: Cause.Cause<WorkError>,
): StopReason | undefined => {
  if (Cause.hasInterruptsOnly(cause)) return undefined
  const error = Cause.findError(cause)
  if (Result.isSuccess(error)) return errorStop(ticket, error.success)
  const defect = Cause.findDefect(cause)
  return panicStop(ticket, Result.isSuccess(defect) ? defect.success : Cause.pretty(cause))
}

/**
 * Shows the end-of-run box (D19) on `status`: the workers waiting on you it names, or null for
 * none. It reads and sets the status in one step, so that another fiber's change in between isn't
 * lost, and publishes nothing when the box is the same.
 */
export const showEndOfRun = (
  status: SubscriptionRef.SubscriptionRef<Status>,
  tickets: ReadonlyArray<TicketId> | null,
): Effect.Effect<void> => showOn(status, "endOfRun")(tickets)
