// A happening said once: its log line and its record in events.jsonl, written in one call. The
// record's text is the line, so the log and the event stream can't say it differently, and Log's
// writeWith keeps another fiber's line from coming between them.
import { Effect } from "effect"
import type { Event } from "./events.ts"
import { EventStream } from "./eventstream.ts"
import { type Line, Log } from "./log.ts"

/** A record whose text is its log line, as the run writes it. */
export type Said = Extract<Event, { readonly text: string }> & { readonly text: Line }

/** Says happenings to a Log and an EventStream held already, as a service's methods need. */
export interface Sayer {
  /** Logs `record`'s text and writes `record` beside it, in the same write. */
  say(record: Said): Effect.Effect<void>
  /** Logs `text` and writes its `warn` record, about `ticket` where it is given. */
  warn(text: Line, ticket?: string): Effect.Effect<void>
  /** Logs `text` and writes its `info` record, about `ticket` where it is given. */
  info(text: Line, ticket?: string): Effect.Effect<void>
}

/** The Sayer over the run's Log and EventStream. */
export const sayer: Effect.Effect<Sayer, never, Log | EventStream> = Effect.gen(function* () {
  const logs = yield* Log
  const events = yield* EventStream
  const say = (record: Said) => logs.writeWith([record.text], events.emit(record))
  const sayer: Sayer = {
    say,
    warn: (text, ticket) =>
      say(ticket === undefined ? { kind: "warn", text } : { kind: "warn", ticket, text }),
    info: (text, ticket) =>
      say(ticket === undefined ? { kind: "info", text } : { kind: "info", ticket, text }),
  }
  return sayer
})

/** Logs `record`'s text and writes `record` beside it, in the same write. */
export const say = (record: Said): Effect.Effect<void, never, Log | EventStream> =>
  Effect.flatMap(sayer, (s) => s.say(record))

/** Logs `text` and writes its `warn` record, about `ticket` where it is given. */
export const warn = (text: Line, ticket?: string): Effect.Effect<void, never, Log | EventStream> =>
  Effect.flatMap(sayer, (s) => s.warn(text, ticket))

/** Logs `text` and writes its `info` record, about `ticket` where it is given. */
export const info = (text: Line, ticket?: string): Effect.Effect<void, never, Log | EventStream> =>
  Effect.flatMap(sayer, (s) => s.info(text, ticket))
