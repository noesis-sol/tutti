// What the run says of the machine's sleep (§ 5 item 15, § 10): as it notices one (Wake.ts), the
// log's SLEPT line and a `slept` record, the time not counted against the run's limits; and the
// first time, in a run started without --keep-awake, how to keep the machine awake (§ 8.2).
import { Duration, Effect, Stream } from "effect"
import { formatDuration } from "../project/configFile.ts"
import { type Sleep, Wake } from "../services/Wake.ts"
import { tenths } from "./events.ts"
import { EventStream } from "./eventstream.ts"
import { clock, clockFrom, timestamp } from "./localTime.ts"
import { detail, type Line, Log, Tag, tagged } from "./log.ts"

/** How long `ms` is, as the SLEPT line says it: to the second under a minute, else the minute. */
export const sleptFor = (ms: number): string =>
  ms < 60_000
    ? formatDuration(Duration.seconds(Math.max(1, Math.round(ms / 1000))))
    : formatDuration(Duration.minutes(Math.round(ms / 60_000)))

/** `SLEPT: the machine slept 33m (14:03-14:37); checks and limits don't count it`. */
export const sleptLine = (sleep: Sleep): Line =>
  tagged(
    Tag.slept,
  )`the machine slept ${sleptFor(sleep.to - sleep.from)} (${clock(sleep.from)}-${clockFrom(sleep.to, sleep.from)}); checks and limits don't count it`

/** Said under the first SLEPT line of a run started without --keep-awake. */
export const keepAwakeHint: Line = detail`run with --keep-awake to keep the machine awake`

/**
 * Says each sleep the run notices, forever: its SLEPT line and record, and under the first, unless
 * the run keeps the machine awake (`keepAwake`, --keep-awake), how it would.
 */
export const watchSleeps = (options: {
  readonly keepAwake: boolean
}): Effect.Effect<void, never, Log | EventStream> =>
  Effect.gen(function* () {
    const logs = yield* Log
    const events = yield* EventStream
    const wake = yield* Wake
    let hinted = options.keepAwake
    yield* Stream.runForEach(wake.sleeps, (sleep) => {
      const text = sleptLine(sleep)
      const lines = hinted ? [text] : [text, keepAwakeHint]
      hinted = true
      return logs.writeWith(
        lines,
        events.emit({
          kind: "slept",
          from: timestamp(new Date(sleep.from)),
          to: timestamp(new Date(sleep.to)),
          seconds: tenths(sleep.to - sleep.from),
          text,
        }),
      )
    })
  })
