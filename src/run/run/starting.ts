// Starting tickets (run.ts, § 5 items 3 to 5): a ticket's fiber, dispatched or carried over, and
// the stop it ends with; the requires list checked again when a merge changed it (requires.ts);
// a spec run's checks gate (checksGate.ts, § 4.14), asked in init's form in place of the dashboard
// (gateForm.ts); the machine's cap on workers across its runs (machineGate.ts) and the room the
// pressure cap, the machine and the disk leave; the queue's footprints (§ 8.4) and the predictor
// (predict.ts); and the scheduler (schedule.ts), which starts each ticket in a slot.
import { join } from "node:path"
import type { FileSystem } from "effect"
import { Effect, Option, Ref, type Scope, Semaphore } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { scoutSearch } from "../../init/checks.ts"
import { liveMachine } from "../../init/steps.ts"
import { Organs } from "../../organs/Organs.ts"
import { checkCommands, scriptedChecks } from "../../project/settings.ts"
import type { Issue, TicketId } from "../../services/Beads.ts"
import { checksNow } from "../../services/Checks.ts"
import { type ChecksGate, make as makeChecksGate } from "../checksGate.ts"
import { makeGateAsk, noScout } from "../gateForm.ts"
import { pastTicketLimit, type StopReason, stopFor, stopOfLine, takesBack } from "../holds.ts"
import type { Ledger } from "../ledger.ts"
import { hasRoom, type MachineGate, make as makeMachineGate, type Room } from "../machineGate.ts"
import { make as makePredictor, type Predictor } from "../predict.ts"
import { runRequires } from "../requires.ts"
import { showOn } from "../runView.ts"
import { footprintsOf, make as makeScheduler, type Scheduler } from "../schedule.ts"
import { type WorkEnv, type WorkError, type Worked, work } from "../work.ts"
import type { Holds } from "./holds.ts"
import type { MergeSide } from "./mergeSide.ts"
import type { Services } from "./services.ts"
import { causeStop, defectOf, type RunEnv, type RunOptions } from "./shared.ts"

/** A ticket's fiber, dispatched or carried over: its work, and the stop it ended with, if any. */
export interface TicketFibers {
  /** The stop a worker resumed by carry-over or an answer ended with, naming its ticket. */
  readonly onResumedLimit: (stop: StopReason) => Effect.Effect<void>
  /** What a ticket's fiber ending with `worked` does: its settling counted, its stop taken up. */
  readonly outcomeOf: <R>(
    ticket: TicketId,
    worked: Effect.Effect<Worked, WorkError, R>,
  ) => Effect.Effect<void, never, R>
  /** A ticket's fiber, dispatched: its work in the run's context. */
  readonly ticketFiber: (issue: Issue) => Effect.Effect<void>
}

/** A ticket's fiber and what its end does to the run. */
export const ticketFibers = (
  services: Pick<Services, "base" | "context" | "holds">,
  runHolds: Pick<Holds, "panicked" | "setUps" | "environment" | "triage" | "overnight">,
  merge: Pick<MergeSide, "playbook" | "queue" | "branches">,
): TicketFibers => {
  const { base, context } = services
  const { stopped } = services.holds
  const { panicked, setUps, environment, triage, overnight } = runHolds
  const { playbook, queue, branches } = merge
  // A ticket's fiber, dispatched or carried over: its work, and the stop it ended with, if any.
  const onTicketLimit = (ticket: TicketId) => (stop: StopReason) =>
    stopped(stop, (now) => pastTicketLimit(now, ticket, stop))
  // The same, for workers resumed by carry-over or an answer, each stop naming its ticket.
  const onResumedLimit = (stop: StopReason) =>
    stop.ticket === undefined ? stopped(stop) : onTicketLimit(stop.ticket)(stop)
  const outcomeOf = <R>(ticket: TicketId, worked: Effect.Effect<Worked, WorkError, R>) =>
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
      work(
        { ...issue, lessons: playbook.section(issue.id) },
        {
          base,
          queue,
          triage,
          setUps,
          closedBranches: branches,
          onTicketLimit: onTicketLimit(issue.id),
          ...overnight,
        },
      ),
    ).pipe(Effect.provideContext(context))

  return { onResumedLimit, outcomeOf, ticketFiber }
}

