// A session whose stream ends before its initialize is answered (AgentHostLive): the start, not the
// reader, settles it, so the start fails saying why Claude Code didn't start, and the worker is
// Gone for that, never "closed while it started" by the close the reader would fork.
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { closedWhy } from "../src/agent/AgentHostLive.ts"
import { WorkerState } from "../src/agent/WorkerState.ts"
import { failStart, layer as hostLayer, type Script } from "../src/testing/AgentHost.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"

/** Starts t-1's worker over `script`: how its start failed, and its state after. */
const started = (script: Script) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const host = yield* AgentHost
      const failed = yield* Effect.flip(host.start("t-1", { sessionId: "s-1", cwd: "/work/t-1" }))
      return { failed, state: yield* host.current("t-1") }
    }).pipe(
      Effect.provide(
        hostLayer({ "t-1": script }).pipe(
          Layer.provideMerge(Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer())),
          Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer())),
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

describe("a stream that ends before its session's initialize is answered", () => {
  test("fails the start with what failed the initialize; the worker is Gone for it", async () => {
    const reason = "Claude Code exited with code 1"
    const { failed, state } = await started([[failStart(reason)]])
    expect(failed).toMatchObject({ _tag: "AgentStartFailed", ticket: "t-1", reason })
    expect(failed.reason).not.toBe(closedWhy)
    expect(state).toEqual(WorkerState.Gone({ why: reason }))
  })

  test("after a startup failure's result, fails the start with it", async () => {
    const { failed, state } = await started([[failStart("exited", "org_config_refused")]])
    expect(failed).toMatchObject({
      reason: "Claude Code refused to start: org_config_refused",
      startupFailureReason: "org_config_refused",
    })
    expect(state).toEqual(WorkerState.Gone({ why: "org_config_refused" }))
  })
})
