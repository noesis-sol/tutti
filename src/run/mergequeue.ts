// The merge queue (§ 3.4, § 5 item 7, § 5.1's ToMerge and Merging): a Queue<FinishedTicket> with one
// consumer, so tickets merge one at a time, in the order they finished. A ticket joins it ToMerge
// with its place in line (1 is next), kept current as the line moves up; its turn moves it to
// Merging, and merge.ts takes it from there.
//
// Only the step from the fast-forward to the end of its notes is protected from interruption, by
// Effect.uninterruptibleMask: what comes before it, the rebase and the check, runs in restore. A
// quit during them aborts the rebase or kills the check, and puts the ticket back at the head of
// the line, ToMerge, for the run's end to stop it there; one during the protected step waits for
// the merge to finish, so the repository is never left half merged.
//
// A merge that stops the merges (DIRTY_TREE, GIT_FAILED, MERGE_FAILED) is kept in the queue's state
// for the run loop, and no ticket merges after it: those behind it stay ToMerge.
import {
  Effect,
  FiberSet,
  Queue,
  Result,
  type Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect"
import { RunFibers } from "./fibers.ts"
import { Ledger } from "./ledger.ts"
import {
  type FinishedTicket,
  fastForward,
  type MergeEnv,
  type MergeOptions,
  type MergeStop,
  prepare,
} from "./merge.ts"
import { Cause, Detail, type InvalidTransition, type TicketPhase } from "./phase.ts"

export interface QueueState {
  /** The tickets waiting for their turn, next first. */
  readonly waiting: ReadonlyArray<string>
  /** The ticket whose merge is under way. */
  readonly merging: string | null
  /** What stopped the merges, if anything has. */
  readonly stop: MergeStop | null
}

export const emptyQueue: QueueState = { waiting: [], merging: null, stop: null }

export interface MergeQueue {
  /**
   * Puts the ticket in line behind the tickets already in it, ToMerge at its place there, by
   * `cause` (Verified, from Working, unless given). A transition the ledger refuses (PHASE_BUG)
   * leaves it out of the queue.
   */
  offer(
    ticket: FinishedTicket,
    cause?: (place: number) => Cause,
  ): Effect.Effect<Result.Result<TicketPhase, InvalidTransition>>
  readonly state: Effect.Effect<QueueState>
  /** The state now, then each new one. */
  readonly changes: Stream.Stream<QueueState>
  /** Waits until no merge is under way and none waits, or the merges have stopped. */
  readonly settled: Effect.Effect<QueueState>
}

/** Whether nothing is left for the queue to do. */
export const isSettled = (state: QueueState): boolean =>
  state.merging === null && (state.waiting.length === 0 || state.stop !== null)

/** The merge queue, its consumer forked into a FiberSet of the caller's scope. */
export const make = (
  options: MergeOptions,
): Effect.Effect<MergeQueue, never, MergeEnv | RunFibers | Scope.Scope> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const fibers = yield* RunFibers
    const context = yield* Effect.context<MergeEnv>()
    const line = yield* Queue.unbounded<FinishedTicket>()
    const ref = yield* SubscriptionRef.make(emptyQueue)
    // Changes to the line and the places it gives, one at a time.
    const lock = yield* Semaphore.make(1)

    // The places of the tickets waiting, from 1.
    const renumber = (waiting: ReadonlyArray<string>) =>
      Effect.forEach(waiting, (id, i) => ledger.refine(id, Detail.Place({ place: i + 1 })), {
        discard: true,
      })

    const offer: MergeQueue["offer"] = (ticket, cause = (place) => Cause.Verified({ place })) =>
      lock.withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const state = yield* SubscriptionRef.get(ref)
            const moved = yield* ledger.transition(ticket.id, cause(state.waiting.length + 1), {
              title: ticket.title,
            })
            if (Result.isFailure(moved)) return moved
            yield* SubscriptionRef.set(ref, { ...state, waiting: [...state.waiting, ticket.id] })
            yield* Queue.offer(line, ticket)
            return moved
          }),
        ),
      )

    // Its turn: out of the line and Merging, the others moved up. False when the merges have
    // stopped, which leaves it waiting, or when the ledger refuses (PHASE_BUG).
    const turn = (ticket: FinishedTicket) =>
      lock.withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const state = yield* SubscriptionRef.get(ref)
            if (state.stop !== null) return false
            const waiting = state.waiting.filter((id) => id !== ticket.id)
            const moved = yield* ledger.transition(ticket.id, Cause.ItsTurn())
            yield* renumber(waiting)
            const merging = Result.isSuccess(moved) ? ticket.id : null
            yield* SubscriptionRef.set(ref, { ...state, waiting, merging })
            return merging !== null
          }),
        ),
      )

    // A quit before the fast-forward: back at the head of the line, ToMerge. A ticket the merge
    // had set aside or blocked just before stays as it was.
    const backInLine = (ticket: FinishedTicket) =>
      lock.withPermit(
        Effect.gen(function* () {
          const state = yield* SubscriptionRef.get(ref)
          const entry = (yield* ledger.current).tickets.get(ticket.id)
          if (entry?.phase._tag !== "Merging") {
            return yield* SubscriptionRef.set(ref, { ...state, merging: null })
          }
          yield* ledger.transition(ticket.id, Cause.MergeInterrupted({ place: 1 }))
          const waiting = [ticket.id, ...state.waiting]
          yield* renumber(waiting)
          yield* SubscriptionRef.set(ref, { ...state, waiting, merging: null })
        }),
      )

    const merged = (stop: MergeStop | undefined) =>
      SubscriptionRef.update(ref, (state) => ({
        ...state,
        merging: null,
        stop: state.stop ?? stop ?? null,
      }))

    const merge = (ticket: FinishedTicket) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const prepared = yield* restore(prepare(ticket, options)).pipe(
            Effect.onInterrupt(() => backInLine(ticket)),
          )
          const stop =
            prepared._tag === "Over"
              ? prepared.stop
              : yield* fastForward(ticket, options, prepared.onto)
          yield* merged(stop)
        }),
      )

    const consume = Effect.forever(
      Effect.gen(function* () {
        const ticket = yield* Queue.take(line)
        if (yield* turn(ticket)) yield* merge(ticket)
      }),
    ).pipe(Effect.provideContext(context))

    const set = yield* fibers.make("merge queue")
    yield* FiberSet.run(set, consume)

    return {
      offer,
      state: SubscriptionRef.get(ref),
      changes: SubscriptionRef.changes(ref),
      settled: SubscriptionRef.changes(ref).pipe(
        Stream.filter(isSettled),
        Stream.runHead,
        Effect.map((found) => (found._tag === "Some" ? found.value : emptyQueue)),
      ),
    } satisfies MergeQueue
  })
