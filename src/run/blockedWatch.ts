// BLOCKED (§ 5 item 10, holds.ts): a request unanswered for its time (Attention's blocksAfter:
// blockedAfter, or past the time of a question --auto-answer takes), counted with the machine awake
// as the other limits are (Wake.ts), holds the run, for its ticket; once that ticket has none open,
// the hold is lifted. Each request is looked at again as it reaches its time, and every request
// open at each change, which wakes the run too: a worker that asks, or is answered, may end it or
// keep it open (D19). In an overnight run, a ticket whose fiber follows its worker, or whose
// hand-back waits on it, is given BLOCKED instead, and set aside (overnightAside.ts); another
// ticket's requests (its worker past its work, its session still open, or one you steered) are
// denied in nobody's name, nobody being there to answer, and the run goes on (tutti-epza.10).
import { Duration, Effect, Ref, Semaphore, Stream } from "effect"
import { Attention, type AttentionRequest, overnightDenial } from "../agent/Attention.ts"
import type { Log } from "../core/log.ts"
import type { EventStream } from "../services/EventStream.ts"
import { awakeSince, sleepAwake } from "../services/Wake.ts"
import { blockedAt, blockedLifted, blockedStop, blockedTickets, liftBlocked } from "./holds.ts"
import type { HoldsGate } from "./holdsGate.ts"
import { blockedDenied, blockedStuck, type OvernightAside } from "./overnightAside.ts"
import { sayer } from "./say.ts"
import type { Wake } from "./wakes.ts"

export interface BlockedWatch {
  /** Holds the run for each request now past its time, and lifts the holds of tickets with none. */
  readonly look: Effect.Effect<void>
}

/**
 * Watches the open requests in a fiber `watch` runs, holding the run on `holds` with BLOCKED as each
 * reaches its time, until the run has `ended`; each change of the requests wakes the run
 * (`wakeUp`), for an attention change, and each hold the look puts on or lifts for a hold.
 */
export const make = (options: {
  readonly holds: HoldsGate
  readonly ended: Effect.Effect<boolean>
  readonly wakeUp: (why: Wake) => Effect.Effect<unknown>
  readonly watch: (effect: Effect.Effect<void>) => Effect.Effect<unknown>
  /** An overnight run's register, whose fibers take BLOCKED rather than the run hold. */
  readonly overnight?: OvernightAside
}): Effect.Effect<BlockedWatch, never, Attention | Log | EventStream> =>
  Effect.gen(function* () {
    const attention = yield* Attention
    const { say, warn } = yield* sayer
    const { holds, wakeUp, watch } = options
    const oneLook = yield* Semaphore.make(1)
    // How long, in ms, the request has yet to wait, awake, before it holds the run.
    const left = (request: AttentionRequest) =>
      Effect.map(
        awakeSince(request.createdAt),
        (waited) => Duration.toMillis(attention.blocksAfter(request)) - waited,
      )
    const look = oneLook.withPermits(1)(
      Effect.gen(function* () {
        if (yield* options.ended) return
        const held = blockedTickets(yield* holds.now)
        const requests = yield* attention.current
        const due = new Set<string>()
        for (const request of requests) if ((yield* left(request)) <= 0) due.add(request.id)
        const { trips, lifts } = blockedAt(requests, held, (request) => due.has(request.id))
        if (trips.length === 0 && lifts.length === 0) return
        for (const ticket of lifts) {
          yield* holds.changeHolds((now) => liftBlocked(now, ticket))
          const text = blockedLifted(ticket)
          yield* say({ kind: "hold", ticket, lifted: true, text })
        }
        for (const trip of trips) {
          // Its oldest request, the one that tripped: the requests are oldest first.
          const oldest = requests.find((request) => request.ticket === trip.ticket)
          const aside = options.overnight
          if (aside !== undefined && oldest !== undefined) {
            if (yield* aside.offer(trip.ticket, blockedStuck(oldest))) continue
            // No fiber follows it (a worker past its work, or steered): its requests are denied,
            // rather than stop the night for them, its worker told to go on without (tutti-epza.10).
            yield* warn(blockedDenied(trip.ticket, oldest), trip.ticket)
            yield* aside.deny(trip.ticket, overnightDenial)
            continue
          }
          yield* holds.stopped(blockedStop(trip.ticket, trip.what))
        }
        yield* wakeUp("hold")
      }),
    )
    // Waits until the request has waited its time, a sleep noticed meanwhile added, then looks.
    const due = (request: AttentionRequest) =>
      Effect.gen(function* () {
        for (;;) {
          const wait = yield* left(request)
          if (wait <= 0) return yield* look
          yield* sleepAwake(Duration.millis(wait))
        }
      })
    // The requests whose time a fiber waits for.
    const timed = yield* Ref.make<ReadonlySet<string>>(new Set())
    yield* watch(
      Stream.runForEach(attention.open, (requests) =>
        Effect.gen(function* () {
          for (const request of requests) {
            if ((yield* Ref.get(timed)).has(request.id)) continue
            yield* Ref.update(timed, (all) => new Set([...all, request.id]))
            yield* watch(due(request))
          }
          yield* look
          yield* wakeUp("attention")
        }),
      ),
    )
    return { look } satisfies BlockedWatch
  })
