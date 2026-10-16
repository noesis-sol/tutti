// EventStream's test layer (§ 3.3): captured records. Each record goes through its line in
// events.jsonl and back, as a script would read it, so one that doesn't fit its schema fails the
// test that emitted it. Time comes from Effect's Clock, so TestClock moves it.
import { Clock, Context, Effect, Layer, Ref, Result } from "effect"
import { decodeLine, type EventRecord, encodeLine } from "../run/events.ts"
import { EventStream, stamp } from "../run/eventstream.ts"

/** The records the test layer captured, for a test to look at. */
export class Captured extends Context.Service<
  Captured,
  {
    /** Every record emitted so far, in order. */
    readonly records: Effect.Effect<ReadonlyArray<EventRecord>>
  }
>()("tutti/testing/EventStream/Captured") {}

/** The run every captured record gives, unless the layer is told another. */
export const testRun = "2026-10-02T09:12:03.98+02:00"

/** An EventStream that captures its records, and Captured, to read them. */
export const layer = (run: string = testRun): Layer.Layer<EventStream | Captured> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const records = yield* Ref.make<ReadonlyArray<EventRecord>>([])
      const stream = EventStream.of({
        emit: (event) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) => {
            const line = encodeLine(stamp(event, run, now))
            const record = Result.flatMap(line, (text) => decodeLine(text))
            return Result.isSuccess(record)
              ? Ref.update(records, (all) => [...all, record.success])
              : Effect.die(record.failure)
          }),
      })
      return Context.make(EventStream, stream).pipe(
        Context.add(Captured, Captured.of({ records: Ref.get(records) })),
      )
    }),
  )
