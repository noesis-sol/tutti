// The end of the run (run.ts, § 5 item 14): nothing left to start or merge, or a quit. No look
// runs from here: every ticket's fiber is stopped, so that an answer through `tutti answer` can't
// run a worker on into the end's steps; quitting stops them in its own order (quitting.ts). Then
// the end's steps (endOfRun.ts): the tickets a run can't end in Stopped and their sessions
// suspended (§ 4.8), the quit's stop put first, the stops' line, the summary lines and the closing
// line (the stops', or READY_EMPTY, LIMIT_REACHED or DRAINED, with a scoped run's SCOPE_ part),
// the full check when the run ended by itself having merged a ticket (fullcheck.ts), with the
// report's evidence from bd and git read beside it (report.ts readEvidence, reportEvidence.ts), so
// that the reviewer starts as the check ends, and the end record; or, given RunOptions.endLater,
// the report and the end record are left to `finish` (run.ts), which main runs on the main screen
// once the renderer is gone (§ 7.1).
import { Deferred, Effect, Exit, Fiber, Option, Result } from "effect"
import { section } from "../../organs/evidence.ts"
import { Organs } from "../../organs/Organs.ts"
import type { TicketId } from "../../services/Beads.ts"
import { earlyEvidence } from "../../services/figures.ts"
import { OrganCost } from "../../services/OrganCost.ts"
import { endRecord } from "../../services/Spending.ts"
import {
  dependentFollowUps,
  scorecardsEvidence,
  scorecardsReport,
} from "../../services/scorecard.ts"
import { notifyLeftOpen } from "../autoAnswer.ts"
import { type EndOfRun, make as makeEndOfRun } from "../endOfRun.ts"
import { featureRequestHeading } from "../feature.ts"
import { changeStops, exitCodeOf, extendFirst, putFirst, type StopReason } from "../holds.ts"
import type { Ledger } from "../ledger.ts"
import type { TicketPhase } from "../phase.ts"
import { capEvidence } from "../pressureCap.ts"
import { interruptedText, keptText } from "../quit.ts"
import { quitStop } from "../quitting.ts"
import { dropRechecks } from "../recheck.ts"
import {
  type ReportOut,
  type ReportRun,
  readEvidence,
  runReport,
  showConcurrency,
} from "../report.ts"
import { failedChecksSection, followUpsSection } from "../reportEvidence.ts"
import { showOn } from "../runView.ts"
import type { Looped } from "./loop.ts"
import type { RunParts } from "./parts.ts"
import { type Outcome, type RunEnv, showEndOfRun } from "./shared.ts"

/** What the wind-down leaves for the summary. */
export interface Wound {
  /** The end's steps (endOfRun.ts), the tickets suspended. */
  readonly end: EndOfRun
  /** The run's stops as it ends, the quit's first. */
  readonly all: ReadonlyArray<StopReason>
}

/**
 * The wind-down: no look runs from here, every ticket's fiber is stopped, the quit's steps run
 * (quitting.ts), and the end's steps suspend the tickets a run can't end in (endOfRun.ts).
 */
export const windDown = (
  parts: RunParts,
  looped: Looped,
): Effect.Effect<Wound, never, RunEnv | Ledger> =>
  Effect.gen(function* () {
    const { options, begun } = parts
    const { attention, base, status, commands, holds } = parts.services
    const { changeHolds, currentStops } = holds
    const { quitting, setUps, usage } = parts.holds
    const { queue, mergeStop } = parts.merge
    const { checksGate, scheduler } = parts.starting
    const { quit, watch, quits, answersAtWakes } = looped
    // The loop's end set it already, under the commands' lock; a quit sets it at once, without
    // waiting for a command acting now: quitting holds the merges and interrupts the workers.
    yield* commands.end
    // No look runs from here, through the full check and the rest of the end. The next run takes
    // back the tickets it reads as answered. Reading at once covers an answer whose wake came too
    // late for the last look; one recorded after that finds the end set, and wakes it.
    yield* showOn(status, "looksOver")(true)
    yield* watch(answersAtWakes)
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
    return { end, all }
  })

/**
 * The summary lines, the closing line, the full check, the report's evidence and the outcome, the
 * end record emitted unless the run leaves it to `finish` (RunOptions.endLater).
 */
export const summarise = (
  parts: RunParts,
  looped: Pick<Looped, "quit">,
  wound: Wound,
): Effect.Effect<Outcome, never, RunEnv | Ledger> =>
  Effect.gen(function* () {
    const { options, begun } = parts
    const { config, beads, ledger, events, base, startHead } = parts.services
    const { quitting, organs, pressure } = parts.holds
    const { early, playbook, queue } = parts.merge
    const { quit } = looped
    const { end, all } = wound
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
    // The report's evidence from bd and git (the commits merged, the tickets closed and set aside,
    // the ready count; for a scoped run, the follow-ups filed outside its scope), read while the
    // full check runs, so that the reviewer starts as the check ends: only the report's section on
    // the check waits for it. Nothing is read for a run quit already, which has no report, and a
    // quit during the check interrupts the reads at once.
    const reviewing =
      Option.isSome(organs) &&
      config.settings.organs.review &&
      quit === null &&
      !(yield* Deferred.isDone(quitting))
    const reading = reviewing
      ? yield* Effect.forkChild(
          Effect.raceFirst(
            Effect.all({
              read: readEvidence({ base, startHead }),
              followUps:
                config.ticket === null
                  ? Effect.succeed([])
                  : followUpsSection(beads, config.ticket, begun),
            }),
            Effect.andThen(Deferred.await(quitting), Effect.interrupt),
          ),
        )
      : null
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

    // What was read is the report's, which a quit skips: a quit during the full check stopped the
    // reads, and one just after it stops them now.
    const quitted = quit !== null || (yield* Deferred.isDone(quitting))
    const read =
      reading === null
        ? undefined
        : quitted
          ? yield* Effect.as(Fiber.interrupt(reading), undefined)
          : yield* Fiber.await(reading)
    if (read !== undefined && read._tag === "Success") sections.push(...read.value.followUps)
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
      ...(read === undefined
        ? {}
        : {
            read: Exit.map(read, ({ read }) => ({ ...read, beforeFullCheck: checked.ran })),
          }),
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
  })

/** The end of the run, from the loop's end or a quit to the outcome. */
export const end = (
  parts: RunParts,
  looped: Looped,
): Effect.Effect<Outcome, never, RunEnv | Ledger> =>
  Effect.flatMap(windDown(parts, looped), (wound) => summarise(parts, looped, wound))
