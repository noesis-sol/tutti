// Whether a send is answered is the worker's state's to say (§ 4.2): the send is outstanding from
// its push (Sent) until a message of its session, or an interrupt's receipt, says it no longer is,
// and AgentHost.answered waits on that. A resume or a start between the send and the wait begins a
// new session, with none of the sends before it outstanding: the wait ends at once.
import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Fiber, Layer, SubscriptionRef } from "effect"
import { makeWorkers, type WorkerEntry, type Workers } from "../src/agent/AgentHost.ts"
import { WorkerEvent } from "../src/agent/WorkerState.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"

const uuid = "00000000-0000-4000-8000-000000000002"
const sdk = (fields: object) => ({ session_id: "s-1", ...fields }) as unknown as SDKMessage

/** Lets every fiber run as far as it can. */
const quiet = Effect.gen(function* () {
  for (let i = 0; i < 200; i++) yield* Effect.yieldNow
})

/**
 * A worker of session s-1 sent `uuid`; `then` is run with a wait on its answer forked: whether the
 * wait had ended before `then`, and after it.
 */
const waited = (then: (workers: Workers, entry: WorkerEntry) => Effect.Effect<void>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const workers = yield* makeWorkers()
        const entry = yield* workers.open("t-1", "s-1", false)
        yield* workers.emit(entry, "s-1", sdk({ type: "system", subtype: "init" }))
        yield* workers.fold(entry, WorkerEvent.Sent({ session: "s-1", uuid }))
        const fiber = yield* Effect.forkChild(workers.answered("t-1", uuid))
        yield* quiet
        const before = fiber.pollUnsafe() !== undefined
        yield* then(workers, entry)
        yield* quiet
        const after = fiber.pollUnsafe() !== undefined
        yield* Fiber.interrupt(fiber)
        return {
          before,
          after,
          outstanding: (yield* SubscriptionRef.get(entry.worker)).outstanding,
        }
      }),
    ).pipe(
      Effect.provide(Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer())),
      Effect.provide(Layer.mergeAll(logLayer(), eventsLayer())),
    ),
  )

describe("a send is answered", () => {
  test("by its command_lifecycle completed or cancelled, not queued or started", async () => {
    for (const state of ["completed", "cancelled"]) {
      const lifecycle = sdk({ type: "command_lifecycle", command_uuid: uuid, state })
      const done = await waited((workers, entry) =>
        Effect.asVoid(workers.emit(entry, "s-1", lifecycle)),
      )
      expect(done).toEqual({ before: false, after: true, outstanding: [] })
    }
    for (const state of ["queued", "started"]) {
      const lifecycle = sdk({ type: "command_lifecycle", command_uuid: uuid, state })
      const done = await waited((workers, entry) =>
        Effect.asVoid(workers.emit(entry, "s-1", lifecycle)),
      )
      expect(done).toEqual({ before: false, after: false, outstanding: [uuid] })
    }
  })

  test("by a result that lists it, or lists no sends at all; not by one listing another", async () => {
    const result = (fields: object) =>
      sdk({ type: "result", subtype: "success", is_error: false, result: "DONE", ...fields })
    for (const [message, answered] of [
      [result({ user_message_uuids: [uuid] }), true],
      [result({}), true],
      [result({ user_message_uuids: ["other"] }), false],
    ] as const) {
      const done = await waited((workers, entry) =>
        Effect.asVoid(workers.emit(entry, "s-1", message)),
      )
      expect(done.after).toBe(answered)
    }
  })

  test("by an interrupt's receipt that cancels it", async () => {
    const done = await waited((workers, entry) =>
      workers.fold(entry, WorkerEvent.Cancelled({ session: "s-1", uuids: [uuid] })),
    )
    expect(done).toEqual({ before: false, after: true, outstanding: [] })
  })

  test("not by a message it can't read", async () => {
    const done = await waited((workers, entry) =>
      Effect.asVoid(workers.emit(entry, "s-1", sdk({ type: "result", subtype: "success" }))),
    )
    expect(done).toEqual({ before: false, after: false, outstanding: [uuid] })
  })

  test("once its session ends, or the worker is ended", async () => {
    const gone = await waited((workers, entry) =>
      workers.fold(entry, WorkerEvent.Ended({ session: "s-1", why: "it crashed" })),
    )
    expect(gone.after).toBe(true)
    const ended = await waited((workers) => workers.forget("t-1"))
    expect(ended.after).toBe(true)
  })

  test("not by a message of an earlier session", async () => {
    const done = await waited((workers, entry) =>
      Effect.gen(function* () {
        yield* workers.open("t-1", "s-2", true)
        yield* workers.fold(entry, WorkerEvent.Sent({ session: "s-2", uuid: "u-2" }))
        yield* workers.emit(
          entry,
          "s-1",
          sdk({ type: "command_lifecycle", command_uuid: "u-2", state: "completed" }),
        )
      }),
    )
    expect(done.outstanding).toEqual(["u-2"])
  })

  test("at once when a resume came between the send and the wait: nothing is outstanding", async () => {
    const done = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workers = yield* makeWorkers()
          const entry = yield* workers.open("t-1", "s-1", false)
          yield* workers.fold(entry, WorkerEvent.Sent({ session: "s-1", uuid }))
          yield* workers.open("t-1", "s-2", true)
          const fiber = yield* Effect.forkChild(workers.answered("t-1", uuid))
          yield* quiet
          return {
            answered: fiber.pollUnsafe() !== undefined,
            outstanding: (yield* SubscriptionRef.get(entry.worker)).outstanding,
          }
        }),
      ).pipe(
        Effect.provide(Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer())),
        Effect.provide(Layer.mergeAll(logLayer(), eventsLayer())),
      ),
    )
    expect(done).toEqual({ answered: true, outstanding: [] })
  })

  test("at once for a worker the host doesn't know", async () => {
    const done = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workers = yield* makeWorkers()
          yield* workers.answered("nobody", uuid)
          return true
        }),
      ).pipe(
        Effect.provide(Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer())),
        Effect.provide(Layer.mergeAll(logLayer(), eventsLayer())),
      ),
    )
    expect(done).toBe(true)
  })
})
