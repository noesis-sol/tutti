// The Battery test layer (§ 5 item 16): the battery reads what a test sets, through Charge: none to
// begin with, as on a machine without one; undefined is a reading that fails.
import { Context, Effect, Layer, Ref } from "effect"
import { Battery, type BatteryReading } from "../run/battery.ts"

/** Sets what the test battery reads, for a test. */
export class Charge extends Context.Service<
  Charge,
  {
    /** The battery reads `reading` from now: null for none, undefined for one that can't be read. */
    readonly set: (reading: BatteryReading | null | undefined) => Effect.Effect<void>
    /** How many times the run has read it. */
    readonly reads: Effect.Effect<number>
  }
>()("tutti/testing/Battery/Charge") {}

/** A Battery source that reads what Charge sets, and Charge, to set it. */
export const layer: Layer.Layer<Charge> = Layer.effectContext(
  Effect.gen(function* () {
    const now = yield* Ref.make<BatteryReading | null | undefined>(null)
    const reads = yield* Ref.make(0)
    const read = Effect.andThen(
      Ref.update(reads, (n) => n + 1),
      Ref.get(now),
    )
    return Context.make(Battery, { read }).pipe(
      Context.add(
        Charge,
        Charge.of({ set: (reading) => Ref.set(now, reading), reads: Ref.get(reads) }),
      ),
    )
  }),
)
