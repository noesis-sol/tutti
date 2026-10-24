// Sends folded into the running turn, coalesced into one queued turn, or answered by none (§ 4.1):
// a worker stays Working until each of tutti's sends is listed, whichever way it ran (§ 4.2). The
// reducer, the scripted sessions (src/testing/AgentHost.ts) and the fake Claude Code
// (test/fixtures/fake-claude/claude.ts) under the live host.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Duration, Effect, Fiber, Layer, Option, Schedule, Stream } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import { Attention } from "../src/agent/Attention.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { noServersNote } from "../src/agent/mcp.ts"
import { read } from "../src/agent/reading.ts"
import type { Transcripts } from "../src/agent/Transcripts.ts"
import {
  initial,
  settled,
  step,
  type Worker,
  WorkerEvent,
  type WorkerState,
} from "../src/agent/WorkerState.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import type { Log } from "../src/run/log.ts"
import {
  backgroundCommand,
  backgroundTasks,
  canUseTool,
  coalescedTurn,
  fold,
  layer as hostLayer,
  init,
  type Recording,
  result,
  run,
  type Script,
  selfStartedTurn,
  sessionState,
  sleep,
  taskEnds,
  tool,
  turn,
  wait,
} from "../src/testing/AgentHost.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { Files, layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"
import { workersIn } from "./workerEnv.ts"

// The live host's tests start the fake Claude Code as a process, about half a second on an idle
// machine: bun's 5 s default fails them when other checks run beside this one.
setDefaultTimeout(30_000)

// The reducer's events, as test/worker-state.test.ts has them.
const sdk = (message: object): WorkerEvent =>
  WorkerEvent.Message({ session: "s", reading: read(message as unknown as SDKMessage) })
const initEvent = sdk({ type: "system", subtype: "init", permissionMode: "auto", session_id: "s" })
const running = sdk({ type: "system", subtype: "session_state_changed", state: "running" })
const idle = sdk({ type: "system", subtype: "session_state_changed", state: "idle" })
const resultEvent = (uuids: ReadonlyArray<string>) =>
  sdk({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "DONE",
    num_turns: 1,
    user_message_uuids: uuids,
  })
const sent = (uuid: string) => WorkerEvent.Sent({ session: "s", uuid })
const lifecycle = (uuid: string, state: "queued" | "started" | "completed") =>
  sdk({ type: "command_lifecycle", command_uuid: uuid, state })

const foldEvents = (events: ReadonlyArray<WorkerEvent>): Worker =>
  events.reduce((w, event, n) => step(w, event, n), initial())
const stateAfter = (...events: ReadonlyArray<WorkerEvent>) => foldEvents(events).state

