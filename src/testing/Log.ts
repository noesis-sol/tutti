// The Log test layer: lines captured in memory, dated with Effect's Clock (so TestClock sets their
// time) and printed to stdout as the live layer does when the sink says so. `texts` gives them
// without their time, for a test to compare.
import { Effect, Layer, Semaphore } from "effect"
import { dated, keptLines, type Line, Log, type Sink, toSink, undated } from "../run/log.ts"

/** A captured log, its lines also printed when `sink` is stdout. */
export const layer = (options: { readonly sink?: Sink } = {}): Layer.Layer<Log> =>
  Layer.effect(
    Log,
    Effect.gen(function* () {
      const kept = keptLines()
      const one = yield* Semaphore.make(1)
      const append = (lines: ReadonlyArray<Line>) =>
        Effect.gen(function* () {
          const text = yield* dated(lines)
          yield* kept.add(lines, text)
          yield* toSink(options.sink ?? "none", text)
        })
      return Log.of({
        write: (...lines) => one.withPermit(append(lines)),
        writeWith: (lines, record) => one.withPermit(Effect.andThen(append(lines), record)),
        lines: kept.lines,
        startBlockEnd: kept.startBlockEnd,
      })
    }),
  )

/** The captured lines without their time. */
export const texts: Effect.Effect<ReadonlyArray<string>, never, Log> = Effect.gen(function* () {
  const lines = yield* (yield* Log).lines
  return lines.map(undated)
})
