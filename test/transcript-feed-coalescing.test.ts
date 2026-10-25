// A worker view redraws no more often than its screen changes (tutti-ejkt.8): a tool call's input
// deltas publish nothing, as its live entry draws only its name, and streamed text is published
// on its first change, then at most once per 33 ms, an appended item at once with the text so far.

import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Exit, Queue, Scope, Stream } from "effect"
import fc from "fast-check"
import {
  type Item,
  type Live,
  Transcripts,
  transcriptVersion,
  type Update,
} from "../src/agent/Transcripts.ts"
import { layer as memoryLayer } from "../src/testing/Transcripts.ts"
import {
  type OpenTranscript,
  type Timeout,
  type TranscriptState,
  transcriptFeed,
} from "../src/ui/transcriptItems.ts"

const session = "0a4f5c3e-1111-4c8e-9a51-6f0d1f0b2a01"

const sdk = (message: Record<string, unknown>): SDKMessage => message as unknown as SDKMessage

const itemOf = (seq: number, text: string): Item => ({
  v: transcriptVersion,
  seq,
  session,
  time: "2026-10-20T13:00:00.000Z",
  message: sdk({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  }),
})

const liveText = (parent: string | null, text: string): Update => ({
  _tag: "Live",
  parent,
  live: { parent, blocks: [{ kind: "text", text }] },
})

/** A Timeout a test runs by hand: `fire` runs the timers set, as 33 ms passing would. */
const handTimeout = () => {
  const set: Array<{ readonly run: () => void; readonly ms: number; cancelled: boolean }> = []
  const timeout: Timeout = (run, ms) => {
    const timer = { run, ms, cancelled: false }
    set.push(timer)
    return () => {
      timer.cancelled = true
    }
  }
  const waiting = () => set.filter((timer) => !timer.cancelled)
  const fire = () => {
    const due = waiting()
    set.length = 0
    for (const timer of due) timer.run()
  }
  return { timeout, waiting, fire }
}

/**
 * A feed over a Transcripts whose one view is told what the test sends: `send` hands it updates
 * and resolves once the feed has taken them all.
 */
const fed = (timeout: Timeout) => {
  const queue = Effect.runSync(Queue.unbounded<Update | (() => void)>())
  const updates = Stream.fromQueue(queue).pipe(
    Stream.filter((each): each is Update => {
      if (typeof each !== "function") return true
      each()
      return false
    }),
  )
  const transcripts = {
    view: () => Effect.succeed({ items: [], live: [], updates }),
  } as unknown as Transcripts["Service"]
  const scope = Effect.runSync(Scope.make())
  const feed = Effect.runSync(transcriptFeed(transcripts, timeout).pipe(Scope.provide(scope)))
  const open = feed.open("t-1" as never)
  let published = 0
  open.state.subscribe(() => published++)
  const send = (...each: ReadonlyArray<Update>) =>
    new Promise<void>((resolve) => {
      for (const update of each) Queue.offerUnsafe(queue, update)
      Queue.offerUnsafe(queue, resolve)
    })
  return {
    open,
    send,
    published: () => published,
    close: () => {
      open.close()
      Effect.runSync(Scope.close(scope, Exit.void))
    },
  }
}

const textOf = (open: OpenTranscript) =>
  open.state.get().live.map((each) => each.blocks.map((block) => block?.text))

