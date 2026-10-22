// init's summary says what the scout cost (§ 8.3): its calls' total in OrganCost, as a scout step
// first, a caution where a call's result wasn't a success, on every ending, a cancelled form's too.
import { describe, expect, test } from "bun:test"
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Layer } from "effect"
import { cancelledEnding, failedEnding, stoppedEnding, withScout } from "../src/cli/commands.ts"
import { scoutCostSteps } from "../src/init/checks.ts"
import { cancelledLine, summaryLines } from "../src/init/init.ts"
import { InitFailed, InitStopped, step } from "../src/init/steps.ts"
import { costOf } from "../src/organs/AgentSdkLanguageModel.ts"
import { noCost, OrganCost, type Total } from "../src/organs/OrganCost.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

/** A result of the scout's session, as the Agent SDK ends it: `subtype` and its cost. */
const result = (subtype: string, costUsd: number): SDKResultMessage =>
  ({
    type: "result",
    subtype,
    session_id: "s-1",
    total_cost_usd: costUsd,
    num_turns: 3,
    duration_ms: 41_000,
  }) as unknown as SDKResultMessage

/** The scout's steps once OrganCost has recorded `results`, as the provider records them. */
const stepsAfter = (...results: ReadonlyArray<SDKResultMessage>) =>
  Effect.runSync(
    Effect.gen(function* () {
      const costs = yield* OrganCost
      for (const each of results) yield* costs.record(costOf("scout", each))
      return scoutCostSteps(yield* costs.total)
    }).pipe(Effect.provide(Layer.provide(OrganCost.layer, logLayer()))),
  )

const total = (fields: Partial<Total>): Total => ({ ...noCost, ...fields })

const plain = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })

describe("the scout's step", () => {
  test("a successful call says what it cost", () => {
    expect(stepsAfter(result("success", 0.4321))).toEqual([step("done", "scout", "cost $0.4321")])
  })

  test("a call whose result wasn't a success is a caution, its cost still said", () => {
    expect(stepsAfter(result("error_max_turns", 1.25))).toEqual([
      step("caution", "scout", "cost $1.2500"),
    ])
  })

  test("calls of unknown cost are said", () => {
    expect(scoutCostSteps(total({ calls: 1, unknown: 1, durationMs: 300_000 }))).toEqual([
      step("done", "scout", "cost unknown"),
    ])
    expect(scoutCostSteps(total({ calls: 3, costUsd: 0.5, unknown: 2 }))).toEqual([
      step("done", "scout", "cost $0.5000, and 2 calls of unknown cost"),
    ])
  })

  test("a scout that made no call has no step", () => {
    expect(scoutCostSteps(noCost)).toEqual([])
    expect(stepsAfter()).toEqual([])
  })
})

describe("init's endings", () => {
  const scout = [step("done", "scout", "cost $0.4321")]
  const scoutLine = "✓ scout  cost $0.4321"

  test("the summary starts with the scout's step", () => {
    const summary = withScout(
      { steps: [step("done", "settings", "wrote .tutti/settings.json")], next: [], ready: true },
      scout,
    )
    expect(summaryLines(summary).slice(0, 2)).toEqual([
      scoutLine,
      "✓ settings  wrote .tutti/settings.json",
    ])
    expect(summary.ready).toBe(true)
    const none = { steps: [], next: [], ready: true }
    expect(withScout(none, [])).toBe(none)
  })

  test("a cancelled form says what the scout cost, then that nothing was changed", () => {
    const ending = cancelledEnding(scout, null, 80)
    expect(ending.stdout).toEqual([scoutLine])
    expect(ending.stderr).toBe(cancelledLine)
    expect(ending.code).toBe(2)
    const themed = cancelledEnding(scout, plain, 80)
    expect(themed.stdout.join("\n")).toContain("scout")
    expect(themed.stdout.join("\n")).toContain("cost $0.4321")
    expect(themed.stderr).toContain(cancelledLine)
    // Cancelled before the scout ran: only the cancel.
    expect(cancelledEnding([], null, 80).stdout).toEqual([])
  })

  test("a stopped or failed init says what the scout cost before the steps it took", () => {
    const took = [step("done", "Beads", "set up")]
    const stopped = new InitStopped({ steps: took, step: "the setup", words: " before writing" })
    expect(stoppedEnding(stopped, null, 80, scout).stdout).toEqual([scoutLine, "✓ Beads  set up"])
    const failed = new InitFailed({ steps: took, step: "the setup", reason: "no disk" })
    expect(failedEnding(failed, null, 80, scout).stdout).toEqual([scoutLine, "✓ Beads  set up"])
  })
})
