// SIGTSTP ignored (§ 7.4, D18): tutti can't be suspended, and each SIGTSTP is logged with its line,
// as main's runFrom has it, until the run's scope closes.
import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { catchSignals, logSuspends, suspendIgnoredLine } from "../src/run/quit.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"

describe("SIGTSTP", () => {
  test("is ignored and logged with its line, once for each, until the scope closes", async () => {
    const logged = await Effect.runPromise(
      Effect.gen(function* () {
        const seen = yield* Effect.scoped(
          Effect.gen(function* () {
            const suspends = yield* Queue.unbounded<void>()
            yield* catchSignals({
              drain: () => {},
              suspend: () => Queue.offerUnsafe(suspends, undefined),
            })
            yield* logSuspends(suspends)
            // A SIGTSTP sent with kill is dropped in an orphaned process group, as the tests' is
            // (docs/spikes/06-bun-ffi.md, § 3): the signal is handed to tutti's handler instead.
            process.emit("SIGTSTP", "SIGTSTP")
            process.emit("SIGTSTP", "SIGTSTP")
            // The lines are written by logSuspends' fiber: wait for both, as a fixed sleep runs out
            // on a loaded machine before that fiber has had its turn.
            for (let i = 0; i < 5000 && (yield* texts).length < 2; i++) {
              yield* Effect.promise(() => Bun.sleep(1))
            }
            // One listener: each SIGTSTP is handled, and so logged, once.
            expect(process.listenerCount("SIGTSTP")).toBe(1)
            return yield* texts
          }),
        )
        expect(process.listenerCount("SIGTSTP")).toBe(0)
        return seen
      }).pipe(Effect.provide(logLayer())),
    )
    expect<unknown>(suspendIgnoredLine).toBe(
      "  SIGTSTP ignored: tutti can't be suspended; SIGUSR1 stops it after the current tickets, Ctrl+C quits",
    )
    expect(logged).toEqual([suspendIgnoredLine, suspendIgnoredLine])
  })
})
