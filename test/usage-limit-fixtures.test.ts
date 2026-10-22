import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { initial, step, type Worker, WorkerEvent, WorkerState } from "../src/agent/WorkerState.ts"

// A usage limit can't be reached on demand in the contract tests (§ 13), so these turns come from
// recorded messages, edited to show the limit: test/fixtures/usage-limit/README.md.
const fixture = (name: string): ReadonlyArray<SDKMessage> =>
  readFileSync(resolve(import.meta.dir, "fixtures/usage-limit", name), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as SDKMessage)

/** The worker after `messages`, each folded in a second after the last. */
const fold = (messages: ReadonlyArray<SDKMessage>, from: Worker = initial()): Worker =>
  messages.reduce(
    (worker, message, i) =>
      step(worker, WorkerEvent.Message({ session: "s", message }), 1_000 * (i + 1)),
    from,
  )

describe("WorkerState on the usage-limit fixtures", () => {
  test("a rejected rate_limit_event and a 429 result are UsageLimited until its reset", () => {
    const worker = fold(fixture("rejected.jsonl"))
    expect(worker.state).toEqual(WorkerState.UsageLimited({ resetsAt: 1_792_222_200_000 }))
  })

  test("a 429 result alone is UsageLimited, with no reset known", () => {
    expect(fold(fixture("result-429.jsonl")).state).toEqual(
      WorkerState.UsageLimited({ resetsAt: null }),
    )
  })

  test("every turn of the fixtures is Working before its result", () => {
    for (const name of ["rejected.jsonl", "result-429.jsonl"]) {
      const messages = fixture(name)
      const before = messages.findIndex((m) => m.type === "result")
      expect(fold(messages.slice(0, before)).state._tag).toBe("Working")
    }
  })

  test("the next turn after the limit is Working again, and Idle once it ends cleanly", () => {
    const limited = fold(fixture("rejected.jsonl"))
    const next = fixture("rejected.jsonl").filter(
      (m) => m.type !== "rate_limit_event" && m.type !== "assistant" && m.type !== "result",
    )
    expect(fold(next, limited).state._tag).toBe("Working")
    const clean = fixture("result-429.jsonl").map((m) =>
      m.type === "result" ? ({ ...m, is_error: false, api_error_status: null } as SDKMessage) : m,
    )
    expect(fold(clean, limited).state._tag).toBe("Idle")
  })
})
