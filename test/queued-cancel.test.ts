// Queued messages are cancelled, not left to the close (§ 4.8): an interrupt cancels the messages
// queued behind the turn, with `interrupt({ cancelQueued: true })` where the CLI advertises
// `interrupt_cancel_queued_v1`, else one by one with `cancel_async_message`; a message cancelled
// either way is no longer outstanding (§ 4.2), and one the CLI won't cancel runs. The scripted
// AgentHost and the live host over the fake Claude Code (test/fixtures/fake-claude/claude.ts); § 13's
// contract tests against the real SDK are in test/contract/sdk.test.ts.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer, Schedule, Stream } from "effect"
import { TestClock } from "effect/testing"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import type { Attention } from "../src/agent/Attention.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { noServersNote } from "../src/agent/mcp.ts"
import { cancelQueuedCapability } from "../src/agent/sessionChecks.ts"
import type { Transcripts } from "../src/agent/Transcripts.ts"
import type { WorkerState } from "../src/agent/WorkerState.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import type { Log } from "../src/run/log.ts"
import {
  awaitInterrupt,
  coalescedTurn,
  layer as hostLayer,
  init,
  initialize,
  interruptedResult,
  type Options,
  Recording,
  type Script,
  sessionState,
  wait,
} from "../src/testing/AgentHost.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { Files, layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"

type Env = AgentHost | Attention | Transcripts | Files | Log | EventStream

/** Waits, at most 10 s, for the ticket's worker to reach a state with `tag`; the states seen. */
const reaches = (ticket: string, tag: WorkerState["_tag"]) =>
  Effect.flatMap(AgentHost, (host) =>
    host.state(ticket).pipe(
      Stream.takeUntil((s) => s._tag === tag),
      Stream.runCollect,
      Effect.timeoutOrElse({
        duration: Duration.seconds(10),
        orElse: () => Effect.die(`${ticket} never reached ${tag}`),
      }),
    ),
  )

/** The transcript's results' sends, and its command_lifecycle `cancelled` sends. */
const transcript = Effect.gen(function* () {
  const raw = (yield* (yield* Files).messages("t-1")).map(
    (item) => item.message as unknown as Record<string, unknown>,
  )
  return {
    results: raw.filter((m) => m.type === "result").map((m) => m.user_message_uuids),
    cancelled: raw
      .filter((m) => m.type === "command_lifecycle" && m.state === "cancelled")
      .map((m) => m.command_uuid),
  }
})

// The scripted AgentHost.

/** Runs `effect` with the scripted host playing `scripts`, under TestClock. */
const scripted = <A, E>(
  scripts: Readonly<Record<string, Script>>,
  effect: Effect.Effect<A, E, Env | Recording>,
  options: Options = {},
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        hostLayer(scripts, options).pipe(
          Layer.provideMerge(Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer())),
          Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer())),
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

/** A turn interrupted with two messages queued behind it, then the turn they share if they run. */
const interrupted = [
  wait,
  init(),
  sessionState("running"),
  awaitInterrupt,
  interruptedResult,
  sessionState("idle"),
  ...coalescedTurn([]),
]

/** Starts t-1, queues two messages behind its first turn, and interrupts it. */
const queueTwoAndInterrupt = (settled: WorkerState["_tag"]) =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    yield* host.start("t-1", { sessionId: "s-1", cwd: "/work/t-1" })
    yield* host.send("t-1", "Go.", "clientComposed")
    yield* reaches("t-1", "Working")
    const b = yield* host.send("t-1", "And this.", "human")
    const c = yield* host.send("t-1", "And that.", "human")
    const receipt = yield* host.interrupt("t-1")
    const states = yield* reaches("t-1", settled)
    return {
      b,
      c,
      receipt,
      states: states.map((s) => s._tag),
      sent: (yield* (yield* Recording).sentTo("t-1")).map((s) =>
        s._tag === "CancelAsync" ? [s._tag, s.uuid, s.cancelled] : [s._tag],
      ),
      ...(yield* transcript),
    }
  })

