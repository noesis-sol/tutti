// What holds the run (§ 5 item 10, holds.ts), as the run keeps it: its stops, the tickets past
// --ticket-limit, the machine's hold and the usage limit's view, changed one change at a time, each
// shown on the dashboard as it comes: `· stopping` while a stop holds the run, the banners, the usage
// line and its notice. A stop holds the run: said as it comes while tickets still run, unless its
// line was, and the run is woken to look again.
import { Effect, Semaphore, SubscriptionRef } from "effect"
import { EventStream } from "./eventstream.ts"
import { type Holds, noHolds, raiseStop, type StopReason, type Stops, shownHolds } from "./holds.ts"
import { Ledger, type State } from "./ledger.ts"
import { hold, Log } from "./log.ts"
import type { PhaseTag, TicketPhase } from "./phase.ts"
import type { Status } from "./runView.ts"
import { same } from "./same.ts"

/** The phases of a ticket the run is still at: the HOLD line counts them as running. */
const running: ReadonlySet<PhaseTag> = new Set([
  "Working",
  "ToMerge",
  "Merging",
  "Resolving",
  "Fixing",
])

/**
 * Whether the ticket `entry` is one the run waits for: running, and not a worker it stopped for
 * TICKET_LIMIT (`over`) still at it, which goes on until the run ends.
 */
export const waitedFor = (
  entry: { readonly ticket: string; readonly phase: TicketPhase },
  over: ReadonlySet<string>,
) => running.has(entry.phase._tag) && !(entry.phase._tag === "Working" && over.has(entry.ticket))

/** How many of the run's tickets are still running, those over their ticket limit left out. */
const runningIn = (state: State, over: ReadonlySet<string>): number =>
  [...state.tickets.values()].filter((entry) => waitedFor(entry, over)).length

export interface HoldsGate {
  /** What holds the run now. */
  readonly now: Effect.Effect<Holds>
  /** The run's stops now. */
  readonly currentStops: Effect.Effect<Stops>
  /** Changes the holds by `change`, one change at a time, and shows them: gives the holds it found. */
  changeHolds(change: (now: Holds) => Holds): Effect.Effect<Holds>
  /**
   * Holds the run for `stop`: `raise` puts it among the holds. Said as it comes while tickets still
   * run, unless its line was; a worker past its ticket limit goes on, so its hold is said even with
   * nothing else running.
   */
  stopped(stop: StopReason, raise?: (now: Holds) => Holds): Effect.Effect<void>
}

/** The run's holds, shown on `status` beside the run's `notices`; a stop wakes the run (`wakeUp`). */
export const make = (options: {
  readonly status: SubscriptionRef.SubscriptionRef<Status>
  readonly notices: ReadonlyArray<string>
  readonly wakeUp: Effect.Effect<unknown>
}): Effect.Effect<HoldsGate, never, Ledger | Log | EventStream> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const logs = yield* Log
    const events = yield* EventStream
    const { status, notices } = options
    const holds = yield* SubscriptionRef.make<Holds>(noHolds)
    const oneChange = yield* Semaphore.make(1)
    const now = SubscriptionRef.get(holds)

    const changeHolds = (change: (now: Holds) => Holds) =>
      oneChange.withPermits(1)(
        Effect.gen(function* () {
          const before = yield* SubscriptionRef.get(holds)
          const after = change(before)
          if (after === before) return before
          yield* SubscriptionRef.set(holds, after)
          const { notice, ...shown } = shownHolds(after)
          const next = { ...shown, warnings: [...notices, ...(notice === null ? [] : [notice])] }
          const { stopping, holds: banners, usage, warnings } = yield* SubscriptionRef.get(status)
          if (!same({ stopping, holds: banners, usage, warnings }, next)) {
            yield* SubscriptionRef.update(status, (now) => ({ ...now, ...next }))
          }
          return before
        }),
      )

    const stopped = (
      stop: StopReason,
      raise: (now: Holds) => Holds = (now) => raiseStop(now, stop),
    ) =>
      Effect.gen(function* () {
        yield* changeHolds(raise)
        const count = runningIn(yield* ledger.current, (yield* now).overLimit)
        if (!stop.held && (count > 0 || stop.why === "TICKET_LIMIT")) {
          const text = hold(stop.text, count)
          yield* logs.writeWith(
            [text],
            events.emit({
              kind: "hold",
              ...(stop.ticket === undefined ? {} : { ticket: stop.ticket }),
              ...(stop.blocked === undefined ? {} : { blocked: stop.blocked }),
              text,
            }),
          )
        }
        yield* options.wakeUp
      })

    return {
      now,
      currentStops: Effect.map(now, (holds) => holds.stops),
      changeHolds,
      stopped,
    } satisfies HoldsGate
  })
