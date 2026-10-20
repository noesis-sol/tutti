// A call that ends without an SDK result (§ 6.1's Cost): timed out, or its session failed first.
// It is logged and counted as a call of unknown cost, and the report's total names it.
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { type Duration, Effect, type Exit, Layer } from "effect"
import { LanguageModel } from "effect/ai"
import { layer, OrganCall } from "../src/organs/AgentSdkLanguageModel.ts"
import { add, addUnknown, noCost, OrganCost, unknownCostLine } from "../src/organs/OrganCost.ts"
import type { Log } from "../src/run/log.ts"
import { compose, costTotal } from "../src/run/report.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { texts } from "../src/testing/Log.ts"
import { layer as costLayer } from "../src/testing/OrganCost.ts"

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

/** Runs `effect` with the provider over the fake, whose one session plays `steps`. */
const run = <A, E>(
  steps: ReadonlyArray<object>,
  effect: Effect.Effect<A, E, LanguageModel.LanguageModel | OrganCost | Log>,
): Promise<Exit.Exit<A, E>> => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-organ-cost-test-"))
  const scenario = { turns: [steps], eofAfterTurn: true }
  return Effect.runPromiseExit(
    effect.pipe(
      Effect.provide(
        layer({
          account: { subscription: true },
          env: { ...process.env, FAKE_CLAUDE_SCENARIO: JSON.stringify(scenario) },
        }).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              costLayer(),
              configLayer(appConfig({ claude: fake }, dir)),
              BunServices.layer,
            ),
          ),
        ),
      ),
    ),
  )
}

const value = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (exit._tag === "Failure") throw new Error(`failed: ${String(exit.cause)}`)
  return exit.value
}

const total = Effect.flatMap(OrganCost, (costs) => costs.total)

/** A triage call, its outcome caught: "answered", "timed out" or "failed". */
const triage = (limit: Duration.Input) =>
  LanguageModel.generateText({ prompt: "What became of tut-1?" }).pipe(
    Effect.provideService(OrganCall, { organ: "triage" }),
    Effect.as("answered"),
    Effect.timeoutOrElse({ duration: limit, orElse: () => Effect.succeed("timed out") }),
    Effect.catch(() => Effect.succeed("failed")),
  )

const unknownLine = /^ORGAN triage: cost unknown, no result after \d+\.\ds$/

describe("an organ call that ends without a result", () => {
  test("timed out, it is logged and counted as a call of unknown cost", async () => {
    const before = Date.now()
    const exit = await run([{ hang: true }], Effect.all([triage("500 millis"), texts, total]))
    const elapsed = Date.now() - before
    const [outcome, lines, sum] = value(exit)
    expect(outcome).toBe("timed out")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(unknownLine)
    expect(sum).toMatchObject({ calls: 1, costUsd: 0, turns: 0, unknown: 1 })
    // The time it ran: the time limit starts before the provider does, so it can be less.
    expect(sum.durationMs).toBeGreaterThan(0)
    expect(sum.durationMs).toBeLessThanOrEqual(elapsed)
  })

  test("its session failing first, it is logged and counted as a call of unknown cost", async () => {
    const exit = await run([{ exit: 1 }], Effect.all([triage("30 seconds"), texts, total]))
    const [outcome, lines, sum] = value(exit)
    expect(outcome).toBe("failed")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(unknownLine)
    expect(sum).toMatchObject({ calls: 1, costUsd: 0, turns: 0, unknown: 1 })
  })

  test("a call with a result is not of unknown cost", async () => {
    const exit = await run(
      [
        { text: "Merged." },
        { result: { total_cost_usd: 0.0123, num_turns: 1, duration_ms: 4200 } },
      ],
      Effect.all([triage("30 seconds"), texts, total]),
    )
    const [outcome, lines, sum] = value(exit)
    expect(outcome).toBe("answered")
    expect(lines).toEqual(["ORGAN triage: $0.0123 in 1 turn, 4.2s"])
    expect(sum).toEqual({ calls: 1, costUsd: 0.0123, turns: 1, durationMs: 4200, unknown: 0 })
  })
})

describe("unknown costs in the total", () => {
  test("the log line says how long the call ran", () => {
    expect(unknownCostLine({ organ: "triage", durationMs: 180_000 })).toBe(
      "ORGAN triage: cost unknown, no result after 180.0s" as never,
    )
  })

  test("a call of unknown cost adds a call and its time, and no cost or turns", () => {
    const known = add(noCost, {
      organ: "triage",
      costUsd: 0.01,
      turns: 2,
      durationMs: 1000,
      sessionId: "s",
    })
    expect(addUnknown(known, { organ: "screen", durationMs: 120_000 })).toEqual({
      calls: 2,
      costUsd: 0.01,
      turns: 2,
      durationMs: 121_000,
      unknown: 1,
    })
  })

  test("the report's total names the calls whose cost it leaves out", () => {
    const cost = { calls: 7, costUsd: 0.0456, turns: 9 }
    expect(costTotal({ ...cost, unknown: 0 })).toBe("$0.0456 in 7 organ calls, 9 turns in all")
    expect(costTotal({ ...cost, unknown: 1 })).toBe(
      "$0.0456 in 7 organ calls, 9 turns in all; 1 call's cost unknown",
    )
    expect(costTotal({ ...cost, unknown: 2 })).toBe(
      "$0.0456 in 7 organ calls, 9 turns in all; 2 calls' cost unknown",
    )
  })

  test("the written report's total says so too, even when no call's cost is known", () => {
    const written = compose({
      started: 0,
      ended: 60_000,
      base: "main",
      scope: null,
      body: "The run went well.",
      cost: { calls: 1, costUsd: 0, turns: 0, unknown: 1 },
    })
    expect(written.trimEnd()).toEndWith(
      "Organs: $0.0000 in 1 organ call, 0 turns in all; 1 call's cost unknown.",
    )
  })
})
