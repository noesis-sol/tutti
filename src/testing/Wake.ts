// The Wake test layer (§ 3.3): the machine sleeps when a test says so. `asleep(span)` notes a sleep
// of `span` from now and moves the TestClock over it, so the timers due meanwhile fire as they would
// at the wake, the sleep already known: the live Wake's look finds it there too. `noted` notes one
// without moving the clock, for a test on the live clock: one ending later counts as it goes.
import { Clock, Context, Duration, Effect, Layer, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import { type Sleep, Wake, wakeOf } from "../services/Wake.ts"

/** Puts the machine to sleep, for a test. */
export class Asleep extends Context.Service<
  Asleep,
  {
    /** The machine sleeps `span` from now: the sleep noted, then the TestClock moved over it. */
    readonly asleep: (span: Duration.Input) => Effect.Effect<void>
    /** Notes `sleep`, the clock left as it is. */
    readonly noted: (sleep: Sleep) => Effect.Effect<void>
  }
>()("tutti/testing/Wake/Asleep") {}

/** A Wake whose sleeps a test reports, and Asleep, to report them. */
export const layer: Layer.Layer<Asleep> = Layer.effectContext(
  Effect.gen(function* () {
    const found = yield* SubscriptionRef.make<ReadonlyArray<Sleep>>([])
    const noted = (sleep: Sleep) => SubscriptionRef.update(found, (all) => [...all, sleep])
    const asleep = (span: Duration.Input) =>
      Effect.gen(function* () {
        const from = yield* Clock.currentTimeMillis
        yield* noted({ from, to: from + Duration.toMillis(Duration.fromInputUnsafe(span)) })
        yield* TestClock.adjust(span)
      })
    return Context.make(Wake, wakeOf(found, Effect.void)).pipe(
      Context.add(Asleep, Asleep.of({ asleep, noted })),
    )
  }),
)
