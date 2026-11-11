// The run's watchers (run.ts, § 3.4): the fibers of the run's scope that follow its sources while
// it goes, each forked into a FiberSet of the scope, one that dies panicking the run. Before the
// start's steps: the login check and the API outage, the auditor's and the playbook's ends, the
// keep-awake badge, the machine's sleeps, the battery (battery.ts), a spec's breakdown filing the
// scope, and the requests to quit (quitting.ts, § 4.8), heard from before the requirements check
// so that a quit during the start's steps cuts the step under way short. After them: the machine's
// poll, what the dashboard shows of triage, the checks ahead, the probe and each worker's figures
// (§ 7.5), the machine's load (load.ts) and the workers' share of it (share.ts), the screen's
// commands, the ready poll, the merge queue's changes, drain requests (drain.ts) and BLOCKED
// (blockedWatch.ts).
import { availableParallelism } from "node:os"
import {
  Deferred,
  Effect,
  FiberSet,
  Option,
  Queue,
  Ref,
  type Scope,
  Stream,
  SubscriptionRef,
} from "effect"
import { tagged } from "../../core/log.ts"
import { OtherWorkers } from "../../services/machine.ts"
import { Spending, showSums } from "../../services/Spending.ts"
import { off as auditorOff, followEnds } from "../auditor.ts"
import { Battery, watchBattery } from "../battery.ts"
import { make as makeBlockedWatch } from "../blockedWatch.ts"
import { hear } from "../drain.ts"
import { stopFor, withBattery, withFiling } from "../holds.ts"
import type { Ledger } from "../ledger.ts"
import { Load, pressing, watchLoad } from "../load.ts"
import { watchLogins } from "../login.ts"
import type { QueueState } from "../mergequeue.ts"
import { off as playbookOff } from "../playbookRun.ts"
import { make as makeQuits, type Quits } from "../quitting.ts"
import { showOn } from "../runView.ts"
import { readyPoll } from "../schedule.ts"
import { makeShareKeeper } from "../share.ts"
import { watchSleeps } from "../slept.ts"
import { mergeWakes } from "../wakes.ts"
import type { RunParts } from "./parts.ts"
import { firstLine, type RunEnv } from "./shared.ts"

/** The run's watchers, and what the start's steps and the end do with them. */
export interface Watchers {
  /** Forks `effect` into the run's watchers: one that dies panics the run. */
  readonly watch: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<unknown, never, R>
  /** Requests to quit, and quitting's steps (quitting.ts). */
  readonly quits: Quits
  /** One of the start's steps, cut short by a quit, `cut` then; not begun once the run quits. */
  readonly untilQuit: <A, E, R>(step: Effect.Effect<A, E, R>, cut: A) => Effect.Effect<A, E, R>
}

/** The watchers forked before the start's steps, and the quits heard from then on. */
export const make = (
  parts: RunParts,
): Effect.Effect<Watchers, never, RunEnv | Ledger | Scope.Scope> =>
  Effect.gen(function* () {
    const { options } = parts
    const { config, ledger, fibers, status, wakeUp, holds } = parts.services
    const { changeHolds } = holds
    const { quitting, panicked, apiOutage, loginCheck, triage } = parts.holds
    const { critic, auditor, playbook, queue } = parts.merge
    const { scheduler } = parts.starting
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

    return { watch, quits, untilQuit }
  })

/** The watchers forked after the start's steps, the screen's commands and the wakes among them. */
export const afterStart = (
  parts: RunParts,
  watchers: Pick<Watchers, "watch" | "quits">,
): Effect.Effect<void, never, RunEnv | Ledger | Scope.Scope> =>
  Effect.gen(function* () {
    const { options } = parts
    const { config, host, logs, events, status, screen, commands, wakeUp, holds } = parts.services
    const { environment, pressed, pressure, disk, overnight, triage } = parts.holds
    const { queue, mergeStop } = parts.merge
    const { machine, lookAround } = parts.starting
    const { watch, quits } = watchers
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
  })
