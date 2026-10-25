// An overnight run's stuck tickets (§ 5 item 10, tutti-kkb.52), as orchestra's overnight run has
// them: nobody is there to answer until the morning, so a ticket whose worker needs someone doesn't
// hold the run. Its ticket is set aside instead, as a failed check sets one aside, and the run goes on
// with the rest:
//
// - PAUSED: its worker idle with the ticket still in progress after the nudges and the idle grace,
//   or gone and not to be resumed (work.ts's conclude);
// - BLOCKED: a request of its worker unanswered for blockedAfter (blockedWatch.ts offers it to the
//   ticket's fiber, which follow() races against settling);
// - TICKET_LIMIT: its worker still going past --ticket-limit (holds.ts's timeLimit).
//
// Each is deferred with a note saying why and what is kept, its line saying so (`<id>: its worker
// was blocked on a permission request for over 4m -> noted and deferred, the run being an overnight
// one (BLOCKED); …`), and its Deferred phase's why `set aside overnight: BLOCKED`, which its row
// shows before its title. Its open requests are denied by tutti, in nobody's name, so that nothing
// answers them later; its worker is interrupted, and its session closed as for any deferred ticket
// (sessions.ts's fit), which frees its slot. Its worktree and branch are kept, and its session's ID
// is in the note, for the morning. The session is kept in state.json too, suspended with its why
// (`set aside overnight: BLOCKED`), which carry-over leaves alone (carry.ts): undeferred, the ticket
// comes back through bd ready, in this run or a later one, and its start resumes that session in
// its worktree rather than draw a new one, so its worker carries on with what it knew (start.ts).
//
// A worker handed a conflict or a failed check (Resolving, Fixing; handback.ts's give) is followed
// by its hand-back instead (tutti-bqr0): BLOCKED ends the hand-back early, its requests denied, its
// worker stopped and told so, and the ticket set aside as one not done in time is (Blocked
// MERGE_CONFLICT, Review CHECKS_FAILED), with its branch put back and its notes saying why; what git
// shows done already is taken as it is, as past resolve_timeout.
import { Deferred, Effect, Option, Ref, type Scope } from "effect"
import { AgentHost } from "../agent/AgentHost.ts"
import { Attention, type AttentionRequest, blockedAfter, describe } from "../agent/Attention.ts"
import { settled } from "../agent/WorkerState.ts"
import { formatDuration } from "../project/configFile.ts"
import type { Beads, TicketId } from "../services/Beads.ts"
import { Store } from "../services/Store.ts"
import { putAside } from "./aside.ts"
import type { Ledger } from "./ledger.ts"
import { detail, type Log } from "./log.ts"
import type { StartedWorker, StartTicket } from "./start.ts"

/** The stops an overnight run sets a ticket aside for, rather than hold the run. */
export type StuckWhy = "PAUSED" | "BLOCKED" | "TICKET_LIMIT"

/** What set a ticket aside overnight: its stop's word, and what its worker did, in a few words. */
export interface Stuck {
  readonly why: StuckWhy
  /** `its worker was blocked on a permission request for over 4m`: the line's and the note's. */
  readonly how: string
  /** What it waited on, for the note: the request's description (BLOCKED). */
  readonly what?: string
}

/** The Deferred phase's why, and its record's detail: `set aside overnight: BLOCKED`. */
export const overnightWhy = (why: StuckWhy): string => `set aside overnight: ${why}`

/** Whether a Deferred phase's `why` is an overnight run's setting it aside. */
export const asideOvernight = (why: string): boolean => why.startsWith("set aside overnight: ")

/** What a BLOCKED request is, as its line says: `a permission request`, `a question`, … */
const requestWords = (request: AttentionRequest): string => {
  switch (request.kind._tag) {
    case "Permission":
      return "a permission request"
    case "Question":
      return "a question"
    case "Elicitation":
      return "an MCP server's request"
  }
}

/** BLOCKED's Stuck, `request` the oldest of its worker's open ones. */
export const blockedStuck = (request: AttentionRequest): Stuck => ({
  why: "BLOCKED",
  how: `its worker was blocked on ${requestWords(request)} for over ${formatDuration(blockedAfter)}`,
  what: describe(request),
})

/** TICKET_LIMIT's Stuck, its worker still going after `limit` (`2h`). */
export const limitStuck = (limit: string): Stuck => ({
  why: "TICKET_LIMIT",
  how: `its worker was still working after the ${limit} ticket limit`,
})

/**
 * PAUSED's Stuck: its worker idle for `grace`, or left as `left` says (gone, closed), what comes of
 * it in a run that holds left out.
 */
export const pausedStuck = (left: string | undefined, grace: string): Stuck => ({
  why: "PAUSED",
  how: `its ticket was still in_progress, ${left ?? `its worker idle for ${grace}`}`,
})

