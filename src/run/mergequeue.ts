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
//
// A ticket set aside as its check failed is kept in the queue's rechecks, and after each merge the
// ones whose base has moved on since are put back in line, ToMerge by RECHECK (recheck.ts).
//
// A ticket whose rebase stopped on conflicts its worker can take is handed back to it, Merging →
// Resolving (handback.ts), and its merge is over for the queue, which goes on with the tickets behind
// it. The hand-back runs in a fiber of its own, kept in the queue's state while it is under way; a
// resolution verified puts the ticket back in line behind the others, ToMerge.
//
// So does a check that fails on the rebased branch in a way its worker can take, Merging → Fixing
// (checkback.ts), as does one that fails on a resolution, Resolving → Fixing: a fix verified and
// checked puts the ticket back in line, ToMerge.
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
import { type CheckStop, fixCheck, fixResolution, handOverFix, makeFixes } from "./checkback.ts"
import { RunFibers } from "./fibers.ts"
import { type HandBacks, handOver, makeHandBacks, type RebaseStop, resolve } from "./handback.ts"
import { Ledger } from "./ledger.ts"
import {
  abandonRebase,
  type FinishedTicket,
  fastForward,
  type MergeEnv,
  type MergeOptions,
  type MergeStop,
  prepare,
} from "./merge.ts"
import { Cause, Detail, type InvalidTransition, type TicketPhase } from "./phase.ts"
import { makeRechecks, type Rechecks, recheckDue } from "./recheck.ts"
import { makeSetUps } from "./setup.ts"

export interface QueueState {
  /** The tickets waiting for their turn, next first. */
  readonly waiting: ReadonlyArray<string>
  /** The ticket whose merge is under way. */
  readonly merging: string | null
  /**
   * The tickets whose conflicts or failed checks are handed back to their workers, Resolving or
   * Fixing.
   */
  readonly resolving: ReadonlyArray<string>
  /** What stopped the merges, if anything has. */
  readonly stop: MergeStop | null
}

export const emptyQueue: QueueState = { waiting: [], merging: null, resolving: [], stop: null }

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
  /**
   * Waits until no merge is under way, and none waits or is handed back to its worker, or the
   * merges have stopped.
   */
  readonly settled: Effect.Effect<QueueState>
  /** The tickets set aside for a failed check that may be checked once more in this run. */
  readonly rechecks: Rechecks
  /** The run's conflict hand-backs: each ticket's count, and those waiting on a steered worker. */
  readonly handBacks: HandBacks
  /**
   * Puts back in line, ToMerge by RECHECK, the tickets whose base has moved on since their check
   * failed, as the queue does after each merge; the tickets it put back.
   */
  readonly recheck: Effect.Effect<ReadonlyArray<string>>
}

