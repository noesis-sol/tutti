// BLOCKED (§ 5 item 10, holds.ts): a request unanswered for blockedAfter holds the run, for its
// ticket; once that ticket has none open, the hold is lifted. Each request is looked at again as it
// reaches its time, and every request open at each change, which wakes the run too: a worker that
// asks, or is answered, may end it or keep it open (D19).
import { Clock, Duration, Effect, Ref, Semaphore, Stream } from "effect"
import { Attention, blockedAfter } from "../agent/Attention.ts"
import { EventStream } from "./eventstream.ts"
import { blockedAt, blockedLifted, blockedStop, blockedTickets, liftBlocked } from "./holds.ts"
import type { HoldsGate } from "./holdsGate.ts"
import { Log } from "./log.ts"

export interface BlockedWatch {
  /** Holds the run for each request now past blockedAfter, and lifts the holds of tickets with none. */
  readonly look: Effect.Effect<void>
}

/**
 * Watches the open requests in a fiber `watch` runs, holding the run on `holds` with BLOCKED as each
 * reaches its time, until the run has `ended`; each look wakes the run (`wakeUp`).
 */
export const make = (options: {
  readonly holds: HoldsGate
  readonly ended: Effect.Effect<boolean>
  readonly wakeUp: Effect.Effect<unknown>
  readonly watch: (effect: Effect.Effect<void>) => Effect.Effect<unknown>
}): Effect.Effect<BlockedWatch, never, Attention | Log | EventStream> =>
  Effect.gen(function* () {
    const attention = yield* Attention
    const logs = yield* Log
    const events = yield* EventStream
    const { holds, wakeUp, watch } = options
    const oneLook = yield* Semaphore.make(1)
    const look = oneLook.withPermits(1)(
      Effect.gen(function* () {
        if (yield* options.ended) return
        const held = blockedTickets(yield* holds.now)
        const now = yield* Clock.currentTimeMillis
        const { trips, lifts } = blockedAt(yield* attention.current, held, now, blockedAfter)
        if (trips.length === 0 && lifts.length === 0) return
        for (const ticket of lifts) {
          yield* holds.changeHolds((now) => liftBlocked(now, ticket))
          const text = blockedLifted(ticket)
          yield* logs.writeWith([text], events.emit({ kind: "hold", ticket, lifted: true, text }))
        }
        for (const trip of trips) yield* holds.stopped(blockedStop(trip.ticket, trip.what))
        yield* wakeUp
      }),
    )
    // The requests whose time a fiber waits for.
    const timed = yield* Ref.make<ReadonlySet<string>>(new Set())
    yield* watch(
      Stream.runForEach(attention.open, (requests) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          for (const request of requests) {
            if ((yield* Ref.get(timed)).has(request.id)) continue
            yield* Ref.update(timed, (all) => new Set([...all, request.id]))
            const left = request.createdAt + Duration.toMillis(blockedAfter) - now
            yield* watch(Effect.andThen(Effect.sleep(Duration.millis(Math.max(0, left))), look))
          }
          yield* look
          yield* wakeUp
        }),
      ),
    )
    return { look } satisfies BlockedWatch
  })
