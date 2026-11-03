// The pressure cap as the run keeps it (pressureCap.ts): each reading of the machine's load
// (load.ts) steps it, each step said (HOLD: PRESSURE: workers allowed 4 → 3: …, workers allowed
// 3 → 4: …) with its pressure_cap record, and the readings go into events.jsonl as load records, a
// minute apart and at each change of the memory pressure's level or of swapping. The ticket about to
// start or resume waits while the run's workers are at the cap (HOLD: PRESSURE on the title line):
// nothing running is interrupted, suspended or killed, and the merge queue is not capped. Once the
// pressure has passed, the hold says when the cap is due to rise if the calm lasts (PRESSURE ·
// rising in 3m, in notice), kept at each reading; a reading pressed again drops it. While the
// memory is pressed the optional checks (the early check, the train's checks ahead) start none.
// pressure_cap false in .tutti/settings.json turns the cap off: the readings are still recorded.
import { Clock, Effect, Ref, type SubscriptionRef } from "effect"
import { EventStream } from "./eventstream.ts"
import { type PressureHold, withPressureHold } from "./holds.ts"
import type { HoldsGate } from "./holdsGate.ts"
import {
  loadRecordEvery,
  type Pressure,
  pressureRaiseAfter,
  type Reading,
  swappingPerMinute,
} from "./load.ts"
import type { Log } from "./log.ts"
import type { Room } from "./machineGate.ts"
import {
  type Cap,
  type CapChange,
  capAt,
  capLine,
  pressedBy,
  stepCap,
  strainOf,
  unreadWhy,
} from "./pressureCap.ts"
import { type Status, showOn } from "./runView.ts"
import { sayer } from "./say.ts"

/** What the run report is told of the cap: the time below concurrent and the lowest cap. */
export interface CapSpent {
  /** In milliseconds. */
  readonly below: number
  readonly lowest: number
  readonly concurrent: number
}

export interface PressureGate {
  /** Takes in a reading of the machine's load: steps the cap, and records the reading when due. */
  read(reading: Reading): Effect.Effect<void>
  /** The run no longer reads the machine's load: the cap goes back to concurrent. */
  readonly unread: Effect.Effect<void>
  /**
   * Whether the cap has room for the ticket about to start or resume, with `own` slots taken (the
   * scheduler's slotsTaken): when it hasn't, the hold begins, shown on the title line.
   */
  room(own: number): Effect.Effect<Room>
  /** Lifts the hold once the run's `own` workers are under the cap: whether it did. */
  lookAround(own: number): Effect.Effect<boolean>
  /** Whether the memory is pressed now, as last read: the optional checks start none meanwhile. */
  readonly pressed: Effect.Effect<boolean>
  /** The workers allowed now: the cap, concurrent while it is off (share.ts divides by them). */
  readonly allowed: Effect.Effect<number>
  /** The time spent below concurrent so far, and the lowest cap. */
  readonly spent: Effect.Effect<CapSpent>
}

/** What a load record says, for whether the next one is due before loadRecordEvery. */
interface Recorded {
  readonly at: number
  readonly pressure: Pressure
  readonly swapping: boolean
}

/** The hold at `cap`: rising pressureRaiseAfter into its calm, if it is calm. */
const holdAt = (cap: Cap): PressureHold => ({
  rises: cap.calmSince === null ? null : cap.calmSince + pressureRaiseAfter,
})

/**
 * The run's pressure cap out of `concurrent`, off unless `on`; its hold on `holds`, the workers
 * allowed on `status`. A step up wakes the run (`wakeUp`), to fill the slot it gives.
 */
