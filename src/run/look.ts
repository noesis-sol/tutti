// The run's loop (§ 5, run.ts): it looks at the run at each wake until nothing is left, then ends
// it. A look does its effects (the fill, which reads bd and git, unless only an attention change
// woke it, wakes.ts) and reads what they left into a Snapshot, which decide (runEnd.ts) turns into
// what the run does: look again, wait on you or for the usage limit's reset, or end. Nothing left,
// a hold for the environment probes the machine (environment.ts), and the run goes on or ends.
//
// Its parts are the run's, each narrowed to what the loop reads and does, so that the loop runs on
// stubs as well as on the run's own.
import { Effect } from "effect"
import type { Attention } from "../agent/Attention.ts"
import type { EnvironmentHold } from "./environment.ts"
import { changeStops, firstStop, type Gate, swapStop, takesNew } from "./holds.ts"
import type { HoldsGate } from "./holdsGate.ts"
import type { Ledger } from "./ledger.ts"
import { isSettled, type MergeQueue } from "./mergequeue.ts"
import { decide, End, endOfRunBox, type Look, limitedOnly } from "./runEnd.ts"
import type { Scheduler } from "./schedule.ts"
import type { ScreenCommands } from "./screenCommands.ts"
import type { Triage } from "./triage.ts"
import type { UsageLimitHold } from "./usageLimit.ts"
import { reads, type Wakes } from "./wakes.ts"

/** What the loop reads and does, of the run's parts. */
export interface LoopParts {
  /**
   * The look's effects, which read bd and git: the tickets put back in the queue, the setups,
   * checks and requires taken again, the carried and answered workers taken up, the free slots
   * filled.
   */
  readonly fill: Effect.Effect<void>
  readonly wakes: Pick<Wakes, "take" | "next">
  /** Whether the run may take work, read once for each decision (holds.ts's Gate). */
  readonly gate: Effect.Effect<Gate>
  readonly holds: Pick<HoldsGate, "now" | "currentStops" | "changeHolds" | "stopped">
  readonly ledger: Pick<Ledger["Service"], "current">
  readonly attention: Pick<Attention["Service"], "current">
  readonly scheduler: Pick<Scheduler, "running" | "freed" | "interrupt">
  readonly queue: Pick<MergeQueue, "state" | "hold">
  readonly triage: Pick<Triage, "pending">
  readonly usage: Pick<UsageLimitHold, "limited" | "handBacks" | "look">
  readonly commands: Pick<ScreenCommands, "acted" | "endAsked" | "endAfter" | "askEnd">
  readonly environment: Pick<EnvironmentHold, "probe">
  /** Whether a worker to be resumed found no slot since the look began (runEnd.ts's Look). */
  readonly resuming: Effect.Effect<boolean>
  /** Shows the end-of-run box, naming the workers waiting on you; null for none. */
  readonly showEndOfRun: (tickets: ReadonlyArray<string> | null) => Effect.Effect<void>
  /** Whether the run has a dashboard, which shows the end-of-run box. */
  readonly dashboard: boolean
}

export interface Loop {
  /** Looks at the run at each wake until nothing is left and the run is to end. */
  readonly untilEnd: Effect.Effect<void>
}

