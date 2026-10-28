// Claude's login refused in a worker's turn (§ 4.13). The startup probe reads the account, which an
// expired login still has, and costs no model turn, so only a turn finds the token refused: its
// assistant message says `authentication_failed` and its result is_error, and its worker is
// LoginRefused (WorkerState). Every turn after it fails the same way until the login is renewed, so
// the run takes no more tickets and ends, as a quit ends it (quitting.ts), with a stop of its own,
// LOGIN (exit 2): its workers interrupted and their sessions kept, no ticket deferred or triaged,
// and no organ called, the reviewer included, as they fail on the same login.
//
// The worker whose turn was refused never saw what that turn was to tell it (a question answered,
// a carry-on, a hand-back): those texts are saved on its ticket in state.json (`retellKey`,
// saveTold), and the next run resumes its session with them (carry.ts, retellText). A turn refused
// again with that message saves it as it is, so it isn't wrapped twice. A fresh start of the ticket
// forgets them (start.ts), as it does the session they were for.
import { Effect, type Schema, type Scope, Stream } from "effect"
import { loginRefusedText } from "../agent/Account.ts"
import { AgentHost } from "../agent/AgentHost.ts"
import type { TicketId } from "../services/Beads.ts"
import { Store } from "../services/Store.ts"
import { type StopReason, stopFor } from "./holds.ts"
import { type Line, line } from "./log.ts"

/** The metadata key of the texts a turn refused for the login was to tell its worker. */
export const retellKey = "login_refused_told"

/**
 * A worker's turn refused for Claude's login: its ticket, its result's text, and the texts of the
 * sends it was to answer.
 */
export interface Refused {
  readonly ticket: TicketId
  readonly error: string
  readonly told: ReadonlyArray<string>
}

/** The LOGIN stop of a turn refused with `error`, over `ticket` where it is one of the run's. */
export const loginStop = (error: string, ticket?: TicketId): StopReason =>
  stopFor(
    "LOGIN",
    `${loginRefusedText(error)}, then start tutti again`,
    ticket === undefined ? {} : { ticket },
  )

/** The line said as a worker's turn is refused for the login, before the run quits. */
export const refusedLine = (refused: Refused): Line =>
  line`${refused.ticket}'s turn was refused for Claude's login (${refused.error}): the run stops, its workers stopped and their sessions kept for the next run`

/** How a message told again (retellText) starts. */
export const retellHead =
  "tutti: the last run ended (LOGIN) as Claude's login was refused, before you could take in " +
  "what it sent you; this run resumes your session and sends it again."

/** Saves on `ticket`, in state.json, the texts its refused turn was to tell its worker. */
export const saveTold = (
  ticket: TicketId,
  told: ReadonlyArray<string>,
): Effect.Effect<void, never, Store> =>
  Effect.flatMap(Store, (store) => Effect.ignore(store.setMetadata(ticket, retellKey, [...told])))

/** `metadata` without the texts saved under `retellKey`. */
export const withoutTold = (
  metadata: Readonly<Record<string, Schema.Json>>,
): Readonly<Record<string, Schema.Json>> => {
  if (!(retellKey in metadata)) return metadata
  const { [retellKey]: _, ...rest } = metadata
  return rest
}

/** The texts saved under `retellKey`, from the ticket's metadata; none when there are none. */
export const toldOf = (metadata: Readonly<Record<string, Schema.Json>>): ReadonlyArray<string> => {
  const told = metadata[retellKey]
  return Array.isArray(told) ? told.filter((each): each is string => typeof each === "string") : []
}

/**
 * What a worker whose last turn was refused for the login is told as the next run resumes it: the
 * texts that turn was to tell it, `told`, after retellHead; a message told again already, as it is.
 */
export const retellText = (told: ReadonlyArray<string>, facts: ReadonlyArray<string>): string => {
  const [only] = told
  if (told.length === 1 && only !== undefined && only.startsWith(retellHead)) return only
  return [retellHead, ...told, ...facts].join("\n\n")
}

/**
 * Follows every worker the host knows, for as long as it runs: `onRefused` is called for each turn
 * refused for the login.
 */
export const watchLogins = <R>(
  onRefused: (refused: Refused) => Effect.Effect<void, never, R>,
): Effect.Effect<void, never, AgentHost | R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* AgentHost
      const followed = new Set<TicketId>()
      const ensure = (ticket: TicketId): Effect.Effect<void, never, Scope.Scope | R> =>
        Effect.suspend(() => {
          if (followed.has(ticket)) return Effect.void
          followed.add(ticket)
          return Effect.asVoid(Effect.forkScoped(follow(ticket)))
        })
      // Once its stream ends, a worker the host still knows was started again: followed anew.
      const follow = (ticket: TicketId): Effect.Effect<void, never, Scope.Scope | R> =>
        host.state(ticket).pipe(
          Stream.runForEach((state) =>
            state._tag === "LoginRefused"
              ? onRefused({ ticket, error: state.error, told: state.told })
              : Effect.void,
          ),
          Effect.ignore,
          Effect.andThen(Effect.sync(() => followed.delete(ticket))),
          Effect.andThen(Effect.result(host.current(ticket))),
          Effect.flatMap((known) => (known._tag === "Success" ? ensure(ticket) : Effect.void)),
        )
      yield* Stream.runForEach(host.workers, (tickets) =>
        Effect.forEach(tickets, ensure, { discard: true }),
      )
    }),
  )