describe("WorkerState: each send is outstanding until a result lists it", () => {
  const [a, b, c] = ["u-a", "u-b", "u-c"]

  test("sends folded into the running turn: Working until its result lists every one", () => {
    const turn = [sent(a), running, initEvent, sent(b), sent(c)]
    expect(stateAfter(...turn, resultEvent([a, b]), idle)._tag).toBe("Working")
    expect(stateAfter(...turn, resultEvent([a, b, c]), idle)._tag).toBe("Idle")
    // command_lifecycle names each folded send, and ends it as well.
    const ended = [lifecycle(a, "completed"), lifecycle(b, "completed")]
    expect(stateAfter(...turn, resultEvent([]), ...ended, idle)._tag).toBe("Working")
    expect(
      stateAfter(...turn, resultEvent([]), ...ended, lifecycle(c, "completed"), idle)._tag,
    ).toBe("Idle")
  })

  test("queued sends sharing a turn: Working until the shared turn's result lists them", () => {
    const first = [sent(a), running, initEvent, sent(b), sent(c), resultEvent([a])]
    expect(stateAfter(...first)._tag).toBe("Working")
    const shared = [initEvent, resultEvent([b, c])]
    expect(stateAfter(...first, ...shared)._tag).toBe("Working")
    expect(stateAfter(...first, ...shared, idle)._tag).toBe("Idle")
  })

  test("a turn the CLI starts by itself lists none: a send pushed meanwhile stays outstanding", () => {
    const report = [sent(a), running, initEvent, resultEvent([a]), idle]
    expect(stateAfter(...report)._tag).toBe("Idle")
    const selfStarted = [running, initEvent, sent(b), resultEvent([]), idle]
    expect(stateAfter(...report, ...selfStarted)._tag).toBe("Working")
    expect(stateAfter(...report, ...selfStarted, initEvent, resultEvent([b]), idle)._tag).toBe(
      "Idle",
    )
  })

  test("however sends are folded, coalesced or left for later turns, Idle only once all are listed", () => {
    // Each send is pushed in one turn and listed in that turn's result (folded) or a later one
    // (queued, perhaps sharing it); some turns list none. Each turn ends with an idle, as when a
    // send arrives just as a turn ends, so only the outstanding sends keep the worker Working.
    const sends = fc.integer({ min: 1, max: 5 }).chain((turns) =>
      fc.record({
        turns: fc.constant(turns),
        sends: fc.array(
          fc
            .tuple(fc.nat(turns - 1), fc.nat(2))
            .map(([pushed, lag]) => ({ pushed, listed: Math.min(pushed + lag, turns - 1) })),
          { minLength: 1, maxLength: 6 },
        ),
        lifecycles: fc.boolean(),
      }),
    )
    fc.assert(
      fc.property(sends, ({ turns, sends, lifecycles }) => {
        const uuid = (i: number) => `u-${i}`
        let events: Array<WorkerEvent> = []
        for (let t = 0; t < turns; t++) {
          const listed = sends.flatMap((s, i) => (s.listed === t ? [uuid(i)] : []))
          events = [
            ...events,
            running,
            initEvent,
            ...sends.flatMap((s, i) => (s.pushed === t ? [sent(uuid(i))] : [])),
            ...(lifecycles ? listed.map((u) => lifecycle(u, "started")) : []),
            resultEvent(listed),
            ...(lifecycles ? listed.map((u) => lifecycle(u, "completed")) : []),
            idle,
          ]
          const answered = sends.every((s) => s.pushed > t || s.listed <= t)
          expect(settled(foldEvents(events).state)).toBe(answered)
        }
      }),
    )
  })
})

// Scripted sessions.

type ScriptedEnv = AgentHost | Recording | Attention | Transcripts | Files | Log | EventStream

const scripted = <A, E>(
  scripts: Readonly<Record<string, Script>>,
  effect: Effect.Effect<A, E, ScriptedEnv>,
): Promise<A> =>
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

const scriptedSession = { sessionId: "s-1", cwd: "/work/t-1" }

/** Watches the ticket's state, from now until it is Idle: a fiber with the states seen. */
const untilIdle = (ticket: string) =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    const listening = yield* Deferred.make<void>()
    const fiber = yield* host.state(ticket).pipe(
      Stream.tap(() => Deferred.succeed(listening, undefined)),
      Stream.takeUntil((s) => s._tag === "Idle"),
      Stream.runCollect,
      Effect.forkChild,
    )
    yield* Deferred.await(listening)
    return fiber
  })

const until = (ticket: string, tag: WorkerState["_tag"]) =>
  Effect.flatMap(AgentHost, (host) =>
    host.state(ticket).pipe(
      Stream.takeUntil((s) => s._tag === tag),
      Stream.runDrain,
    ),
  )

/** The transcript's raw messages: the results' sends, each send's lifecycle, the idles. */
const transcript = Effect.gen(function* () {
  const raw = (yield* (yield* Files).messages("t-1")).map(
    (item) => item.message as unknown as Record<string, unknown>,
  )
  return {
    results: raw.filter((m) => m.type === "result").map((m) => m.user_message_uuids),
    lifecycle: (uuid: string) =>
      raw
        .filter((m) => m.type === "command_lifecycle" && m.command_uuid === uuid)
        .map((m) => m.state),
    idles: raw.filter((m) => m.subtype === "session_state_changed" && m.state === "idle").length,
  }
})

