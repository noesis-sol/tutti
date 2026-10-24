// Quitting (§ 4.8, quit.ts), as the run does it: the first request to quit (SIGINT, SIGTERM,
// SIGHUP, the quit box's `q`), or a panic in one of the run's fibers, cuts the run's loop short; a
// second request says what is under way and how to abandon it; a third ends tutti at once, saving
// the workers not merged or dropped. Once the loop has stopped scheduling, quitting's first four
// steps: the dashboard says what it waits for; every worker is interrupted at once, its result
// waited for quitWait at most; a merge in its protected step finishes, one before it is cut short;
// the organ calls are aborted. The tickets' fibers and the hand-backs stop before the interrupts, so
// that none acts on an interrupted turn.
import { Deferred, Effect, Option, Ref, Result, Stream, SubscriptionRef } from "effect"
import { AgentHost } from "../agent/AgentHost.ts"
import { Attention } from "../agent/Attention.ts"
import { Store } from "../services/Store.ts"
import { saveAsked, saveLeft } from "./carry.ts"
import { EventStream } from "./eventstream.ts"
import { type StopReason, stopFor } from "./holds.ts"
import { Ledger } from "./ledger.ts"
import { type Line, Log } from "./log.ts"
import type { MergeQueue } from "./mergequeue.ts"
import { stopsAtEnd } from "./phase.ts"
import {
  type Awaited,
  atOnceText,
  heard,
  interruptWorkers,
  type QuitRequest,
  quitLine,
  quittingText,
  stillQuittingLine,
  unansweredLine,
  underWayLine,
} from "./quit.ts"
import type { Status } from "./runView.ts"
import { sayer } from "./say.ts"
import type { Scheduler } from "./schedule.ts"
import { endRecord } from "./spending.ts"
import type { Triage } from "./triage.ts"

/** Why the run quits: a request to quit now, or a panic in one of its fibers (§ 4.8, § 7.4). */
export type Quitting = { readonly request: QuitRequest } | { readonly panic: StopReason }

export interface Quits {
  /** Hears a request to quit: the first quits, the second warns, the third ends tutti at once. */
  hearQuit(request: QuitRequest): Effect.Effect<void>
  /** Quitting's first four steps, once the loop has stopped scheduling. */
  quitNow(quit: Quitting): Effect.Effect<void>
  /**
   * Refuses every answer from now on, NotOpen, which `tutti answer` reports: once the tickets'
   * fibers have stopped, an answer to a worker's open request would run it on with no fiber
   * watching it, until its session closes.
   */
  readonly refuseAnswers: Effect.Effect<void>
  /** The tickets whose workers' sessions are open, sorted. */
  readonly openWorkers: Effect.Effect<ReadonlyArray<string>>
}

/**
 * The run's quitting: `quitting` is done by the first request or panic; `exitNow` ends tutti at
 * once with a code and the lines to print; what it waits for shows on `status`.
 */
