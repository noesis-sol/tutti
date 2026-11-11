// Starting a ticket in a slot: a ticket dispatched from the queue (dispatch), a worker resumed or
// carried over (carry), a ticket checked once more (recheckSlot), and whether a dispatch may start
// (mayStart).
import { Effect, Ref, Result } from "effect"
import type { Issue, TicketId } from "../../services/Beads.ts"
import { type Footprint, showFootprint } from "../footprint.ts"
import { isSolo, takesBack, takesNew } from "../holds.ts"
import { detail, type Line, line } from "../log.ts"
import { Move, TicketPhase } from "../phase.ts"
import { footprintOf } from "../predict.ts"
import type { Said as SaidRecord } from "../say.ts"
import { followUpsOf } from "../scorecard.ts"
import { issueOf, known } from "./place.ts"
import { recorded, remember, soloState } from "./queue.ts"
import { claimRoom, current, mergingIn, occupy, slotFree } from "./slots.ts"
import { progress, type Scheduling } from "./state.ts"

/** `[n/limit] <id> dispatching: <title>`, the dispatch's log line; `dispatching solo` for one. */
export const dispatchLine = (n: number, limit: number | null, issue: Issue): Line =>
  isSolo(issue)
    ? line`[${progress(n, limit)}] ${issue.id} dispatching solo: ${issue.title}`
    : line`[${progress(n, limit)}] ${issue.id} dispatching: ${issue.title}`

/** `<id> footprint: …`, under the dispatch's line with footprints on (§ 5 item 5). */
export const footprintLine = (id: TicketId, fp: Footprint): Line =>
  detail`${id} footprint: ${showFootprint(fp)}`

/**
 * Whether a dispatch may start now: a slot is free, and, after `beforeStart`, the gate lets a
 * ticket start and the machine has room for it (claimRoom).
 */
export const mayStart = (sched: Scheduling): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const { s, state } = yield* current(sched)
    if (!slotFree(s, state, sched.options.concurrent)) return false
    yield* sched.beforeStart
    return takesNew(yield* sched.gate) && (yield* claimRoom(sched))
  })

/**
 * Dispatches `issue`: counts it toward --limit, moves it to Working with its dispatch record (the
 * queue's counts among `ids` with it, its playbook's lessons, and the follow-up it is of a scored
 * ticket), logs its footprint line, and runs its fiber in a slot (occupy). False, nothing counted,
 * when the ledger refuses the move (a PHASE_BUG, which it logged).
 */
export const dispatch = (
  sched: Scheduling,
  issue: Issue,
  ids: ReadonlyArray<TicketId>,
  footprint?: Footprint,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const { options } = sched
    const s = yield* Ref.updateAndGet(sched.slots, (s) => ({ ...s, started: s.started + 1 }))
    const text = dispatchLine(s.started, options.limit, issue)
    const solo = isSolo(issue)
      ? { ticket: issue.id }
      : soloState(s, (yield* Ref.get(sched.memo)).soloNext)
    const queue = yield* recorded(sched, yield* sched.ledger.current, ids, solo, [
      issue.id,
      TicketPhase.Working(),
    ])
    const lessons = yield* options.playbook?.choose(issue, footprint) ?? Effect.void
    const record: SaidRecord = {
      kind: "dispatch",
      ticket: issue.id,
      title: issue.title,
      n: s.started,
      ...(options.limit === null ? {} : { limit: options.limit }),
      ...queue,
      ...(footprint === undefined ? {} : { footprint: footprint.files.length }),
      ...(lessons === undefined ? {} : { playbook: lessons }),
      text,
    }
    // A ticket filed against one the run scored is a follow-up of it, for its scorecard.
    const follows = followUpsOf(issue, (yield* sched.events.figures).scoring)
    const moved = yield* sched.ledger.transition(issue.id, Move.Dispatched(), {
      said: [record],
      beside: follows.map((ticket) => ({
        kind: "score_update" as const,
        ticket,
        follow_up: issue.id,
      })),
    })
    if (Result.isFailure(moved)) {
      // A PHASE_BUG, which the ledger logged: nothing starts, and nothing is counted.
      yield* Ref.update(sched.slots, (s) => ({ ...s, started: s.started - 1 }))
      return false
    }
    if (footprint !== undefined) yield* sched.logs.write(footprintLine(issue.id, footprint))
    yield* occupy(sched, issue.id, options.start.start(issue), issue, true)
    return true
  })

/**
 * Logs a resumed or carried-over ticket's footprint as a dispatched ticket's is, as orchestra's
 * startFootprint does for a ticket it adopts or resumes, and remembers what its branch changed.
 */
export const carriedFootprint = (
  sched: Scheduling,
  issue: Issue | undefined,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { footprints, predictor } = sched.options
    if (issue === undefined || footprints === undefined) return
    const repo = yield* footprints.repo
    const predicted: ReadonlyMap<TicketId, ReadonlyArray<string>> = predictor === undefined
      ? new Map()
      : yield* predictor.predicted
    const branch = footprints.branch === undefined ? [] : yield* footprints.branch(issue.id)
    yield* remember(sched, (m) => ({
      ...m,
      startBranch: new Map(m.startBranch).set(issue.id, branch),
    }))
    yield* sched.logs.write(footprintLine(issue.id, footprintOf(issue, repo, predicted, branch)))
  })

/**
 * Runs a resumed or carried-over worker in a slot, counting toward no limit (Scheduler.carry):
 * only with a slot free, the run taking tickets and not winding down, no solo ticket running or
 * past its work, and, for a solo one, no other ticket either. Whether there was a slot for it.
 */
export const carry = (
  sched: Scheduling,
  ticket: TicketId,
  start: Effect.Effect<Effect.Effect<void> | undefined>,
  issue?: Issue,
): Effect.Effect<boolean> =>
  sched.oneFill.withPermit(
    Effect.gen(function* () {
      const { s, state } = yield* known(sched)
      const others = s.running.size + mergingIn(state, s.running).length
      const free =
        slotFree(s, state, sched.options.concurrent) &&
        s.solo === null &&
        !s.running.has(ticket) &&
        (issue === undefined || !isSolo(issue) || others === 0)
      if (!free) return false
      yield* sched.beforeStart
      if (!takesBack(yield* sched.gate) || !(yield* claimRoom(sched))) return false
      const work = yield* start
      if (work !== undefined) {
        yield* Effect.andThen(carriedFootprint(sched, issue), occupy(sched, ticket, work, issue))
      }
      return true
    }),
  )

/**
 * Runs `work` in a slot for a ticket checked once more (Scheduler.recheckSlot), as a running
 * ticket's, counting toward no limit: only with a slot free, no solo ticket running or first in
 * line at the last pick, and the ticket holding none still. Whether it took one.
 */
export const recheckSlot = (
  sched: Scheduling,
  ticket: TicketId,
  work: Effect.Effect<void>,
): Effect.Effect<boolean> =>
  sched.oneFill.withPermit(
    Effect.gen(function* () {
      const { s, state } = yield* known(sched)
      const free =
        slotFree(s, state, sched.options.concurrent) &&
        s.solo === null &&
        (yield* Ref.get(sched.memo)).soloFirst === null &&
        !s.running.has(ticket)
      // Its issue, read as it takes the slot, so that its footprint and solo label hold the
      // others back from the start, as a dispatched ticket's do.
      if (free) yield* occupy(sched, ticket, work, (yield* issueOf(sched, ticket)) ?? undefined)
      return free
    }),
  )
