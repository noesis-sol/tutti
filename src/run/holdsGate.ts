// What holds the run (§ 5 item 10, holds.ts), as the run keeps it: its stops, the tickets past
// --ticket-limit, the machine's hold and the usage limit's view, changed one change at a time, each
// shown on the dashboard as it comes: `· stopping` while a stop holds the run, the banners, the usage
// line and its notice. A stop holds the run: said as it comes while tickets still run, unless its
// line was, and the run is woken to look again.
import { Effect, Option, SubscriptionRef } from "effect"
import type { EventStream } from "./eventstream.ts"
import { type Holds, noHolds, raiseStop, type StopReason, type Stops, shownHolds } from "./holds.ts"
import { Ledger, type State } from "./ledger.ts"
import { hold, type Log } from "./log.ts"
import { phaseFacts, type TicketPhase } from "./phase.ts"
import type { Status } from "./runView.ts"
import { same } from "./same.ts"
import { sayer } from "./say.ts"

/**
 * Whether the ticket `entry` is one the run waits for: running, and not a worker it stopped for
 * TICKET_LIMIT (`over`) still at it, which goes on until the run ends.
 */
export const waitedFor = (
  entry: { readonly ticket: string; readonly phase: TicketPhase },
  over: ReadonlySet<string>,
) =>
  phaseFacts[entry.phase._tag].running &&
  !(entry.phase._tag === "Working" && over.has(entry.ticket))

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
    const { say } = yield* sayer
    const { status, notices } = options
    const holds = yield* SubscriptionRef.make<Holds>(noHolds)
    const now = SubscriptionRef.get(holds)

    const changeHolds = (change: (now: Holds) => Holds) =>
      SubscriptionRef.modifySomeEffect(holds, (before) => {
        const after = change(before)
        if (after === before) return Effect.succeed([before, Option.none()] as const)
        const { notice, ...shown } = shownHolds(after)
        const next = { ...shown, warnings: [...notices, ...(notice === null ? [] : [notice])] }
        const show = SubscriptionRef.updateSome(status, (now) => {
          const { stopping, holds: banners, usage, warnings } = now
          return same({ stopping, holds: banners, usage, warnings }, next)
            ? Option.none()
            : Option.some({ ...now, ...next })
        })
        return Effect.as(show, [before, Option.some(after)] as const)
      })

    const stopped = (
      stop: StopReason,
      raise: (now: Holds) => Holds = (now) => raiseStop(now, stop),
    ) =>
      Effect.gen(function* () {
        yield* changeHolds(raise)
        const count = runningIn(yield* ledger.current, (yield* now).overLimit)
        if (!stop.held && (count > 0 || stop.why === "TICKET_LIMIT")) {
          const text = hold(stop.text, count)
          yield* say({
            kind: "hold",
            ...(stop.ticket === undefined ? {} : { ticket: stop.ticket }),
            ...(stop.blocked === undefined ? {} : { blocked: stop.blocked }),
            text,
          })
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
