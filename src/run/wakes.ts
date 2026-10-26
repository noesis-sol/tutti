// What wakes the run to look again (run.ts), as data: each wake records its reason beside the one
// wake the loop waits for, and the look reads and clears them. Only a look with a reason that can
// change bd or git reads them (`reads`): one woken by an attention change alone, a request opened
// or answered, builds its Look from the run's state for the end's decision (runEnd.ts), as nothing
// it would read again can have changed. A merge-queue change wakes the run only when a look can act
// on it (mergeWakes): not a ticket put in line, nor its turn taken.
import { Effect, Queue, Ref } from "effect"
import type { TicketId } from "../services/Beads.ts"
import type { QueueState } from "./mergequeue.ts"

/**
 * Why the run woke: the ready poll, a slot freed, a merge-queue change, a hold put on or lifted
 * (a stop, BLOCKED, the usage limit, the machine's cap), an attention change, a screen command, a
 * triage verdict, a drain request.
 */
export type Wake =
  | "poll"
  | "freed"
  | "merge"
  | "hold"
  | "attention"
  | "command"
  | "verdict"
  | "drain"

/**
 * The reasons a look takes up without reading bd or git. Only an attention change for now: a
 * reason wrongly put here would put off a fill to the next ready poll.
 */
const unread: ReadonlySet<Wake> = new Set(["attention"])

/**
 * Whether a look woken for `why` reads bd and git: for any reason but those in `unread`, or none
 * recorded (the first look, or a wake whose reason an earlier look took up).
 */
export const reads = (why: ReadonlySet<Wake>): boolean =>
  why.size === 0 || [...why].some((each) => !unread.has(each))

const same = (one: ReadonlyArray<TicketId>, other: ReadonlyArray<TicketId>): boolean =>
  one.length === other.length && one.every((id, i) => id === other[i])

/**
 * Whether the merge queue's change from `before` to `after` wakes the run as "merge": any change
 * but one that only puts tickets in line behind the others (an offer), or only moves a waiting
 * ticket into an empty merging (its turn). Neither frees anything a look would fill, nor settles the
 * queue for the run's end; the worker's freed slot wakes the run of its own, and a merge over, a
 * stop or a hand-back wakes it as before. `before` null, the first state seen,
 * wakes it.
 */
export const mergeWakes = (before: QueueState | null, after: QueueState): boolean => {
  if (before === null || before.stop !== after.stop || !same(before.resolving, after.resolving)) {
    return true
  }
  const { waiting } = before
  // An offer: the same merge, the line as it was with tickets behind it.
  if (before.merging === after.merging) {
    return !(
      after.waiting.length > waiting.length && same(waiting, after.waiting.slice(0, waiting.length))
    )
  }
  // A turn: a waiting ticket now merging, where none was, the others as they were.
  const turned = after.merging
  return !(
    before.merging === null &&
    turned !== null &&
    waiting.includes(turned) &&
    same(
      waiting.filter((id) => id !== turned),
      after.waiting,
    )
  )
}

export interface Wakes {
  /** Wakes the run to look again, for `why`. */
  readonly wakeUp: (why: Wake) => Effect.Effect<void>
  /** Waits for the next wake, or for `freed`, which wakes the run as "freed". */
  readonly next: (freed: Effect.Effect<unknown>) => Effect.Effect<void>
  /**
   * The reasons recorded since it was last taken, cleared, with the wake still pending for them:
   * the look that takes them sees what they woke it for, so another would look for nothing. A wake
   * whose reason comes after it is still pending, so none is lost.
   */
  readonly take: Effect.Effect<ReadonlySet<Wake>>
}

export const make: Effect.Effect<Wakes> = Effect.gen(function* () {
  const wake = yield* Queue.sliding<void>(1)
  const reasons = yield* Ref.make<ReadonlySet<Wake>>(new Set())
  const note = (why: Wake) =>
    Ref.update(reasons, (all) => (all.has(why) ? all : new Set([...all, why])))
  return {
    wakeUp: (why) => Effect.andThen(note(why), Effect.asVoid(Queue.offer(wake, undefined))),
    next: (freed) => Effect.raceFirst(Queue.take(wake), Effect.andThen(freed, note("freed"))),
    // The wake first: a reason recorded after it has its wake offered after it too.
    take: Effect.andThen(Queue.poll(wake), Ref.getAndSet(reasons, new Set())),
  }
})
