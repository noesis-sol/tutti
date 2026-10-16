// The Log test layer: lines captured in memory, dated with Effect's Clock (so TestClock sets their
// time) and printed to stdout as the live layer does when the sink says so. `texts` gives them
// without their time, for a test to compare.
import { Effect, Layer, Ref, Semaphore } from "effect"
import { dated, Log, type Sink, toSink } from "../run/log.ts"

/** A captured log, its lines also printed when `sink` is stdout. */
export const layer = (options: { readonly sink?: Sink } = {}): Layer.Layer<Log> =>
  Layer.effect(
    Log,
    Effect.gen(function* () {
      const written = yield* Ref.make<ReadonlyArray<string>>([])
      const one = yield* Semaphore.make(1)
      return Log.of({
        write: (...lines) =>
          Effect.gen(function* () {
            const text = yield* dated(lines)
            yield* Ref.update(written, (all) => [...all, ...text])
            yield* toSink(options.sink ?? "none", text)
          }).pipe(one.withPermit),
        lines: Ref.get(written),
      })
    }),
  )

/** The time a line starts with, and the space after it. */
const time = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d /

/** The captured lines without their time. */
export const texts: Effect.Effect<ReadonlyArray<string>, never, Log> = Effect.gen(function* () {
  const lines = yield* (yield* Log).lines
  return lines.map((each) => each.replace(time, ""))
})
