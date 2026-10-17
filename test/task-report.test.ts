import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { AgentHost } from "../src/agent/AgentHost.ts"
import type { Attention } from "../src/agent/Attention.ts"
import type { Transcripts } from "../src/agent/Transcripts.ts"
import { WorkerState } from "../src/agent/WorkerState.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import type { Log } from "../src/run/log.ts"
import {
  backgroundCommand,
  layer as hostLayer,
  monitorWatch,
  type Recording,
  type Script,
} from "../src/testing/AgentHost.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"

// § 4.2: idle comes while a background task is live, and a task that ends after it is reported by
// a turn the CLI starts by itself, ~70 ms after the set empties. The worker stays Working through
// that window and the turn, and stops waiting for a report that doesn't come within 30 s.

type Env = AgentHost | Recording | Attention | Transcripts | Log | EventStream

/** Runs `effect` with the scripted host playing `scripts`, under TestClock. */
const run = <A, E>(scripts: Readonly<Record<string, Script>>, effect: Effect.Effect<A, E, Env>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        hostLayer(scripts).pipe(
          Layer.provideMerge(Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer())),
          Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer())),
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

const session = { sessionId: "s-1", cwd: "/work/t-1" }
const working = WorkerState.Working({ doing: "working" })
const late =
  "  t-1: a background task ended and no turn came to report it within 30 seconds; not waiting for it"

/** Starts t-1's worker and sends it its first message. */
const start = Effect.gen(function* () {
  const host = yield* AgentHost
  yield* host.start("t-1", session)
  yield* host.send("t-1", "Your ticket is t-1.", "clientComposed")
})

const current = Effect.gen(function* () {
  return yield* (yield* AgentHost).current("t-1")
})

describe("a finished background task's report", () => {
  test("keeps the worker Working from idle through the turn reporting the task", async () => {
    const seen = await run(
      { "t-1": [backgroundCommand("sleep 20", "20 seconds")] },
      Effect.gen(function* () {
        yield* start
        yield* TestClock.adjust("1 second")
        const seen: Array<WorkerState> = [yield* current]
        yield* TestClock.adjust("18 seconds")
        seen.push(yield* current)
        // The set empties at 20 s; running comes 70 ms later.
        yield* TestClock.adjust("1 second")
        seen.push(yield* current)
        yield* TestClock.adjust("69 millis")
        seen.push(yield* current)
        yield* TestClock.adjust("1 millis")
        seen.push(yield* current)
        // The report came, so the wait for it ends with nothing logged.
        yield* TestClock.adjust("1 minute")
        seen.push(yield* current)
        expect(yield* texts).toEqual([])
        return seen
      }),
    )
    expect(seen).toEqual([
      working,
      working,
      working,
      working,
      WorkerState.Idle({ at: 20_070 }),
      WorkerState.Idle({ at: 20_070 }),
    ])
  })

  test("a report that never comes: Working for 30 s, then logged and Idle", async () => {
    const seen = await run(
      { "t-1": [backgroundCommand("sleep 20", "20 seconds", { reported: false })] },
      Effect.gen(function* () {
        yield* start
        yield* TestClock.adjust("20 seconds")
        const seen: Array<WorkerState> = [yield* current]
        yield* TestClock.adjust("29999 millis")
        seen.push(yield* current)
        expect(yield* texts).toEqual([])
        yield* TestClock.adjust("1 millis")
        seen.push(yield* current)
        expect(yield* texts).toEqual([late])
        return seen
      }),
    )
    expect(seen).toEqual([working, working, WorkerState.Idle({ at: 50_000 })])
  })

  test("a Monitor watch live after idle keeps the worker Working, through its events", async () => {
    const seen = await run(
      { "t-1": [monitorWatch("1 hour")] },
      Effect.gen(function* () {
        yield* start
        yield* TestClock.adjust("1 minute")
        const seen: Array<WorkerState> = [yield* current]
        yield* TestClock.adjust("58 minutes")
        seen.push(yield* current)
        // An event the watch saw starts a turn by itself; the watch is still live after it.
        yield* TestClock.adjust("2 minutes")
        seen.push(yield* current)
        yield* TestClock.adjust("1 hour")
        seen.push(yield* current)
        expect(yield* texts).toEqual([])
        return seen
      }),
    )
    expect(seen).toEqual([working, working, working, working])
  })
})
