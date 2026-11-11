// What holds the run and what it reads (run.ts, § 5 item 10): a stop holds the run (no new tickets,
// the running ones finish and merge), and the run ends once nothing runs or waits to merge, with
// the stops' line and the first one's exit code (holds.ts). Workers failing at once hold the run
// with ENVIRONMENT (environment.ts): once nothing runs, the probe either lifts that stop, and the
// run takes tickets again, or ends the run. The account's usage limit (usageLimit.ts), Claude's
// API unavailable (apiOutage.ts) and a turn refused for the login (loginCheck.ts, § 4.13) hold it
// without a stop. Given Organs, the run triages each ticket set aside in the background
// (triage.ts), its verdicts counting toward the environment hold. Memory pressure (pressureGate.ts)
// and the free disk (diskGate.ts) hold the ticket about to start or resume. The first request to
// quit, or a panic in one of the run's fibers, ends the loop and the run quits (§ 4.8, quitting.ts).
import { Deferred, Effect, FiberSet, Option, Ref, type Scope } from "effect"
import type { Log } from "../../core/log.ts"
import { Organs } from "../../organs/Organs.ts"
import type { TicketId } from "../../services/Beads.ts"
import type { EventStream } from "../../services/EventStream.ts"
import { type ApiOutage, make as makeApiOutage } from "../apiOutage.ts"
import { AutoAnswer } from "../autoAnswer.ts"
import { noteCompactions } from "../compactions.ts"
import { type DiskGate, make as makeDiskGate } from "../diskGate.ts"
import { type EnvironmentHold, make as makeEnvironmentHold } from "../environment.ts"
import {
  firstStop,
  type Gate,
  noMoreWork,
  type StopReason,
  showUsage,
  stopFor,
  takesBack,
  withApiHold,
  withLoginHold,
} from "../holds.ts"
import type { Ledger } from "../ledger.ts"
import { Load } from "../load.ts"
import { loginStop } from "../login.ts"
import { type LoginCheck, make as makeLoginCheck } from "../loginCheck.ts"
import { make as makeOvernightAside, type OvernightAside } from "../overnightAside.ts"
import { make as makePressureGate, type PressureGate } from "../pressureGate.ts"
import { panicLines } from "../quit.ts"
import { Quitting } from "../quitting.ts"
import { showOn } from "../runView.ts"
import { warn } from "../say.ts"
import type { Scheduler } from "../schedule.ts"
import { makeSetUps, type SetUps } from "../setup.ts"
import { make as makeTriage, type Triage, off as triageOff } from "../triage.ts"
import { make as makeUsageHold, type UsageLimitHold } from "../usageLimit.ts"
import { make as watchUsageWindows } from "../usageWindows.ts"
import type { Services } from "./services.ts"
import { firstLine, type RunEnv } from "./shared.ts"

/** What holds the run, and what its parts read of the machine and the account. */
export interface Holds {
  /** The first request to quit, or a panic: it ends the loop, and the run quits. */
  readonly quitting: Deferred.Deferred<Quitting>
  /** A panic in one of the run's fibers (`where`), logged with its stack, quits the run: PANIC. */
  readonly panicked: (where: string, stop: StopReason, defect: unknown) => Effect.Effect<void>
  /** The run's setups (setup.ts), which the merge queue and the tickets' starts share. */
  readonly setUps: SetUps
  readonly environment: EnvironmentHold
  readonly usage: UsageLimitHold
  readonly apiOutage: ApiOutage
  readonly loginCheck: LoginCheck<Log | EventStream>
  /** The run's organs, when it has them. */
  readonly organs: Option.Option<Organs["Service"]>
  readonly triage: Triage
  /** --limit reached, the scheduler's count once it is made: no ticket has started before it is. */
  readonly limitReached: Ref.Ref<Effect.Effect<boolean>>
  /** Whether the run may take work (holds.ts's Gate), read once for each decision. */
  readonly gate: Effect.Effect<Gate>
  /** Why the run takes on no more work, for the merges: no failed check is handed back then. */
  readonly noMore: Effect.Effect<string | undefined>
  /** The scheduler's recheck slot, once it is made: none before it is. */
  readonly slots: Ref.Ref<Scheduler["recheckSlot"] | undefined>
  /** A ticket checked once more takes a slot from the scheduler, or none before it is made. */
  readonly recheckSlot: (ticket: TicketId, work: Effect.Effect<void>) => Effect.Effect<boolean>
  /** Whether the run holds at --machine-workers (machineGate.ts). */
  readonly machineFull: Effect.Effect<boolean>
  /** Whether the machine's last load reading has it pressed (load.ts's pressing). */
  readonly pressed: Ref.Ref<boolean>
  /** Whether the machine is loaded: the time it is, a hand-back's limit and a check's leave out. */
  readonly machineLoaded: Effect.Effect<boolean>
  readonly pressure: PressureGate
  /** The disk gate; none where the machine's load doesn't read the disk. */
  readonly disk: DiskGate | undefined
  /** An overnight run's register of the fibers following their workers (overnightAside.ts). */
  readonly overnight: { readonly overnight?: OvernightAside }
}