export const make = (options: {
  readonly quitting: Deferred.Deferred<Quitting>
  readonly queue: MergeQueue
  readonly scheduler: Pick<Scheduler, "interrupt">
  readonly triage: Pick<Triage, "interrupt">
  readonly status: SubscriptionRef.SubscriptionRef<Status>
  readonly exitNow?: (code: number, said: ReadonlyArray<Line>) => Effect.Effect<void>
}): Effect.Effect<Quits, never, AgentHost | Attention | Ledger | Store | Log | EventStream> =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    const attention = yield* Attention
    const ledger = yield* Ledger
    const store = yield* Store
    const logs = yield* Log
    const events = yield* EventStream
    const { say, warn } = yield* sayer
    const { quitting, queue, status } = options
    // The requests to quit heard.
    const asked = yield* Ref.make(0)
    // What quitting waits for, for a second request to say.
    const awaiting = yield* Ref.make<ReadonlyArray<Awaited>>([])

    // The third request: every worker not merged or dropped saved, and tutti ends at once.
    const atOnce = (request: QuitRequest) =>
      Effect.gen(function* () {
        const merging = (yield* queue.state).merging
        const saved: Array<string> = []
        for (const entry of (yield* ledger.current).tickets.values()) {
          const phase = entry.phase
          if (!stopsAtEnd(phase) && phase._tag !== "Merging" && phase._tag !== "Stopped") continue
          if ((yield* store.ticket(entry.ticket))?.session === undefined) continue
          const why = phase._tag === "Stopped" ? phase.why : "quit"
          yield* Effect.ignore(store.suspend(entry.ticket, why, "Stopped"))
          saved.push(entry.ticket)
        }
        yield* ledger.endQueued
        yield* saveAsked
        yield* saveLeft
        const stop = stopFor("INTERRUPTED", atOnceText(request.how, saved, merging))
        yield* say({ kind: "stop", detail: stop.why, text: stop.text })
        yield* Effect.flatMap(endRecord(stop.code), events.emit)
        if (options.exitNow !== undefined) yield* options.exitNow(stop.code, [stop.text])
      }).pipe(Effect.provideService(Store, store), Effect.provideService(Ledger, ledger))

    const hearQuit = (request: QuitRequest) =>
      Effect.gen(function* () {
        let n = yield* Ref.updateAndGet(asked, (n) => n + 1)
        // A panic that already quit the run makes the first request the second: it says what is
        // under way, and the next exits at once.
        if (heard(n) === "quit" && !(yield* Deferred.succeed(quitting, { request }))) {
          n = yield* Ref.updateAndGet(asked, (n) => n + 1)
        }
        switch (heard(n)) {
          case "quit":
            return
          case "warn": {
            const merging = (yield* queue.state).merging
            const text =
              merging === null
                ? stillQuittingLine(yield* Ref.get(awaiting), request)
                : underWayLine(merging, request)
            yield* warn(text, merging ?? undefined)
            return
          }
          case "exit":
            yield* atOnce(request)
        }
      })

    const waitFor = (awaited: ReadonlyArray<Awaited>) =>
      Effect.andThen(
        Ref.set(awaiting, awaited),
        SubscriptionRef.update(status, (now) => ({ ...now, quitting: quittingText(awaited) })),
      )
    const openWorkers = Effect.gen(function* () {
      const known = Option.getOrElse(yield* Stream.runHead(host.workers), () => new Set<string>())
      const open: Array<string> = []
      for (const ticket of known) {
        const state = yield* Effect.result(host.current(ticket))
        if (Result.isFailure(state)) continue
        if (state.success._tag !== "Closed" && state.success._tag !== "Gone") open.push(ticket)
      }
      return open.sort()
    })
    const refuseAnswers = Effect.gen(function* () {
      const tickets = new Set((yield* ledger.current).tickets.keys())
      for (const request of yield* attention.current) tickets.add(request.ticket)
      yield* Effect.forEach(tickets, attention.refuse, { discard: true })
    })
    const quitNow = (quit: Quitting) =>
      Effect.gen(function* () {
        const workers = yield* openWorkers
        yield* waitFor(workers.map((ticket) => ({ ticket, what: "worker" as const })))
        if ("request" in quit) {
          const text = quitLine(quit.request, workers)
          yield* warn(text)
        }
        yield* options.scheduler.interrupt
        yield* refuseAnswers
        yield* queue.hold
        const unanswered = yield* interruptWorkers(workers).pipe(
          Effect.provideService(AgentHost, host),
        )
        if (unanswered.length > 0) yield* logs.write(unansweredLine(unanswered))
        const merging = (yield* queue.state).merging
        yield* waitFor(merging === null ? [] : [{ ticket: merging, what: "merge" as const }])
        yield* queue.stopMerges
        yield* options.triage.interrupt
        yield* waitFor([])
      })

    return { hearQuit, quitNow, refuseAnswers, openWorkers } satisfies Quits
  })
