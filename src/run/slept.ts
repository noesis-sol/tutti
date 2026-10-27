// What the run says of the machine's sleep (§ 5 item 15, § 10): as it notices one (Wake.ts), the
// log's SLEPT line and a `slept` record, the time not counted against the run's limits, with the
// sleep's cause where the system tells it (sleepCause.ts); the first time, in a run that doesn't
// keep the machine awake (keep_awake false), how it would (§ 8.2); and for a closed lid in a run
// that does, that keeping awake can't prevent it.
import { Duration, Effect, type FileSystem, Stream } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { formatDuration } from "../project/configFile.ts"
import { type Sleep, Wake } from "../services/Wake.ts"
import { tenths } from "./events.ts"
import { EventStream } from "./eventstream.ts"
import { clock, clockFrom, timestamp } from "./localTime.ts"
import { detail, type Line, Log, Tag, tagged } from "./log.ts"
import { type SleepCause, SleepCauses } from "./sleepCause.ts"

/** How long `ms` is, as the SLEPT line says it: to the second under a minute, else the minute. */
export const sleptFor = (ms: number): string =>
  ms < 60_000
    ? formatDuration(Duration.seconds(Math.max(1, Math.round(ms / 1000))))
    : formatDuration(Duration.minutes(Math.round(ms / 60_000)))

/**
 * `SLEPT: the machine slept 33m (14:03-14:37); checks and limits don't count it`, its `cause`
 * after the times where it is known: `(09:41-09:45, lid closed)`.
 */
export const sleptLine = (sleep: Sleep, cause: SleepCause | null = null): Line =>
  tagged(
    Tag.slept,
  )`the machine slept ${sleptFor(sleep.to - sleep.from)} (${clock(sleep.from)}-${clockFrom(sleep.to, sleep.from)}${cause === null ? "" : `, ${cause}`}); checks and limits don't count it`

/** Said under the first SLEPT line of a run that doesn't keep the machine awake. */
export const keepAwakeHint: Line = detail`keep_awake is false for this run, as the START block said: set it true to keep the machine awake`

/** Said under the SLEPT line of a closed lid's sleep in a run that keeps the machine awake. */
export const lidClosedHint: Line = detail`keeping the machine awake can't prevent a closed lid's sleep: keep the Mac on power with an external display, or run sudo pmset -a disablesleep 1 (and 0 after)`

/**
 * Says each sleep the run notices, forever: its SLEPT line and record, with its cause where
 * SleepCauses tells it; under the first, unless the run keeps the machine awake (`keepAwake`),
 * how it would, but under a closed lid's, which it wouldn't have prevented; and under a closed
 * lid's in a run kept awake, that it can't.
 */
export const watchSleeps = (options: {
  readonly keepAwake: boolean
}): Effect.Effect<
  void,
  never,
  Log | EventStream | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const logs = yield* Log
    const events = yield* EventStream
    const wake = yield* Wake
    const causes = yield* SleepCauses
    let hinted = options.keepAwake
    yield* Stream.runForEach(wake.sleeps, (sleep) =>
      Effect.gen(function* () {
        const cause = causes === null ? null : yield* causes.read(sleep.from)
        const text = sleptLine(sleep, cause)
        const lid = cause === "lid closed"
        const lines = [text]
        if (lid && options.keepAwake) lines.push(lidClosedHint)
        if (!hinted && !lid) {
          lines.push(keepAwakeHint)
          hinted = true
        }
        yield* logs.writeWith(
          lines,
          events.emit({
            kind: "slept",
            from: timestamp(new Date(sleep.from)),
            to: timestamp(new Date(sleep.to)),
            seconds: tenths(sleep.to - sleep.from),
            text,
          }),
        )
      }),
    )
  })
