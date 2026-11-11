import {
  Clock,
  Deferred,
  Duration,
  Effect,
  type FileSystem,
  Option,
  Ref,
  Result,
  type Scope,
  SubscriptionRef,
} from "effect"
import { AppConfig } from "../core/AppConfig.ts"
import { line } from "../core/log.ts"
import { section } from "../organs/evidence.ts"
import { Organs } from "../organs/Organs.ts"
import { printSummary } from "../print/summary.ts"
import { formatDuration } from "../project/configFile.ts"
import { beadsWhy, type TicketId } from "../services/Beads.ts"
import { EventStream } from "../services/EventStream.ts"
import { earlyEvidence } from "../services/figures.ts"
import type { Notifier } from "../services/Notifier.ts"
import { OrganCost } from "../services/OrganCost.ts"
import { endRecord } from "../services/Spending.ts"
import { dependentFollowUps, scorecardsEvidence, scorecardsReport } from "../services/scorecard.ts"
import { awakeSince } from "../services/Wake.ts"
import { askedQuestions, readAnswers, takeAnswers } from "./asked.ts"
import { askedLook } from "./askedLook.ts"
import {
  AutoAnswer,
  answeredQuestions,
  answerQuestions,
  makeAutoAnswering,
  notifyLeftOpen,
} from "./autoAnswer.ts"
import { carryWaiting } from "./carry.ts"
import { make as makeEndOfRun } from "./endOfRun.ts"
import { featureRequestHeading } from "./feature.ts"
import {
  changeStops,
  exitCodeOf,
  exitCodes,
  extendFirst,
  putFirst,
  stopFor,
  takesBack,
  takesNew,
} from "./holds.ts"
import { Ledger } from "./ledger.ts"
import { make as makeLoop } from "./look.ts"
import type { TicketPhase } from "./phase.ts"
import { capEvidence } from "./pressureCap.ts"
import { backoff, failedRead, lasted, type Outage, readDue, sustained } from "./queueOutage.ts"
import { interruptedText, keptText } from "./quit.ts"
import { quitStop } from "./quitting.ts"
import { dropRechecks } from "./recheck.ts"
import { type ReportOut, type ReportRun, runReport, showConcurrency } from "./report.ts"
import { failedChecksSection, followUpsSection } from "./reportEvidence.ts"
import { showOn } from "./runView.ts"
import { beadsOutage } from "./schedule.ts"
import { retrySetups } from "./setup.ts"
import { reads } from "./wakes.ts"
import { requeueWaiting, type WorkEnv } from "./work.ts"

export {
  errorStop,
  type Outcome,
  panicStop,
  type RunEnv,
  type RunOptions,
  showEndOfRun,
} from "./run/shared.ts"

