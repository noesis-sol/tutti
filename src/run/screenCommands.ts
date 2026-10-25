// The screen's commands (§ 7.2, § 7.5), each resolved against the ledger and the open requests as
// it is taken: one that no longer names anything (the worker finished, the request was answered) is
// dropped. The end-of-run box's `q` (EndRun) ends the run. Quit without `now` is the quit box's to
// ask. Steering's commands (SendMessage, Interrupt, Release, HandBackNow) go to steer.ts. Once the
// run ends, only moving between the views, quitting and filing a finished worker's message as a
// ticket (FileTicket, fileTicket.ts) act: the others are dropped. ReadTicket reads a worker view's
// ticket again with bd show, in a fiber of its own, for the view's whole ticket (§ 7.5).
//
// The commands that act on the run act one at a time under `acting`, each counted in `acted`; the
// run's end is set under it too, once its last look saw every command acted on, so that none acts
// after the end (a hand-back merged, a worker steered, after the summary).
import { Effect, Queue, Ref, Result, Semaphore, Stream, SubscriptionRef } from "effect"
import { Attention } from "../agent/Attention.ts"
import { Beads, beadsWhy, type TicketId } from "../services/Beads.ts"
import { resolve, type UiCommand } from "./commands.ts"
import { hear } from "./drain.ts"
import { fileTicket } from "./fileTicket.ts"
import { Ledger } from "./ledger.ts"
import type { MergeQueue } from "./mergequeue.ts"
import { fromDashboard, type QuitRequest } from "./quit.ts"
import { Screen, type ScreenInputs } from "./screen.ts"
import { handBackNow, interrupt, releaseAndHandOver, type SteerEnv } from "./steer.ts"

export interface ScreenCommands {
  /** Whether the run has ended: nothing starts or acts after it. */
  readonly ended: Effect.Effect<boolean>
  /** Ends the run at once, without waiting for a command acting now: a quit's end. */
  readonly end: Effect.Effect<void>
  /** How many of the screen's commands have acted on the run. */
  readonly acted: Effect.Effect<number>
  /**
   * Ends the run, with nothing acting after it, unless one of the screen's commands acted since the
   * look that saw `seen` of them (null, as the usage limit's end, doesn't look again): whether it did.
   */
  endAfter(seen: number | null): Effect.Effect<boolean>
  /** Whether the end-of-run box's `q` asked the run to end since this was last asked. */
  readonly endAsked: Effect.Effect<boolean>
  /** Asks the run to end at its next look, as the end-of-run box's `q` does. */
  readonly askEnd: Effect.Effect<void>
  /**
   * Takes the commands of `screen` in a fiber `watch` runs, quitting with `hearQuit`, and puts the
   * hand-backs waiting on steered workers on their views (§ 4.3).
   */
  listen(
    screen: ScreenInputs,
    options: {
      readonly queue: MergeQueue
      readonly hearQuit: (request: QuitRequest) => Effect.Effect<void>
      readonly watch: (effect: Effect.Effect<void>) => Effect.Effect<unknown>
      readonly wakeUp: Effect.Effect<unknown>
    },
  ): Effect.Effect<void>
}

/** Reads `ticket` again with bd show, onto its ledger entry; what bd can't say is logged only. */
const readTicket = (ticket: TicketId): Effect.Effect<void, never, Beads | Ledger> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const read = yield* Effect.result((yield* Beads).show(ticket, { dependents: true }))
    if (Result.isSuccess(read)) return yield* ledger.readIssue(ticket, read.success)
    yield* Effect.logDebug(`could not read ${ticket} again: ${beadsWhy(read.failure)}`)
  })

