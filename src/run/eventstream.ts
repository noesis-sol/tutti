// The EventStream service (§ 3.3, § 10): the run's records for scripts and agents, as the log is
// for people. Each is appended to .tutti/run/events.jsonl in the main checkout as one line in a
// single write, so a reader tailing the file never sees half of one, and the file keeps every run.
// The file is opened below the checkout with openat and O_NOFOLLOW, so a symbolic link in its path
// is refused rather than written through. A stream that can't be opened or written is warned about
// once; the run goes on, and later records are still tried.
import { mkdirSync, writeSync } from "node:fs"
import { join } from "node:path"
import { Clock, Context, Effect, Layer, Result } from "effect"
import { close, O, openUnder } from "../native/libc.ts"
import { type Event, type EventRecord, encodeLine, timestamp, version } from "./events.ts"

/** The event stream's file, relative to the main checkout's top level (§ 9.1). */
export const eventsFile = ".tutti/run/events.jsonl"

/** `event` as a record of the run that started at `run`, written at `now` (epoch milliseconds). */
export const stamp = (event: Event, run: string, now: number): EventRecord =>
  ({ v: version, time: timestamp(new Date(now)), run, ...event }) as EventRecord

/** The warning for a stream that can't be opened or written, as orchestra words it. */
export const notRecorded = (reason: string): string =>
  `events not recorded in ${eventsFile}: ${reason}; the run goes on, and later failures aren't logged`

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === "string" ? error : String(error)

export class EventStream extends Context.Service<
  EventStream,
  {
    /** Appends a record of `event`, with the version, the time and the run. It never fails. */
    emit(event: Event): Effect.Effect<void>
  }
>()("tutti/run/EventStream") {
  /**
   * The stream in the main checkout at `repo`, for the run that started at `run` (RFC 3339, as its
   * lock's `started`). `warn` is told the first failure; Effect's logger is by default.
   */
  static readonly layer = (options: {
    readonly repo: string
    readonly run: string
    readonly warn?: (message: string) => Effect.Effect<void>
  }) =>
    Layer.effect(
      EventStream,
      Effect.gen(function* () {
        const warn = options.warn ?? ((message: string) => Effect.logWarning(message))
        let warned = false
        const failed = (reason: string) =>
          Effect.suspend(() => {
            if (warned) return Effect.void
            warned = true
            return warn(notRecorded(reason))
          })

        const fd = yield* Effect.acquireRelease(
          Effect.try({
            try: () => mkdirSync(join(options.repo, ".tutti", "run"), { recursive: true }),
            catch: reasonOf,
          }).pipe(
            Effect.andThen(
              openUnder(options.repo, eventsFile, O.WRONLY | O.APPEND | O.CREAT, 0o644).pipe(
                Effect.mapError((error) => error.message),
              ),
            ),
            Effect.catch((reason) => Effect.as(failed(reason), undefined)),
          ),
          (fd) => (fd === undefined ? Effect.void : Effect.ignore(close(fd))),
        )

        const write = (line: string) =>
          Effect.suspend(() => {
            if (fd === undefined) return Effect.void
            const bytes = Buffer.from(line)
            try {
              const written = writeSync(fd, bytes)
              return written === bytes.length
                ? Effect.void
                : failed(`wrote ${written} of a record's ${bytes.length} bytes`)
            } catch (error) {
              return failed(reasonOf(error))
            }
          })

        return EventStream.of({
          emit: (event) =>
            Effect.flatMap(Clock.currentTimeMillis, (now) => {
              const line = encodeLine(stamp(event, options.run, now))
              return Result.isSuccess(line)
                ? write(`${line.success}\n`)
                : failed(`a ${event.kind} record doesn't fit its schema: ${line.failure.message}`)
            }),
        })
      }),
    )
}