import { make as makeHolds } from "./run/holds.ts"
import { make as makeMergeSide } from "./run/mergeSide.ts"
import type { RunParts } from "./run/parts.ts"
import { make as makeServices } from "./run/services.ts"
import {
  firstLine,
  type Outcome,
  type RunEnv,
  type RunOptions,
  showEndOfRun,
} from "./run/shared.ts"
import { make as startRun } from "./run/start.ts"
import { make as makeStarting } from "./run/starting.ts"
import { afterStart, make as makeWatchers } from "./run/watchers.ts"

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
    const services = yield* makeServices(options, begun)
    const {
      config,
      beads,
      attention,
      ledger,
      logs,
      events,
      context,
      base,
      startHead,
      status,
      screen,
      commands,
      wakes,
      holds,
    } = services
    const { changeHolds, currentStops, stopped } = holds
    const runHolds = yield* makeHolds(services)
    const { quitting, panicked, setUps, environment, usage, organs, triage, gate, pressure, disk } =
      runHolds
    const merge = yield* makeMergeSide(services, runHolds)
    const { early, critic, auditor, playbook, queue, mergeStop, branches } = merge

    const starting = yield* makeStarting(options, services, runHolds, merge)
    const { checksGate, beforeStart, machine, predictor, carrying, scheduler, lookAround } =
      starting

    const parts: RunParts = { options, begun, services, holds: runHolds, merge, starting }
    const watchers = yield* makeWatchers(parts)
    const { watch, quits } = watchers
    const started = yield* startRun(parts, watchers)
    const { unslotted, carryOptions, waitingOf } = started
    // Whether a question --auto-answer takes waits for its time, as the last fill found (look.ts).
    const autoAnswering = yield* Ref.make(false)
    // bd failing every fill's read of the queue since, if it does (queueOutage.ts).
    const outage = yield* Ref.make<Outage | null>(null)
    yield* afterStart(parts, watchers)

    // bd's open list, read here once where a ticket is Asked, for the answers and the fill both: a
    // ticket whose question it has open isn't shown (asked.ts's AskedLook).
    const lookAtAsked = Effect.gen(function* () {
      const asked = [...(yield* ledger.current).tickets.values()].some(
        (entry) => entry.phase._tag === "Asked",
      )
      const listed = asked ? yield* Effect.result(beads.list()) : undefined
      const open = listed !== undefined && Result.isSuccess(listed) ? listed.success : undefined
      // The panel beside the tickets table shows the questions Asked tickets wait on, from the
      // list read for them; with none Asked, none.
      if (!asked) yield* showOn(status, "questions")(new Map())
      else if (open !== undefined) {
        yield* showOn(status, "questions")(askedQuestions(yield* ledger.current, open))
      }
      return { open, look: askedLook(open, (yield* SubscriptionRef.get(status)).answered) }
    })
    // The look's effects, which read bd and git: the tickets put back in the queue, the setups,
    // checks and requires taken again, the carried and answered workers taken up, then the free
    // slots filled.
    const fill = Effect.gen(function* () {
      yield* lookAround
      yield* requeueWaiting(branches)
      // A ticket merged, which may bring what a setup that failed in a ticket's worktree needed.
      yield* retrySetups(setUps)
      // The tickets set aside for a failed check whose base has moved on are checked once more
      // first, each in a slot: each is done but for its merge, and others may wait on it. One left
      // for a hold, a solo ticket or a slot is due again at a later look (recheck.ts).
      yield* queue.recheck
      // The requires list a merge changed, checked before anything starts (requiresChecked), then a
      // spec run's checks gate, once its environment ticket has merged.
      yield* beforeStart
      // The workers carried over that waited for a slot, then the answered tickets, come back
      // before new ones start, each in a slot of its own and counting toward no limit (carry.ts,
      // asked.ts); one with no slot for it waits for a later look. Not while the run holds or
      // winds down, which takes up only what is running: the next run resumes them, though the look
      // still reads which questions are answered.
      yield* Ref.set(unslotted, new Set())
      const gateNow = yield* gate
      if (takesBack(gateNow)) {
        const left = yield* carryWaiting(carryOptions, yield* Ref.get(carrying)).pipe(
          Effect.provideContext(context),
        )
        yield* Ref.set(carrying, waitingOf(left))
      }
      const read = yield* lookAtAsked
      const { look } = read
      let { open } = read
      if (takesBack(gateNow)) {
        // --auto-answer's questions first, so that takeAnswers resumes their tickets at once; one
        // still waiting for its time keeps the run from ending on it.
        const before = (yield* answeredQuestions).length
        yield* Ref.set(autoAnswering, yield* answerQuestions(look))
        // A question answered closed since the list was read: the fill reads it afresh.
        if ((yield* answeredQuestions).length !== before) open = undefined
        yield* takeAnswers(carryOptions, look)
      } else {
        yield* Ref.set(autoAnswering, false)
        // Winding down, it answers none: the questions --auto-answer took at once, which notified
        // nothing, notify now. A hold only puts their answer off.
        if (gateNow.windingDown) yield* notifyLeftOpen
        // A question answered meanwhile needs you no longer, though its ticket comes back later.
        yield* readAnswers(look)
      }
      // Those answered with no slot for them need you no longer: a later look brings them back.
      yield* showOn(status, "answered")(look.noSlot)
      // A fill bd can't read the queue for leaves the slots as they are, and a later look reads it
      // again; bd failing every read for beadsOutage stops the run (queueOutage.ts).
      const failing = yield* Ref.get(outage)
      if (takesNew(yield* gate) && readDue(failing, yield* Clock.currentTimeMillis)) {
        const filled = yield* Effect.result(
          open === undefined ? scheduler.fillTrying : scheduler.fillWith(open),
        )
        const now = yield* Clock.currentTimeMillis
        if (Result.isSuccess(filled)) {
          yield* Ref.set(outage, null)
          if (failing !== null) {
            const awake = yield* awakeSince(failing.since)
            yield* logs.write(line`read the queue again, after ${lasted(awake)} of bd failing`)
          }
        } else {
          const why = beadsWhy(filled.failure)
          const failed = failedRead(failing, now)
          yield* Ref.set(outage, failed)
          const awake = yield* awakeSince(failed.since)
          if (sustained(awake)) {
            yield* stopped(
              stopFor("BEADS_FAILED", `could not read the queue for ${lasted(awake)}: ${why}`),
            )
          } else {
            const after = backoff(failed.failed)
            const next = Duration.isZero(after) ? "at the next look" : `in ${formatDuration(after)}`
            yield* logs.write(
              line`could not read the queue: ${why}; nothing new starts until it is read, again ${next}, and the run stops if bd fails for ${formatDuration(beadsOutage)}`,
            )
          }
        }
      }
      // For the other runs to count before this one next looks around.
      yield* machine.sayRunning(yield* scheduler.slots)
      // The critic's next review, in a slot the fill left free.
      yield* critic.look
    })
    // The loop (look.ts): it looks at each wake until nothing is left, then ends the run.
    const fillContext = yield* Effect.context<WorkEnv | FileSystem.FileSystem | Notifier>()
    // Where no look runs, the environment hold's wait for its probe and the end's steps, the wakes
    // are this one's: it reads which questions are answered at each, for the dashboard, as a look
    // that takes nothing back does (asked.ts). A look after the wait looks whatever it took.
    const answersAtWakes: Effect.Effect<never> =
      screen === null
        ? Effect.never
        : Effect.forever(
            Effect.gen(function* () {
              if (reads(yield* wakes.take)) {
                const { look } = yield* lookAtAsked
                yield* readAnswers(look)
                yield* showOn(status, "answered")(look.noSlot)
              }
              yield* wakes.next(Effect.never)
            }),
          ).pipe(Effect.provideContext(fillContext))
    const { untilEnd } = yield* makeLoop({
      fill: Effect.provideContext(fill, fillContext),
      wakes,
      gate,
      holds,
      ledger,
      attention,
      scheduler,
      queue,
      triage,
      critic,
      auditor,
      playbook,
      usage,
      commands,
      environment: { probe: (stops) => environment.probe(stops, answersAtWakes) },
      resuming: Effect.map(Ref.get(unslotted), (all) => all.size > 0),
      answering: Ref.get(autoAnswering),
      unread: Effect.map(Ref.get(outage), (now) => now !== null),
      ...(disk === undefined ? {} : { diskHeld: disk.held }),
      setAside: Effect.map(queue.handBacks.setAside, (all) => all.map((each) => each.id)),
      ...(options.filing === undefined
        ? {}
        : { filing: Effect.map(SubscriptionRef.get(options.filing), (now) => now !== null) }),
      showEndOfRun: (tickets) => showEndOfRun(status, tickets),
      dashboard: screen !== null,
      overnight: config.overnight,
    })

    // A panic in the loop quits the run as one in its other fibers does.
    const guardedLoop = Effect.catchDefect(Effect.as(untilEnd, null), (defect) =>
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
