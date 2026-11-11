// Placing and holding: a waiting ticket moved to the phase its hold says (placeWaiting), one set
// aside for an ID that can't name a worktree (setAside), and the issues of the tickets running or
// past their work, read from bd as the scheduler needs them (withIssues, known).
import { Effect, Ref, Result } from "effect"
import { detail, type Line } from "../../core/log.ts"
import { beadsWhy, type Issue, type TicketId } from "../../services/Beads.ts"
import { isSolo } from "../holds.ts"
import type { State } from "../ledger.ts"
import { type HoldBack, Move, TicketPhase } from "../phase.ts"
import { recorded, soloNow } from "./queue.ts"
import { current, mergingIn, type Slots } from "./slots.ts"
import type { Scheduling } from "./state.ts"

/** The BAD_TICKET_ID line, as orchestra words it. */
export const badTicketIdLine = (id: TicketId, why: string): Line =>
  detail`BAD_TICKET_ID: ${why}: ${id} -> deferred without starting a worker; rename it (bd rename ${id} <new-id>), then bd undefer <new-id>`

/** The note bd defer appends to a ticket set aside for its ID. */
export const badTicketIdNote = (id: TicketId, why: string): string =>
  `tutti: ${why}, so no worker was started on ${id}: a ticket's ID names its worktree folder and its branch tutti/<id>. Give it a plain ID (bd rename ${id} <new-id>), then bring it back with: bd undefer <new-id>`

/** `<id>: undeferred; back in the queue`, for a ticket set aside that bd ready lists again. */
export const undeferredLine = (id: TicketId): Line => detail`${id}: undeferred; back in the queue`

/** A ticket's issue as bd show gives it; null, saying why, when bd couldn't. */
export const issueOf = (sched: Scheduling, id: TicketId): Effect.Effect<Issue | null> =>
  Effect.gen(function* () {
    const read = yield* sched.beads.show(id).pipe(Effect.result)
    if (Result.isSuccess(read)) return read.success
    yield* sched.logs.write(detail`could not read ${id}'s links: ${beadsWhy(read.failure)}`)
    return null
  })

/**
 * `s` with the issue of each ticket running or past its work (`past`) that took no slot with its
 * issue (carried over closed, handed over again), read from bd once (`read`, bd show by default)
 * and kept until it merges: its footprint and solo label then count as a dispatched ticket's do.
 */
export const withIssues = (
  sched: Scheduling,
  s: Slots,
  past: ReadonlyArray<TicketId>,
  read: (id: TicketId) => Effect.Effect<Issue | null> = (id) => issueOf(sched, id),
): Effect.Effect<Slots> =>
  Effect.gen(function* () {
    const found = new Map<TicketId, Issue>()
    for (const id of [...s.running, ...past]) {
      if (s.issues.has(id)) continue
      const issue = yield* read(id)
      if (issue !== null) found.set(id, issue)
    }
    if (found.size === 0) return s
    const solo = [...found.values()].find(isSolo)?.id ?? null
    const add = (now: Slots): Slots => ({
      ...now,
      issues: new Map([...now.issues, ...found]),
      solo: now.solo ?? solo,
    })
    yield* Ref.update(sched.slots, add)
    return add(s)
  })

/** `current`, the issues of the tickets running or past their work read as `withIssues` does. */
export const known = (
  sched: Scheduling,
): Effect.Effect<{ readonly s: Slots; readonly state: State }> =>
  Effect.gen(function* () {
    const { s, state } = yield* current(sched)
    return { s: yield* withIssues(sched, s, mergingIn(state, s.running)), state }
  })

/**
 * Sets a ticket aside whose ID can't be run: it moves through Working to Deferred at once, and no
 * worker starts, so it has no dispatch record and counts toward no limit.
 */
export const setAside = (sched: Scheduling, issue: Issue, why: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const text = badTicketIdLine(issue.id, why)
    yield* sched.ledger.transition(issue.id, Move.Dispatched())
    const deferred = yield* sched.beads
      .defer(issue.id, { reason: badTicketIdNote(issue.id, why) })
      .pipe(Effect.result)
    const failed = Result.isFailure(deferred)
      ? detail`${why}: ${issue.id}, and bd could not defer it`
      : undefined
    yield* sched.ledger.transition(issue.id, Move.Defer({ why: "BAD_TICKET_ID" }), {
      said: [{ kind: "deferred", ticket: issue.id, title: issue.title, detail: why, text }],
      ...(failed === undefined ? {} : { lines: [failed], deferFailed: failed.trimStart() }),
    })
  })

/**
 * Moves a waiting ticket to the phase `held` says: HeldBack for its reason, or Queued; one held
 * for another reason is released first. Each move writes a queue record counting `ids`, the
 * candidates the fill read. A ticket already placed so, or not in the ledger, is left as it is.
 */
export const placeWaiting = (
  sched: Scheduling,
  id: TicketId,
  held: HoldBack | undefined,
  ids: ReadonlyArray<TicketId>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const before = yield* sched.ledger.current
    const phase = before.tickets.get(id)?.phase
    if (phase === undefined) return
    if (phase._tag === "HeldBack" ? phase.why === held : held === undefined) return
    if (phase._tag === "HeldBack") {
      const solo = yield* soloNow(sched)
      yield* sched.ledger.transition(id, Move.Released(), {
        beside: [
          {
            kind: "queue",
            ...(yield* recorded(sched, before, ids, solo, [id, TicketPhase.Queued()])),
          },
        ],
      })
    }
    if (held === undefined) return
    const now = yield* sched.ledger.current
    const solo = yield* soloNow(sched)
    const to = TicketPhase.HeldBack({ why: held })
    yield* sched.ledger.transition(id, Move.Held({ why: held }), {
      beside: [{ kind: "queue", ...(yield* recorded(sched, now, ids, solo, [id, to])) }],
    })
  })
