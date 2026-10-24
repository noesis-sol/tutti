// The Log test layer: the live log over a file that keeps nothing. Its lines are captured in
// memory, dated with Effect's Clock (so TestClock sets their time) and printed to stdout when the
// sink says so, as live. `texts` gives them without their time, for a test to compare.
import { Effect, type Layer } from "effect"
import { Log, type Sink } from "../run/log.ts"

/** A captured log, its lines also printed when `sink` is stdout. */
export const layer = (options: { readonly sink?: Sink } = {}): Layer.Layer<Log> =>
  Log.layerOn({ file: { writeAll: () => Effect.void }, ...options })

/** The captured lines without their time. */
export const texts: Effect.Effect<ReadonlyArray<string>, never, Log> = Effect.gen(function* () {
  const lines = yield* (yield* Log).lines
  return lines.map((each) => each.text)
})
