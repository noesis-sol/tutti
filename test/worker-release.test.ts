// A finished worker is let go of (tutti-7y43): the host forgets it and Transcripts lets go of its
// ring of messages and its open files, once its views have closed, so a run doesn't hold them for
// every ticket it finished.
import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Exit, Layer, Scope } from "effect"
import { TestClock } from "effect/testing"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { makeTranscripts, type Storage, Transcripts } from "../src/agent/Transcripts.ts"
import { Ledger } from "../src/run/ledger.ts"
import { Cause } from "../src/run/phase.ts"
import { fit } from "../src/run/sessions.ts"
import { untilSettled } from "../src/run/settle.ts"
import { layer as hostLayer, turn } from "../src/testing/AgentHost.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { backlog, scenario } from "./harness.ts"

const worker = "t-1"

const text = (words: string) =>
  ({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: words }] },
    parent_tool_use_id: null,
    session_id: "s-1",
    uuid: crypto.randomUUID(),
  }) as unknown as SDKMessage

/** Storage in memory that counts its releases and the times a worker's file is read back. */
const counting = () => {
  const lines = new Map<string, Array<string>>()
  const counts = { released: 0, readBack: 0 }
  const storage: Storage = {
    append: (id, line) => {
      const file = lines.get(id) ?? []
      file.push(line.replace(/\n$/, ""))
      lines.set(id, file)
    },
    stderr: () => {},
    linesBackward: (id) => {
      counts.readBack += 1
      return [...(lines.get(id) ?? [])].reverse()
    },
    release: () => {
      counts.released += 1
    },
  }
  return { storage, counts }
}

describe("Transcripts' release", () => {
  test("lets go of the worker's files and memory at once with no view open", async () => {
    const { storage, counts } = counting()
    const after = await Effect.runPromise(
      Effect.gen(function* () {
        const transcripts = yield* makeTranscripts(storage)
        yield* transcripts.record(worker, "s-1", text("one"))
        const read = counts.readBack
        yield* transcripts.release(worker)
        const released = counts.released
        // Started again from its file by what comes next.
        const recent = yield* transcripts.recent(worker)
        return { released, readAgain: counts.readBack - read, recent: recent.length }
      }),
    )
    expect(after).toEqual({ released: 1, readAgain: 1, recent: 1 })
  })

  test("waits for the last open view to close", async () => {
    const { storage, counts } = counting()
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const transcripts = yield* makeTranscripts(storage)
        yield* transcripts.record(worker, "s-1", text("one"))
        const first = yield* Scope.make()
        const second = yield* Scope.make()
        yield* Scope.provide(transcripts.view(worker), first)
        yield* Scope.provide(transcripts.view(worker), second)
        yield* transcripts.release(worker)
        const whileOpen = counts.released
        // Still the same worker in memory: nothing is read back.
        const read = counts.readBack
        yield* transcripts.recent(worker)
        const readWhileOpen = counts.readBack - read
        yield* Scope.close(first, Exit.void)
        const oneLeft = counts.released
        yield* Scope.close(second, Exit.void)
        return { whileOpen, readWhileOpen, oneLeft, closed: counts.released }
      }),
    )
    expect(seen).toEqual({ whileOpen: 0, readWhileOpen: 0, oneLeft: 0, closed: 1 })
  })

  test("a view opened and closed with no release asked lets go of nothing", async () => {
    const { storage, counts } = counting()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transcripts = yield* makeTranscripts(storage)
          yield* transcripts.record(worker, "s-1", text("one"))
          yield* Effect.scoped(transcripts.view(worker))
        }),
      ),
    )
    expect(counts.released).toBe(0)
  })
})

describe("the host's end", () => {
  test("lets go of the worker's transcript", async () => {
    const { storage, counts } = counting()
    const released = await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start(worker, { sessionId: "s-1", cwd: "/work/t-1" })
        yield* host.send(worker, "go", "clientComposed")
        yield* untilSettled(worker)
        const before = counts.released
        yield* host.end(worker)
        return { before, after: counts.released }
      }).pipe(
        Effect.provide(
          hostLayer({ [worker]: [turn([])] }).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                attentionLayer(waitForTest),
                Layer.effect(Transcripts, makeTranscripts(storage)),
              ),
            ),
            Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer())),
            Layer.provideMerge(TestClock.layer()),
          ),
        ),
      ),
    )
    expect(released).toEqual({ before: 0, after: 1 })
  })
})

/** The ticket's worker started, its ticket moved by `cause` and fitted: what the host knows of it. */
const fitted = (cause: Cause) =>
  scenario(
    { backlog: backlog().ticket(worker).seeds, scripts: { [worker]: [turn([])] } },
    Effect.gen(function* () {
      const host = yield* AgentHost
      const ledger = yield* Ledger
      yield* ledger.transition(worker, Cause.Ready(), { title: "One ticket" })
      yield* ledger.transition(worker, Cause.Dispatched())
      yield* host.start(worker, { sessionId: "s-1", cwd: "/work/t-1" })
      yield* host.send(worker, "go", "clientComposed")
      yield* untilSettled(worker)
      yield* ledger.transition(worker, cause)
      yield* fit(worker)
      return yield* Effect.exit(host.current(worker))
    }).pipe(Effect.provide(Ledger.layer)),
  )

const known = async (cause: Cause) => {
  const ran = await fitted(cause)
  if (Exit.isFailure(ran.exit)) throw new Error(`the scenario failed: ${ran.exit.cause}`)
  const current = ran.exit.value
  return {
    state: Exit.isSuccess(current) ? current.value._tag : "forgotten",
    closed: ran.sent.some((sent) => sent._tag === "Closed" && sent.ticket === worker),
  }
}

describe("fit, as a ticket's part in the run ends", () => {
  const ended: ReadonlyArray<readonly [string, Cause]> = [
    ["closed with no change", Cause.NoChange()],
    ["deferred", Cause.Defer({ why: "by the worker" })],
    ["left for review", Cause.Aside({ why: "CLOSED_WITHOUT_COMMIT" })],
  ]
  for (const [what, cause] of ended) {
    test(`${what}: its session closed and its worker ended`, async () => {
      expect(await known(cause)).toEqual({ state: "forgotten", closed: true })
    })
  }

  const back: ReadonlyArray<readonly [string, Cause]> = [
    ["asked", Cause.FiledQuestion({ question: "t-2" })],
    ["waiting for a merge", Cause.WaitsForMerge({ for: "t-0" })],
  ]
  for (const [what, cause] of back) {
    test(`${what}: its session closed, its worker kept for the resume`, async () => {
      expect(await known(cause)).toEqual({ state: "Closed", closed: true })
    })
  }
})