describe("the scripted AgentHost: an interrupt without cancelQueued", () => {
  test("cancels each message still queued with cancel_async_message; none runs", async () => {
    const done = await scripted({ "t-1": [interrupted] }, queueTwoAndInterrupt("Failed"))
    expect(done.receipt).toEqual({ stillQueued: [], cancelled: [done.b, done.c] })
    expect(done.sent).toEqual([
      ["Started"],
      ["Message"],
      ["Message"],
      ["Message"],
      ["CancelAsync", done.b, true],
      ["CancelAsync", done.c, true],
      ["Interrupted"],
    ])
    // No longer outstanding, they leave the interrupted worker to settle, Failed.
    expect(done.states.at(-1)).toBe("Failed")
    expect(done.cancelled).toEqual([done.b, done.c])
    expect(done.results).toEqual([[expect.any(String)]])
  })

  test("a message it answers cancelled: false for stays queued, outstanding, and runs", async () => {
    const done = await scripted({ "t-1": [interrupted] }, queueTwoAndInterrupt("Idle"), {
      cancelAsync: "notQueued",
    })
    expect(done.receipt).toEqual({ stillQueued: [done.b, done.c], cancelled: [] })
    expect(done.sent.slice(4)).toEqual([
      ["CancelAsync", done.b, false],
      ["CancelAsync", done.c, false],
      ["Interrupted"],
    ])
    expect(done.states).not.toContain("Failed")
    expect(done.results).toEqual([[expect.any(String)], [done.b, done.c]])
  })

  test("with cancelQueued, the receipt cancels them and no cancel_async_message is sent", async () => {
    // The CLI lists the capability in its initialize answer.
    const listing = [initialize({ capabilities: [cancelQueuedCapability] }), ...interrupted]
    const done = await scripted({ "t-1": [listing] }, queueTwoAndInterrupt("Failed"))
    expect(done.receipt).toEqual({ stillQueued: [], cancelled: [done.b, done.c] })
    expect(done.sent.map(([tag]) => tag)).not.toContain("CancelAsync")
    expect(done.results).toEqual([[expect.any(String)]])
  })
})

// The live host over the fake Claude Code.

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

/** The control requests the fake read, from its log. */
const requestsRead = (file: string): ReadonlyArray<Record<string, unknown>> =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l))
        .filter((e) => e.stdin?.type === "control_request")
        .map((e) => e.stdin.request)
    : []

/** Waits, at most 10 s, until the fake has read `n` user messages. */
const fakeRead = (file: string, n: number) =>
  Effect.sync(() =>
    existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .filter((l) => l.includes('"type":"user"')).length
      : 0,
  ).pipe(
    Effect.repeat({ until: (k) => k >= n, schedule: Schedule.spaced(Duration.millis(20)) }),
    Effect.timeout(Duration.seconds(10)),
  )

/** Runs `effect` with the live host over the fake, playing `scenario`, in a fresh folder. */
const overFake = <A, E>(
  scenario: Record<string, unknown>,
  effect: (log: string) => Effect.Effect<A, E, Env>,
): Promise<A> => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-queued-cancel-"))
  const log = join(dir, "fake.jsonl")
  const host = liveLayer({
    prompt: { text: "Work on TICKET_ID.", file: null },
    servers: { servers: [], note: noServersNote },
    account: { billing: { _tag: "Subscription", keyUnused: false }, subscription: true },
    env: { ...testEnv, FAKE_CLAUDE_SCENARIO: JSON.stringify({ ...scenario, log }) },
  })
  return Effect.runPromise(
    effect(log).pipe(
      Effect.provide(
        host.pipe(
          Layer.provideMerge(
            Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer(), ClaudeCode.layer),
          ),
          Layer.provideMerge(
            Layer.mergeAll(
              logLayer(),
              eventsLayer(),
              configLayer(appConfig({ claude: fake, settings: defaultSettings }, dir)),
              BunServices.layer,
            ),
          ),
        ),
      ),
    ),
  )
}