export const make = (options: {
  readonly concurrent: number
  readonly on: boolean
  readonly holds: HoldsGate
  readonly status: SubscriptionRef.SubscriptionRef<Status>
  readonly wakeUp: Effect.Effect<unknown>
}): Effect.Effect<PressureGate, never, Log | EventStream> =>
  Effect.gen(function* () {
    const { concurrent, on, holds, status } = options
    const events = yield* EventStream
    const { say } = yield* sayer
    const cap = yield* Ref.make<Cap>(capAt(concurrent))
    const pressedNow = yield* Ref.make(false)
    const recorded = yield* Ref.make<Recorded | null>(null)
    // The time below concurrent: what ended, and since when it has been below now.
    const below = yield* Ref.make({ done: 0, since: null as number | null, lowest: concurrent })

    // Whether the hold began or lifted.
    const holdPressure = (full: boolean) =>
      Effect.gen(function* () {
        const hold = full ? holdAt(yield* Ref.get(cap)) : null
        const was = yield* holds.changeHolds((now) => withPressureHold(now, hold))
        return (was.pressure != null) !== full
      })

    // Says a step, shows the workers allowed, keeps the time below concurrent, and wakes the run
    // for a step up.
    const changed = (change: CapChange, now: number) =>
      Effect.gen(function* () {
        yield* say({ kind: "pressure_cap", ...change, text: capLine(change) })
        yield* showOn(status, "allowed")(change.to < concurrent ? change.to : null)
        yield* Ref.update(below, (was) => ({
          done:
            change.to >= concurrent && was.since !== null ? was.done + now - was.since : was.done,
          since: change.to >= concurrent ? null : (was.since ?? now),
          lowest: Math.min(was.lowest, change.to),
        }))
        if (change.to > change.from) yield* options.wakeUp
      })

    const record = (reading: Reading, allowed: number) =>
      Effect.gen(function* () {
        const swapping = reading.swapping >= swappingPerMinute
        const { kernel } = reading
        const last = yield* Ref.get(recorded)
        const due =
          last === null ||
          reading.at - last.at >= loadRecordEvery ||
          last.pressure !== kernel.pressure ||
          last.swapping !== swapping
        if (!due) return
        yield* Ref.set(recorded, { at: reading.at, pressure: kernel.pressure, swapping })
        const memory = [...reading.workers.values()].reduce(
          (sum, each) => sum + Math.max(each, 0),
          0,
        )
        yield* events.emit({
          kind: "load",
          pressure: kernel.pressure,
          ...(reading.swapping >= 0 ? { swapping: Math.round(reading.swapping) } : {}),
          ...(kernel.load1 >= 0 ? { load: kernel.load1 } : {}),
          ...(kernel.cores > 0 ? { cores: kernel.cores } : {}),
          memory: memory + reading.check,
          allowed,
          concurrent,
        })
      })

    const read = (reading: Reading) =>
      Effect.gen(function* () {
        const strain = strainOf(reading)
        yield* Ref.set(pressedNow, on && pressedBy(strain))
        if (on) {
          const next = stepCap(yield* Ref.get(cap), strain, reading.at, concurrent)
          yield* Ref.set(cap, next.cap)
          if (next.change !== null) yield* changed(next.change, reading.at)
          // The hold, while on, says when the cap rises next, or that the memory is pressed now.
          yield* holds.changeHolds((now) =>
            now.pressure == null ? now : withPressureHold(now, holdAt(next.cap)),
          )
        }
        yield* record(reading, (yield* Ref.get(cap)).cap)
      })

    const unread = Effect.gen(function* () {
      yield* Ref.set(pressedNow, false)
      const was = yield* Ref.getAndSet(cap, capAt(concurrent))
      if (was.cap < concurrent) {
        yield* changed(
          { from: was.cap, to: concurrent, why: unreadWhy },
          yield* Clock.currentTimeMillis,
        )
      }
    })

    const room = (own: number) =>
      Effect.gen(function* () {
        const allowed = (yield* Ref.get(cap)).cap
        if (!on || own < allowed) return (yield* holdPressure(false)) ? "lifted" : "room"
        return (yield* holdPressure(true)) ? "began" : "held"
      })

    const lookAround = (own: number) =>
      Effect.gen(function* () {
        if (own >= (yield* Ref.get(cap)).cap) return false
        return yield* holdPressure(false)
      })

    const spent = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const { done, since, lowest } = yield* Ref.get(below)
      return { below: done + (since === null ? 0 : now - since), lowest, concurrent }
    })

    return {
      read,
      unread,
      room,
      lookAround,
      pressed: Ref.get(pressedNow),
      allowed: Effect.map(Ref.get(cap), (now) => now.cap),
      spent,
    } satisfies PressureGate
  })
