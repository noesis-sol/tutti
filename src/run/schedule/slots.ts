// The slots (§ 5 item 5): which tickets hold one, how many are taken as the ledger has the
// tickets, and taking and freeing one (occupy). A ticket holds its slot for as long as its fiber
// runs; its issue and solo label are kept past its work until it merges.
import { Effect, FiberSet, Queue, Ref } from "effect"
import type { Issue, TicketId } from "../../services/Beads.ts"
import { isSolo } from "../holds.ts"
import type { State } from "../ledger.ts"
import { hasRoom } from "../machineGate.ts"
import { phaseFacts } from "../phase.ts"
import { forget, recordQueue, remember, showQueue } from "./queue.ts"
import type { Scheduling } from "./state.ts"

/** Whether the ticket waits in the queue: Queued, or HeldBack. */
export const waiting = (state: State, id: TicketId): boolean => {
  const tag = state.tickets.get(id)?.phase._tag
  return tag !== undefined && phaseFacts[tag].ready
}

/** Whether the ticket is past its work and not merged yet: it waits to merge, merges, or is fixed. */
export const merging = (state: State, id: TicketId): boolean => {
  const tag = state.tickets.get(id)?.phase._tag
  return tag !== undefined && phaseFacts[tag].pastWork
}

/** The tickets past their work and not merged yet that hold no slot: those not `running`. */
export const mergingIn = (state: State, running: ReadonlySet<TicketId>): ReadonlyArray<TicketId> =>
  [...state.tickets.values()]
    .filter((entry) => merging(state, entry.ticket) && !running.has(entry.ticket))
    .map((entry) => entry.ticket)

/** Whether the ticket is handed back to its worker, Resolving or Fixing: its worker is at work. */
export const handedBack = (state: State, id: TicketId): boolean => {
  const tag = state.tickets.get(id)?.phase._tag
  return tag !== undefined && phaseFacts[tag].pastWork && phaseFacts[tag].atWork
}

/**
 * The slots taken by `running` tickets, those `handedBack` to their workers, each of which takes
 * one as its worker is at work, and the `merging` ones past their work with no worker at it, waiting
 * to merge or merging: up to `concurrent` of those take none, and each beyond them one.
 */
export const slotsTaken = (
  running: number,
  handedBack: number,
  merging: number,
  concurrent: number,
): number => running + handedBack + Math.max(0, merging - concurrent)

/** Whether the ticket is back in the queue as its worktree's setup failed, Waiting{setup}. */
export const setupFailed = (state: State, id: TicketId): boolean => {
  const phase = state.tickets.get(id)?.phase
  return phase?._tag === "Waiting" && phase.for._tag === "Setup"
}

/** Whether the ledger lets the run take `id` from bd ready: not taken up yet, or still waiting. */
export const candidate = (state: State, id: TicketId): boolean =>
  !state.tickets.has(id) || waiting(state, id)

/** Whether the ticket is set aside, Deferred. */
export const deferred = (state: State, id: TicketId): boolean =>
  state.tickets.get(id)?.phase._tag === "Deferred"

export interface Slots {
  readonly running: ReadonlySet<TicketId>
  readonly started: number
  /**
   * The running tickets dispatched, or carried with their issue, and those past their work until
   * they merge: their footprints and labels.
   */
  readonly issues: ReadonlyMap<TicketId, Issue>
  /** The solo ticket running, or past its work until it merges, if any. */
  readonly solo: TicketId | null
}

/** `s` without the issues and solo ticket of the tickets neither running nor past their work. */
export const prune = (s: Slots, state: State): Slots => {
  const kept = (id: TicketId) => s.running.has(id) || merging(state, id)
  if ([...s.issues.keys()].every(kept) && (s.solo === null || kept(s.solo))) return s
  return {
    ...s,
    issues: new Map([...s.issues].filter(([id]) => kept(id))),
    solo: s.solo !== null && kept(s.solo) ? s.solo : null,
  }
}