/** A CLI with interrupt receipts and without interrupt_cancel_queued_v1, as `--claude` may be. */
const noCancelQueued = { init: { capabilities: ["interrupt_receipt_v1"] } }

/** Starts t-1 over the fake, queues two of your messages behind a hanging turn, interrupts it. */
const liveQueueTwoAndInterrupt = (log: string, settled: WorkerState["_tag"]) =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    yield* host.start("t-1", {
      sessionId: "11111111-1111-4111-8111-111111111111",
      cwd: join(log, ".."),
    })
    yield* host.send("t-1", "Go.", "clientComposed")
    yield* reaches("t-1", "Working")
    const b = yield* host.send("t-1", "And this.", "human")
    const c = yield* host.send("t-1", "And that.", "human")
    yield* fakeRead(log, 3)
    const receipt = yield* host.interrupt("t-1")
    const states = yield* reaches("t-1", settled)
    return {
      b,
      c,
      receipt,
      states: states.map((s) => s._tag),
      // The start's own requests aside: its initialize, and mcp_status for the setup check.
      requests: requestsRead(log).filter(
        (r) => r.subtype !== "initialize" && r.subtype !== "mcp_status",
      ),
      ...(yield* transcript),
    }
  })

describe("the live AgentHost: an interrupt on a CLI without interrupt_cancel_queued_v1", () => {
  test("cancels each message still queued with cancel_async_message, at once; none runs", async () => {
    const done = await overFake(
      // The interrupted turn ends 300 ms after the receipt: the cancels land before the next turn.
      { ...noCancelQueued, turns: [[{ hang: true }]], interruptLag: 300 },
      (log) => liveQueueTwoAndInterrupt(log, "Failed"),
    )
    expect(done.receipt).toEqual({ stillQueued: [], cancelled: [done.b, done.c] })
    expect(done.requests).toEqual([
      { subtype: "interrupt" },
      { subtype: "cancel_async_message", message_uuid: done.b },
      { subtype: "cancel_async_message", message_uuid: done.c },
    ])
    expect(done.states.at(-1)).toBe("Failed")
    expect(done.cancelled).toEqual([done.b, done.c])
    expect(done.results).toEqual([[expect.any(String)]])
  })

  test("a message it answers cancelled: false for runs, and the worker waits for it", async () => {
    const done = await overFake(
      { ...noCancelQueued, turns: [[{ hang: true }]], cancelAsync: "notQueued" },
      (log) => liveQueueTwoAndInterrupt(log, "Idle"),
    )
    expect(done.receipt).toEqual({ stillQueued: [done.b, done.c], cancelled: [] })
    expect(done.states).not.toContain("Failed")
    expect(done.results).toEqual([[expect.any(String)], [done.b, done.c]])
  })

  test("a message whose cancel the CLI refuses runs", async () => {
    const done = await overFake(
      { ...noCancelQueued, turns: [[{ hang: true }]], cancelAsync: "refuse" },
      (log) => liveQueueTwoAndInterrupt(log, "Idle"),
    )
    expect(done.receipt).toEqual({ stillQueued: [done.b, done.c], cancelled: [] })
    expect(done.results).toEqual([[expect.any(String)], [done.b, done.c]])
  })

  test("where the CLI advertises it, the interrupt cancels them and no cancel is sent", async () => {
    const done = await overFake({ turns: [[{ hang: true }]] }, (log) =>
      liveQueueTwoAndInterrupt(log, "Failed"),
    )
    expect(done.receipt).toEqual({ stillQueued: [], cancelled: [done.b, done.c] })
    expect(done.requests).toEqual([{ subtype: "interrupt", cancel_queued: true }])
    expect(done.results).toEqual([[expect.any(String)]])
  })
})