export const make = (parts: LoopParts): Effect.Effect<Loop> =>
  Effect.sync(() => {
    const { wakes, holds, queue, scheduler, usage, commands } = parts
    // Fills the free slots, after the look's other effects, then reads what they left for the end's
    // decision (runEnd.ts). A look woken only for what bd and git can't have changed, an attention
    // change, skips to the reading (wakes.ts).
    const nothingLeft = Effect.gen(function* () {
      // A merge that ends during this look frees what it held back after the look has read it: the
      // run is done only when nothing was merging as the look began, and its wake has it look again.
      const mergedBefore = isSettled(yield* queue.state)
      const why = yield* wakes.take
      yield* Effect.logDebug(`look, woken for ${why.size === 0 ? "nothing" : [...why].join(", ")}`)
      if (reads(why)) yield* parts.fill
      const look: Look = {
        mergedBefore,
        tickets: (yield* parts.ledger.current).tickets,
        overLimit: (yield* holds.now).overLimit,
        asking: (yield* parts.attention.current).map((request) => request.ticket),
        running: yield* scheduler.running,
        canTake: takesNew(yield* parts.gate),
        resuming: yield* parts.resuming,
        settled: isSettled(yield* queue.state),
        triagePending: yield* parts.triage.pending,
        dashboard: parts.dashboard,
      }
      return look
    })
    // Whether nothing runs but workers waiting for the usage limit (runEnd.ts's limitedOnly).
    const alone = Effect.gen(function* () {
      return limitedOnly({
        limited: yield* usage.limited,
        handBacks: yield* usage.handBacks,
        overLimit: (yield* holds.now).overLimit,
        tickets: (yield* parts.ledger.current).tickets.values(),
        merges: yield* queue.state,
      })
    })
    // Waits until nothing is left. With the usage-limit hold on, the run waits for its reset
    // instead, unless a stop ends it anyway; it ends USAGE_LIMIT when it can't wait for it: whether
    // it does. With everything else done and workers waiting on you (D19), a dashboard shows the
    // end-of-run box and waits, until they are answered, their conflicts handed over (§ 4.3), or the
    // box's `q` ends the run; plain, the run waits only until a stop holds it. Gives whether the
    // usage limit ends it, whether the box's `q` did, and the count of the screen's commands acted
    // on before its last look.
    const untilDone = Effect.gen(function* () {
      for (;;) {
        const seen = yield* commands.acted
        const look = yield* nothingLeft
        const limit = yield* usage.look(yield* alone)
        if (limit !== null) {
          yield* scheduler.interrupt
          // The hand-backs under way, all of workers at the limit, stop as quitting's do.
          yield* queue.hold
          yield* holds.stopped(limit)
          return { limited: true, asked: false, seen }
        }
        const { stop, usageHeld } = yield* parts.gate
        yield* parts.showEndOfRun(endOfRunBox(look))
        const endAsked = yield* commands.endAsked
        const done = End.$match(decide({ ...look, held: stop !== null, usageHeld, endAsked }), {
          // Something runs, merges or could start: the run looks again at its next wake.
          Busy: () => null,
          // The end-of-run box, shown above, waits for an answer, a hand-over or its `q`; plain, a
          // stop: each wakes the run.
          WaitOnYou: () => null,
          // The usage-limit hold's look counts down to the reset, which wakes the run.
          WaitForReset: () => null,
          Done: ({ asked }) => ({ limited: false, asked, seen }),
        })
        if (done !== null) return done
        yield* wakes.next(scheduler.freed)
      }
    })
    // Nothing left: a hold for the environment probes the machine, and goes on or ends the run. A
    // command acted on meanwhile (a hand-back handed over, an answer) has the run look again, the
    // box's `q` it ended on still asked.
    const untilEnd = Effect.gen(function* () {
      for (;;) {
        const { limited, asked, seen } = yield* untilDone
        if (limited) {
          yield* commands.endAfter(null)
          break
        }
        // The probe runs only with its hold's stop alone, the first; it lifts or replaces only
        // that one, those raised while it waited (BLOCKED, TICKET_LIMIT, PAUSED) kept.
        const before = yield* holds.currentStops
        const probed = yield* parts.environment.probe(before)
        const held = firstStop(before)
        if (probed._tag === "Resumed" && held !== null) {
          yield* holds.changeHolds((now) => changeStops(now, (all) => swapStop(all, held, null)))
          continue
        }
        if (probed._tag === "Failed" && held !== null) {
          yield* holds.changeHolds((now) =>
            changeStops(now, (all) => swapStop(all, held, probed.stop)),
          )
        }
        if (yield* commands.endAfter(seen)) break
        if (asked) yield* commands.askEnd
      }
    })
    return { untilEnd }
  })
