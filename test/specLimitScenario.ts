// A spec's breakdown at the account's usage limit, under TestClock: the scripted turns that end on
// the limit, and specRun run on a new spec with the clock moved on beside it.
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, type Duration, Effect, Fiber, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import type { Log } from "../src/core/log.ts"
import { makePrinter, type Out } from "../src/print/organLine.ts"
import { orchestra } from "../src/project/scheme.ts"
import { breakdownWorker } from "../src/run/breakdown.ts"
import { specRun } from "../src/run/specRun.ts"
import {
  apiErrorResult,
  apiRetry,
  assistantText,
  Recording,
  rateLimit,
  type Script,
  sessionState,
  wait,
} from "../src/testing/AgentHost.ts"
import { texts } from "../src/testing/Log.ts"
import { makeTheme } from "../src/ui/theme.ts"
import { breakdownInit, type Calls, specLayers, specOf } from "./specScenario.ts"

// TestClock starts at the epoch, so a limit resetting at 3600 (seconds, as the API says it) resets
// an hour into the breakdown.
export const hour = 3600

/** A turn under way ending on the usage limit resetting at `resetsAt` (seconds), or at no time given. */
export const refusedTurn = (resetsAt?: number) => [
  sessionState("running"),
  rateLimit("rejected", resetsAt, 1),
  apiRetry(1, 429),
  assistantText("API Error: usage limit reached", { error: "rate_limit" }),
  apiErrorResult("API Error: usage limit reached", 429),
  sessionState("idle"),
]

/** The breakdown's first turn, ending on the usage limit resetting at `resetsAt` (seconds). */
export const limitedTurn = (resetsAt?: number) => [wait, breakdownInit, ...refusedTurn(resetsAt)]

/** How many log lines match `pattern`. */
export const logged = (pattern: RegExp) =>
  Effect.map(texts, (lines) => lines.filter((text) => pattern.test(text)).length)

/** Waits, in real time, until `count` log lines (one, unless given) match `pattern`. */
export const untilLogged = (pattern: RegExp, count = 1) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* logged(pattern)) >= count) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}`)
  })

/**
 * Runs specRun on a new spec under TestClock, the scripted host playing `script`; `during` runs
 * beside it, to move the clock on.
 */
export const runs = (options: {
  readonly script: (recording: Calls) => Script
  readonly timeLimit: Duration.Duration
  readonly during: Effect.Effect<void, never, Log>
}) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-spec-limit-")))
  const spec = specOf()
  const errors: Array<string> = []
  const stdout: Out = { write: () => {}, columns: () => 100, tty: false }
  const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })
  const recording = Effect.runSync(Deferred.make<Recording["Service"]>())
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Deferred.succeed(recording, yield* Recording)
      const fiber = yield* Effect.forkChild(
        specRun(
          { spec, repo, refine: false, timeLimit: options.timeLimit, effort: "high" },
          {
            printer: makePrinter(stdout, theme),
            error: (text) => Effect.sync(() => void errors.push(text)),
            refine: Option.none(),
          },
        ),
      )
      yield* options.during
      const outcome = yield* Fiber.join(fiber)
      const messages = yield* (yield* Recording).messages(breakdownWorker)
      return {
        outcome,
        log: yield* texts,
        messages: messages.map((m) => String(m.message.content)),
        errors,
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        specLayers({
          repo,
          scripts: { [breakdownWorker]: options.script(recording) },
          files: { "README.md": "# shop\n", [spec.path]: spec.text },
        }).pipe(Layer.provideMerge(TestClock.layer())),
      ),
    ),
  )
}
