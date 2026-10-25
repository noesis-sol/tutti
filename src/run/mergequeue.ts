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
// ones whose base has moved on since are put back in line, ToMerge by RECHECK (recheck.ts): first,
// those merged by hand since the base last moved are taken as merged (handMerged.ts).
//
// A ticket whose rebase stopped on conflicts its worker can take is handed back to it, Merging →
// Resolving (handback.ts), and its merge is over for the queue, which goes on with the tickets behind
// it. The hand-back runs in a fiber of its own, kept in the queue's state while it is under way; a
// resolution verified puts the ticket back in line behind the others, ToMerge.
//
// So does a check that fails on the rebased branch in a way its worker can take, Merging → Fixing
// (checkback.ts), as does one that fails on a resolution, Resolving → Fixing: a fix verified and
// checked puts the ticket back in line, ToMerge.
//
// Once a ticket's merge is over, the messages you sent its worker meanwhile, held, are sent or
// dropped (held.ts). Once its merge, or a hand-back to its worker, is over, its session is closed
// if its phase no longer needs it (sessions.ts): merged, blocked (unless its hand-back waits for its
// steered worker), or set aside and not to be checked again.
//
// While a ticket's check runs in its turn, the next in line, waiting for its first turn, is checked
// ahead of it on top of its branch (mergetrain.ts): its turn then merges it with no second check when
// the ticket ahead merged as it was checked. Quitting, or the merges stopping, puts back the branches
// the trains rebased.
import {
  Effect,
  FiberSet,
  Queue,
  Ref,
  Result,
  type Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect"
import type { TicketId } from "../services/Beads.ts"
import { Git } from "../services/Git.ts"
import { makePasses } from "./check.ts"
import { fixCheck, fixResolution, type HandedCheck, handOverFix, makeFixes } from "./checkback.ts"
import { RunFibers } from "./fibers.ts"
import {
  type HandBacks,
  type HandedRebase,
  handOver,
  makeHandBacks,
  noReset,
  resolve,
} from "./handback.ts"
import { mergedByHand as handMerged } from "./handMerged.ts"
import { type Held, makeHeld } from "./held.ts"
import { Ledger } from "./ledger.ts"
import {
  closeUnchanged,
  type FinishedTicket,
  type GivenMergeOptions,
  type MergeEnv,
  type MergeOptions,
  type MergeStop,
  mergeTurn,
} from "./merge.ts"
import { type CheckAhead, make as makeTrain } from "./mergetrain.ts"
import { Detail, type InvalidTransition, Move, type TicketPhase } from "./phase.ts"
import { makeRechecks, type Rechecks, recheckDue } from "./recheck.ts"
import { fit } from "./sessions.ts"
import { makeSetUps, takeSettings } from "./setup.ts"

export interface QueueState {
  /** The tickets waiting for their turn, next first. */
  readonly waiting: ReadonlyArray<TicketId>
  /** The ticket whose merge is under way. */
  readonly merging: TicketId | null
  /**
   * The tickets whose conflicts or failed checks are handed back to their workers, Resolving or
   * Fixing.
   */
  readonly resolving: ReadonlyArray<TicketId>
  /** What stopped the merges, if anything has. */
  readonly stop: MergeStop | null
}

export const emptyQueue: QueueState = { waiting: [], merging: null, resolving: [], stop: null }

export interface MergeQueue {
  /**
   * Puts the ticket in line behind the tickets already in it, ToMerge at its place there, by
   * `move` (Verified, from Working, unless given). A transition the ledger refuses (PHASE_BUG)
   * leaves it out of the queue. `ahead`: it waits for its first turn in its merge, and may be
   * checked ahead of it (mergetrain.ts); true unless given.
   */
  offer(
    ticket: FinishedTicket,
    move?: (place: number) => Move,
    ahead?: boolean,
  ): Effect.Effect<Result.Result<TicketPhase | null, InvalidTransition>>
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
  /** Your messages to the workers of tickets waiting to merge or merging, held (held.ts). */
  readonly held: Held
  /** How the checks ahead of their turn go, by ticket, now and on each change (mergetrain.ts). */
  readonly checksAhead: Stream.Stream<ReadonlyMap<string, CheckAhead>>
  /**
   * Puts back in line, ToMerge by RECHECK, the tickets whose base has moved on since their check
   * failed, as the queue does after each merge; the tickets it put back.
   */
  readonly recheck: Effect.Effect<ReadonlyArray<string>>
  /**
   * Takes as merged the tickets closed but not merged that were merged by hand since the base last
   * moved on (handMerged.ts), as `recheck` does first, and the run's end once more; the tickets it
   * found merged.
   */
  readonly mergedByHand: Effect.Effect<ReadonlyArray<string>>
  /**
   * Holds the queue as quitting begins (quit.ts): no ticket takes its turn and none is handed back
   * from now on (a merge under way that would hand its ticket back puts it back in line instead,
   * ToMerge), and the hand-backs under way stop, their tickets left Resolving or Fixing, their
   * rebases or fixes as they are, for the run's end to stop them. The checks ahead of their turn
   * stop, and the branches they rebased are put back as their workers left them.
   */
  readonly hold: Effect.Effect<void>
  /**
   * Stops the merges, as quitting does: one in its protected step finishes it first; one before it
   * has its rebase aborted or its check killed, and is back at the head of the line, ToMerge.
   */
  readonly stopMerges: Effect.Effect<void>
}

/** Whether nothing is left for the queue to do. */
export const isSettled = (state: QueueState): boolean =>
  state.merging === null &&
  ((state.waiting.length === 0 && state.resolving.length === 0) || state.stop !== null)

/**
 * The merge queue, its consumer forked into a FiberSet of the caller's scope. A defect in the
 * consumer or a hand-back goes to `onPanic`, naming where it came from, when one is given (the run
 * then quits, PANIC); the ticket whose merge it cut short before the fast-forward is back in line.
 */
export const make = (
  given: GivenMergeOptions,
  onPanic?: (where: string, defect: unknown) => Effect.Effect<void>,
): Effect.Effect<MergeQueue, never, MergeEnv | RunFibers | Scope.Scope> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const git = yield* Git
    const fibers = yield* RunFibers
    const context = yield* Effect.context<MergeEnv>()
    const line = yield* Queue.unbounded<FinishedTicket>()
    const ref = yield* SubscriptionRef.make(emptyQueue)
    const rechecks = yield* makeRechecks
    // Set as quitting begins: no more turns or hand-backs.
    const held = yield* Ref.make(false)
    // What the run didn't give, in its place once (MergeOptions): a recheck then takes no slot.
    const options: MergeOptions = {
      ...given,
      noMore: given.noMore ?? Effect.succeed(undefined),
      atReset: given.atReset ?? noReset,
      loaded: given.loaded ?? Effect.succeed(false),
      recheckSlot: given.recheckSlot ?? (() => Effect.succeed(true)),
      setUps: given.setUps ?? (yield* makeSetUps),
      machineFull: given.machineFull ?? Effect.succeed(false),
    }
    const { setUps } = options
    const handBacks = yield* makeHandBacks
    const heldMessages = yield* makeHeld
    const fixes = yield* makeFixes
    const passes = yield* makePasses
    // Changes to the line and the places it gives, one at a time: the waiting list changes only
    // under it, so a place read under it holds until its write. The rest of the state changes
    // outside it (a merge over, a hand-back under way or done, while an offer waits on the ledger),
    // so every write updates the state as it is then, not as it was read.
    const lock = yield* Semaphore.make(1)
    const state = SubscriptionRef.get(ref)
    const guarded = <A, E, R>(where: string, effect: Effect.Effect<A, E, R>) =>
      onPanic === undefined
        ? effect
        : Effect.catchDefect(effect, (defect) => onPanic(where, defect))
    const train = yield* makeTrain(
      { ...options, waiting: Effect.map(state, (now) => now.waiting) },
      { rechecks, setUps, passes, handBacks, fixes },
      guarded,
    )
    const memory = { rechecks, setUps, passes, handBacks, fixes, train }

    // The places of the tickets waiting, from 1.
    const renumber = (waiting: ReadonlyArray<TicketId>) =>
      Effect.forEach(waiting, (id, i) => ledger.refine(id, Detail.Place({ place: i + 1 })), {
        discard: true,
      })

    const offer: MergeQueue["offer"] = (
      ticket,
      move = (place) => Move.Verified({ place }),
      ahead = true,
    ) =>
      Effect.tap(
        lock.withPermit(
          Effect.uninterruptible(
            Effect.gen(function* () {
              const place = (yield* SubscriptionRef.get(ref)).waiting.length + 1
              // A message to its worker goes before it, or is held from now on (held.ts).
              const moved = yield* heldMessages
                .entering(
                  ticket.id,
                  ledger.transition(ticket.id, move(place), { title: ticket.title }),
                )
                .pipe(Effect.provideContext(context))
              if (Result.isFailure(moved)) return moved
              if (ahead) yield* train.mayCheckAhead(ticket)
              yield* SubscriptionRef.update(ref, (now) => ({
                ...now,
                waiting: [...now.waiting, ticket.id],
              }))
              yield* Queue.offer(line, ticket)
              return moved
            }),
          ),
        ),
        // The check under way may have it checked ahead of its turn.
        (moved) => (Result.isSuccess(moved) && ahead ? train.start : Effect.void),
      )

    // Its turn: out of the line and Merging, the others moved up. False when the merges have
    // stopped, which leaves it waiting, or when the ledger refuses (PHASE_BUG).
    const turn = (ticket: FinishedTicket) =>
      lock.withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const state = yield* SubscriptionRef.get(ref)
            if (state.stop !== null || (yield* Ref.get(held))) return false
            const waiting = state.waiting.filter((id) => id !== ticket.id)
            const moved = yield* ledger.transition(ticket.id, Move.ItsTurn())
            yield* renumber(waiting)
            const merging = Result.isSuccess(moved) ? ticket.id : null
            yield* SubscriptionRef.update(ref, (now) => ({
              ...now,
              waiting: now.waiting.filter((id) => id !== ticket.id),
              merging,
            }))
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
          yield* git.abandonRebase(ticket.worktree)
          const entry = (yield* ledger.current).tickets.get(ticket.id)
          if (entry?.phase._tag !== "Merging") {
            return yield* SubscriptionRef.update(ref, (now) => ({ ...now, merging: null }))
          }
          yield* ledger.transition(ticket.id, Move.MergeInterrupted({ place: 1 }))
          yield* renumber([ticket.id, ...(yield* SubscriptionRef.get(ref)).waiting])
          yield* SubscriptionRef.update(ref, (now) => ({
            ...now,
            waiting: [ticket.id, ...now.waiting],
            merging: null,
          }))
        }),
      )

    const handBacksSet = yield* fibers.make("hand-backs")

    // A ticket merged by hand since the base last moved on isn't checked again: it is looked for
    // first, one look at a time, the first look asking of every one.
    const looking = yield* Semaphore.make(1)
    const seen = yield* Ref.make<string | undefined>(undefined)
    const mergedByHand = looking.withPermits(1)(
      handMerged(seen, { rechecks, handBacks }, options).pipe(Effect.provideContext(context)),
    )
    // `at`: where the base is, as a merge just put it, for neither to ask git again.
    const recheckFrom = (at?: string) =>
      looking.withPermits(1)(
        Effect.andThen(
          handMerged(seen, { rechecks, handBacks }, options, at),
          recheckDue(
            rechecks,
            { offer, state, changes: SubscriptionRef.changes(ref) },
            options,
            at,
          ),
        ).pipe(Effect.provideContext(context)),
      )
    const recheck = recheckFrom()

    // The merges stopping leave the tickets behind waiting: the branches their trains rebased are
    // put back.
    const merged = (stop: MergeStop | undefined) =>
      Effect.andThen(
        SubscriptionRef.update(ref, (state) => ({
          ...state,
          merging: null,
          stop: state.stop ?? stop ?? null,
        })),
        stop === undefined ? Effect.void : train.leave,
      )

    // A hand-back to the ticket's worker, `handed` when the ledger took it: `work` in a fiber of
    // its own, the ticket's merge over for the queue. Verified puts it back in line; the run's end
    // stops one under way.
    const underWay = (
      id: TicketId,
      handed: boolean,
      work: Effect.Effect<boolean, never, MergeEnv>,
      ticket: FinishedTicket,
    ) =>
      Effect.gen(function* () {
        // Its merge is over: the messages held for its worker go to it now, or are dropped, before
        // the queue can settle.
        yield* heldMessages.over(id)
        yield* SubscriptionRef.update(ref, (state) => ({
          ...state,
          merging: null,
          resolving: handed ? [...state.resolving, id] : state.resolving,
        }))
        if (!handed) return yield* fit(id, rechecks, handBacks)
        const done = SubscriptionRef.update(ref, (state) => ({
          ...state,
          resolving: state.resolving.filter((each) => each !== id),
        }))
        yield* FiberSet.run(
          handBacksSet,
          guarded(
            `${id}'s hand-back`,
            Effect.interruptible(
              Effect.gen(function* () {
                // Back in line in the same merge: checked in its turn, not ahead of it.
                if (yield* work) yield* offer(ticket, undefined, false)
                yield* fit(id, rechecks, handBacks)
              }),
            ).pipe(Effect.ensuring(done), Effect.provideContext(context)),
          ),
        )
      })

    // Its conflicts handed back to its worker, Resolving; a resolution that changes nothing is
    // closed at once, protected as a merge's last step is; one whose check fails goes on to Fixing,
    // or is blocked (checkback.ts).
    const handBack = (stop: HandedRebase) =>
      Effect.gen(function* () {
        const handed = yield* handOver(stop, options, handBacks, memory.setUps)
        const work = Effect.gen(function* () {
          const resolved = yield* resolve(stop, options, memory)
          if (resolved._tag === "Unchanged") {
            yield* Effect.uninterruptible(closeUnchanged(stop.ticket, options, resolved.unchanged))
            return false
          }
          if (resolved._tag === "CheckFailed") {
            const fixed = yield* fixResolution(
              stop,
              resolved.error,
              resolved.output,
              resolved.at,
              options,
              memory,
            )
            return fixed._tag === "Verified"
          }
          return resolved._tag === "Verified"
        })
        yield* underWay(stop.ticket.id, handed, work, stop.ticket)
      })

    // Its failed check handed back to its worker, Fixing. The ledger refusing (PHASE_BUG) leaves it
    // as it is.
    const fixBack = (stop: HandedCheck) =>
      Effect.gen(function* () {
        const handed = yield* handOverFix(stop, options, fixes)
        const work = Effect.map(
          fixCheck(stop, options, memory),
          (fixed) => fixed._tag === "Verified",
        )
        yield* underWay(stop.ticket.id, handed, work, stop.ticket)
      })

    // Its turn and its merge, under one mask: a quit as its turn starts finds it Merging, and puts
    // it back in line, as does a defect before the fast-forward. A ticket checked ahead of its turn
    // boards its train first (mergetrain.ts): over when git can't put its branch back.
    const merge = (ticket: FinishedTicket) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (!(yield* turn(ticket))) return
          const boarded = yield* restore(train.board(ticket)).pipe(
            Effect.onError(() => backInLine(ticket)),
          )
          // Each step but the fast-forward may be interrupted, putting it back in line.
          const prepared =
            boarded ??
            (yield* mergeTurn(ticket, options, memory, (step) =>
              restore(step).pipe(Effect.onError(() => backInLine(ticket))),
            ))
          const handingBack = prepared._tag === "HandBack" || prepared._tag === "FixBack"
          if (handingBack && (yield* Ref.get(held))) return yield* backInLine(ticket)
          if (prepared._tag === "HandBack") return yield* handBack(prepared.stop)
          if (prepared._tag === "FixBack") return yield* fixBack(prepared.stop)
          if (prepared._tag === "Unchanged") yield* closeUnchanged(ticket, options, prepared)
          const stop = prepared._tag === "Over" ? prepared.stop : undefined
          // A merge that changed .tutti/settings.json may set the setup the run uses from now on.
          // The fast-forward put the base at the commit checked, `at`: it isn't read again.
          // A merge moves the base on, which may be what a ticket's failed check waits for: the
          // tickets it puts back are in line before this merge is over, so `settled` waits for them.
          if (prepared._tag === "Merged") {
            yield* takeSettings(ticket.id, options, setUps, prepared.onto, prepared.at)
            yield* Effect.exit(restore(recheckFrom(prepared.at)))
          }
          yield* heldMessages.over(ticket.id)
          yield* merged(stop)
          yield* fit(ticket.id, rechecks, handBacks)
        }),
      ).pipe(Effect.ensuring(train.holderDone))

    const consume = Effect.forever(
      Effect.gen(function* () {
        const ticket = yield* Queue.take(line)
        yield* merge(ticket)
      }),
    ).pipe(Effect.provideContext(context))

    const set = yield* fibers.make("merge queue")
    yield* FiberSet.run(set, guarded("the merge queue", consume))

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
      held: heldMessages,
      checksAhead: train.checksAhead,
      recheck,
      mergedByHand,
      hold: Effect.andThen(
        Ref.set(held, true),
        Effect.andThen(train.leave, FiberSet.clear(handBacksSet)),
      ),
      stopMerges: Effect.andThen(FiberSet.clear(set), train.leave),
    } satisfies MergeQueue
  })