/** What starts the run's tickets, and the fibers they run in. */
export interface Starting extends Pick<TicketFibers, "onResumedLimit" | "outcomeOf"> {
  /** A spec run's checks gate (checksGate.ts): its hold stops the run. */
  readonly checksGate: ChecksGate
  /** The requires list a merge changed, checked, then the checks gate, before anything starts. */
  readonly beforeStart: Effect.Effect<void>
  readonly machine: MachineGate
  /** The predictor, with organs, the queue's footprint on and more than one slot. */
  readonly predictor: Predictor | undefined
  /** The tickets the last run left whose workers wait for a slot to be resumed (carry.ts). */
  readonly carrying: Ref.Ref<ReadonlySet<TicketId>>
  readonly scheduler: Scheduler
  /** A look around the machine (machineGate.ts): the hold's end writes the queue's record. */
  readonly lookAround: Effect.Effect<void>
}

/** What starts the run's tickets, made over the parts before it, in the run's scope. */
export const make = (
  options: Pick<RunOptions, "version" | "gateAsk">,
  services: Pick<
    Services,
    "config" | "store" | "base" | "context" | "status" | "screen" | "wakeUp" | "holds"
  >,
  runHolds: Pick<
    Holds,
    | "panicked"
    | "setUps"
    | "environment"
    | "organs"
    | "triage"
    | "limitReached"
    | "gate"
    | "slots"
    | "machineFull"
    | "pressure"
    | "disk"
    | "overnight"
  >,
  merge: Pick<MergeSide, "early" | "criticIdle" | "playbook" | "queue" | "branches">,
): Effect.Effect<
  Starting,
  never,
  RunEnv | Ledger | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const { config, store, base, status, screen, wakeUp, holds } = services
    const { stopped } = services.holds
    const { setUps, organs, limitReached, gate, slots, machineFull, pressure, disk } = runHolds
    const { early, criticIdle, playbook, queue, branches } = merge
    const { onResumedLimit, outcomeOf, ticketFiber } = ticketFibers(services, runHolds, merge)
    // A merge that changed the requires list has it checked again before the next ticket starts
    // (requires.ts): what is still missing stops the run as at its start, the running tickets
    // finishing first. The scheduler checks it before each start and carry (its beforeStart), so
    // that a merge during a look's fill is checked before the fill starts another; one check at a
    // time, so that a start while one runs waits for its answer.
    const requiresChecking = yield* Semaphore.make(1)
    const requiresContext = yield* Effect.context<
      WorkEnv | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
    >()
    const requiresChecked = requiresChecking
      .withPermit(
        Effect.gen(function* () {
          if (!(yield* setUps.requiresDue)) return
          const missing = yield* runRequires(yield* setUps.requires, {
            repo: config.repo,
            installLimit: (yield* checksNow).fast.timeout,
          })
          if (missing !== "") yield* stopped(stopFor("REQUIREMENTS_MISSING", missing))
        }),
      )
      .pipe(Effect.provideContext(requiresContext))
    // With the dashboard, the gate asks in init's form in place of it (gateForm.ts): tutti checks'
    // step, scouting with the run's organs where it has them.
    const gateAsk =
      options.gateAsk ??
      (screen?.form === undefined || config.specPath === null
        ? undefined
        : yield* makeGateAsk({
            slot: screen.form,
            base,
            version: options.version,
            scout: Option.isSome(organs)
              ? (repo: string) =>
                  scoutSearch(repo).pipe(Effect.provideService(Organs, organs.value))
              : noScout,
            machine: yield* liveMachine,
          }))
    // A spec run's checks gate (checksGate.ts): once its environment ticket has merged, the checks
    // on the base are checked before anything else of the tree starts or resumes; a hold stops the
    // run. The dashboard shows it as the full check's phase.
    const checksGate = yield* makeChecksGate({
      base,
      setUps,
      stopped: (stop) => stopped(stop),
      show: showOn(status, "fullCheck"),
      takesWork: Effect.map(gate, takesBack),
      ...(gateAsk === undefined ? {} : { ask: gateAsk }),
      early,
    })
    const beforeStart = Effect.andThen(requiresChecked, checksGate.before)

    // The machine's other tutti and orchestra runs (machineGate.ts): with --machine-workers, the
    // ticket about to start waits while the workers across them are at that cap.
    const machine = yield* makeMachineGate({ holds, status, wakeUp: wakeUp("hold") })
    // The workers allowed are the least of concurrent, the machine's cap and the pressure cap: the
    // pressure cap's room is asked first, then the machine's, then the disk's.
    const room = (own: number): Effect.Effect<Room> =>
      Effect.gen(function* () {
        const first = yield* pressure.room(own)
        if (!hasRoom(first)) return first
        const second = yield* machine.room(own)
        if (!hasRoom(second)) return second
        const third = disk === undefined ? "room" : yield* disk.room
        if (!hasRoom(third)) return third
        return [first, second, third].includes("lifted") ? "lifted" : "room"
      })
    // With the queue's footprint on (§ 8.4), a ticket sharing a function or an area with a running
    // one is held back, and one sharing a file is warned of as it starts: the checks' scripts, and
    // what the merge and full checks' scripts run, count as no ticket's, and the queue's shared
    // files warn of none. A ticket works in the worktree the Store saved
    // for it, wherever git had it (a reused one, or one an earlier run's --worktrees put
    // elsewhere), or else in <worktrees>/<id>.
    const footprints = config.settings.queue.footprint
      ? yield* footprintsOf({
          repo: config.repo,
          base,
          checkCommands: checkCommands(config.settings),
          scriptedChecks: scriptedChecks(config.settings),
          sharedFiles: config.settings.queue.shared_files,
          vendored: config.settings.vendored,
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
        ? yield* makePredictor({ repo: config.repo, vendored: config.settings.vendored }).pipe(
            Effect.provideService(Organs, organs.value),
          )
        : undefined
    // The tickets the last run left whose workers wait for a slot to be resumed (carry.ts): the
    // scheduler dispatches none of them afresh.
    const carrying = yield* Ref.make<ReadonlySet<TicketId>>(new Set())
    const scheduler = yield* makeScheduler({
      concurrent: config.settings.concurrent,
      limit: config.limit,
      scope: config.ticket,
      excludeTypes: config.settings.queue.exclude_types,
      start: { start: ticketFiber },
      gate,
      beforeStart,
      room,
      machineFull,
      carrying: Ref.get(carrying),
      ...(footprints === undefined ? {} : { footprints }),
      ...(predictor === undefined ? {} : { predictor }),
      playbook,
      closedBranches: branches,
      show: ({ solo, unclosed, waits, skips }) =>
        Effect.andThen(
          Effect.andThen(showOn(status, "solo")(solo), showOn(status, "unclosed")(unclosed)),
          showOn(status, "holdTexts")({ waits, skips }),
        ),
    })
    yield* Ref.set(slots, scheduler.recheckSlot)
    yield* Ref.set(limitReached, scheduler.limitReached)
    yield* Ref.set(
      criticIdle,
      Effect.map(
        Effect.all([scheduler.slots, queue.state, pressure.pressed]),
        ([taken, now, hard]) => taken < config.settings.concurrent && now.merging === null && !hard,
      ),
    )
    // A look around the machine (machineGate.ts): the hold's end writes the queue's record.
    const lookAround = Effect.gen(function* () {
      const own = yield* scheduler.slots
      const lifted = yield* pressure.lookAround(own)
      if ((yield* machine.lookAround(own)) || lifted) yield* scheduler.recordQueue
    })
    return {
      onResumedLimit,
      outcomeOf,
      checksGate,
      beforeStart,
      machine,
      predictor,
      carrying,
      scheduler,
      lookAround,
    }
  })