/** The line of a ticket set aside overnight, its worktree at `path`. */
export const asideLine = (id: TicketId, stuck: Stuck, path: string) =>
  detail`${id}: ${stuck.how} -> noted and deferred, the run being an overnight one (${stuck.why}); worktree ${path} kept for review`

/** The note a ticket set aside overnight gets: why, and what is kept for the morning. */
export const asideNote = (worker: StartedWorker, stuck: Stuck): string => {
  const { id, path, branch } = worker.worktree
  const what = stuck.what === undefined ? "" : ` (${stuck.what})`
  const denied = stuck.why === "BLOCKED" ? " its request was denied," : ""
  const session = worker.session === "" ? "" : `, and its session ${worker.session}`
  return (
    `tutti: ${stuck.how}${what}, and nobody was there to answer, the run being an overnight one ` +
    `(${stuck.why}):${denied} its worker was stopped, and ${id} deferred for review. Its worktree ` +
    `${path}, branch ${branch}${session} are kept; bring it back with: bd undefer ${id}`
  )
}

/**
 * An overnight run's register of the tickets whose fibers follow their workers, or whose hand-backs
 * wait on them (handback.ts's give), for BLOCKED to set them aside; the run makes it only with
 * --overnight.
 */
export interface OvernightAside {
  /** Registers `ticket`'s fiber for the scope: BLOCKED's Stuck completes `stuck`. */
  follow(ticket: TicketId, stuck: Deferred.Deferred<Stuck>): Effect.Effect<void, never, Scope.Scope>
  /** Gives `ticket`'s fiber BLOCKED's `stuck`: whether a fiber follows it, which sets it aside. */
  offer(ticket: TicketId, stuck: Stuck): Effect.Effect<boolean>
  /** Denies `ticket`'s open requests, in nobody's name. */
  deny(ticket: TicketId): Effect.Effect<void>
}

/** The register, over the run's Attention. */
export const make: Effect.Effect<OvernightAside, never, Attention> = Effect.gen(function* () {
  const attention = yield* Attention
  const following = yield* Ref.make<ReadonlyMap<TicketId, Deferred.Deferred<Stuck>>>(new Map())
  return {
    follow: (ticket, stuck) =>
      Effect.acquireRelease(
        Ref.update(following, (all) => new Map(all).set(ticket, stuck)),
        () =>
          Ref.update(following, (all) => {
            if (all.get(ticket) !== stuck) return all
            const left = new Map(all)
            left.delete(ticket)
            return left
          }),
      ),
    offer: (ticket, stuck) =>
      Effect.gen(function* () {
        const fiber = (yield* Ref.get(following)).get(ticket)
        if (fiber === undefined) return false
        yield* Deferred.succeed(fiber, stuck)
        return true
      }),
    deny: (ticket) =>
      Effect.gen(function* () {
        const reason = "the run is an overnight one, and sets its ticket aside for the morning"
        for (const request of yield* attention.current) {
          if (request.ticket !== ticket) continue
          const answer =
            request.kind._tag === "Elicitation"
              ? ({ _tag: "Decline" } as const)
              : ({ _tag: "Deny", reason, byTutti: true } as const)
          // One answered or withdrawn meanwhile is no longer open: nothing to deny.
          yield* Effect.ignore(attention.answer(request.id, answer, "overnight"))
        }
      }),
  }
})

/**
 * Sets `ticket` aside overnight, as `stuck` says: its open requests denied, its worker interrupted
 * if it is at a turn, and the ticket deferred with its note and line, its saved session suspended
 * with its why for its start to resume once it is undeferred. Its session is the caller's to close
 * (sessions.ts's fit).
 */
export const setAside = (
  ticket: StartTicket,
  worker: StartedWorker,
  stuck: Stuck,
  aside: OvernightAside,
): Effect.Effect<void, never, AgentHost | Beads | Ledger | Log | Store> =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    const store = yield* Store
    const { id, path } = worker.worktree
    yield* aside.deny(id)
    const state = yield* Effect.option(host.current(id))
    if (Option.isSome(state) && !settled(state.value)) yield* Effect.ignore(host.interrupt(id))
    const deferred = yield* putAside(ticket, {
      note: asideNote(worker, stuck),
      reason: `${stuck.how}, the run being an overnight one (${stuck.why})`,
      detail: overnightWhy(stuck.why),
      deferred: asideLine(id, stuck, path),
      failed: `${id}: ${stuck.how}, the run being an overnight one (${stuck.why}), and bd could not defer it`,
      instead: `worktree ${path} kept for review`,
    })
    // One bd couldn't defer isn't waiting to be undeferred: the run's end forgets it as it does.
    const saved = yield* store.ticket(id)
    if (deferred && saved?.session !== undefined) {
      yield* Effect.ignore(store.suspend(id, overnightWhy(stuck.why), "Deferred"))
    }
  })
