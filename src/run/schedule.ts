// The scheduler (§ 5 item 5): it reads bd ready within the run's scope (scope.ts), enters each
// candidate in the ledger as Queued, and dispatches the highest-priority Queued ticket to Working
// while a slot is free, handing it to its per-ticket fiber through Start. A slot is taken for as
// long as that fiber runs. Free slots are filled at once (as the run starts, and as a ticket's
// fiber ends) and on the ready poll, every 30 s.
//
// The ledger's phases keep a ticket from being taken twice: only a ticket the run hasn't taken up,
// or one still Queued, is a candidate. --limit counts the tickets this run starts; a resumed or
// carried-over worker takes a slot (carry) but counts toward nothing. A ticket whose ID can't name
// a worktree or a branch is set aside as it is queued (BAD_TICKET_ID), without a worker or a slot.
import { Duration, Effect, FiberSet, Queue, Ref, Result, type Scope, Semaphore } from "effect"
import { Beads, type BeadsError, type Issue } from "../services/Beads.ts"
import { ticketIdProblem } from "../services/Worktrees.ts"
import type { Event } from "./events.ts"
import { RunFibers } from "./fibers.ts"
import { Ledger, type State } from "./ledger.ts"
import { detail, type Line, Log, line } from "./log.ts"
import { Cause } from "./phase.ts"
import { ready } from "./scope.ts"

/** How often bd ready is read while tickets run: tickets become ready mid-run. */
export const readyPoll: Duration.Duration = Duration.seconds(30)

/** How many times a poll reads bd ready while it fails, and how long it waits between reads. */
export const readTries = 3
export const readAgainAfter: Duration.Duration = Duration.seconds(3)

/** The per-ticket fiber's entry: `start` is that fiber, and the ticket holds its slot until it ends. */
export interface Start {
  /** Takes the ticket, now Working in the ledger, from its worktree and session to its outcome. */
  start(issue: Issue): Effect.Effect<void>
}

export interface Options {
  /** How many tickets run at once. */
  readonly concurrent: number
  /** The most tickets this run starts (--limit). */
  readonly limit: number
  /** The ticket the run is scoped to (--ticket), or null for the whole of bd ready. */
  readonly scope: string | null
  /** The queue's `exclude_types`. */
  readonly excludeTypes: ReadonlyArray<string>
  readonly start: Start
  /** Whether the run takes new tickets now (holds say no); the ledger's wind-down says no too. */
  readonly taking?: Effect.Effect<boolean>
}

/** What one fill did. */
export interface Filled {
  /** The tickets it dispatched, in order. */
  readonly dispatched: ReadonlyArray<string>
  /** The tickets it set aside for their IDs. */
  readonly setAside: ReadonlyArray<string>
  /** The candidates left Queued. */
  readonly queued: number
}

export interface Scheduler {
  /** Reads bd ready, queues its new candidates and fills the free slots. */
  readonly fill: Effect.Effect<Filled, BeadsError>
  /**
   * Fills, then again on each ready poll and each slot freed, until interrupted. A read that
   * fails is tried again, up to `readTries` reads in all; then it fails with bd's error.
   */
  readonly run: Effect.Effect<never, BeadsError>
  /** Runs a resumed or carried-over worker's `work` in a slot, counting toward no limit. */
  carry(ticket: string, work: Effect.Effect<void>): Effect.Effect<void>
  /** The tickets this run has started: what --limit counts. */
  readonly started: Effect.Effect<number>
  /** The tickets holding a slot now. */
  readonly running: Effect.Effect<ReadonlySet<string>>
  /** Whether the run has started as many tickets as --limit allows. */
  readonly limitReached: Effect.Effect<boolean>
}

/** `[n/limit] <id> dispatching: <title>`, the dispatch's log line. */
export const dispatchLine = (n: number, limit: number, issue: Issue): Line =>
  line`[${n}/${limit}] ${issue.id} dispatching: ${issue.title}`

/** The BAD_TICKET_ID line, as orchestra words it. */
export const badTicketIdLine = (id: string, why: string): Line =>
  detail`BAD_TICKET_ID: ${why}: ${id} -> deferred without starting a worker; rename it (bd rename ${id} <new-id>), then bd undefer <new-id>`

/** The note bd defer appends to a ticket set aside for its ID. */
export const badTicketIdNote = (id: string, why: string): string =>
  `tutti: ${why}, so no worker was started on ${id}: a ticket's ID names its worktree folder and its branch tutti/<id>. Give it a plain ID (bd rename ${id} <new-id>), then bring it back with: bd undefer <new-id>`

/** Whether the ledger lets the run take `id` from bd ready: not taken up yet, or still Queued. */
const candidate = (state: State, id: string): boolean => {
  const entry = state.tickets.get(id)
  return entry === undefined || entry.phase._tag === "Queued"
}

/** The tickets the ledger has Queued among `ids`. */
const queuedAmong = (state: State, ids: ReadonlyArray<string>): number =>
  ids.filter((id) => state.tickets.get(id)?.phase._tag === "Queued").length

interface Slots {
  readonly running: ReadonlySet<string>
  readonly started: number
}

