import { describe, expect, test } from "bun:test"
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Attention, type AttentionRequest, allowsForRun } from "../src/agent/Attention.ts"
import { layer as attentionLayer } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"

// In default mode a removal the safety check holds reaches canUseTool with decisionReasonType
// "safetyCheck" and suppressAlwaysAllowRule, but without defaultToNo (§ 4.5, the session spike).

/** Asks canUseTool for a Bash call with the SDK's `options`, and gives the request it opens. */
const requestFor = (command: string, options: Record<string, unknown>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const attention = yield* Attention
      const canUseTool = yield* attention.request("tut-1")
      const controller = new AbortController()
      const sdk = {
        signal: controller.signal,
        toolUseID: "toolu_1",
        requestId: "req",
        ...options,
      } as Parameters<CanUseTool>[2]
      canUseTool("Bash", { command }, sdk)
      const seen = yield* attention.open.pipe(
        Stream.filter((all) => all.length > 0),
        Stream.runHead,
      )
      controller.abort()
      return (seen._tag === "Some" ? seen.value[0] : undefined) as AttentionRequest
    }).pipe(
      Effect.provide(
        attentionLayer().pipe(
          Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer())),
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

describe("Attention: a removal held by the safety check", () => {
  test("opens on Deny without the SDK's defaultToNo, and has no Allow for this run", async () => {
    const request = await requestFor("rm -rf $T/*", {
      decisionReason: "held by the safety check",
      decisionReasonType: "safetyCheck",
      suppressAlwaysAllowRule: true,
      suggestions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "rm -rf $T/*" }],
          behavior: "allow",
          destination: "localSettings",
        },
      ],
    })
    expect(request.defaultToNo).toBe(true)
    expect(request.suppressAlwaysAllowRule).toBe(true)
    expect(allowsForRun(request)).toBe(false)
  })

  test("the SDK's defaultToNo is honoured on any request", async () => {
    const request = await requestFor("make", { defaultToNo: true })
    expect(request.defaultToNo).toBe(true)
  })

  test("another decisionReasonType leaves defaultToNo unset", async () => {
    const request = await requestFor("cat ../x", {
      decisionReason: "outside the folder",
      decisionReasonType: "workingDir",
    })
    expect(request.defaultToNo).toBe(false)
  })
})