/** Whether nothing is left for the queue to do. */
export const isSettled = (state: QueueState): boolean =>
  state.merging === null &&
  ((state.waiting.length === 0 && state.resolving.length === 0) || state.stop !== null)

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
    const rechecks = yield* makeRechecks
    const setUps = yield* makeSetUps
    const handBacks = yield* makeHandBacks
    const fixes = yield* makeFixes
    const memory = { rechecks, setUps, handBacks, fixes }
    // Changes to the line and the places it gives, one at a time.
    const lock = yield* Semaphore.make(1)
    const state = SubscriptionRef.get(ref)

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

    // A quit before the fast-forward: back at the head of the line, ToMerge, its branch put back
    // from a rebase the quit cut short wherever it came (git's or the abort of a conflict's). A
    // ticket the merge had set aside or blocked just before stays as it was.
    const backInLine = (ticket: FinishedTicket) =>
      lock.withPermit(
        Effect.gen(function* () {
          yield* abandonRebase(ticket.worktree)
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

    const handBacksSet = yield* fibers.make("hand-backs")

    const recheck = recheckDue(rechecks, { offer, state }, options).pipe(
      Effect.provideContext(context),
    )

    const merged = (stop: MergeStop | undefined) =>
      SubscriptionRef.update(ref, (state) => ({
        ...state,
        merging: null,
        stop: state.stop ?? stop ?? null,
      }))

    // A hand-back to the ticket's worker, `handed` when the ledger took it: `work` in a fiber of
    // its own, the ticket's merge over for the queue. Verified puts it back in line; the run's end
    // stops one under way.
    const underWay = (
      id: string,
      handed: boolean,
      work: Effect.Effect<boolean, never, MergeEnv>,
      ticket: FinishedTicket,
    ) =>
      Effect.gen(function* () {
        yield* SubscriptionRef.update(ref, (state) => ({
          ...state,
          merging: null,
          resolving: handed ? [...state.resolving, id] : state.resolving,
        }))
        if (!handed) return
        const done = SubscriptionRef.update(ref, (state) => ({
          ...state,
          resolving: state.resolving.filter((each) => each !== id),
        }))
        yield* FiberSet.run(
          handBacksSet,
          Effect.interruptible(
            Effect.gen(function* () {
              if (yield* work) yield* offer(ticket)
            }),
          ).pipe(Effect.ensuring(done), Effect.provideContext(context)),
        )
      })

    // Its conflicts handed back to its worker, Resolving; a resolution whose check fails goes on to
    // Fixing, or is blocked (checkback.ts).
    const handBack = (stop: RebaseStop) =>
      Effect.gen(function* () {
        const handed = yield* handOver(stop, options, handBacks)
        const work = Effect.gen(function* () {
          const resolved = yield* resolve(stop, options)
          if (resolved._tag === "CheckFailed") {
            const fixed = yield* fixResolution(
              stop,
              resolved.error,
              resolved.output,
              options,
              memory,
            )
            return fixed === "verified"
          }
          return resolved._tag === "Verified"
        })
        yield* underWay(stop.ticket.id, handed, work, stop.ticket)
      })

    // Its failed check handed back to its worker, Fixing. The ledger refusing (PHASE_BUG) leaves it
    // as it is.
    const fixBack = (stop: CheckStop) =>
      Effect.gen(function* () {
        const handed = yield* handOverFix(stop, options, fixes)
        const work = Effect.map(fixCheck(stop, options, memory), (fixed) => fixed === "verified")
        yield* underWay(stop.ticket.id, handed, work, stop.ticket)
      })

    // Its turn and its merge, under one mask: a quit as its turn starts finds it Merging, and puts
    // it back in line.
    const merge = (ticket: FinishedTicket) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (!(yield* turn(ticket))) return
          const prepared = yield* restore(prepare(ticket, options, memory)).pipe(
            Effect.onInterrupt(() => backInLine(ticket)),
          )
          if (prepared._tag === "HandBack") return yield* handBack(prepared.stop)
          if (prepared._tag === "FixBack") return yield* fixBack(prepared.stop)
          const stop =
            prepared._tag === "Over"
              ? prepared.stop
              : yield* fastForward(ticket, options, prepared.onto)
          // A merge moves the base on, which may be what a ticket's failed check waits for: the
          // tickets it puts back are in line before this merge is over, so `settled` waits for them.
          if (stop === undefined) yield* Effect.exit(restore(recheck))
          yield* merged(stop)
        }),
      )

    const consume = Effect.forever(
      Effect.gen(function* () {
        const ticket = yield* Queue.take(line)
        yield* merge(ticket)
      }),
    ).pipe(Effect.provideContext(context))

    const set = yield* fibers.make("merge queue")
    yield* FiberSet.run(set, consume)

    return {
      offer,
      state,
      changes: SubscriptionRef.changes(ref),
      settled: SubscriptionRef.changes(ref).pipe(
        Stream.filter(isSettled),
        Stream.runHead,
        Effect.map((found) => (found._tag === "Some" ? found.value : emptyQueue)),
      ),
      rechecks,
      handBacks,
      recheck,
    } satisfies MergeQueue
  })
