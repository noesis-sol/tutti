// Partial messages (`stream_event`, § 4.4) are cheap to pass on: each is published to the worker's
// subscribers, and folded into its state only while an api_retry holds, the one thing it changes.
import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Layer, Stream, SubscriptionRef } from "effect"
import { makeWorkers } from "../src/agent/AgentHost.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"

const sdk = (fields: object) => fields as unknown as SDKMessage

const init = sdk({ type: "system", subtype: "init", session_id: "s-1", permissionMode: "default" })
const running = sdk({ type: "system", subtype: "session_state_changed", state: "running" })
const retry = sdk({ type: "system", subtype: "api_retry", attempt: 2, max_retries: 10 })
const partial = (text: string) =>
  sdk({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    parent_tool_use_id: null,
    uuid: `u-${text}`,
    session_id: "s-1",
  })

/** Emits `before`, then `partials`, into a worker's session: what its state and subscribers saw. */
const emitted = (before: ReadonlyArray<SDKMessage>, partials: ReadonlyArray<SDKMessage>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const workers = yield* makeWorkers()
        const entry = yield* workers.open("t-1", "s-1", false)
        for (const message of before) yield* workers.emit(entry, "s-1", message)
        const subscribed = yield* workers.subscribe("t-1")
        const worker = yield* SubscriptionRef.get(entry.worker)
        for (const message of partials) yield* workers.emit(entry, "s-1", message)
        const after = yield* SubscriptionRef.get(entry.worker)
        const seen = yield* subscribed.pipe(Stream.take(partials.length), Stream.runCollect)
        return {
          seen: seen.map((item) => item.message),
          folded: after !== worker,
          state: after.state,
        }
      }),
    ).pipe(
      Effect.provide(Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer())),
      Effect.provide(Layer.mergeAll(logLayer(), eventsLayer())),
    ),
  )

describe("partial messages", () => {
  test("pass to the worker's subscribers without a fold of its state", async () => {
    const partials = ["a", "b", "c"].map(partial)
    const { seen, folded, state } = await emitted([init, running], partials)
    expect(seen).toEqual(partials)
    expect(folded).toBe(false)
    expect(state).toMatchObject({ _tag: "Working" })
  })

  test("end an api_retry: the first is folded, Working again", async () => {
    const partials = ["a", "b"].map(partial)
    const { seen, folded, state } = await emitted([init, running, retry], partials)
    expect(seen).toEqual(partials)
    expect(folded).toBe(true)
    expect(state).toMatchObject({ _tag: "Working" })
  })

  test("leave a worker Retrying when none comes", async () => {
    const { state } = await emitted([init, running, retry], [])
    expect(state).toMatchObject({ _tag: "Retrying", attempt: 2, max: 10 })
  })
})
