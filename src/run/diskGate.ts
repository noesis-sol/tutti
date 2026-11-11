// The disk hold as the run keeps it (disk.ts): each reading of the machine's load (load.ts) gives
// the free disk where the worktrees go. The ticket about to start or resume asks for room, the disk
// read afresh for it (the last reading where it can't be, as when the load is no longer read): under
// diskFloor the hold begins, said once (HOLD: DISK: … with its disk_hold record) and shown on the
// title line, and nothing starts or resumes; the workers running go on, and their tickets merge.
// The first reading back at diskClear lifts it, said (disk hold lifted: …), and wakes the run to
// fill its slots. Held with nothing running, the run waits rather than end on the tickets it held
// back (runEnd.ts's Look). A disk that can't be read changes nothing.
import { Effect, Ref } from "effect"
import type { Log } from "../core/log.ts"
import type { EventStream } from "../services/EventStream.ts"
import { diskLow, holdLine, liftedLine } from "./disk.ts"
import { withDiskHold } from "./holds.ts"
import type { HoldsGate } from "./holdsGate.ts"
import type { DiskFree, Reading } from "./load.ts"
import type { Room } from "./machineGate.ts"
import { sayer } from "./say.ts"

export interface DiskGate {
  /** Takes in a reading of the machine's load: its free disk lifts the hold once it is enough. */
  read(reading: Reading): Effect.Effect<void>
  /**
   * Whether the disk has room for the ticket about to start or resume: when it hasn't, the hold
   * begins, said and shown on the title line; when it has, a hold is lifted.
   */
  readonly room: Effect.Effect<Room>
  /** Whether the hold is on. */
  readonly held: Effect.Effect<boolean>
}

/**
 * The run's disk hold on `holds`, from the load's readings and `measure`, the free disk where the
 * worktrees go read afresh. A lift by a reading wakes the run (`wakeUp`).
 */
export const make = (options: {
  readonly holds: HoldsGate
  readonly measure: Effect.Effect<DiskFree | undefined>
  readonly wakeUp: Effect.Effect<unknown>
}): Effect.Effect<DiskGate, never, Log | EventStream> =>
  Effect.gen(function* () {
    const { holds } = options
    const { say } = yield* sayer
    // The last free disk read; null before the first.
    const last = yield* Ref.make<DiskFree | null>(null)
    const held = Effect.map(holds.now, (now) => now.disk === true)

    // Puts the hold on (`low`) or off for `disk`, saying it: whether this call changed it.
    const hold = (low: boolean, disk: DiskFree) =>
      Effect.gen(function* () {
        const was = yield* holds.changeHolds((now) => withDiskHold(now, low))
        if ((was.disk === true) === low) return false
        const text = low ? holdLine(disk) : liftedLine(disk)
        yield* say({ kind: "disk_hold", held: low, free: disk.free, where: disk.where, text })
        return true
      })

    const read = (reading: Reading) =>
      Effect.gen(function* () {
        const disk = reading.disk
        if (disk === undefined) return
        yield* Ref.set(last, disk)
        if ((yield* held) && !diskLow(true, disk.free) && (yield* hold(false, disk))) {
          yield* options.wakeUp
        }
      })

    const room = Effect.gen(function* () {
      const fresh = yield* options.measure
      if (fresh !== undefined) yield* Ref.set(last, fresh)
      const disk = fresh ?? (yield* Ref.get(last))
      const on = yield* held
      if (disk === null) return on ? "held" : "room"
      if (diskLow(on, disk.free)) return (yield* hold(true, disk)) ? "began" : "held"
      return (yield* hold(false, disk)) ? "lifted" : "room"
    }) satisfies Effect.Effect<Room>

    return { read, room, held } satisfies DiskGate
  })
