// A spec's breakdown at the account's usage limit (§ 4.14, § 4.12), under TestClock: it waits for
// the reset, its time limit paused, and is told to carry on in its session; one whose reset is later
// than --usage-limit-wait is given up on, the run stopping USAGE_LIMIT (exit 8).
import { describe, expect, test } from "bun:test"
import { Duration, Effect } from "effect"
import { TestClock } from "effect/testing"
import type { ToolAnswer } from "../src/agent/callbacks.ts"
import { resetLabel } from "../src/core/localTime.ts"
import { breakdownResetText, limitWait } from "../src/run/breakdown.ts"
import { exitCodes } from "../src/run/holds.ts"
import { countdown } from "../src/run/runView.ts"
import { SpecOutcome } from "../src/run/specRun.ts"
import { sessionState, wait } from "../src/testing/AgentHost.ts"
import { hour, limitedTurn, runs, untilLogged } from "./specLimitScenario.ts"
import { breakdownInit, rootInput, ticket, turn } from "./specScenario.ts"

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
    expect(limitWait(now + 60_000, now, now, wait)).toEqual({ at: now + 120_000 })
  })

  test("a reset passed or unknown: fifteen minutes from now", () => {
    expect(limitWait(now, now, now, wait)).toEqual({ at: now + 15 * 60_000 })
    expect(limitWait(now - 1, now, now, wait)).toEqual({ at: now + 15 * 60_000 })
    expect(limitWait(null, now, now, wait)).toEqual({ at: now + 15 * 60_000 })
  })

  test("a reset later than the wait: given up on", () => {
    const late = limitWait(now + Duration.toMillis(wait) + 1, now, now, wait)
    expect("giveUp" in late && late.giveUp).toContain("later than --usage-limit-wait (6h)")
    expect(limitWait(now + Duration.toMillis(wait), now, now, wait)).toEqual({
      at: now + Duration.toMillis(wait) + 60_000,
    })
  })

  test("a reset unknown or passed: given up on once its next try is past the wait since it began", () => {
    const retry = 15 * 60_000
    // Its next try is the wait after the wait began: tried again.
    const since = now + retry - Duration.toMillis(wait)
    expect(limitWait(null, now, since, wait)).toEqual({ at: now + retry })
    expect(limitWait(now - 1, now, since, wait)).toEqual({ at: now + retry })
    // A millisecond later: given up on.
    expect(limitWait(null, now, since - 1, wait)).toEqual({
      giveUp: `it stopped at the account's usage limit, and when it resets is unknown; it has waited since ${resetLabel(since - 1, now)}, and its next try, at ${resetLabel(now + retry, now)}, is later than --usage-limit-wait (6h) allows`,
    })
    expect(limitWait(now - 1, now, since - 1, wait)).toEqual({
      giveUp: `it stopped at the account's usage limit, which was to reset at ${resetLabel(now - 1, now)}; it has waited since ${resetLabel(since - 1, now)}, and its next try, at ${resetLabel(now + retry, now)}, is later than --usage-limit-wait (6h) allows`,
    })
    // A reset to come within the wait is waited for, however long the wait has gone on.
    expect(limitWait(now + 60_000, now, 0, wait)).toEqual({ at: now + 120_000 })
  })
})
