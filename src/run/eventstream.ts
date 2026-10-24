// The EventStream service (§ 3.3, § 10): the run's records for scripts and agents, as the log is
// for people. Each is appended to .tutti/run/events.jsonl in the main checkout as one line in a
// single write, so a reader tailing the file never sees half of one, and the file keeps every run.
// The file is opened below the checkout with openat and O_NOFOLLOW, so a symbolic link in its path
// is refused rather than written through. A stream that can't be opened or written is warned about
// once; the run goes on, and later records are still tried. A write cut short (on ENOSPC, say)
// leaves part of a record without its newline: the newline is written at once, or, where that
// fails too, ahead of the next record, so only the cut record is lost, not the one after it. A file
// an earlier run left so cut, its last byte not a newline, is ended the same way, ahead of the
// first record of this run.
import { fstatSync, readSync, writeSync } from "node:fs"
import { Clock, Context, Effect, Layer, Result } from "effect"
import { close, makeFoldersUnder, O, openUnder } from "../native/libc.ts"
import { runFolder } from "../services/Worktrees.ts"
import { type Event, type EventRecord, encodeLine, version } from "./events.ts"
import { addRecord, type Figures, noFigures } from "./figures.ts"
import { timestamp } from "./localTime.ts"

/** The event stream's file, relative to the main checkout's top level (§ 9.1). */
export const eventsFile = ".tutti/run/events.jsonl"

/** `event` as a record of the run that started at `run`, written at `now` (epoch milliseconds). */
export const stamp = (event: Event, run: string, now: number): EventRecord =>
  ({ v: version, time: timestamp(new Date(now)), run, ...event }) as EventRecord

/** The warning for a stream that can't be opened or written, as orchestra words it. */
export const notRecorded = (reason: string): string =>
  `events not recorded in ${eventsFile}: ${reason}; the run goes on, and later failures aren't logged`

const newline = 0x0a

// Whether the file at `fd` ends in part of a record: it has bytes and the last isn't a newline. A
// file that can't be read is taken as ended, which at worst runs the next record onto its line.
const endsTorn = (fd: number): boolean => {
  try {
    const size = fstatSync(fd).size
    if (size === 0) return false
    const last = Buffer.alloc(1)
    return readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== newline
  } catch {
    return false
  }
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === "string" ? error : String(error)

export class EventStream extends Context.Service<
  EventStream,
  {
    /** Appends a record of `event`, with the version, the time and the run. It never fails. */
    emit(event: Event): Effect.Effect<void>
    /** What the run's records add up to so far (figures.ts), those not written included. */
    readonly figures: Effect.Effect<Figures>
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
    /** Writes to the stream's file, as `writeSync`; a test cuts a write short with it. */
    readonly writeSync?: (fd: number, bytes: Uint8Array) => number
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

        // Nothing is made through a link in .tutti/run's path, which openUnder refuses too. The file
        // is opened to read as well, for its last byte; O_APPEND still puts every write at its end.
        const fd = yield* Effect.acquireRelease(
          Effect.suspend(() => {
            const why = makeFoldersUnder(options.repo, runFolder)
            return why === undefined ? Effect.void : Effect.fail(why)
          }).pipe(
            Effect.andThen(
              openUnder(options.repo, eventsFile, O.RDWR | O.APPEND | O.CREAT, 0o644).pipe(
                Effect.mapError((error) => error.message),
              ),
            ),
            Effect.catch((reason) => Effect.as(failed(reason), undefined)),
          ),
          (fd) => (fd === undefined ? Effect.void : Effect.ignore(close(fd))),
        )

        const writeTo = options.writeSync ?? writeSync
        // Whether the file ends in part of a record, cut short, that the next write ends first: by
        // this run, or by an earlier one killed mid-write.
        let torn = fd !== undefined && endsTorn(fd)
        // Writes `bytes` in one write, and returns how many were written; a throw writes none.
        const writeOnce = (bytes: Uint8Array): number => {
          const written = writeTo(fd as number, bytes)
          if (written > 0) torn = bytes[written - 1] !== newline
          return written
        }

        const write = (line: string) =>
          Effect.suspend(() => {
            if (fd === undefined) return Effect.void
            const record = Buffer.from(line)
            const bytes = torn ? Buffer.concat([Buffer.of(newline), record]) : record
            let written: number
            try {
              written = writeOnce(bytes)
            } catch (error) {
              return failed(reasonOf(error))
            }
            if (written === bytes.length) return Effect.void
            try {
              if (torn) writeOnce(Buffer.of(newline))
            } catch {
              // The next write ends the cut record first.
            }
            return failed(`wrote ${written} of a record's ${bytes.length} bytes`)
          })

        let figures = noFigures
        return EventStream.of({
          emit: (event) =>
            Effect.flatMap(Clock.currentTimeMillis, (now) => {
              const line = encodeLine(stamp(event, options.run, now))
              if (Result.isFailure(line)) {
                return failed(
                  `a ${event.kind} record doesn't fit its schema: ${line.failure.message}`,
                )
              }
              figures = addRecord(figures, event, now)
              return write(`${line.success}\n`)
            }),
          figures: Effect.sync(() => figures),
        })
      }),
    )
}
