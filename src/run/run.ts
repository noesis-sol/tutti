import { Clock, Deferred, Effect, Option, Result, type Scope } from "effect"
import { AppConfig } from "../core/AppConfig.ts"
import { section } from "../organs/evidence.ts"
import { Organs } from "../organs/Organs.ts"
import { printSummary } from "../print/summary.ts"
import type { TicketId } from "../services/Beads.ts"
import { EventStream } from "../services/EventStream.ts"
import { earlyEvidence } from "../services/figures.ts"
import { OrganCost } from "../services/OrganCost.ts"
import { endRecord } from "../services/Spending.ts"
import { dependentFollowUps, scorecardsEvidence, scorecardsReport } from "../services/scorecard.ts"
import { AutoAnswer, makeAutoAnswering, notifyLeftOpen } from "./autoAnswer.ts"
import { make as makeEndOfRun } from "./endOfRun.ts"
import { featureRequestHeading } from "./feature.ts"
import { changeStops, exitCodeOf, exitCodes, extendFirst, putFirst } from "./holds.ts"
import { Ledger } from "./ledger.ts"
import type { TicketPhase } from "./phase.ts"
import { capEvidence } from "./pressureCap.ts"
import { interruptedText, keptText } from "./quit.ts"
import { quitStop } from "./quitting.ts"
import { dropRechecks } from "./recheck.ts"
import { type ReportOut, type ReportRun, runReport, showConcurrency } from "./report.ts"
import { failedChecksSection, followUpsSection } from "./reportEvidence.ts"
import { showOn } from "./runView.ts"

export {
  errorStop,
  type Outcome,
  panicStop,
  type RunEnv,
  type RunOptions,
  showEndOfRun,
} from "./run/shared.ts"

import { loop } from "./run/loop.ts"
import { assemble } from "./run/parts.ts"
import { type Outcome, type RunEnv, type RunOptions, showEndOfRun } from "./run/shared.ts"

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