/** The slots taken, the running tickets and those past their work as `state` has them. */
export const taken = (s: Slots, state: State, concurrent: number): number => {
  const past = mergingIn(state, s.running)
  const atWork = past.filter((id) => handedBack(state, id)).length
  return slotsTaken(s.running.size, atWork, past.length - atWork, concurrent)
}

/** Whether a slot is free, the running tickets and those past their work as `state` has them. */
export const slotFree = (s: Slots, state: State, concurrent: number): boolean =>
  taken(s, state, concurrent) < concurrent

/** The slots taken now, as the scheduler counts them (slotsTaken). */
export const slotsNow = (sched: Scheduling): Effect.Effect<number> =>
  Effect.map(Effect.all([Ref.get(sched.slots), sched.ledger.current]), ([s, state]) =>
    taken(s, state, sched.options.concurrent),
  )

/** The slots as the ledger has the tickets now: those merged since let go of what they held. */
export const current = (
  sched: Scheduling,
): Effect.Effect<{ readonly s: Slots; readonly state: State }> =>
  Effect.gen(function* () {
    const state = yield* sched.ledger.current
    const s = yield* Ref.updateAndGet(sched.slots, (s) => prune(s, state))
    return { s, state }
  })

/**
 * Whether the machine has room for the ticket about to start (Options.room): the queue record
 * says the hold's start and end (`machine_full`). Room always without the option.
 */
export const claimRoom = (sched: Scheduling): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (sched.options.room === undefined) return true
    const room = yield* sched.options.room(yield* slotsNow(sched))
    if (room === "began" || room === "lifted") yield* recordQueue(sched)
    return hasRoom(room)
  })

/**
 * Whether a ticket dispatched (`counted`) that started too early, put back in the queue until its
 * blocker merges (WAITS_FOR_MERGE), counts toward --limit once, as it starts again. Its fiber
 * ends a few steps after it enters Waiting: by then its blocker may have merged, putting it back
 * in the queue, and bd ready may no longer list it, taking it out of the ledger. It isn't
 * dispatched again before its fiber ends, so it is never Working here for a later start.
 */
export const requeued = (state: State, ticket: TicketId): boolean => {
  const phase = state.tickets.get(ticket)?.phase
  if (phase === undefined) return true
  return phase._tag === "Waiting" ? phase.for._tag !== "Probe" : waiting(state, ticket)
}

/**
 * Runs `work` in a slot of `ticket`'s, as its fiber: the ticket runs until it ends, when the slot
 * is freed and `freed` woken. With `issue`, its footprint and solo label count while it runs and
 * past its work until it merges, and its parent is remembered. `counted` for a ticket dispatched,
 * whose start is given back to --limit when it is put back in the queue (`requeued`).
 */
export const occupy = (
  sched: Scheduling,
  ticket: TicketId,
  work: Effect.Effect<void>,
  issue?: Issue,
  counted = false,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    // Its parent, or that it has none, so that no look shows it for its parent once it closes.
    if (issue !== undefined) {
      const parent = issue.parent ?? null
      yield* remember(sched, (m) => ({ ...m, parentOf: new Map(m.parentOf).set(ticket, parent) }))
    }
    yield* Ref.update(sched.slots, (s) => ({
      ...s,
      running: new Set([...s.running, ticket]),
      issues: issue === undefined ? s.issues : new Map([...s.issues, [ticket, issue]]),
      solo: issue !== undefined && isSolo(issue) ? ticket : s.solo,
    }))
    yield* showQueue(sched)
    // A ticket gone to the merge queue keeps its issue and solo label until it merges.
    const release = Effect.gen(function* () {
      const state = yield* sched.ledger.current
      const again = counted && requeued(state, ticket)
      yield* forget(sched, "skipSaid", ticket)
      yield* Ref.update(sched.slots, (s) =>
        prune(
          {
            ...s,
            running: new Set([...s.running].filter((id) => id !== ticket)),
            started: again ? s.started - 1 : s.started,
          },
          state,
        ),
      )
      yield* showQueue(sched)
      yield* Queue.offer(sched.freed, undefined)
    })
    yield* FiberSet.run(sched.tickets, Effect.ensuring(work, release))
  })
