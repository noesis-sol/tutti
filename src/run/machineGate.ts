// The machine's other tutti and orchestra runs, as the run counts them (machine.ts): the run
// registers among them, says once of each that it is going (SHARED_MACHINE), and that it has ended.
// With --machine-workers, the ticket about to start waits while the workers across them, this run's
// included, are at that cap, with one of this run's among them (HOLD: MACHINE, said once a hold): a
// run with no worker of its own running never waits, so one at the cap with others' workers alone
// gets on. Held, the run reads the other runs every machinePoll, and looks again once one of their
// workers has finished, so that the slot it freed is filled within seconds.
import { Effect, type FileSystem, type Scope, type SubscriptionRef } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { AppConfig } from "../cli/AppConfig.ts"
import type { EventStream } from "./eventstream.ts"
import { withMachineHold } from "./holds.ts"
import type { HoldsGate } from "./holdsGate.ts"
import { detail, Log } from "./log.ts"
import { holdLine, machinePoll, make as makeMachine, OtherWorkers } from "./machine.ts"
import { type Status, showOn } from "./runView.ts"
import { sayer } from "./say.ts"

/**
 * Whether the machine has room for the ticket about to start: `room`, or `lifted` when the hold at
 * the cap ended for it; `held` while the hold goes on, or `began` when it began. The scheduler
 * writes its queue record when the hold begins or ends (`machine_full`).
 */
export type Room = "room" | "lifted" | "held" | "began"

/** Whether `room` lets the ticket start. */
export const hasRoom = (room: Room): boolean => room === "room" || room === "lifted"

// Each of the gate's calls takes `own`, the run's workers the others count: the slots the scheduler
// counts taken (slotsTaken). Tickets merging or waiting to merge take none up to concurrent of
// them, so they hold the run at no cap; none is taken before it is given.
export interface MachineGate {
  /**
   * Claims room on the machine for the ticket about to start. When it hasn't any, the hold at the
   * cap begins: written on the run's holds and said (HOLD: MACHINE); when it has, a hold is lifted.
   */
  room(own: number): Effect.Effect<Room>
  /**
   * Writes how many of the run's workers run, reads the other runs, saying which started and ended
   * and keeping how many workers they run (OtherWorkers) and how many runs share the machine (the
   * title line's `· shared with 1 run`), and lifts the hold once the machine is under the cap:
   * whether it did.
   */
  lookAround(own: number): Effect.Effect<boolean>
  /** Writes how many of the run's workers run, for the other runs to count. */
  sayRunning(own: number): Effect.Effect<void>
  /**
   * Runs `lookAround` every machinePoll while the run holds at the cap, and wakes it once the
   * machine is under it; undefined without --machine-workers or a folder for the runs.
   */
  readonly poll: ((lookAround: Effect.Effect<void>) => Effect.Effect<void>) | undefined
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
    const { say } = yield* sayer
    const { holds, status } = options
    const machine = yield* makeMachine({
      dir: config.runs,
      repo: config.repo,
      concurrent: config.settings.concurrent,
      cannot: (why) => logs.write(detail`${why}`),
    })
    // The other runs' workers, as each look reads them: a worker's share of the cores counts them.
    const otherWorkers = yield* OtherWorkers
    const machineFull = Effect.map(holds.now, (now) => now.machine)

    const atCap = (own: number) =>
      Effect.gen(function* () {
        const cap = config.machineWorkers
        return cap > 0 && own > 0 && own + (yield* machine.others) >= cap
      })
    // Sets whether the run holds a free slot at the cap, its word on the title line meanwhile, and
    // says whether that changed it.
    const holdMachine = (full: boolean) =>
      Effect.map(
        holds.changeHolds((now) => withMachineHold(now, full)),
        (was) => was.machine !== full,
      )
    const lookAround = (own: number) =>
      Effect.gen(function* () {
        yield* machine.running(own)
        const seen = yield* machine.look
        for (const each of seen) {
          yield* say({ kind: "shared_machine", shared: each.shared, text: each.text })
        }
        const last = seen.at(-1)
        if (last !== undefined) {
          yield* showOn(status, "shared")(last.shared)
        }
        yield* otherWorkers.set(yield* machine.others)
        return !(yield* atCap(own)) && (yield* holdMachine(false))
      })
    const room = (own: number) =>
      Effect.gen(function* () {
        if (!(yield* atCap(own))) return (yield* holdMachine(false)) ? "lifted" : "room"
        if (!(yield* holdMachine(true))) return "held"
        const text = holdLine(own + (yield* machine.others), own, config.machineWorkers)
        yield* say({ kind: "machine_hold", text })
        return "began"
      })
    const poll =
      config.runs !== null && config.machineWorkers > 0
        ? (look: Effect.Effect<void>) =>
            Effect.forever(
              Effect.gen(function* () {
                yield* Effect.sleep(machinePoll)
                if (!(yield* machineFull)) return
                yield* look
                if (!(yield* machineFull)) yield* options.wakeUp
              }),
            )
        : undefined

    return {
      room,
      lookAround,
      sayRunning: machine.running,
      poll,
    } satisfies MachineGate
  })
