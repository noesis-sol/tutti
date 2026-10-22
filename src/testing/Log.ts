// The Log test layer: lines captured in memory, dated with Effect's Clock (so TestClock sets their
// time) and printed to stdout as the live layer does when the sink says so. `texts` gives them
// without their time, for a test to compare.
import { Effect, Layer, Semaphore } from "effect"
import { filed, keep, keptLines, Log, type Sink, toSink, type Written } from "../run/log.ts"

/** A captured log, its lines also printed when `sink` is stdout. */
export const layer = (options: { readonly sink?: Sink } = {}): Layer.Layer<Log> =>
  Layer.effect(
    Log,
    Effect.gen(function* () {
      const kept = keptLines()
      const one = yield* Semaphore.make(1)
      const append = (lines: ReadonlyArray<Written>) =>
        Effect.gen(function* () {
          const these = yield* keep(lines)
          yield* kept.add(these)
          yield* toSink(options.sink ?? "none", these.map(filed))
        })
      return Log.of({
        write: (...lines) => one.withPermit(Effect.uninterruptible(append(lines))),
        writeWith: (lines, record) =>
          one.withPermit(Effect.uninterruptible(Effect.andThen(append(lines), record))),
        lines: kept.lines,
        startBlockEnd: kept.startBlockEnd,
      })
    }),
  )

/** The captured lines without their time. */
export const texts: Effect.Effect<ReadonlyArray<string>, never, Log> = Effect.gen(function* () {
  const lines = yield* (yield* Log).lines
  return lines.map((each) => each.text)
})
