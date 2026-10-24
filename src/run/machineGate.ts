// The machine's other tutti and orchestra runs, as the run counts them (machine.ts): the run
// registers among them, says once of each that it is going (SHARED_MACHINE), and that it has ended.
// With --machine-workers, the ticket about to start waits while the workers across them, this run's
// included, are at that cap, with one of this run's among them (HOLD: MACHINE, said once a hold): a
// run with no worker of its own running never waits, so one at the cap with others' workers alone
// gets on. Held, the run reads the other runs every machinePoll, and looks again once one of their
// workers has finished, so that the slot it freed is filled within seconds.
import { Effect, type FileSystem, Ref, type Scope, SubscriptionRef } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { AppConfig } from "../cli/AppConfig.ts"
import { EventStream } from "./eventstream.ts"
import { withMachineHold } from "./holds.ts"
import type { HoldsGate } from "./holdsGate.ts"
import { detail, Log } from "./log.ts"
import { holdLine, machinePoll, make as makeMachine, OtherWorkers } from "./machine.ts"
import type { Status } from "./runView.ts"
import type { Scheduler } from "./schedule.ts"

export interface MachineGate {
  /** Whether the machine has room for the ticket about to start: the hold begins when it hasn't. */
  readonly room: Effect.Effect<boolean>
  /**
   * Writes how many of the run's workers run, reads the other runs, saying which started and ended
   * and keeping how many workers they run (OtherWorkers) and how many runs share the machine (the
   * title line's `· shared with 1 run`), and lifts the hold once the machine is under the cap.
   */
  readonly lookAround: Effect.Effect<void>
  /** Writes how many of the run's workers run, for the other runs to count. */
  readonly sayRunning: Effect.Effect<void>
  /**
   * Reads the other runs every machinePoll while the run holds at the cap, and wakes it once the
   * machine is under it; undefined without --machine-workers or a folder for the runs.
   */
  readonly poll: Effect.Effect<void> | undefined
  /**
   * The scheduler, made after the cap's hold it asks: the run's workers the others count are the
   * slots it counts taken (slotsTaken), and the hold's start and end each write its queue record.
   * Tickets merging or waiting to merge take none up to concurrent of them, so they hold the run at
   * no cap; none is taken before it is given.
   */
  attach(scheduler: Pick<Scheduler, "slots" | "recordQueue">): Effect.Effect<void>
}

/** The run's place among the machine's runs: its hold on `holds`, the runs shared on `status`. */
export const make = (options: {
  readonly holds: HoldsGate
  readonly status: SubscriptionRef.SubscriptionRef<Status>
  readonly wakeUp: Effect.Effect<unknown>
}): Effect.Effect<
  MachineGate,
  never,
  | AppConfig
  | Log
  | EventStream
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | Scope.Scope
> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const logs = yield* Log
    const events = yield* EventStream
    const { holds, status } = options
    const machine = yield* makeMachine({
      dir: config.runs,
      repo: config.repo,
      concurrent: config.settings.concurrent,
      cannot: (why) => logs.write(detail`${why}`),
    })
    // The other runs' workers, as each look reads them: a worker's share of the cores counts them.
    const otherWorkers = yield* OtherWorkers
    const schedulerSlots = yield* Ref.make<Effect.Effect<number>>(Effect.succeed(0))
    const ownWorkers = Effect.flatten(Ref.get(schedulerSlots))
    const queueRecord = yield* Ref.make<Effect.Effect<void>>(Effect.void)
    const machineFull = Effect.map(holds.now, (now) => now.machine)

    const atCap = Effect.gen(function* () {
      const own = yield* ownWorkers
      const cap = config.machineWorkers
      return cap > 0 && own > 0 && own + (yield* machine.others) >= cap
    })
    // Sets whether the run holds a free slot at the cap, its word on the title line meanwhile, and
    // says whether the hold began.
    const holdMachine = (full: boolean) =>
      Effect.gen(function* () {
        if ((yield* holds.changeHolds((now) => withMachineHold(now, full))).machine === full) {
          return false
        }
        if (!full) yield* Effect.flatten(Ref.get(queueRecord))
        return full
      })
    const sayRunning = Effect.flatMap(ownWorkers, machine.running)
    const lookAround = Effect.gen(function* () {
      yield* sayRunning
      const seen = yield* machine.look
      for (const each of seen) {
        yield* logs.writeWith(
          [each.text],
          events.emit({ kind: "shared_machine", shared: each.shared, text: each.text }),
        )
      }
      const last = seen.at(-1)
      if (last !== undefined) {
        yield* SubscriptionRef.update(status, (now) =>
          now.shared === last.shared ? now : { ...now, shared: last.shared },
        )
      }
      yield* otherWorkers.set(yield* machine.others)
      if (!(yield* atCap)) yield* holdMachine(false)
    })
    const room = Effect.gen(function* () {
      if (!(yield* atCap)) {
        yield* holdMachine(false)
        return true
      }
      if (yield* holdMachine(true)) {
        const own = yield* ownWorkers
        const text = holdLine(own + (yield* machine.others), own, config.machineWorkers)
        yield* logs.writeWith([text], events.emit({ kind: "machine_hold", text }))
        yield* Effect.flatten(Ref.get(queueRecord))
      }
      return false
    })
    const poll =
      config.runs !== null && config.machineWorkers > 0
        ? Effect.forever(
            Effect.gen(function* () {
              yield* Effect.sleep(machinePoll)
              if (!(yield* machineFull)) return
              yield* lookAround
              if (!(yield* machineFull)) yield* options.wakeUp
            }),
          )
        : undefined

    return {
      room,
      lookAround,
      sayRunning,
      poll,
      attach: (scheduler) =>
        Effect.andThen(
          Ref.set(queueRecord, scheduler.recordQueue),
          Ref.set(schedulerSlots, scheduler.slots),
        ),
    } satisfies MachineGate
  })