/** The run, begun at `begun`, as `run` says. */
const runFrom = (
  options: RunOptions,
  begun: number,
): Effect.Effect<Outcome, never, RunEnv | Scope.Scope> =>
  Effect.gen(function* () {
    const parts = yield* assemble(options, begun)
    const looped = yield* loop(parts)
    const { config, beads, ledger, events, attention, base, startHead, status, commands, holds } =
      parts.services
    const { changeHolds, currentStops } = holds
    const { quitting, setUps, usage, organs, pressure } = parts.holds
    const { early, playbook, queue, mergeStop } = parts.merge
    const { checksGate, predictor, scheduler } = parts.starting
    const { quit, watch, quits, answersAtWakes } = looped
    // The loop's end set it already, under the commands' lock; a quit sets it at once, without
    // waiting for a command acting now: quitting holds the merges and interrupts the workers.
    yield* commands.end
    // No look runs from here, through the full check and the rest of the end. The next run takes
    // back the tickets it reads as answered. Reading at once covers an answer whose wake came too
    // late for the last look; one recorded after that finds the end set, and wakes it.
    yield* showOn(status, "looksOver")(true)
    yield* watch(answersAtWakes)
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
        : new Set<TicketId>()
    if (quit === null) yield* Effect.andThen(scheduler.interrupt, quits.refuseAnswers)
    yield* showEndOfRun(status, null)
    if (quit !== null) yield* quits.quitNow(quit)
    yield* mergeStop(yield* queue.state)
    // A ticket set aside and merged by hand since the base last moved counts closed, for the end
    // line and the report (handMerged.ts).
    if (quit === null) yield* queue.mergedByHand
    // The questions --auto-answer took at once and the run ends with unanswered notify, as their
    // asked records didn't (autoAnswer.ts).
    yield* notifyLeftOpen

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
      autoAnswered: attention.autoAnswered,
      status,
      checksGate: checksGate.said,
    })
    const { saved, handedBack, neverSent } = yield* end.suspend({
      quit,
      over,
      asking,
      stops: yield* currentStops,
      open: quits.openWorkers,
    })

    // Quitting's last step: the run ends INTERRUPTED (exit 130), PANIC (exit 4) or LOGIN (exit 2),
    // before any stop the run had.
    if (quit !== null) {
      const stop = quitStop(
        quit,
        ({ how }) => interruptedText(how, saved, handedBack),
        keptText(saved, handedBack),
      )
      yield* changeHolds((now) => changeStops(now, (all) => putFirst(all, stop)))
    }
    yield* changeHolds((now) => changeStops(now, (all) => extendFirst(all, neverSent)))
    const all = yield* currentStops
    // A stopped run names the tickets it leaves without the check once more it promised them.
    if (quit === null && all.length > 0) yield* dropRechecks(queue.rechecks, "the run stopped")

    // The follow-ups the run's workers filed that it didn't take up, on their tickets' scorecards
    // before the summary's Scores line counts them: each scored ticket's dependents, as bd show
    // gives them; a ticket bd can't show is left out.
    yield* Effect.forEach(
      [...(yield* events.figures).scoring.scores.keys()],
      (id) =>
        Effect.gen(function* () {
          const read = yield* Effect.result(beads.show(id as TicketId, { dependents: true }))
          if (Result.isFailure(read)) return
          const filed = dependentFollowUps(read.success, (yield* events.figures).scoring)
          for (const follow of filed) {
            yield* events.emit({ kind: "score_update", ticket: id, follow_up: follow })
          }
        }),
      { concurrency: showConcurrency, discard: true },
    )
    // The summary lines, then the closing line: the stops', or how the run ended by itself.
    const state = yield* ledger.current
    const { lines: summary, summary: summarised } = yield* end.summary(state)
    const { line: closing, ending: closed } = yield* end.closing(state, all, summarised.took)

    // The full check, after a run that ended by itself and merged a ticket (fullcheck.ts).
    const phases: Record<string, TicketPhase> = {}
    for (const entry of state.tickets.values()) phases[entry.ticket] = entry.phase
    // The report's evidence beside the log, in orchestra's order: the failed checks, the full
    // check, the follow-ups filed outside the scope, the feature request; then the early checks.
    const sections = [...failedChecksSection(state.tickets, yield* queue.rechecks.failures)]
    // No early check runs beside the full check, nor after it.
    yield* early.stop("the full check runs")
    const checked = yield* end.fullCheck(Object.values(phases), all.length > 0, quit)
    const said = [...summary, closing, ...checked.said]
    sections.push(...checked.sections)
    const earlyChecks = earlyEvidence((yield* events.figures).early)
    if (earlyChecks !== null) sections.push(section("Early checks", earlyChecks))
    const capped = capEvidence(yield* pressure.spent)
    if (capped !== null) sections.push(section("Workers allowed under memory pressure", capped))
    // Each ended ticket's scorecard (scorecard.ts), for the reviewer and the report's section.
    const scores = [...(yield* events.figures).scoring.scores.values()]
    if (scores.length > 0) {
      sections.push(
        section(
          "Each ticket's scorecard from the run's records, best first, the worst last",
          scorecardsEvidence(scores).join("\n"),
        ),
      )
    }
    const after = scorecardsReport(scores) + (yield* playbook.report) + checked.after
    const exitCode = checked.code ?? exitCodeOf(all)

    // Gathered only for a report, which a quit skips: bd lists the scope's tickets level by level.
    const quitted = quit !== null || (yield* Deferred.isDone(quitting))
    const reviews = Option.isSome(organs) && config.settings.organs.review && !quitted
    if (config.ticket !== null && reviews) {
      sections.push(...(yield* followUpsSection(beads, config.ticket, begun)))
    }
    if (config.feature !== null) {
      sections.push(section(featureRequestHeading(config.ticket), config.feature))
    }

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
