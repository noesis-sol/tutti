import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, type Layer } from "effect"
import { type Line, Log, type LogFile } from "../src/run/log.ts"
import * as TestLog from "../src/testing/Log.ts"

/** A log file that keeps each write. */
const keepingFile = () => {
  const written: Array<string> = []
  const decoder = new TextDecoder()
  const file = {
    writeAll: (buffer: Uint8Array) => Effect.sync(() => written.push(decoder.decode(buffer))),
  } satisfies LogFile
  return { written, file }
}

/**
 * A record that says when it has begun, then holds until `release` is done before it is kept: the
 * time a quit can land in once the line is written, before its record is.
 */
const holdingRecord = Effect.gen(function* () {
  const started = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const recorded: Array<string> = []
  const record = (text: string) =>
    Effect.gen(function* () {
      yield* Deferred.succeed(started, undefined)
      yield* Deferred.await(release)
      recorded.push(text)
    })
  return { started, release, recorded, record }
})

const layers: ReadonlyArray<
  readonly [string, () => { log: Layer.Layer<Log, unknown>; file: Array<string> | undefined }]
> = [
  [
    "the live log",
    () => {
      const fs = keepingFile()
      return {
        log: Log.layerOn({ file: fs.file }),
        file: fs.written,
      }
    },
  ],
  ["the test log", () => ({ log: TestLog.layer(), file: undefined })],
]

describe.each(layers)("writeWith on %s, interrupted on quit", (_, make) => {
  test("between its line and its record, keeps both", async () => {
    const { log, file } = make()
    const { kept, recorded } = await Effect.runPromise(
      Effect.gen(function* () {
        const r = yield* holdingRecord
        const logs = yield* Log
        const writing = yield* Effect.forkChild(logs.writeWith(["STOP" as Line], r.record("stop")))
        yield* Deferred.await(r.started)
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(writing))
        yield* Effect.yieldNow
        yield* Deferred.succeed(r.release, undefined)
        yield* Fiber.join(interrupting)
        return { kept: yield* logs.lines, recorded: r.recorded }
      }).pipe(Effect.provide(log)),
    )
    expect<unknown>(kept.map((each) => each.text)).toEqual(["STOP"])
    expect(recorded).toEqual(["stop"])
    if (file !== undefined) expect(file.join("")).toMatch(/ STOP\n$/)
  })

  test("while waiting for another fiber's line, writes neither, and the other is whole", async () => {
    const { log } = make()
    const { kept, recorded } = await Effect.runPromise(
      Effect.gen(function* () {
        const r = yield* holdingRecord
        const logs = yield* Log
        const first = yield* Effect.forkChild(logs.writeWith(["FIRST" as Line], r.record("first")))
        yield* Deferred.await(r.started)
        const second = yield* Effect.forkChild(
          logs.writeWith(["SECOND" as Line], r.record("second")),
        )
        yield* Effect.yieldNow
        const interrupting = yield* Effect.forkChild(Fiber.interruptAll([first, second]))
        yield* Effect.yieldNow
        yield* Deferred.succeed(r.release, undefined)
        yield* Fiber.join(interrupting)
        return { kept: yield* logs.lines, recorded: r.recorded }
      }).pipe(Effect.provide(log)),
    )
    expect<unknown>(kept.map((each) => each.text)).toEqual(["FIRST"])
    expect(recorded).toEqual(["first"])
  })
})
