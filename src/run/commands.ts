// UiCommand (§ 3.5): what the screen asks the run to do, and the queue it asks through. React's
// handlers put commands in the queue with offer(), never running an Effect themselves, and the run
// loop takes them out. A command carries IDs (a worker's number, a ticket, a request), never state
// captured in a handler: the run loop resolves them against the state as it is when it takes the
// command, so a key pressed as a worker finishes can't reach another one (OpenTUI #1660).
import { Data, type Effect, Queue, Result, Schema } from "effect"
import type { Answer as AttentionAnswer, AttentionRequest } from "../agent/Attention.ts"
import { holdsWorker, type State, ticketOfWorker } from "./ledger.ts"

/** A command from the screen. */
export type UiCommand = Data.TaggedEnum<{
  /** Open the worker view of the worker with this number (its card's, which never shifts). */
  OpenWorker: { readonly worker: number }
  /** Leave the worker view for the dashboard. */
  CloseWorker: Record<never, never>
  /** Answer the open attention request `requestId`. */
  Answer: { readonly requestId: string; readonly answer: AttentionAnswer }
  /**
   * Send your message to the ticket's worker, which becomes steered (§ 4.3), with the uuid the
   * composer drew for it: its `queued` mark waits for that send by it (§ 7.5).
   */
  SendMessage: { readonly ticket: string; readonly text: string; readonly uuid: string }
  /** Interrupt the turn of the ticket's worker; it becomes steered. */
  Interrupt: { readonly ticket: string }
  /** Hand a steered worker back to the run (§ 4.3). */
  Release: { readonly ticket: string }
  /** Hand the ticket's steered worker the conflict waiting for it now (§ 4.3). */
  HandBackNow: { readonly ticket: string }
  /** Stop after the current tickets: wind down. */
  Drain: Record<never, never>
  /** Take tickets again. */
  Undrain: Record<never, never>
  /** Quit: `now` quits at once (§ 4.8); otherwise the quit box asks. */
  Quit: { readonly now: boolean }
  /** End the run that waits only on workers waiting on you, suspending them (D19). */
  EndRun: Record<never, never>
}>

export const UiCommand = Data.taggedEnum<UiCommand>()

/** The queue the screen offers commands into and the run loop takes them from. */
export type Commands = Queue.Queue<UiCommand>

/** An empty command queue. Unbounded: a command is never refused or dropped. */
export const makeCommands: Effect.Effect<Commands> = Queue.unbounded<UiCommand>()

/** Puts `command` in the queue at once, from a React handler, without running an Effect. */
export const offer = (commands: Commands, command: UiCommand): void => {
  Queue.offerUnsafe(commands, command)
}

/** A command whose IDs no longer name anything: the worker finished, the request was answered. */
export class Stale extends Schema.TaggedError<Stale>()("Stale", {
  command: Schema.String,
  why: Schema.String,
}) {
  override get message(): string {
    return `${this.command}: ${this.why}`
  }
}

/** A command resolved against current state, with the ticket it acts on (null: the run). */
export interface Resolved {
  readonly command: UiCommand
  readonly ticket: string | null
}

/** What a command is resolved against: the ledger, and the open attention requests. */
export interface Current {
  readonly ledger: State
  readonly requests: ReadonlyArray<AttentionRequest>
}

// The ticket, if it has a worker now: a session open for it.
const withWorker = (
  command: UiCommand,
  ticket: string,
  current: Current,
): Result.Result<Resolved, Stale> => {
  const entry = current.ledger.tickets.get(ticket)
  return entry !== undefined && holdsWorker(entry.phase)
    ? Result.succeed({ command, ticket })
    : Result.fail(new Stale({ command: command._tag, why: `${ticket} has no worker` }))
}

/** Resolves `command`'s IDs against `current`; Stale when one no longer names anything. */
export const resolve = (command: UiCommand, current: Current): Result.Result<Resolved, Stale> => {
  switch (command._tag) {
    case "OpenWorker": {
      const ticket = ticketOfWorker(current.ledger, command.worker)
      return ticket === undefined
        ? Result.fail(new Stale({ command: command._tag, why: `no worker ${command.worker}` }))
        : Result.succeed({ command, ticket })
    }
    case "Answer": {
      const request = current.requests.find((open) => open.id === command.requestId)
      return request === undefined
        ? Result.fail(
            new Stale({
              command: command._tag,
              why: `request ${command.requestId} is no longer open`,
            }),
          )
        : Result.succeed({ command, ticket: request.ticket })
    }
    case "SendMessage":
    case "Interrupt":
    case "Release":
      return withWorker(command, command.ticket, current)
    case "HandBackNow":
      // Its worker may wait outside a phase that holds one: the run checks the hand-back waits.
      return Result.succeed({ command, ticket: command.ticket })
    case "CloseWorker":
    case "Drain":
    case "Undrain":
    case "Quit":
    case "EndRun":
      return Result.succeed({ command, ticket: null })
  }
}
