// A spec's breakdown at the account's usage limit (§ 4.14, § 4.12), under TestClock: it waits for
// the reset, its time limit paused, and is told to carry on in its session; one whose reset is later
// than --usage-limit-wait is given up on, the run stopping USAGE_LIMIT (exit 8).
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Duration, Effect, Fiber, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { breakdownResetText, breakdownWorker, limitWait } from "../src/agent/breakdown.ts"
import type { ToolAnswer } from "../src/agent/callbacks.ts"
import { makePrinter, type Out } from "../src/print/organLine.ts"
import { exitCodes } from "../src/run/holds.ts"
import { resetLabel } from "../src/run/localTime.ts"
import type { Log } from "../src/run/log.ts"
import { countdown } from "../src/run/runView.ts"
import { SpecOutcome, specRun } from "../src/run/specRun.ts"
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
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  breakdownInit,
  type Calls,
  rootInput,
  specLayers,
  specOf,
  ticket,
  turn,
} from "./specScenario.ts"

// TestClock starts at the epoch, so a limit resetting at 3600 (seconds, as the API says it) resets
// an hour into the breakdown.
const hour = 3600

/** The breakdown's first turn, ending on the usage limit resetting at `resetsAt` (seconds). */
const limitedTurn = (resetsAt: number) => [
  wait,
  breakdownInit,
  sessionState("running"),
  rateLimit("rejected", resetsAt, 1),
  apiRetry(1, 429),
  assistantText("API Error: usage limit reached", { error: "rate_limit" }),
  apiErrorResult("API Error: usage limit reached", 429),
  sessionState("idle"),
]

/** Waits, in real time, until a log line matches `pattern`. */
const untilLogged = (pattern: RegExp) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2000; i++) {
      if ((yield* texts).some((text) => pattern.test(text))) return
      yield* Effect.promise(() => Bun.sleep(2))
    }
    throw new Error(`no log line matched ${pattern}`)
  })

/**
 * Runs specRun on a new spec under TestClock, the scripted host playing `script`; `during` runs
 * beside it, to move the clock on.
 */
const runs = (options: {
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

describe("a breakdown at the usage limit", () => {
  test("waits for the reset, its time limit paused, then carries on in its session and files", async () => {
    const answers: Array<ToolAnswer> = []
    const rest = {
      root: "test-1",
      issues: [ticket({ key: "list", waits_for: ["test-1.1"], files: ["src/list.ts"] })],
    }
    const ran = await runs({
      // Its time limit is half an hour; the reset is an hour away.
      timeLimit: Duration.minutes(30),
      script: (recording) => [
        [
          ...limitedTurn(hour),
          wait,
          ...turn(
            recording,
            [
              ["file_root", rootInput],
              ["file_breakdown", rest],
            ],
            answers,
          ),
        ],
      ],
      during: Effect.gen(function* () {
        yield* untilLogged(/waits for the reset/)
        // Past its time limit, still waiting.
        yield* TestClock.adjust(Duration.minutes(45))
        yield* TestClock.adjust(Duration.minutes(16))
        yield* untilLogged(/the breakdown carries on/)
      }),
    })
    expect(ran.outcome).toEqual(SpecOutcome.Run({ root: "test-1" as never }))
    expect(answers.map((a) => a.isError)).toEqual([undefined, undefined])
    expect(ran.messages).toHaveLength(2)
    expect(ran.messages[1]).toBe(breakdownResetText)
    expect(ran.log).toContain(
      `SPEC: the breakdown stopped at the account's usage limit; it waits for the reset at ${resetLabel(hour * 1000, 0)}, in 1h, its time limit paused`,
    )
    expect(ran.log).toContain("SPEC: the usage limit has reset; the breakdown carries on")
    expect(ran.errors).toEqual([])
  })

  test("its time limit still runs out once it carries on", async () => {
    const ran = await runs({
      timeLimit: Duration.minutes(30),
      script: () => [[...limitedTurn(hour), wait, breakdownInit, sessionState("running"), wait]],
      during: Effect.gen(function* () {
        yield* untilLogged(/waits for the reset/)
        yield* TestClock.adjust(Duration.minutes(61))
        yield* untilLogged(/the breakdown carries on/)
        yield* TestClock.adjust(Duration.minutes(31))
      }),
    })
    expect(ran.outcome).toEqual(SpecOutcome.Stopped({ exitCode: exitCodes.setup }))
    expect(ran.errors[0]).toBe(
      "tutti couldn't break the spec down: it ran past its time limit of 30m",
    )
  })

  test("one resetting later than --usage-limit-wait is given up on: USAGE_LIMIT, exit 8", async () => {
    const at = 10 * hour
    const ran = await runs({
      timeLimit: Duration.minutes(30),
      script: () => [limitedTurn(at)],
      during: Effect.void,
    })
    expect(ran.outcome).toEqual(SpecOutcome.Stopped({ exitCode: exitCodes.usageLimit }))
    expect(ran.errors[0]).toBe(
      `tutti couldn't break the spec down: it stopped at the account's usage limit, which resets at ${resetLabel(at * 1000, 0)}, in ${countdown(at * 1000, 0)}, later than --usage-limit-wait (6h)`,
    )
    expect(ran.errors.at(-1)).toBe("Run it again to carry on: tutti --spec docs/shop.md")
    expect(ran.messages).toHaveLength(1)
  })
})

describe("limitWait", () => {
  const wait = Duration.hours(6)
  const now = 1_000_000

  test("a reset to come: at it plus a minute", () => {
    expect(limitWait(now + 60_000, now, wait)).toEqual({ at: now + 120_000 })
  })

  test("a reset passed: fifteen minutes from now", () => {
    expect(limitWait(now, now, wait)).toEqual({ at: now + 15 * 60_000 })
    expect(limitWait(now - 1, now, wait)).toEqual({ at: now + 15 * 60_000 })
  })

  test("a reset unknown, or later than the wait: given up on", () => {
    expect(limitWait(null, now, wait)).toEqual({
      giveUp: "it stopped at the account's usage limit, and when it resets is unknown",
    })
    const late = limitWait(now + Duration.toMillis(wait) + 1, now, wait)
    expect("giveUp" in late && late.giveUp).toContain("later than --usage-limit-wait (6h)")
    expect(limitWait(now + Duration.toMillis(wait), now, wait)).toEqual({
      at: now + Duration.toMillis(wait) + 60_000,
    })
  })
})
