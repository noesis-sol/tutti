import { describe, expect, test } from "bun:test"
import { Console, Deferred, Effect, Fiber, FileSystem, Layer } from "effect"
import { type Line, Log } from "../src/run/log.ts"

/** A console that keeps what is logged to it, as stdout would show it. */
const capturingConsole = () => {
  const printed: Array<string> = []
  const console: Console.Console = Object.assign(Object.create(globalThis.console), {
    log: (...args: ReadonlyArray<unknown>) => printed.push(args.join(" ")),
  })
  return { printed, console }
}

/**
 * A file system whose log file keeps each write, then holds it until `release` is done, saying when
 * one has started: the time a quit can land in once a line is in the file, before the log goes on.
 */
const holdingFileSystem = Effect.gen(function* () {
  const started = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const written: Array<string> = []
  const decoder = new TextDecoder()
  const file = {
    writeAll: (buffer: Uint8Array) =>
      Effect.gen(function* () {
        written.push(decoder.decode(buffer))
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
      }),
  } as unknown as FileSystem.File
  const layer = FileSystem.layerNoop({ open: () => Effect.succeed(file) })
  return { started, release, written, layer }
})

/** The lines without their time. */
const undated = (lines: ReadonlyArray<string>) => lines.map((l) => l.replace(/^\S+ \S+ \S+ /, ""))

const run = <A>(
  body: (fs: Effect.Success<typeof holdingFileSystem>) => Effect.Effect<A, never, Log>,
  console: Console.Console,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* holdingFileSystem
      const log = Log.layer({ file: "tutti.log", sink: "stdout" }).pipe(Layer.provide(fs.layer))
      return yield* Effect.provide(body(fs), log)
    }).pipe(Effect.provideService(Console.Console, console)),
  )

describe("a log line interrupted on quit", () => {
  test("once its file write has begun, is in the file, the kept lines and stdout", async () => {
    const { printed, console } = capturingConsole()
    const { written, kept } = await run(
      (fs) =>
        Effect.gen(function* () {
          const log = yield* Log
          const writing = yield* Effect.forkChild(log.write("STOP" as Line))
          yield* Deferred.await(fs.started)
          const interrupting = yield* Effect.forkChild(Fiber.interrupt(writing))
          yield* Effect.yieldNow
          yield* Deferred.succeed(fs.release, undefined)
          yield* Fiber.join(interrupting)
          return { written: fs.written, kept: yield* log.lines }
        }),
      console,
    )
    expect(written.join("")).toMatch(/ STOP\n$/)
    expect(undated(kept)).toEqual(["STOP"])
    expect(undated(printed)).toEqual(["STOP"])
  })

  test("while waiting for another fiber's line, is nowhere, and the other line is whole", async () => {
    const { printed, console } = capturingConsole()
    const { written, kept } = await run(
      (fs) =>
        Effect.gen(function* () {
          const log = yield* Log
          const first = yield* Effect.forkChild(log.write("FIRST" as Line))
          yield* Deferred.await(fs.started)
          const second = yield* Effect.forkChild(log.write("SECOND" as Line))
          yield* Effect.yieldNow
          const interrupting = yield* Effect.forkChild(Fiber.interruptAll([first, second]))
          yield* Effect.yieldNow
          yield* Deferred.succeed(fs.release, undefined)
          yield* Fiber.join(interrupting)
          return { written: fs.written, kept: yield* log.lines }
        }),
      console,
    )
    expect(written).toHaveLength(1)
    expect(written[0]).toMatch(/ FIRST\n$/)
    expect(undated(kept)).toEqual(["FIRST"])
    expect(undated(printed)).toEqual(["FIRST"])
  })
})