describe("scripted sessions: folded, coalesced and self-started turns", () => {
  test("fold takes every send waiting into the running turn; its one result lists them all", async () => {
    const script = [
      wait,
      init(),
      sessionState("running"),
      canUseTool("Bash", { command: "make" }),
      fold,
      result(),
      sessionState("idle"),
    ]
    const done = await scripted(
      { "t-1": [script] },
      Effect.gen(function* () {
        const host = yield* AgentHost
        const attention = yield* Attention
        yield* host.start("t-1", scriptedSession)
        const first = yield* host.send("t-1", "Go.", "clientComposed")
        yield* until("t-1", "NeedsYou")
        const second = yield* host.send("t-1", "Also this.", "clientComposed")
        const third = yield* host.send("t-1", "And this.", "human")
        const states = yield* untilIdle("t-1")
        yield* attention.answer("r1", { _tag: "Allow" }, "screen")
        return {
          sends: [first, second, third],
          states: yield* Fiber.join(states),
          ...(yield* transcript),
        }
      }),
    )
    expect(done.states.map((s) => s._tag)).toEqual(["NeedsYou", "Working", "Idle"])
    expect(done.results).toEqual([done.sends])
    for (const uuid of done.sends) {
      expect(done.lifecycle(uuid)).toEqual(["queued", "started", "completed"])
    }
    expect(done.idles).toBe(1)
  })

  test("a folded send the result doesn't list keeps the worker Working", async () => {
    const played = Deferred.makeUnsafe<void>()
    const script = [
      wait,
      init(),
      sessionState("running"),
      canUseTool("Bash", { command: "make" }),
      fold,
      result("DONE", { user_message_uuids: [] }),
      sessionState("idle"),
      run(Deferred.succeed(played, undefined)),
    ]
    const state = await scripted(
      { "t-1": [script] },
      Effect.gen(function* () {
        const host = yield* AgentHost
        const attention = yield* Attention
        yield* host.start("t-1", scriptedSession)
        yield* host.send("t-1", "Go.", "clientComposed")
        yield* until("t-1", "NeedsYou")
        yield* host.send("t-1", "Also this.", "clientComposed")
        yield* attention.answer("r1", { _tag: "Allow" }, "screen")
        yield* Deferred.await(played)
        return yield* host.current("t-1")
      }),
    )
    expect(state._tag).toBe("Working")
  })

  test("coalesce shares a turn among the queued sends of one kind; the other kind waits", async () => {
    const script = [
      wait,
      init(),
      sessionState("running"),
      canUseTool("Bash", { command: "make" }),
      result(),
      sessionState("idle"),
      ...coalescedTurn([]),
      ...coalescedTurn([]),
      ...coalescedTurn([]),
    ]
    const done = await scripted(
      { "t-1": [script] },
      Effect.gen(function* () {
        const host = yield* AgentHost
        const attention = yield* Attention
        yield* host.start("t-1", scriptedSession)
        const go = yield* host.send("t-1", "Go.", "clientComposed")
        yield* until("t-1", "NeedsYou")
        const a = yield* host.send("t-1", "a", "clientComposed")
        const b = yield* host.send("t-1", "b", "clientComposed")
        const c = yield* host.send("t-1", "/context", "human")
        const d = yield* host.send("t-1", "d", "clientComposed")
        const states = yield* untilIdle("t-1")
        yield* attention.answer("r1", { _tag: "Allow" }, "screen")
        return { go, a, b, c, d, states: yield* Fiber.join(states), ...(yield* transcript) }
      }),
    )
    // Idle only after the last queued turn, never between them.
    expect(done.states.map((s) => s._tag)).toEqual(["NeedsYou", "Working", "Idle"])
    expect(done.results).toEqual([[done.go], [done.a, done.b], [done.c], [done.d]])
    expect(done.lifecycle(done.b)).toEqual(["queued", "started", "completed"])
    expect(done.idles).toBe(1)
  })

  test("a send pushed during a self-started report turn is Working until its own turn lists it", async () => {
    const script = [
      ...turn([
        ...tool("Bash", { command: "make", run_in_background: true }),
        backgroundTasks({ id: "b1" }),
      ]),
      sleep("1 minute"),
      ...taskEnds("b1"),
      ...selfStartedTurn([canUseTool("Read", { file_path: "/tmp/tasks/b1.output" })]),
      ...turn([]),
    ]
    const done = await scripted(
      { "t-1": [script] },
      Effect.gen(function* () {
        const host = yield* AgentHost
        const attention = yield* Attention
        yield* host.start("t-1", scriptedSession)
        const go = yield* host.send("t-1", "Go.", "clientComposed")
        // The first adjust lets the script reach its sleep, which the second passes.
        yield* TestClock.adjust("1 second")
        yield* TestClock.adjust("2 minutes")
        yield* until("t-1", "NeedsYou")
        const later = yield* host.send("t-1", "Continue.", "clientComposed")
        const states = yield* untilIdle("t-1")
        yield* attention.answer("r1", { _tag: "Allow" }, "screen")
        return { go, later, states: yield* Fiber.join(states), ...(yield* transcript) }
      }),
    )
    expect(done.states.map((s) => s._tag)).toEqual(["NeedsYou", "Working", "Idle"])
    // The report's turn lists none of tutti's sends.
    expect(done.results).toEqual([[done.go], [], [done.later]])
  })

  test("the helper backgroundCommand's report turn lists no send", async () => {
    const results = await scripted(
      { "t-1": [backgroundCommand("make", "1 minute")] },
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start("t-1", scriptedSession)
        yield* host.send("t-1", "Go.", "clientComposed")
        const states = yield* untilIdle("t-1")
        // The first adjust lets the script reach its sleep, which the second passes.
        yield* TestClock.adjust("1 second")
        yield* TestClock.adjust("2 minutes")
        yield* Fiber.join(states)
        return (yield* transcript).results
      }),
    )
    expect(results).toEqual([[expect.any(String)], []])
  })
})

