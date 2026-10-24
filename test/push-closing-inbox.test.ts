// A message pushed into a session's inbox (AgentHostLive's push): one the inbox takes is recorded
// and outstanding; one pushed as the session closes, its inbox ended, fails AgentGone with nothing
// recorded and its uuid withdrawn.
import { describe, expect, test } from "bun:test"
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { type Cause, Effect, Exit, Layer, Queue, SubscriptionRef } from "effect"
import { AgentGone, makeWorkers } from "../src/agent/AgentHost.ts"
import { closingWhy, push } from "../src/agent/AgentHostLive.ts"
import { WorkerEvent } from "../src/agent/WorkerState.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { Files, layer as transcriptsLayer } from "../src/testing/Transcripts.ts"

const message = (fields: object) =>
  WorkerEvent.Message({ session: "s-1", message: fields as unknown as SDKMessage })

// A session that has started, run a turn and gone idle.
const settled = [
  message({ type: "system", subtype: "init", session_id: "s-1", permissionMode: "default" }),
  message({ type: "result", subtype: "success", is_error: false, result: "", num_turns: 1 }),
  message({ type: "system", subtype: "session_state_changed", state: "idle" }),
]

/** Pushes "hello" as `uuid` into an idle session, its inbox `ended` or not: what came of it. */
const pushed = (ended: boolean, uuid: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const workers = yield* makeWorkers()
        const entry = yield* workers.open("t-1", "s-1", false)
        for (const event of settled) yield* workers.fold(entry, event)
        const inbox = yield* Queue.unbounded<SDKUserMessage, Cause.Done>()
        if (ended) yield* Queue.end(inbox)
        const session = { ticket: "t-1", sessionId: "s-1", entry, inbox }
        const exit = yield* Effect.exit(
          push(workers, session, { text: "hello", from: "clientComposed", uuid }),
        )
        const worker = yield* SubscriptionRef.get(entry.worker)
        return {
          exit,
          recorded: (yield* (yield* Files).messages("t-1")).length,
          queued: ended ? 0 : yield* Queue.size(inbox),
          outstanding: worker.outstanding,
          state: worker.state._tag,
        }
      }),
    ).pipe(
      Effect.provide(Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer())),
      Effect.provide(Layer.mergeAll(logLayer(), eventsLayer())),
    ),
  )

describe("push", () => {
  test("into an open inbox: its uuid, recorded, queued and outstanding", async () => {
    const { exit, recorded, queued, outstanding, state } = await pushed(false, "u-1")
    expect(exit).toEqual(Exit.succeed("u-1"))
    expect(recorded).toBe(1)
    expect(queued).toBe(1)
    expect(outstanding).toEqual(["u-1"])
    expect(state).toBe("Working")
  })

  test("into an inbox the session's close ended: AgentGone, nothing recorded, still Idle", async () => {
    const { exit, recorded, outstanding, state } = await pushed(true, "u-1")
    expect(exit).toEqual(Exit.fail(new AgentGone({ ticket: "t-1", why: closingWhy })))
    expect(recorded).toBe(0)
    expect(outstanding).toEqual([])
    expect(state).toBe("Idle")
  })
})
