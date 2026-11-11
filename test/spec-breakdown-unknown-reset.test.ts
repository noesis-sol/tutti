// A spec's breakdown at the account's usage limit with no reset given (§ 4.14, § 4.12), under
// TestClock: as the run's hold does, it tries again every 15 minutes, its time limit paused, and is
// given up on, USAGE_LIMIT (exit 8), once its next try is later than --usage-limit-wait after its
// wait began. A stop well after its last carry-on begins a wait of its own.
import { describe, expect, test } from "bun:test"
import { Duration, Effect } from "effect"
import { TestClock } from "effect/testing"
import type { ToolAnswer } from "../src/agent/callbacks.ts"
import { resetLabel } from "../src/core/localTime.ts"
import { breakdownResetText } from "../src/run/breakdown.ts"
import { exitCodes } from "../src/run/holds.ts"
import { SpecOutcome } from "../src/run/specRun.ts"
import { sleep, wait } from "../src/testing/AgentHost.ts"
import { limitedTurn, refusedTurn, runs, untilLogged } from "./specLimitScenario.ts"
import { rootInput, ticket, turn } from "./specScenario.ts"

const minute = 60_000
const rest = {
  root: "test-1",
  issues: [ticket({ key: "list", waits_for: ["test-1.1"], files: ["src/list.ts"] })],
}
const carriesOn = /the breakdown carries on/

describe("a breakdown at the usage limit, its reset unknown", () => {
  test("tries again 15 minutes on, its time limit paused, then carries on and files", async () => {
    const answers: Array<ToolAnswer> = []
    const ran = await runs({
      timeLimit: Duration.minutes(10),
      script: (recording) => [
        [
          ...limitedTurn(),
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
        yield* untilLogged(/tutti tries again/)
        yield* TestClock.adjust(Duration.minutes(15))
        yield* untilLogged(carriesOn)
      }),
    })
    expect(ran.outcome).toEqual(SpecOutcome.Run({ root: "test-1" as never }))
    expect(answers.map((a) => a.isError)).toEqual([undefined, undefined])
    expect(ran.messages).toEqual([expect.any(String), breakdownResetText])
    expect(ran.log).toContain(
      `SPEC: the breakdown stopped at the account's usage limit, and when it resets is unknown; tutti tries again at ${resetLabel(15 * minute, 0)}, in 15m, its time limit paused`,
    )
    expect(ran.errors).toEqual([])
  })

  test("refused at every try, it is given up on once its next try is past --usage-limit-wait: exit 8", async () => {
    // Tried at 15m, 30m, … 6h, each refused at once: the stop at 6h would try again at 6h15m.
    const tries = 24
    const ran = await runs({
      timeLimit: Duration.minutes(30),
      script: () => [
        [...limitedTurn(), ...Array.from({ length: tries }, () => [wait, ...refusedTurn()]).flat()],
      ],
      during: Effect.gen(function* () {
        for (let i = 1; i <= tries; i++) {
          yield* untilLogged(/tutti tries again/, i)
          yield* TestClock.adjust(Duration.minutes(15))
          yield* untilLogged(carriesOn, i)
        }
      }),
    })
    expect(ran.outcome).toEqual(SpecOutcome.Stopped({ exitCode: exitCodes.usageLimit }))
    expect(ran.messages).toHaveLength(1 + tries)
    const now = 6 * 60 * minute
    expect(ran.errors[0]).toBe(
      `tutti couldn't break the spec down: it stopped at the account's usage limit, and when it resets is unknown; it has waited since ${resetLabel(0, now)}, and its next try, at ${resetLabel(now + 15 * minute, now)}, is later than --usage-limit-wait (6h) allows`,
    )
    expect(ran.errors.at(-1)).toBe("Run it again to carry on: tutti --spec docs/shop.md")
  })

  test("a stop well after its carry-on begins a wait of its own", async () => {
    const answers: Array<ToolAnswer> = []
    const ran = await runs({
      timeLimit: Duration.hours(8),
      script: (recording) => [
        [
          ...limitedTurn(),
          // Carried on at 15m, it works until 5h50m, then stops at the limit again: counted from
          // the first stop, its next try at 6h05m would be past the wait.
          wait,
          sleep(Duration.minutes(5 * 60 + 35)),
          ...refusedTurn(),
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
        yield* untilLogged(/tutti tries again/)
        yield* TestClock.adjust(Duration.minutes(15))
        yield* untilLogged(carriesOn)
        yield* TestClock.adjust(Duration.minutes(5 * 60 + 35))
        yield* untilLogged(/tutti tries again/, 2)
        yield* TestClock.adjust(Duration.minutes(15))
        yield* untilLogged(carriesOn, 2)
      }),
    })
    expect(ran.outcome).toEqual(SpecOutcome.Run({ root: "test-1" as never }))
    expect(ran.messages).toEqual([expect.any(String), breakdownResetText, breakdownResetText])
    expect(ran.errors).toEqual([])
  })
})
