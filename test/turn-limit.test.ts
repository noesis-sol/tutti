// turnLimit, the one reading of whether a turn ended on the usage limit, shared by a worker's turn
// (WorkerState), the usage probe and an organ's call: they agree on the recorded fixtures.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Exit } from "effect"
import { read, turnLimit } from "../src/agent/reading.ts"
import { endedOnLimit, noTurnLimit } from "../src/agent/UsageLimits.ts"
import { answerOf, ProbeAnswer } from "../src/agent/UsageProbe.ts"
import { initial, step, WorkerEvent, WorkerState } from "../src/agent/WorkerState.ts"
import { outcome } from "../src/organs/AgentSdkLanguageModel.ts"

const fixture = (name: string): ReadonlyArray<SDKMessage> =>
  readFileSync(resolve(import.meta.dir, "fixtures/usage-limit", name), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as SDKMessage)

const event = (status: string, extra: Record<string, unknown> = {}): SDKMessage =>
  ({ type: "rate_limit_event", rate_limit_info: { status, ...extra } }) as unknown as SDKMessage

describe("turnLimit", () => {
  test("the last event's status wins; the limit and reset are the last said", () => {
    const limit = turnLimit([
      event("rejected", { rateLimitType: "five_hour", resetsAt: 1_000 }),
      event("allowed"),
    ])
    expect(limit).toEqual({
      seen: true,
      rejected: false,
      limit: "five_hour",
      resetsAt: 1_000_000,
      rateLimited: false,
    })
    expect(endedOnLimit(limit, undefined)).toBe(false)
    expect(endedOnLimit(limit, 429)).toBe(true)
  })

  test("an event it can't read, or any other message, changes nothing", () => {
    expect(turnLimit([event("unheard-of"), { type: "user" } as SDKMessage])).toBe(noTurnLimit)
  })

  test("an assistant message's rate_limit error is the limit", () => {
    const limit = turnLimit([{ type: "assistant", error: "rate_limit" } as unknown as SDKMessage])
    expect(endedOnLimit(limit, null)).toBe(true)
  })
})

describe("a worker, the probe and an organ agree on the fixtures", () => {
  for (const name of ["rejected.jsonl", "result-429.jsonl"]) {
    test(name, () => {
      const messages = fixture(name)
      const worker = messages.reduce(
        (w, message, i) =>
          step(w, WorkerEvent.Message({ session: "s", reading: read(message) }), 1_000 * (i + 1)),
        initial(),
      )
      const resetsAt = turnLimit(messages).resetsAt
      expect(worker.state).toEqual(WorkerState.UsageLimited({ resetsAt }))
      expect(answerOf(messages)).toEqual(
        ProbeAnswer.Refused({ limit: turnLimit(messages).limit, resetsAt }),
      )
      const organ = Effect.runSyncExit(outcome("generateText", messages))
      expect(Exit.isFailure(organ)).toBe(true)
      expect(String(organ)).toContain("QuotaExhausted")
    })
  }
})