/** The run's end, and the screen's commands acting on the run until it, in `repo` onto `base`. */
export const make = (options: {
  readonly repo: string
  readonly base: string
}): Effect.Effect<ScreenCommands, never, SteerEnv | Attention | Beads> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<SteerEnv | Attention | Beads>()
    const attention = yield* Attention
    const ledger = yield* Ledger
    const ending = yield* Ref.make(false)
    const acting = yield* Semaphore.make(1)
    const acted = yield* Ref.make(0)
    const endAsked = yield* Ref.make(false)
    const where = { repo: options.repo, base: options.base }

    const listen: ScreenCommands["listen"] = (screen, { queue, hearQuit, watch, wakeUp }) => {
      // A command that acts on the run, once resolved.
      const act = (command: UiCommand) =>
        Effect.gen(function* () {
          switch (command._tag) {
            case "OpenWorker":
            case "CloseWorker":
            case "Quit":
            case "FileTicket":
            case "ReadTicket":
              return
            case "Answer":
              return yield* attention
                .answer(command.requestId, command.answer, "screen")
                .pipe(Effect.catch((error) => Effect.logDebug(`dropped Answer: ${error.message}`)))
            case "Drain":
            case "Undrain":
              yield* hear({ on: command._tag === "Drain", how: fromDashboard.how }, queue.rechecks)
              return yield* wakeUp
            case "EndRun":
              yield* Ref.set(endAsked, true)
              return yield* wakeUp
            case "SendMessage":
              // Held while its ticket waits to merge or merges, so its branch stays as checked.
              return yield* queue.held.holdOrSend(command.ticket, {
                text: command.text,
                uuid: command.uuid,
              })
            case "Interrupt":
              // It cancels the messages held for the worker too, as the view says (held.ts).
              yield* queue.held.cancel(command.ticket)
              return yield* interrupt(command.ticket)
            case "Release":
              if (yield* releaseAndHandOver(command.ticket, queue, where)) yield* wakeUp
              return
            case "HandBackNow":
              yield* handBackNow(command.ticket, queue, where)
              return yield* wakeUp
          }
        })
      const take = (command: UiCommand) =>
        Effect.gen(function* () {
          const resolved = resolve(command, {
            ledger: yield* ledger.current,
            requests: yield* attention.current,
          })
          if (Result.isFailure(resolved)) {
            yield* Effect.logDebug(`dropped ${resolved.failure.message}`)
            return
          }
          switch (command._tag) {
            case "OpenWorker":
              return yield* SubscriptionRef.set(
                screen.screen,
                Screen.Worker({ ticket: command.ticket }),
              )
            case "CloseWorker":
              return yield* SubscriptionRef.set(screen.screen, Screen.Dashboard())
            case "Quit":
              if (command.now) yield* hearQuit(fromDashboard)
              return
            case "FileTicket":
              // bd's, not the run's: in a fiber of its own, after the end too (fileTicket.ts).
              return yield* Effect.asVoid(
                watch(fileTicket(command, screen.filings).pipe(Effect.provideContext(context))),
              )
            case "ReadTicket":
              // bd's too: the view shows what it has until bd answers, and keeps it if bd can't.
              return yield* Effect.asVoid(
                watch(readTicket(command.ticket).pipe(Effect.provideContext(context))),
              )
          }
          yield* acting.withPermits(1)(
            Effect.gen(function* () {
              if (yield* Ref.get(ending)) {
                yield* Effect.logDebug(`dropped ${command._tag}: the run has ended`)
                return
              }
              yield* act(command)
              yield* Ref.update(acted, (n) => n + 1)
            }),
          )
        }).pipe(Effect.provideContext(context))
      return Effect.andThen(
        Effect.asVoid(
          watch(
            Stream.runForEach(queue.handBacks.changes, (stops) =>
              SubscriptionRef.set(
                screen.handBacks,
                stops.map((stop) => stop.ticket.id),
              ),
            ),
          ),
        ),
        Effect.asVoid(watch(Effect.forever(Effect.flatMap(Queue.take(screen.commands), take)))),
      )
    }

    return {
      ended: Ref.get(ending),
      end: Ref.set(ending, true),
      acted: Ref.get(acted),
      endAfter: (seen) =>
        acting.withPermits(1)(
          Effect.gen(function* () {
            if (seen !== null && (yield* Ref.get(acted)) !== seen) return false
            yield* Ref.set(ending, true)
            return true
          }),
        ),
      endAsked: Ref.getAndSet(endAsked, false),
      askEnd: Ref.set(endAsked, true),
      listen,
    } satisfies ScreenCommands
  })
