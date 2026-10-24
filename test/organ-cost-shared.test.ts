// A scenario's usage probe and the organs it adds share one OrganCost, as a run's do (main.ts): the
// probe's cost and an organ call's add up in the total the report and the end record read, each
// logged once.
import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Layer, Schema } from "effect"
import { UsageProbe } from "../src/agent/UsageProbe.ts"
import { OrganCost } from "../src/organs/OrganCost.ts"
import { make, Organs } from "../src/organs/Organs.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { answered, layer as cannedLayer } from "../src/testing/Organs.ts"
import { layer as probeLayer } from "../src/testing/UsageProbe.ts"
import { scenario } from "./harness.ts"

const triage = make("triage", {
  prompt: "You are the triage organ.\n",
  answer: Schema.Struct({ cause: Schema.String }),
})

/** The probe's turn: under the limit, at `costUsd`. */
const probeTurn = (costUsd: number): ReadonlyArray<SDKMessage> => [
  {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "OK",
    num_turns: 1,
    total_cost_usd: costUsd,
    duration_ms: 0,
    stop_reason: "end_turn",
    session_id: "usage-probe",
  } as unknown as SDKMessage,
]

/** Triage's answer, at `costUsd`. */
const triageAnswer = (costUsd: number) =>
  answered({ cause: "the tests fail" }, { total_cost_usd: costUsd, session_id: "triage" })

describe("a scenario's OrganCost", () => {
  test("adds the probe's cost and an organ's it adds in one total", async () => {
    const ran = await scenario(
      { usageProbe: [probeTurn(0.01)] },
      Effect.gen(function* () {
        yield* (yield* UsageProbe).probe(null)
        yield* Effect.flatMap(Organs, (organs) => organs.ask(triage, [])).pipe(
          Effect.provide(
            Organs.layer.pipe(Layer.provideMerge(cannedLayer({ triage: triageAnswer(0.02) }))),
          ),
        )
        return yield* (yield* OrganCost).total
      }),
    )
    if (ran.exit._tag !== "Success") throw new Error(`the scenario failed: ${String(ran.exit)}`)
    expect(ran.exit.value).toMatchObject({ calls: 2, turns: 2, unknown: 0, failed: 0 })
    expect(ran.exit.value.costUsd).toBeCloseTo(0.03, 10)
    expect(ran.log.filter((text) => text.startsWith("ORGAN"))).toEqual([
      "ORGAN usage-probe: $0.0100 in 1 turn, 0.0s",
      "ORGAN triage: $0.0200 in 1 turn, 0.0s",
    ])
    expect(ran.events.filter((record) => record.kind === "organ")).toHaveLength(2)
  })

  test("is the test layers' own where the context has none", async () => {
    const total = await Effect.gen(function* () {
      yield* (yield* UsageProbe).probe(null)
      return yield* (yield* OrganCost).total
    }).pipe(
      Effect.provide(probeLayer([probeTurn(0.01)]).pipe(Layer.provideMerge(logLayer()))),
      Effect.runPromise,
    )
    expect(total).toMatchObject({ calls: 1, costUsd: 0.01 })
  })
})