describe("streamed text in a worker view", () => {
  test("is published on its first change, then once per 33 ms, the latest each time", async () => {
    const clock = handTimeout()
    const view = fed(clock.timeout)
    try {
      await view.send()
      const opened = view.published()
      await view.send(liveText(null, "Hel"))
      expect(view.published()).toBe(opened + 1)
      expect(textOf(view.open)).toEqual([["Hel"]])
      expect(clock.waiting().map((timer) => timer.ms)).toEqual([33])
      // Within the 33 ms: folded, not published.
      await view.send(liveText(null, "Hello"), liveText(null, "Hello wor"))
      expect(view.published()).toBe(opened + 1)
      expect(textOf(view.open)).toEqual([["Hel"]])
      clock.fire()
      expect(view.published()).toBe(opened + 2)
      expect(textOf(view.open)).toEqual([["Hello wor"]])
      // Nothing came in the next 33 ms: the timer stops, and the next change is published at once.
      clock.fire()
      expect(clock.waiting()).toEqual([])
      expect(view.published()).toBe(opened + 2)
      await view.send(liveText(null, "Hello world"))
      expect(view.published()).toBe(opened + 3)
      expect(textOf(view.open)).toEqual([["Hello world"]])
    } finally {
      view.close()
    }
  })

  test("an appended item is published at once, with the text pending", async () => {
    const clock = handTimeout()
    const view = fed(clock.timeout)
    try {
      await view.send(liveText(null, "One"))
      const before = view.published()
      await view.send(liveText(null, "One two"), {
        _tag: "Appended",
        item: itemOf(1, "go on"),
      })
      expect(view.published()).toBe(before + 1)
      expect(textOf(view.open)).toEqual([["One two"]])
      expect(view.open.state.get().window.items.map((item) => item.seq)).toEqual([1])
      // Nothing is left pending: the timer publishes nothing more.
      clock.fire()
      expect(view.published()).toBe(before + 1)
    } finally {
      view.close()
    }
  })

  test("closing the view clears its timer", async () => {
    const clock = handTimeout()
    const view = fed(clock.timeout)
    await view.send(liveText(null, "Hel"), liveText(null, "Hello"))
    expect(clock.waiting()).toHaveLength(1)
    view.close()
    expect(clock.waiting()).toEqual([])
  })

  test("shows what the changes unthrottled give once 33 ms pass, and in the end", async () => {
    const updateArb: fc.Arbitrary<Update> = fc.oneof(
      fc
        .record({
          parent: fc.constantFrom(null, "a-1", "a-2"),
          text: fc.option(fc.string(), { nil: undefined }),
        })
        .map(
          ({ parent, text }): Update =>
            text === undefined ? { _tag: "Live", parent, live: undefined } : liveText(parent, text),
        ),
      fc.string().map((text): Update => ({ _tag: "Appended", item: itemOf(0, text) })),
    )
    // Batches of updates the feed takes at once, and whether 33 ms pass after each.
    const stepsArb = fc.array(fc.record({ batch: fc.array(updateArb), passes: fc.boolean() }), {
      maxLength: 8,
    })
    await fc.assert(
      fc.asyncProperty(stepsArb, async (steps) => {
        const clock = handTimeout()
        const view = fed(clock.timeout)
        const shown: Array<TranscriptState> = []
        view.open.state.subscribe(() => shown.push(view.open.state.get()))
        let live: ReadonlyArray<Live> = []
        let seq = 0
        let items: ReadonlyArray<number> = []
        try {
          await view.send()
          for (const { batch, passes } of steps) {
            const numbered = batch.map((update): Update => {
              if (update._tag !== "Appended") return update
              seq++
              return { _tag: "Appended", item: { ...update.item, seq } }
            })
            for (const update of numbered) {
              if (update._tag === "Appended") items = [...items, update.item.seq]
              else
                live = [
                  ...live.filter((each) => each.parent !== update.parent),
                  ...(update.live === undefined ? [] : [update.live]),
                ]
            }
            await view.send(...numbered)
            // Once 33 ms pass, what is shown is the latest.
            if (passes) {
              clock.fire()
              expect(view.open.state.get().live).toEqual(live)
            }
          }
          clock.fire()
          clock.fire()
          const final = view.open.state.get()
          expect(final.live).toEqual(live)
          expect(final.window.items.map((item) => item.seq)).toEqual([...items])
          expect(clock.waiting()).toEqual([])
          // No publish repeats the one before it.
          for (const [i, state] of shown.entries()) {
            if (i > 0) expect(state).not.toBe(shown[i - 1] as TranscriptState)
          }
        } finally {
          view.close()
        }
      }),
      { numRuns: 60 },
    )
  })
})

describe("a tool call's input in a worker view", () => {
  test("streaming publishes nothing: its live entry draws only its name", async () => {
    const updates = await Effect.runPromise(
      Effect.gen(function* () {
        const t = yield* Transcripts
        const event = (e: Record<string, unknown>) =>
          t.record("t-1", {
            session,
            message: sdk({ type: "stream_event", event: e, parent_tool_use_id: null }),
          })
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const view = yield* t.view("t-1")
            yield* event({ type: "message_start", message: {} })
            yield* event({
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", id: "w-1", name: "Write", input: {} },
            })
            for (const partial_json of ['{"file_path":', '"a.ts",', '"content":"x"}']) {
              yield* event({
                type: "content_block_delta",
                index: 0,
                delta: { type: "input_json_delta", partial_json },
              })
            }
            yield* event({ type: "content_block_stop", index: 0 })
            yield* event({ type: "message_stop" })
            return yield* Stream.runCollect(Stream.take(view.updates, 3))
          }),
        )
      }).pipe(Effect.provide(memoryLayer())),
    )
    expect(updates).toEqual([
      { _tag: "Live", parent: null, live: undefined },
      {
        _tag: "Live",
        parent: null,
        live: { parent: null, blocks: [{ kind: "tool_use", name: "Write", text: "" }] },
      },
      { _tag: "Live", parent: null, live: undefined },
    ])
  })
})
