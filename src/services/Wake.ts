// The machine's sleep (§ 3.3 "Time limits"). tutti's time limits count the time the machine is
// awake: a check's, a setup's, bd's and git's, a ticket's, the idle grace's, an organ's. Without
// this, a timer counting wall time fires as the machine wakes, and a check that ran a minute before
// the machine slept for half an hour fails "did not finish within 30m" (tutti-dhyy).
//
// Bun gives no clock known to stop while the machine sleeps on both macOS and Linux: its timers on
// macOS count the sleep (CLOCK_MONOTONIC goes on while asleep there), and it doesn't say what
// performance.now and process.hrtime read. So the live Wake keeps a beat of its own: every second
// it reads the wall clock, and a gap between two readings longer than the beat by more than
// sleepGap is a sleep, whichever clock the timer went by. Whoever asks how long the machine slept
// looks first, so a limit whose timer fires at the wake, before the beat's, sees the sleep too. A
// process stopped (SIGSTOP) or an event loop held as long reads as a sleep, and is not counted
// either; a wall clock set forward too.
//
// Wake is a reference: none is noticed unless the run's layers give the live one (src/main.ts), so
// a test or a command outside a run counts wall time. src/testing/Wake.ts reports sleeps on cue.
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  type Scope,
  Stream,
  SubscriptionRef,
} from "effect"

/** A sleep of the machine, from when it was last seen awake to when it woke, in epoch ms. */
export interface Sleep {
  readonly from: number
  readonly to: number
}

export interface WakeValue {
  /** How long, in ms, the machine slept from the instant `from` to now, a sleep just ended counted. */
  readonly sleptSince: (from: number) => Effect.Effect<number>
  /** Each sleep as it is noticed, those noticed before the stream was read first. */
  readonly sleeps: Stream.Stream<Sleep>
}

/** How long the machine slept between the instants `from` and `to`, in ms, of `sleeps`. */
export const sleptBetween = (sleeps: ReadonlyArray<Sleep>, from: number, to: number): number =>
  sleeps.reduce(
    (sum, sleep) => sum + Math.max(0, Math.min(to, sleep.to) - Math.max(from, sleep.from)),
    0,
  )

/**
 * The Wake of the sleeps in `found`, `look` run before each question so that one just ended is in
 * it.
 */
export const wakeOf = (
  found: SubscriptionRef.SubscriptionRef<ReadonlyArray<Sleep>>,
  look: Effect.Effect<void>,
): WakeValue => ({
  sleptSince: (from) =>
    Effect.gen(function* () {
      yield* look
      const sleeps = yield* SubscriptionRef.get(found)
      return sleptBetween(sleeps, from, yield* Clock.currentTimeMillis)
    }),
  sleeps: SubscriptionRef.changes(found).pipe(
    Stream.mapAccum(
      () => 0,
      (seen, all: ReadonlyArray<Sleep>) => [all.length, all.slice(seen)] as const,
    ),
  ),
})

const noSleeps: WakeValue = { sleptSince: () => Effect.succeed(0), sleeps: Stream.empty }

/** The machine's sleeps as the run notices them; none unless a layer gives the live Wake. */
export const Wake = Context.Reference<WakeValue>("tutti/services/Wake", {
  defaultValue: () => noSleeps,
})

/** How often the live Wake reads the wall clock. */
export const beat: Duration.Duration = Duration.seconds(1)

/** How much longer than the beat a gap between two readings is before it is taken for a sleep. */
export const sleepGap: Duration.Duration = Duration.seconds(15)

/** The live Wake: its beat runs until `Scope` closes. */
export const makeWake: Effect.Effect<WakeValue, never, Scope.Scope> = Effect.gen(function* () {
  const clock = yield* Clock.Clock
  const found = yield* SubscriptionRef.make<ReadonlyArray<Sleep>>([])
  const beatMs = Duration.toMillis(beat)
  const gapMs = Duration.toMillis(sleepGap)
  let last = clock.currentTimeMillisUnsafe()
  // Read and moved on at once, so that two looking together don't both take the same gap.
  const look = Effect.suspend(() => {
    const now = clock.currentTimeMillisUnsafe()
    const from = last
    last = Math.max(last, now)
    return now - from > beatMs + gapMs
      ? SubscriptionRef.update(found, (all) => [...all, { from, to: now - beatMs }])
      : Effect.void
  })
  yield* Effect.forkScoped(Effect.forever(Effect.andThen(Effect.sleep(beat), look)))
  return wakeOf(found, look)
})

/** The live Wake, for the run's layers. */
export const wakeLayer: Layer.Layer<never> = Layer.effectContext(
  Effect.map(makeWake, (wake) => Context.make(Wake, wake)),
)

/** How long, in ms, the machine has been awake from the instant `from` to now. */
export const awakeSince = (from: number): Effect.Effect<number> =>
  Effect.gen(function* () {
    const slept = yield* (yield* Wake).sleptSince(from)
    return Math.max(0, (yield* Clock.currentTimeMillis) - from - slept)
  })

/**
 * Sleeps until the machine has been awake for `duration`: a sleep of the machine meanwhile is
 * added to it, as tutti's time limits count only the time awake.
 */
export const sleepAwake = (duration: Duration.Input): Effect.Effect<void> =>
  Effect.gen(function* () {
    const want = Duration.toMillis(Duration.fromInputUnsafe(duration))
    if (!Number.isFinite(want)) return yield* Effect.never
    const from = yield* Clock.currentTimeMillis
    for (;;) {
      const left = want - (yield* awakeSince(from))
      if (left <= 0) return
      yield* Effect.sleep(Duration.millis(left))
    }
  })

/**
 * Effect.timeoutOrElse, its time counted awake (sleepAwake): `orElse` once `self` has gone on for
 * `duration` with the machine awake, `self` interrupted.
 */
export const timeoutAwake =
  <A2, E2, R2>(options: {
    readonly duration: Duration.Input
    readonly orElse: () => Effect.Effect<A2, E2, R2>
  }) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A | A2, E | E2, R | R2> =>
    Effect.raceFirst(self, Effect.flatMap(sleepAwake(options.duration), options.orElse))
