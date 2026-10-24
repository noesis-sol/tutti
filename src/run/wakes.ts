// What wakes the run to look again (run.ts), as data: each wake records its reason beside the one
// wake the loop waits for, and the look reads and clears them. Only a look with a reason that can
// change bd or git reads them (`reads`): one woken by an attention change alone, a request opened
// or answered, builds its Look from the run's state for the end's decision (runEnd.ts), as nothing
// it would read again can have changed.
import { Effect, Queue, Ref } from "effect"

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

export interface Wakes {
  /** Wakes the run to look again, for `why`. */
  readonly wakeUp: (why: Wake) => Effect.Effect<void>
  /** Waits for the next wake, or for `freed`, which wakes the run as "freed". */
  readonly next: (freed: Effect.Effect<unknown>) => Effect.Effect<void>
  /** The reasons recorded since it was last taken, cleared. */
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
    take: Ref.getAndSet(reasons, new Set()),
  }
})
