// The run (§ 5, § 3.4): what follows the startup checks and the run lock, from the START block to
// the end record. It is a scoped Effect. It forks the ready poll, the merge queue's consumer, the
// watchers of the merge queue and of drain requests, and one fiber per running ticket, each into a
// FiberSet of the run's scope (§ 3.4), and drives the scheduler itself: it fills the free slots as
// the run starts, whenever a ticket's fiber ends or a merge finishes, and on each ready poll. Each
// such look first puts back the Waiting tickets whose blockers merged, checks once more in a slot
// each ticket set aside for a failed check whose base has moved on (recheck.ts), and resumes the
// Asked ones whose questions are answered (asked.ts), unless the run holds or winds down; past the
// last look, it only reads which are answered, and the next run takes them back.
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
// open; its banner is on the title line while it holds. An overnight run sets such a ticket aside
// instead, as it does one PAUSED or past its ticket limit, and goes on (overnightAside.ts).
//
// Quitting (§ 4.8, quit.ts): the first request to quit (SIGINT, SIGTERM, SIGHUP, the quit box's
// `q`), a panic in one of the run's fibers, or a worker's turn refused for Claude's login that the
// login check's probes find refused too (loginCheck.ts, login.ts), cuts the loop short: the workers are interrupted at once and their results waited for, the merges
// and hand-backs stopped, triage aborted, then the end below suspends every session and the run
// ends INTERRUPTED (130), PANIC (4) or LOGIN (2), with no report. A second request
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
// BLOCKED (blockedWatch.ts), the loop that looks at the run until nothing is left (look.ts),
// quitting (quitting.ts) and the end's steps (endOfRun.ts).
import { availableParallelism } from "node:os"
import {
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
  Stream,
  SubscriptionRef,
} from "effect"
import { AppConfig } from "../core/AppConfig.ts"
import { line, tagged } from "../core/log.ts"
import { section } from "../organs/evidence.ts"
import { Organs } from "../organs/Organs.ts"
import { printSummary } from "../print/summary.ts"
import { formatDuration } from "../project/configFile.ts"
import { beadsWhy, type TicketId } from "../services/Beads.ts"
import { EventStream } from "../services/EventStream.ts"
import { earlyEvidence } from "../services/figures.ts"
import { OtherWorkers } from "../services/machine.ts"
import type { Notifier } from "../services/Notifier.ts"
import { OrganCost } from "../services/OrganCost.ts"
import { endRecord, Spending, showSums } from "../services/Spending.ts"
import { dependentFollowUps, scorecardsEvidence, scorecardsReport } from "../services/scorecard.ts"
import { awakeSince } from "../services/Wake.ts"
import { askedQuestions, readAnswers, takeAnswers } from "./asked.ts"
import { askedLook } from "./askedLook.ts"
import { off as auditorOff, followEnds } from "./auditor.ts"
import {
  AutoAnswer,
  answeredQuestions,
  answerQuestions,
  makeAutoAnswering,
  notifyLeftOpen,
} from "./autoAnswer.ts"
import { Battery, watchBattery } from "./battery.ts"
import { make as makeBlockedWatch } from "./blockedWatch.ts"
import { clearStaleLocks } from "./branch.ts"
import { type Carried, type CarryOptions, carryOver, carryWaiting } from "./carry.ts"
import { sayAtStart as sayDeferredFree } from "./deferredFree.ts"
import { hear } from "./drain.ts"
import { make as makeEndOfRun } from "./endOfRun.ts"
import { removeLeftProbes } from "./environment.ts"
import { featureRequestHeading } from "./feature.ts"
import { removeLeftFullChecks } from "./fullcheck.ts"
import {
  changeStops,
  exitCodeOf,
  exitCodes,
  extendFirst,
  putFirst,
  stopFor,
  takesBack,
  takesNew,
  withBattery,
  withFiling,
} from "./holds.ts"
import { Ledger } from "./ledger.ts"
import { Load, pressing, watchLoad } from "./load.ts"
import { watchLogins } from "./login.ts"
import { make as makeLoop } from "./look.ts"
import type { QueueState } from "./mergequeue.ts"
import { putBackLeft } from "./mergetrain.ts"
import type { TicketPhase } from "./phase.ts"
import { off as playbookOff } from "./playbookRun.ts"
import { capEvidence } from "./pressureCap.ts"
import { backoff, failedRead, lasted, type Outage, readDue, sustained } from "./queueOutage.ts"
import { interruptedText, keptText } from "./quit.ts"
import { make as makeQuits, quitStop } from "./quitting.ts"
import { dropRechecks } from "./recheck.ts"
import { type ReportOut, type ReportRun, runReport, showConcurrency } from "./report.ts"
import { failedChecksSection, followUpsSection } from "./reportEvidence.ts"
import { runRequires } from "./requires.ts"
import { showOn } from "./runView.ts"
import { beadsOutage, readyPoll } from "./schedule.ts"
import { retrySetups } from "./setup.ts"
import { makeShareKeeper } from "./share.ts"
import { watchSleeps } from "./slept.ts"
import { Trash } from "./trash.ts"
import { loadUnmerged } from "./unmerged.ts"
import { mergeWakes, reads } from "./wakes.ts"
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
import { make as makeServices } from "./run/services.ts"
import {
  firstLine,
  type Outcome,
  type RunEnv,
  type RunOptions,
  showEndOfRun,
} from "./run/shared.ts"
import { make as makeStarting } from "./run/starting.ts"

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
      host,
      attention,
      ledger,
      logs,
      events,
      fibers,
      context,
      base,
      startHead,
      status,
      screen,
      commands,
      wakes,
      wakeUp,
      holds,
    } = services
    const { changeHolds, currentStops, stopped } = holds
    const runHolds = yield* makeHolds(services)
    const {
      quitting,
      panicked,
      setUps,
      environment,
      usage,
      apiOutage,
      loginCheck,
      organs,
      triage,
      gate,
      pressed,
      pressure,
      disk,
      overnight,
    } = runHolds
    const merge = yield* makeMergeSide(services, runHolds)
    const { early, critic, auditor, playbook, queue, mergeStop, branches } = merge

    const starting = yield* makeStarting(options, services, runHolds, merge)
    const {
      onResumedLimit,
      outcomeOf,
      checksGate,
      beforeStart,
      machine,
      predictor,
      carrying,
      scheduler,
      lookAround,
    } = starting

    // The run's watchers: one that dies panics the run.
    const watchers = yield* fibers.make("run")
    const watch = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      FiberSet.run(
        watchers,
        Effect.catchDefect(effect, (defect) =>
          panicked("the run", stopFor("PANIC", `the run's fiber: ${firstLine(defect)}`), defect),
        ),
      )
    // A worker's turn refused for Claude's login holds the run for the login check (loginCheck.ts).
    yield* watch(watchLogins(loginCheck.refused))
    yield* watch(apiOutage.watch)
    // Each ticket whose part in the run ends is audited, with the auditor on (auditor.ts).
    if (auditor !== auditorOff) yield* watch(followEnds(ledger.changes, auditor))
    // And counted for the lessons it was given, and towards the next reflection (playbookRun.ts).
    if (playbook !== playbookOff) yield* watch(followEnds(ledger.changes, playbook))
    // The title line's badge while the keep-awake command holds the machine awake.
    if (options.keepingAwake !== undefined) {
      yield* watch(Stream.runForEach(options.keepingAwake, showOn(status, "keepAwake")))
    }

    // Each sleep of the machine the run notices, said with its SLEPT line (slept.ts).
    yield* watch(watchSleeps({ keepAwake: config.keepAwake }))
    // The battery, read every minute while the run goes (battery.ts): a BATTERY line and record as
    // it falls to 20% and to 10%, discharging, and its notice on the dashboard's warning line; at
    // 10% the run winds down as a drain request does, and plugging in doesn't take that back.
    const batterySource = yield* Battery
    if (batterySource !== null) {
      yield* watch(
        watchBattery({
          source: batterySource,
          platform: process.platform,
          show: (notice) => changeHolds((now) => withBattery(now, notice)),
          windDown: (level) =>
            Effect.andThen(
              hear({ on: true, how: `by the battery at ${level}%` }, queue.rechecks),
              wakeUp("drain"),
            ),
        }),
      )
    }

    // A spec's breakdown filing the rest of the scope (specRun.ts): its banner, and a look at what
    // it filed, as it files.
    if (options.filing !== undefined) {
      yield* watch(
        Stream.runForEach(SubscriptionRef.changes(options.filing), (filing) =>
          Effect.andThen(
            changeHolds((now) => withFiling(now, filing)),
            wakeUp("poll"),
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
      critic,
      auditor,
      playbook,
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

    // The lock files a git stopped mid-write left in the main repository (a run killed mid
    // fast-forward, a power loss), removed before anything writes there (branch.ts).
    yield* untilQuit(clearStaleLocks(config.repo), undefined)

    // The branches a killed run's trains left rebased onto the branch ahead, put back before their
    // tickets are carried over to merge (mergetrain.ts). One cut short by a quit keeps its mark in
    // state.json, for the next run to put back.
    yield* untilQuit(putBackLeft(config.repo, setUps), undefined)

    // The full check's worktrees a run killed while its full check ran left, removed (fullcheck.ts).
    yield* untilQuit(removeLeftFullChecks, undefined)

    // The probe's worktrees a run killed while the probe's setup ran left, removed (environment.ts).
    yield* untilQuit(removeLeftProbes, undefined)

    // The merged worktrees' folders an earlier run left in the trash folder, deleted in the
    // background (trash.ts), before a carried-over ticket's merge sets aside any more.
    yield* untilQuit((yield* Trash).clearLeft, undefined)

    // The workers the last run left (carry.ts), taken up before the first dispatch: each resumed
    // takes a slot, counting toward no limit, its ticket limit counted afresh; one with no slot
    // for it waits for a later look. A quit takes up no more of them: those not yet taken stay in
    // state.json as they were, for the next run.
    // The workers to be resumed that found no slot since the look began, for its end (runEnd.ts).
    const unslotted = yield* Ref.make<ReadonlySet<string>>(new Set())
    // Whether a question --auto-answer takes waits for its time, as the last fill found (look.ts).
    const autoAnswering = yield* Ref.make(false)
    // bd failing every fill's read of the queue since, if it does (queueOutage.ts).
    const outage = yield* Ref.make<Outage | null>(null)
    const carryOptions: CarryOptions = {
      base,
      queue,
      triage,
      closedBranches: branches,
      onTicketLimit: onResumedLimit,
      ...overnight,
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
    const waitingOf = (carried: ReadonlyMap<TicketId, Carried>) =>
      new Set([...carried].flatMap(([id, what]) => (what === "waiting" ? [id] : [])))
    const carried: ReadonlyMap<TicketId, Carried> =
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
    if (machine.poll !== undefined) yield* watch(machine.poll(lookAround))
    // Triage's verdicts go on their tickets' rows as they come in.
    yield* watch(Stream.runForEach(triage.verdicts, showOn(status, "verdicts", Object.is)))
    // How the checks ahead of their turn to merge go shows on their tickets' cards (mergetrain.ts).
    yield* watch(Stream.runForEach(queue.checksAhead, showOn(status, "checksAhead", Object.is)))
    // The environment probe's session shows as a card while it runs.
    yield* watch(Stream.runForEach(environment.probing, showOn(status, "probe")))
    // What each worker consumes, for its view's figures (§ 7.5): its tokens and dollars, live
    // while a turn goes on, at most once a second (showSums); and how full its context is, as the
    // host last asked it.
    if (screen !== null) {
      const spending = yield* Effect.serviceOption(Spending)
      if (Option.isSome(spending)) {
        yield* watch(
          Effect.scoped(showSums(spending.value.sums, showOn(status, "spending", Object.is))),
        )
      }
      yield* watch(Stream.runForEach(host.contexts, showOn(status, "contexts", Object.is)))
      // What the run's records say of each ticket so far, for its row's box (§ 7.2).
      yield* watch(Stream.runForEach(events.scorings, showOn(status, "scoring", Object.is)))
    }
    // The machine's load (load.ts), with the dashboard or plain output: the pressure cap's readings,
    // the load line and each worker's memory in Current. A reading that fails stops the reading,
    // not the run: the line stays as it was last read, and the cap goes back to concurrent.
    const loadSource = yield* Load
    if (loadSource !== null) {
      // The workers' share of the machine for their checks (share.ts), worked out again at each
      // reading from the workers the pressure cap allows then: kept in .tutti/run/share.json.
      const otherWorkers = yield* OtherWorkers
      const share = yield* makeShareKeeper({
        repo: config.repo,
        machine: { cores: availableParallelism(), limit: config.machineWorkers },
        allowed: pressure.allowed,
        others: otherWorkers.others,
      })
      yield* watch(
        watchLoad({
          source: loadSource,
          roots: host.processes,
          runs: otherWorkers.runs,
          self: process.pid,
          dir: config.worktrees,
          show: (load) =>
            Effect.asVoid(
              Effect.all([
                Ref.set(pressed, pressing(load.levels)),
                pressure.read(load),
                disk === undefined ? Effect.void : disk.read(load),
                share.read(load),
                showOn(status, "load")(load),
              ]),
            ),
        }).pipe(
          Effect.catchDefect((defect) =>
            Effect.andThen(
              // No longer read: the machine's hold alone counts.
              Effect.andThen(
                Ref.set(pressed, false),
                logs.write(
                  tagged(
                    "LOAD_FAILED",
                  )`${firstLine(defect)}; the machine's load is not shown for the rest of the run`,
                ),
              ),
              // Nor the pressure: the workers allowed go back to concurrent, and the share with them.
              Effect.andThen(pressure.unread, share.refresh),
            ),
          ),
        ),
      )
    }
    // The screen's commands, and the hand-backs waiting on steered workers for their views' notices
    // (screenCommands.ts, § 4.3).
    if (screen !== null) {
      yield* commands.listen(screen, {
        queue,
        hearQuit: quits.hearQuit,
        watch,
        wakeUp: wakeUp("command"),
      })
    }
    // The ready poll, the merge queue's changes a look can act on (wakes.ts's mergeWakes) and drain
    // requests each wake the run. The merges stopping is taken up at every change.
    yield* watch(Effect.forever(Effect.andThen(Effect.sleep(readyPoll), wakeUp("poll"))))
    const queueSeen = yield* Ref.make<QueueState | null>(null)
    yield* watch(
      Stream.runForEach(queue.changes, (state) =>
        Effect.gen(function* () {
          yield* mergeStop(state)
          if (mergeWakes(yield* Ref.getAndSet(queueSeen, state), state)) yield* wakeUp("merge")
        }),
      ),
    )
    const drains = options.drains
    if (drains !== undefined) {
      yield* watch(
        Effect.forever(
          Effect.andThen(
            Effect.flatMap(Queue.take(drains), (request) => hear(request, queue.rechecks)),
            wakeUp("drain"),
          ),
        ),
      )
    }

    // A request unanswered for its time holds the run with BLOCKED, for its ticket, until its
    // ticket has none open (blockedWatch.ts).
    yield* makeBlockedWatch({ holds, ended: commands.ended, wakeUp, watch, ...overnight })

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
