// A new session's spending (§ 10): only a resumed session's totals are seeded from its last result
// in the ticket's transcript; a session started anew has none there, and isn't read back for one.

import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Stream } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { Transcripts } from "../src/agent/Transcripts.ts"
import { settled } from "../src/agent/WorkerState.ts"
import type { EventRecord } from "../src/run/events.ts"
import { Spending } from "../src/run/spending.ts"
import { result, turn } from "../src/testing/AgentHost.ts"
import { backlog, scenario } from "./harness.ts"

const model = "claude-opus-5-5"

/** A model's usage as a result's modelUsage gives it. */
const usage = (input: number, output: number) => ({
  [model]: {
    inputTokens: input,
    outputTokens: output,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
  },
})

/** A result with the running totals `cost` and `modelUsage`. */
const resultMessage = (cost: number, modelUsage: object): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "DONE",
    num_turns: 2,
    duration_ms: 4000,
    duration_api_ms: 3000,
    total_cost_usd: cost,
    modelUsage,
  }) as unknown as SDKMessage

const turnsOf = (records: ReadonlyArray<EventRecord>) =>
  records.flatMap((r) => (r.kind === "turn" ? [r] : []))

describe("a session started anew", () => {
  test("its first turn counts all it spent, whatever the transcript holds", async () => {
    const ran = await scenario(
      {
        backlog: backlog().ticket("t-1").seeds,
        scripts: {
          "t-1": [turn([], result("DONE", { total_cost_usd: 1.25, modelUsage: usage(14, 250) }))],
        },
      },
      Effect.gen(function* () {
        // A result of the same session ID in the transcript: a resume would count over it, a start
        // doesn't read it.
        const transcripts = yield* Transcripts
        yield* transcripts.record("t-1", "s-1", resultMessage(1, usage(13, 200)))
        const host = yield* AgentHost
        yield* host.start("t-1", { sessionId: "s-1", cwd: "/w/t-1" })
        yield* host.send("t-1", "Work on t-1.", "clientComposed")
        yield* host.state("t-1").pipe(Stream.filter(settled), Stream.take(1), Stream.runDrain)
        yield* host.end("t-1")
        return yield* (yield* Spending).ofTicket("t-1")
      }),
    )
    if (ran.exit._tag !== "Success") throw new Error(`the scenario failed: ${String(ran.exit)}`)
    expect(turnsOf(ran.events).map((t) => [t.session, t.cost_usd, t.tokens?.[model]])).toEqual([
      ["s-1", 1.25, { input: 14, output: 250, cache_write: 0, cache_read: 0 }],
    ])
    expect(ran.exit.value.costUsd).toBe(1.25)
  })
})