// The fake Claude Code under the live host, as in test/agent-host-live.test.ts.

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

type LiveEnv = AgentHost | Attention | Transcripts | Files | Log | EventStream

/** The user messages the fake read, from its log. */
const usersRead = (file: string): number =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l))
        .filter((e) => e.stdin?.type === "user").length
    : 0

const live = <A, E>(
  turns: ReadonlyArray<ReadonlyArray<object>>,
  effect: (where: { dir: string; log: string }) => Effect.Effect<A, E, LiveEnv>,
): Promise<A> => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-folded-sends-"))
  const where = { dir, log: join(dir, "fake.jsonl") }
  const config = appConfig({ claude: fake, settings: defaultSettings }, dir)
  const host = liveLayer({
    prompt: { text: "Work on TICKET_ID.", file: null },
    servers: { servers: [], note: noServersNote },
    account: { billing: { _tag: "Subscription", keyUnused: false } },
  })
  return Effect.runPromise(
    effect(where).pipe(
      Effect.provide(
        host.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              attentionLayer(waitForTest),
              transcriptsLayer(),
              ClaudeCode.layer.pipe(
                Layer.provide(
                  workersIn({
                    ...testEnv,
                    FAKE_CLAUDE_SCENARIO: JSON.stringify({ turns, log: where.log }),
                  }),
                ),
              ),
            ),
          ),
          Layer.provideMerge(
            Layer.mergeAll(logLayer(), eventsLayer(), configLayer(config), BunServices.layer),
          ),
        ),
      ),
    ),
  )
}

const liveSession = (dir: string) => ({
  sessionId: "11111111-1111-4111-8111-111111111111",
  cwd: dir,
})

