// The run's parts, each made on its own (run.ts): its holds (holdsGate.ts), and the run's end the
// screen's commands act until (screenCommands.ts).
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref, SubscriptionRef } from "effect"
import { stopFor } from "../src/run/holds.ts"
import { make as makeHoldsGate } from "../src/run/holdsGate.ts"
import { emptyStatus, type Status } from "../src/run/runView.ts"
import { make as makeScreenCommands } from "../src/run/screenCommands.ts"
import * as TestAgentHost from "../src/testing/AgentHost.ts"
import * as TestAttention from "../src/testing/Attention.ts"
import * as TestBeads from "../src/testing/Beads.ts"
import * as TestLedger from "../src/testing/Ledger.ts"
import { texts } from "../src/testing/Log.ts"
import * as TestTranscripts from "../src/testing/Transcripts.ts"

const ledgerLayer = TestLedger.layer()
const attentionLayer = TestAttention.layer().pipe(Layer.provideMerge(ledgerLayer))
const commandsLayer = Layer.mergeAll(
  TestAgentHost.layer({}).pipe(
    Layer.provideMerge(Layer.mergeAll(attentionLayer, TestTranscripts.layer())),
  ),
  TestBeads.layer(),
)

/** A holds gate over a fresh status, with how often it woke the run. */
const gate = Effect.gen(function* () {
  const status = yield* SubscriptionRef.make<Status>(emptyStatus)
  const woken = yield* Ref.make(0)
  const holds = yield* makeHoldsGate({
    status,
    notices: ["a notice"],
    wakeUp: Ref.update(woken, (n) => n + 1),
  })
  return { holds, status, woken }
})

describe("the holds gate", () => {
  test("a stop holds the run, shows `· stopping` and wakes it, said only while tickets run", async () => {
    const said = await Effect.runPromise(
      Effect.gen(function* () {
        const { holds, status, woken } = yield* gate
        const stop = stopFor("PAUSED", "the worker paused", { ticket: "t-1" })
        yield* holds.stopped(stop)
        expect((yield* holds.currentStops).first).toEqual(stop)
        expect((yield* SubscriptionRef.get(status)).stopping).toBe(true)
        expect((yield* SubscriptionRef.get(status)).warnings).toEqual(["a notice"])
        expect(yield* Ref.get(woken)).toBe(1)
        return yield* texts
      }).pipe(Effect.provide(ledgerLayer)),
    )
    expect(said).toEqual([])
  })

  test("a worker past its ticket limit has its hold said with nothing else running", async () => {
    const said = await Effect.runPromise(
      Effect.gen(function* () {
        const { holds } = yield* gate
        yield* holds.stopped(stopFor("TICKET_LIMIT", "t-1 ran past its limit", { ticket: "t-1" }))
        return yield* texts
      }).pipe(Effect.provide(ledgerLayer)),
    )
    expect(said).toHaveLength(1)
    expect(said[0]).toContain("TICKET_LIMIT: t-1 ran past its limit")
  })

  test("a change gives the holds it found, and one changing nothing shows nothing new", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { holds, status } = yield* gate
        const before = yield* holds.now
        const shown = yield* SubscriptionRef.get(status)
        expect(yield* holds.changeHolds((now) => now)).toBe(before)
        expect(yield* SubscriptionRef.get(status)).toBe(shown)
        const found = yield* holds.changeHolds((now) => ({ ...now, machine: true }))
        expect(found).toBe(before)
        expect((yield* holds.now).machine).toBe(true)
      }).pipe(Effect.provide(ledgerLayer)),
    )
  })
})

describe("the run's end the screen's commands act until", () => {
  test("ends unless a command acted since the look that counted them", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const commands = yield* makeScreenCommands({ repo: "/repo", base: "main" })
        expect(yield* commands.acted).toBe(0)
        expect(yield* commands.endAfter(1)).toBe(false)
        expect(yield* commands.ended).toBe(false)
        expect(yield* commands.endAfter(0)).toBe(true)
        expect(yield* commands.ended).toBe(true)
      }).pipe(Effect.provide(commandsLayer)),
    )
  })

  test("the usage limit's end, looking no more, ends it at once; a quit's ends it too", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const limited = yield* makeScreenCommands({ repo: "/repo", base: "main" })
        expect(yield* limited.endAfter(null)).toBe(true)
        expect(yield* limited.ended).toBe(true)
        const quit = yield* makeScreenCommands({ repo: "/repo", base: "main" })
        yield* quit.end
        expect(yield* quit.ended).toBe(true)
      }).pipe(Effect.provide(commandsLayer)),
    )
  })

  test("the end-of-run box's `q` is taken once by the next look", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const commands = yield* makeScreenCommands({ repo: "/repo", base: "main" })
        expect(yield* commands.endAsked).toBe(false)
        yield* commands.askEnd
        expect(yield* commands.endAsked).toBe(true)
        expect(yield* commands.endAsked).toBe(false)
      }).pipe(Effect.provide(commandsLayer)),
    )
  })
})
