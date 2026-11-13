// The run (§ 5, § 3.4): what follows the startup checks and the run lock, from the START block to
// the end record, a scoped Effect that hands back its exit code and each ticket's phase. Its parts
// are in src/run/run/: `assemble` (parts.ts) makes its services, status and screen (services.ts),
// what holds it (holds.ts, § 5 item 10), its merge side (mergeSide.ts) and what starts its tickets
// (starting.ts), each in the run's scope, in that order; `loop` (loop.ts) forks its watchers
// (watchers.ts), runs the start's steps (start.ts) and looks at the run (looks.ts, look.ts) at
// each wake until nothing is left or it quits (§ 4.8, quitting.ts); `end` (end.ts) winds it down
// and hands back the summary and closing lines (§ 5 item 14), the report and the end record left
// to `finish` below, which main runs once the renderer is gone (§ 7.1). What the parts share, the
// run's options, its outcome and the stop a ticket's fiber ends with, is shared.ts. In plain mode
// (§ 7.6) every line goes to stdout as the Log writes it; with a dashboard (screen.ts) the run
// shows its status live instead, and main prints the lines it hands back. Its Checking (checking.ts)
// holds the checks running, which the dashboard draws their bars from.
import { Clock, Effect, type Scope } from "effect"
import { AppConfig } from "../core/AppConfig.ts"
import { printSummary } from "../print/summary.ts"
import { EventStream } from "../services/EventStream.ts"
import { endRecord } from "../services/Spending.ts"
import { AutoAnswer, makeAutoAnswering } from "./autoAnswer.ts"
import { Checking } from "./checking.ts"
import { exitCodes } from "./holds.ts"
import { Ledger } from "./ledger.ts"
import type { ReportOut } from "./report.ts"
import { end } from "./run/end.ts"
import { loop } from "./run/loop.ts"
import { assemble } from "./run/parts.ts"
import type { Outcome, RunEnv, RunOptions } from "./run/shared.ts"

export {
  errorStop,
  type Outcome,
  panicStop,
  type RunEnv,
  type RunOptions,
  showEndOfRun,
} from "./run/shared.ts"

/**
 * The run, from its START block to its end record, in the run's scope: it hands back its exit
 * code and each ticket's phase. It never fails: what goes wrong stops it, with an exit code.
 */
export const run = (options: RunOptions): Effect.Effect<Outcome, never, RunEnv | Scope.Scope> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const begun = yield* Clock.currentTimeMillis
    // --auto-answer (autoAnswer.ts), for every part of the run that asks of it.
    const auto =
      config.autoAnswer === null ? null : yield* makeAutoAnswering(config.autoAnswer, begun)
    return yield* runFrom(options, begun).pipe(Effect.provideService(AutoAnswer, auto))
  })

/** The run, begun at `begun`, as `run` says: its parts assembled, its loop, then its end. */
const runFrom = (
  options: RunOptions,
  begun: number,
): Effect.Effect<Outcome, never, RunEnv | Scope.Scope> =>
  Effect.gen(function* () {
    const parts = yield* assemble(options, begun)
    const looped = yield* loop(parts)
    return yield* end(parts, looped)
  }).pipe(Effect.provide(Ledger.layer), Effect.provide(Checking.layer))

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