/** The scheduler over the run's Beads, Ledger (which writes the records), Log and RunFibers. */
export const make = (
  options: Options,
): Effect.Effect<Scheduler, never, Beads | Ledger | Log | RunFibers | Scope.Scope> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const ledger = yield* Ledger
    const logs = yield* Log
    const tickets = yield* (yield* RunFibers).make<void, never>("tickets")
    const slots = yield* Ref.make<Slots>({ running: new Set(), started: 0 })
    // A ticket's fiber that ends wakes the poll, so its slot is filled at once.
    const freed = yield* Queue.sliding<void>(1)
    const oneFill = yield* Semaphore.make(1)
    const taking = options.taking ?? Effect.succeed(true)
    const filter = { excludeTypes: options.excludeTypes }

    const occupy = (ticket: string, work: Effect.Effect<void>) =>
      Effect.gen(function* () {
        yield* Ref.update(slots, (s) => ({ ...s, running: new Set([...s.running, ticket]) }))
        const release = Effect.andThen(
          Ref.update(slots, (s) => ({
            ...s,
            running: new Set([...s.running].filter((id) => id !== ticket)),
          })),
          Queue.offer(freed, undefined),
        )
        yield* FiberSet.run(tickets, Effect.ensuring(work, release))
      })

    // A ticket whose ID can't be run moves through Working to Deferred at once: no worker starts,
    // so it has no dispatch record and counts toward no limit.
    const setAside = (issue: Issue, why: string) =>
      Effect.gen(function* () {
        const text = badTicketIdLine(issue.id, why)
        yield* ledger.transition(issue.id, Cause.Dispatched())
        yield* ledger.transition(issue.id, Cause.Defer({ why: "BAD_TICKET_ID" }), {
          beside: [{ kind: "deferred", ticket: issue.id, title: issue.title, detail: why, text }],
        })
        yield* logs.write(text)
        const deferred = yield* beads
          .defer(issue.id, { reason: badTicketIdNote(issue.id, why) })
          .pipe(Effect.result)
        if (Result.isFailure(deferred)) {
          yield* logs.write(detail`${why}: ${issue.id}, and bd could not defer it`)
        }
      })

    const dispatch = (issue: Issue, queued: number) =>
      Effect.gen(function* () {
        const { started } = yield* Ref.updateAndGet(slots, (s) => ({
          ...s,
          started: s.started + 1,
        }))
        const text = dispatchLine(started, options.limit, issue)
        const record: Event = {
          kind: "dispatch",
          ticket: issue.id,
          title: issue.title,
          n: started,
          limit: options.limit,
          queued,
          text,
        }
        const moved = yield* ledger.transition(issue.id, Cause.Dispatched(), { beside: [record] })
        if (Result.isFailure(moved)) {
          // A PHASE_BUG, which the ledger logged: nothing starts, and nothing is counted.
          yield* Ref.update(slots, (s) => ({ ...s, started: s.started - 1 }))
          return false
        }
        yield* logs.write(text)
        yield* occupy(issue.id, options.start.start(issue))
        return true
      })

    const mayStart = Effect.gen(function* () {
      const s = yield* Ref.get(slots)
      const state = yield* ledger.current
      return (
        s.running.size < options.concurrent &&
        s.started < options.limit &&
        state.windDown === null &&
        (yield* taking)
      )
    })

    const fill = oneFill.withPermit(
      Effect.gen(function* () {
        const found = yield* ready(beads, options.scope, filter)
        const before = yield* ledger.current
        const candidates = found.filter((issue) => candidate(before, issue.id))
        const ids = candidates.map((issue) => issue.id)
        const setAsideNow: Array<string> = []
        // Each new candidate enters the ledger as Queued; one with an unusable ID is set aside.
        for (const issue of candidates) {
          if (before.tickets.has(issue.id)) continue
          const queued = queuedAmong(yield* ledger.current, ids) + 1
          yield* ledger.transition(issue.id, Cause.Ready(), {
            title: issue.title,
            beside: [{ kind: "queue", queued }],
          })
          const why = ticketIdProblem(issue.id)
          if (why !== undefined) {
            yield* setAside(issue, why)
            setAsideNow.push(issue.id)
          }
        }
        const dispatched: Array<string> = []
        for (const issue of candidates) {
          if (setAsideNow.includes(issue.id)) continue
          if (!(yield* mayStart)) break
          const queued = queuedAmong(yield* ledger.current, ids) - 1
          if (yield* dispatch(issue, queued)) dispatched.push(issue.id)
        }
        const queued = queuedAmong(yield* ledger.current, ids)
        return { dispatched, setAside: setAsideNow, queued }
      }),
    )

    // A fill whose read fails is tried again a few seconds later, up to readTries reads.
    const fillTries = (tries: number): Effect.Effect<Filled, BeadsError> =>
      fill.pipe(
        Effect.catch((error) =>
          tries >= readTries
            ? Effect.fail(error)
            : Effect.gen(function* () {
                yield* logs.write(
                  line`could not read the queue (try ${tries} of ${readTries}), reading it again: ${error.message || error._tag}`,
                )
                yield* Effect.sleep(readAgainAfter)
                return yield* fillTries(tries + 1)
              }),
        ),
      )

    const run = Effect.forever(
      Effect.andThen(
        fillTries(1),
        Effect.race(Queue.take(freed), Effect.asVoid(Effect.sleep(readyPoll))),
      ),
    )

    return {
      fill,
      run,
      carry: occupy,
      started: Effect.map(Ref.get(slots), (s) => s.started),
      running: Effect.map(Ref.get(slots), (s) => s.running),
      limitReached: Effect.map(Ref.get(slots), (s) => s.started >= options.limit),
    }
  })