/** What holds the run, made over `services`, in the run's scope. */
export const make = (
  services: Pick<
    Services,
    "config" | "ledger" | "logs" | "fibers" | "base" | "status" | "commands" | "wakeUp" | "holds"
  >,
): Effect.Effect<Holds, never, RunEnv | Ledger | Scope.Scope> =>
  Effect.gen(function* () {
    const { config, ledger, logs, fibers, base, status, commands, wakeUp, holds } = services
    const { changeHolds, currentStops, stopped } = holds
    // The first request to quit, or a panic, ends the loop below, and the run quits (quitting.ts).
    const quitting = yield* Deferred.make<Quitting>()
    // A panic in one of the run's fibers (`where`), logged with its stack, quits the run: PANIC.
    const panicked = (where: string, stop: StopReason, defect: unknown) =>
      Effect.andThen(
        logs.write(...panicLines(where, defect)),
        Deferred.succeed(quitting, Quitting.Panic({ stop })),
      )
    // Each worker's compactions are counted and logged (compactions.ts), from before any worker
    // starts or is carried over; a watcher that dies panics the run.
    yield* FiberSet.run(
      yield* fibers.make("compactions"),
      Effect.catchDefect(noteCompactions, (defect) =>
        panicked("the run", stopFor("PANIC", `the run's fiber: ${firstLine(defect)}`), defect),
      ),
    )

    // The run's setups (setup.ts): the setup before each worker and before each check, and the
    // tickets whose setup failed, which the merge queue and the tickets' starts share.
    const setUps = yield* makeSetUps
    // Workers failing at once, or setups failing, hold the run, as a stop does, until the probe
    // (environment.ts).
    const environment = yield* makeEnvironmentHold({
      onHold: stopped,
      base,
      setup: Effect.map(setUps.now, (setup) => setup.command),
    })

    // The account's usage limit holds the run until it resets, without a stop (usageLimit.ts).
    const usage = yield* makeUsageHold({
      base,
      wakeUp: wakeUp("hold"),
      show: (view) => changeHolds((now) => showUsage(now, view)),
    })
    // Claude's API unavailable in a worker's turn holds the run until a probe finds it answering
    // again, its workers told then to carry on (apiOutage.ts); it follows the workers below.
    const apiOutage = yield* makeApiOutage({
      show: (held) => changeHolds((now) => withApiHold(now, held)),
      wakeUp: wakeUp("hold"),
    })
    // A worker's turn refused for Claude's login holds the run while a few probes check the login
    // again, its workers told then what the turn was to tell them; every probe failing quits the
    // run, LOGIN (loginCheck.ts, login.ts, § 4.13), as a refusal outside the run's tickets does.
    const loginCheck = yield* makeLoginCheck({
      show: (held) => changeHolds((now) => withLoginHold(now, held)),
      wakeUp: wakeUp("hold"),
      quit: (first, said) =>
        Effect.gen(function* () {
          const ours = (yield* ledger.current).tickets.has(first.ticket)
          const stop = loginStop(first.error, ours ? first.ticket : undefined)
          if (yield* Deferred.succeed(quitting, Quitting.Login({ stop }))) {
            yield* warn(said, ours ? first.ticket : undefined)
          }
        }),
    })
    // The account's windows on the title line all the time, each figure recorded (usageWindows.ts).
    yield* watchUsageWindows({
      show: showOn(status, "windows"),
      rise: showOn(status, "rise"),
    })

    // Triage in the background, when the run has organs: each verdict wakes the run, which doesn't
    // end while a ticket waits for one.
    const organs = yield* Effect.serviceOption(Organs)
    const triage = Option.isNone(organs)
      ? triageOff
      : yield* makeTriage({ base, hold: environment, done: wakeUp("verdict") }).pipe(
          Effect.provideService(Organs, organs.value),
        )

    // Whether the run may take work (holds.ts's Gate), read once for each decision. --limit is the
    // scheduler's count, made below: no ticket has started before it is.
    const limitReached = yield* Ref.make<Effect.Effect<boolean>>(Effect.succeed(false))
    const gate = Effect.map(
      Effect.all([
        currentStops,
        usage.held,
        apiOutage.held,
        loginCheck.held,
        commands.ended,
        ledger.current,
        Effect.flatten(Ref.get(limitReached)),
      ]),
      ([all, usageHeld, apiHeld, loginHeld, ended, state, limit]): Gate => ({
        stop: firstStop(all),
        usageHeld,
        apiHeld,
        loginHeld,
        ended,
        windingDown: state.windDown !== null,
        limitReached: limit,
      }),
    )
    // --auto-answer answers a question at once only while the run takes work back.
    const auto = yield* AutoAnswer
    if (auto !== null) {
      yield* Ref.set(auto.takesBack, Effect.map(gate, takesBack))
    }
    // Why the run takes on no more work, for the merges: no failed check is handed back then.
    const noMore = Effect.map(gate, noMoreWork)
    // A ticket checked once more takes a slot from the scheduler, made after the queue it starts
    // tickets with: none before it is.
    const slots = yield* Ref.make<Scheduler["recheckSlot"] | undefined>(undefined)
    const recheckSlot = (ticket: TicketId, work: Effect.Effect<void>) =>
      Effect.flatMap(Ref.get(slots), (take) =>
        take === undefined ? Effect.succeed(false) : take(ticket, work),
      )
    // Whether the run holds at --machine-workers (machineGate.ts): no ticket is checked ahead of
    // its turn to merge then (mergetrain.ts).
    const machineFull = Effect.map(holds.now, (now) => now.machine)
    // Whether the machine's last load reading has it pressed (load.ts's pressing): with machineFull,
    // the time a hand-back's limit leaves out (handback.ts).
    const pressed = yield* Ref.make(false)
    // Whether the machine is loaded: the time it is, a hand-back's limit and a check's leave out.
    const machineLoaded = Effect.map(
      Effect.all([machineFull, Ref.get(pressed)]),
      ([full, hard]) => full || hard,
    )
    // The workers memory pressure allows (pressureGate.ts): the ticket about to start or resume
    // waits while the run's workers are at them, and the optional checks start none while the
    // memory is pressed.
    const pressure = yield* makePressureGate({
      concurrent: config.settings.concurrent,
      on: config.settings.pressure_cap,
      holds,
      status,
      wakeUp: wakeUp("hold"),
    })
    // The free disk where the worktrees go (diskGate.ts): under its floor, the ticket about to start
    // or resume waits, until the disk is freed; none where the machine's load doesn't read the disk.
    const diskSource = (yield* Load)?.disk
    const disk =
      diskSource === undefined
        ? undefined
        : yield* makeDiskGate({
            holds,
            measure: diskSource(config.worktrees),
            wakeUp: wakeUp("hold"),
          })
    // An overnight run sets a ticket aside rather than hold the run for PAUSED, BLOCKED or
    // TICKET_LIMIT (overnightAside.ts): its register of the fibers following their workers, the
    // hand-backs' included.
    const overnight = config.overnight ? { overnight: yield* makeOvernightAside } : {}
    return {
      quitting,
      panicked,
      setUps,
      environment,
      usage,
      apiOutage,
      loginCheck,
      organs,
      triage,
      limitReached,
      gate,
      noMore,
      slots,
      recheckSlot,
      machineFull,
      pressed,
      machineLoaded,
      pressure,
      disk,
      overnight,
    }
  })