/** Waits, at most 10 s, for the ticket's worker to reach a state with `tag`. */
const reaches = (ticket: string, tag: WorkerState["_tag"]) =>
  Effect.flatMap(AgentHost, (host) =>
    host.state(ticket).pipe(
      Stream.filter((s) => s._tag === tag),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
      Effect.timeoutOrElse({
        duration: Duration.seconds(10),
        orElse: () => Effect.die(`${ticket} never reached ${tag}`),
      }),
    ),
  )

/** Waits, at most 10 s, until the fake has read `n` user messages. */
const fakeRead = (log: string, n: number) =>
  Effect.sync(() => usersRead(log)).pipe(
    Effect.repeat({ until: (k) => k >= n, schedule: Schedule.spaced(Duration.millis(20)) }),
    Effect.timeout(Duration.seconds(10)),
  )

/** The results' text and sends, and the idles, from the transcript. */
const liveTranscript = Effect.gen(function* () {
  const raw = (yield* (yield* Files).messages("t-1")).map(
    (item) => item.message as unknown as Record<string, unknown>,
  )
  return {
    results: raw.filter((m) => m.type === "result").map((m) => [m.result, m.user_message_uuids]),
    completed: raw.filter((m) => m.type === "command_lifecycle" && m.state === "completed").length,
    idles: raw.filter((m) => m.subtype === "session_state_changed" && m.state === "idle").length,
  }
})

const permission = { permission: { tool_name: "Bash", input: { command: "make" } } }

describe("the fake Claude Code: folded, coalesced and self-started turns", () => {
  test("a wait step folds the queued messages into the running turn", async () => {
    const done = await live([[permission, { wait: true }]], ({ dir, log }) =>
      Effect.gen(function* () {
        const host = yield* AgentHost
        const attention = yield* Attention
        yield* host.start("t-1", liveSession(dir))
        const first = yield* host.send("t-1", "first", "clientComposed")
        yield* reaches("t-1", "NeedsYou")
        const second = yield* host.send("t-1", "second", "clientComposed")
        const third = yield* host.send("t-1", "third", "human")
        yield* fakeRead(log, 3)
        yield* attention.answer("r1", { _tag: "Allow" }, "screen")
        yield* reaches("t-1", "Idle")
        return { sends: [first, second, third], ...(yield* liveTranscript) }
      }),
    )
    expect(done.results).toEqual([["PERMISSION: allow", done.sends]])
    expect(done.completed).toBe(3)
    expect(done.idles).toBe(1)
  })

  test("queued messages share a turn only with those of their kind", async () => {
    const done = await live([[permission]], ({ dir, log }) =>
      Effect.gen(function* () {
        const host = yield* AgentHost
        const attention = yield* Attention
        yield* host.start("t-1", liveSession(dir))
        const go = yield* host.send("t-1", "go", "clientComposed")
        yield* reaches("t-1", "NeedsYou")
        const a = yield* host.send("t-1", "a", "clientComposed")
        const b = yield* host.send("t-1", "b", "human")
        const c = yield* host.send("t-1", "c", "human")
        yield* fakeRead(log, 4)
        yield* attention.answer("r1", { _tag: "Allow" }, "screen")
        yield* reaches("t-1", "Idle")
        return { go, a, b, c, ...(yield* liveTranscript) }
      }),
    )
    expect(done.results).toEqual([
      ["PERMISSION: allow", [done.go]],
      ["ECHO: a", [done.a]],
      ["ECHO: b\nc", [done.b, done.c]],
    ])
    expect(done.idles).toBe(1)
  })

  test("a background task's report is a turn of the fake's own, listing no message", async () => {
    const done = await live([[{ background: "b1" }, { text: "Started it." }]], ({ dir }) =>
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start("t-1", liveSession(dir))
        const go = yield* host.send("t-1", "go", "clientComposed")
        // The task is live, then its report is to come: Idle only after the report's turn.
        yield* reaches("t-1", "Idle")
        return { go, ...(yield* liveTranscript) }
      }),
    )
    expect(done.results).toEqual([
      ["Started it.", [done.go]],
      ["REPORTED", []],
    ])
    expect(done.idles).toBe(2)
  })
})
