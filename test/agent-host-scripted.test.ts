import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import { AgentHost, type SessionMessage, userMessage } from "../src/agent/AgentHost.ts"
import { Attention, type Policy } from "../src/agent/Attention.ts"
import type { Transcripts } from "../src/agent/Transcripts.ts"
import { WorkerState } from "../src/agent/WorkerState.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import type { Log } from "../src/run/log.ts"
import {
  apiErrorResult,
  apiRetry,
  asksPermission,
  awaitInterrupt,
  backgroundTasks,
  bash,
  canUseTool,
  checkCommand,
  claimsAndCloses,
  defers,
  elicit,
  failStart,
  filesQuestion,
  gone,
  hitsUsageLimit,
  layer as hostLayer,
  init,
  interruptedResult,
  type Options,
  Recording,
  result,
  type Script,
  Sent,
  selfStartedTurn,
  sessionState,
  sleep,
  taskEnds,
  turn,
  wait,
} from "../src/testing/AgentHost.ts"
import { allowAll, layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { Files, layer as transcriptsLayer } from "../src/testing/Transcripts.ts"

type Env = AgentHost | Recording | Attention | Transcripts | Files | Log | EventStream

/** Runs `effect` with the scripted host playing `scripts`, under TestClock. */
const run = <A, E>(
  scripts: Readonly<Record<string, Script>>,
  effect: Effect.Effect<A, E, Env>,
  policy: Policy = waitForTest,
  options: Options = {},
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        hostLayer(scripts, { checks: [checkCommand], ...options }).pipe(
          Layer.provideMerge(Layer.mergeAll(attentionLayer(policy), transcriptsLayer())),
          Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer())),
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

const session = (sessionId = "s-1") => ({ sessionId, cwd: "/work/t-1" })

/**
 * Watches the ticket's worker's state: a fiber collecting its first `n` states, already listening
 * when it is returned.
 */
const watch = (ticket: string, n: number) =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    const listening = yield* Deferred.make<void>()
    const fiber = yield* host.state(ticket).pipe(
      Stream.tap(() => Deferred.succeed(listening, undefined)),
      Stream.take(n),
      Stream.runCollect,
      Effect.forkChild,
    )
    yield* Deferred.await(listening)
    return fiber
  })

/** Starts the ticket's worker, sends it its first message, and gives its first `n` states. */
const startAndWatch = (ticket: string, n: number) =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    yield* host.start(ticket, session())
    const states = yield* watch(ticket, n)
    yield* host.send(ticket, `Your ticket is ${ticket}.`, "clientComposed")
    return yield* Fiber.join(states)
  })

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

const working = WorkerState.Working({ doing: "working" })

describe("the helper scripts drive WorkerState", () => {
  test("claims and closes its ticket with a commit", async () => {
    const did: Array<string> = []
    const note = (what: string) => Effect.sync(() => void did.push(what))
    const script = claimsAndCloses("t-1", {
      claim: note("claim"),
      commit: note("commit"),
      close: note("close"),
    })
    const states = await run({ "t-1": [script] }, startAndWatch("t-1", 7))
    expect(states).toEqual([
      WorkerState.Starting(),
      working,
      WorkerState.Working({ doing: "editing" }),
      working,
      WorkerState.Working({ doing: "testing" }),
      working,
      WorkerState.Idle({ at: 0 }),
    ])
    expect(did).toEqual(["claim", "commit", "close"])
  })

  test("defers", async () => {
    const states = await run({ "t-1": [defers("t-1")] }, startAndWatch("t-1", 3))
    expect(states).toEqual([WorkerState.Starting(), working, WorkerState.Idle({ at: 0 })])
  })

  test("files a question", async () => {
    const states = await run({ "t-1": [filesQuestion("t-1")] }, startAndWatch("t-1", 3))
    expect(states).toEqual([WorkerState.Starting(), working, WorkerState.Idle({ at: 0 })])
  })

  test("asks permission: NeedsYou until the request is answered through Attention", async () => {
    const done = await run(
      { "t-1": [asksPermission({ options: { defaultToNo: true } })] },
      Effect.gen(function* () {
        const host = yield* AgentHost
        const attention = yield* Attention
        yield* host.start("t-1", session())
        const states = yield* watch("t-1", 5)
        yield* host.send("t-1", "Go.", "clientComposed")
        yield* host.state("t-1").pipe(
          Stream.takeUntil((s) => s._tag === "NeedsYou"),
          Stream.runDrain,
        )
        const open = yield* attention.current
        yield* attention.answer("r1", { _tag: "Allow" }, "screen")
        return { states: yield* Fiber.join(states), open, sent: yield* (yield* Recording).all }
      }),
    )
    expect(done.states).toEqual([
      WorkerState.Starting(),
      working,
      WorkerState.NeedsYou({ requests: 1 }),
      working,
      WorkerState.Idle({ at: 0 }),
    ])
    expect(done.open.map((r) => [r.ticket, r.defaultToNo, r.kind._tag])).toEqual([
      ["t-1", true, "Permission"],
    ])
    const answered = done.sent.find((s) => s._tag === "Answered")
    expect(answered).toMatchObject({
      ticket: "t-1",
      toolName: "Bash",
      result: { behavior: "allow", updatedInput: { command: "rm -rf build" } },
    })
  })

  test("hits the usage limit: Retrying, then UsageLimited until its reset", async () => {
    const states = await run({ "t-1": [hitsUsageLimit(1_800_000_000)] }, startAndWatch("t-1", 5))
    expect(states).toEqual([
      WorkerState.Starting(),
      working,
      WorkerState.Retrying({ attempt: 1, max: 10, status: 429 }),
      working,
      WorkerState.UsageLimited({ resetsAt: 1_800_000_000_000 }),
    ])
  })
})

describe("scripted cases", () => {
  test("an is_error result is a failed turn: Failed, not Idle", async () => {
    const failed = WorkerState.Failed({ at: 0, error: "API Error: 500", interrupted: false })
    const script = turn([apiRetry(2, 500)], apiErrorResult("API Error: 500", 500))
    const done = await run(
      { "t-1": [script] },
      Effect.gen(function* () {
        const states = yield* startAndWatch("t-1", 5)
        return { states, now: yield* (yield* AgentHost).current("t-1") }
      }),
    )
    // The result ends the turn; idle after it ends the worker's work.
    expect(done.states).toEqual([
      WorkerState.Starting(),
      working,
      WorkerState.Retrying({ attempt: 2, max: 10, status: 500 }),
      working,
      failed,
    ])
    expect(done.now).toEqual(failed)
  })

  test("a live background task keeps it Working; ambient ones don't count", async () => {
    const script = [
      wait,
      init(),
      sessionState("running"),
      backgroundTasks({ id: "b1" }, { id: "watch", ambient: true }),
      result(),
      sessionState("idle"),
      sleep("1 minute"),
      ...taskEnds("b1", { id: "watch", ambient: true }),
      ...selfStartedTurn(),
    ]
    const states = await run(
      { "t-1": [script] },
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start("t-1", session())
        const states = yield* watch("t-1", 3)
        yield* host.send("t-1", "Go.", "clientComposed")
        yield* TestClock.adjust("30 seconds")
        expect(yield* host.current("t-1")).toEqual(working)
        // b1 ends at 60 s; until the turn reporting it starts, 70 ms later, its report is to come.
        yield* TestClock.adjust("30 seconds")
        expect(yield* host.current("t-1")).toEqual(working)
        yield* TestClock.adjust("70 millis")
        return yield* Fiber.join(states)
      }),
    )
    expect(states).toEqual([WorkerState.Starting(), working, WorkerState.Idle({ at: 60_070 })])
  })

  test("only ambient tasks: Idle as the turn ends", async () => {
    const script = turn([backgroundTasks({ id: "watch", ambient: true })])
    const states = await run({ "t-1": [script] }, startAndWatch("t-1", 3))
    expect(states).toEqual([WorkerState.Starting(), working, WorkerState.Idle({ at: 0 })])
  })

  test("a session that goes is Gone, takes no message, and resumes once scripted", async () => {
    const done = await run(
      { "t-1": [[wait, init(), gone("the subprocess exited")], turn([])] },
      Effect.gen(function* () {
        const host = yield* AgentHost
        const states = yield* startAndWatch("t-1", 3)
        const send = yield* Effect.exit(host.send("t-1", "Hello?", "human"))
        const interrupt = yield* Effect.exit(host.interrupt("t-1"))
        const resumed = yield* watch("t-1", 4)
        yield* host.resume("t-1", session(), { text: "Carry on.", from: "clientComposed" })
        return { states, send, interrupt, resumed: yield* Fiber.join(resumed) }
      }),
    )
    expect(done.states).toEqual([
      WorkerState.Starting(),
      working,
      WorkerState.Gone({ why: "the subprocess exited" }),
    ])
    expect(Exit.isFailure(done.send) && JSON.stringify(done.send.cause)).toContain("AgentGone")
    expect(Exit.isFailure(done.interrupt) && JSON.stringify(done.interrupt.cause)).toContain(
      "AgentGone",
    )
    expect(done.resumed).toEqual([
      WorkerState.Gone({ why: "the subprocess exited" }),
      WorkerState.Starting(),
      working,
      WorkerState.Idle({ at: 0 }),
    ])
  })

  test("a turn waits for a message; a sleep waits for the clock", async () => {
    const script = turn([sleep("10 minutes")])
    await run(
      { "t-1": [script] },
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start("t-1", session())
        yield* TestClock.adjust("1 hour")
        expect(yield* host.current("t-1")).toEqual(WorkerState.Starting())
        yield* host.send("t-1", "Go.", "clientComposed")
        yield* host.state("t-1").pipe(
          Stream.takeUntil((s) => s._tag === "Working"),
          Stream.runDrain,
        )
        yield* TestClock.adjust("9 minutes")
        expect(yield* host.current("t-1")).toEqual(working)
        yield* TestClock.adjust("1 minute")
        yield* host.state("t-1").pipe(
          Stream.takeUntil((s) => s._tag === "Idle"),
          Stream.runDrain,
        )
        expect(yield* host.current("t-1")).toEqual(WorkerState.Idle({ at: 70 * 60_000 }))
      }),
    )
  })

  test("a start that fails: AgentStartFailed with the startup failure reason, and Gone", async () => {
    const done = await run(
      { "t-1": [[failStart("the worktree is gone", "cwd_unavailable")]] },
      Effect.gen(function* () {
        const host = yield* AgentHost
        const started = yield* Effect.flip(host.start("t-1", session()))
        const again = yield* Effect.flip(host.start("t-1", session("s-2")))
        return { started, again, now: yield* host.current("t-1") }
      }),
    )
    expect(done.started._tag).toBe("AgentStartFailed")
    expect(done.started).toMatchObject({
      ticket: "t-1",
      reason: "the worktree is gone",
      startupFailureReason: "cwd_unavailable",
    })
    expect(done.again.reason).toBe("the script has no more sessions")
    expect(done.now).toEqual(WorkerState.Gone({ why: "the worktree is gone" }))
  })

  test("a second start while a session is open fails", async () => {
    const failed = await run(
      { "t-1": [turn([]), turn([])] },
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start("t-1", session())
        return yield* Effect.flip(host.start("t-1", session("s-2")))
      }),
    )
    expect(failed.reason).toBe("a session is already open")
  })

  test("an elicitation is answered through Attention", async () => {
    const script = turn([
      elicit({ serverName: "linear", message: "Log in", mode: "url", url: "https://x.test" }),
    ])
    const sent = await run(
      { "t-1": [script] },
      Effect.gen(function* () {
        yield* startAndWatch("t-1", 3)
        return yield* (yield* Recording).sentTo("t-1")
      }),
      allowAll,
    )
    expect(sent.find((s) => s._tag === "Elicited")).toMatchObject({ result: { action: "accept" } })
  })
})

describe("what it was sent", () => {
  test("messages carry client_composed or origin human, with uuids and the session's ID", async () => {
    const done = await run(
      { "t-1": [turn([])] },
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start("t-1", session())
        const first = yield* host.send("t-1", "Your ticket is t-1.", "clientComposed")
        const second = yield* host.send("t-1", "/context", "human")
        return { first, second, messages: yield* (yield* Recording).messages("t-1") }
      }),
    )
    expect(done.first).not.toBe(done.second)
    expect(done.messages).toEqual([
      userMessage(
        { text: "Your ticket is t-1.", from: "clientComposed" },
        done.first as never,
        "s-1",
      ),
      userMessage({ text: "/context", from: "human" }, done.second as never, "s-1"),
    ])
    expect(done.messages[0]?.client_composed).toBe(true)
    expect(done.messages[0]?.origin).toBeUndefined()
    expect(done.messages[1]?.client_composed).toBeUndefined()
    expect(done.messages[1]?.origin).toEqual({ kind: "human" })
  })

  test("an interrupt withdraws the open request and its receipt cancels what is queued", async () => {
    const script = [
      wait,
      init(),
      sessionState("running"),
      canUseTool("Bash", { command: "sleep 60" }),
      awaitInterrupt,
      interruptedResult,
      sessionState("idle"),
    ]
    const done = await run(
      { "t-1": [script] },
      Effect.gen(function* () {
        const host = yield* AgentHost
        const attention = yield* Attention
        yield* host.start("t-1", session())
        yield* host.send("t-1", "Go.", "clientComposed")
        yield* host.state("t-1").pipe(
          Stream.takeUntil((s) => s._tag === "NeedsYou"),
          Stream.runDrain,
        )
        const queued = yield* host.send("t-1", "And then this.", "human")
        const receipt = yield* host.interrupt("t-1")
        const stopped = yield* host.state("t-1").pipe(
          Stream.takeUntil((s) => s._tag === "Failed"),
          Stream.runLast,
        )
        const open = yield* attention.current
        yield* host.close("t-1")
        yield* host.close("t-1")
        return {
          queued,
          receipt,
          stopped,
          open,
          now: yield* host.current("t-1"),
          sent: yield* (yield* Recording).sentTo("t-1"),
        }
      }),
      waitForTest,
      { cancelQueued: true },
    )
    // Cancelled, the queued message is no longer outstanding: the interrupted worker settles.
    expect(done.receipt).toEqual({ stillQueued: [], cancelled: [done.queued] })
    expect(Option.getOrNull(done.stopped)).toMatchObject({ _tag: "Failed", interrupted: true })
    expect(done.open).toEqual([])
    expect(done.now).toEqual(WorkerState.Closed())
    expect(done.sent.map((s) => s._tag)).toEqual([
      "Started",
      "Message",
      "Message",
      "Interrupted",
      "Answered",
      "Closed",
    ])
    const answered = done.sent[4]
    expect(answered?._tag === "Answered" && answered.result?.behavior).toBe("deny")
  })

  test("a message still queued that the CLI won't cancel runs after the interrupted turn", async () => {
    const script = [
      wait,
      init(),
      sessionState("running"),
      canUseTool("Bash", { command: "sleep 60" }),
      awaitInterrupt,
      interruptedResult,
      sessionState("idle"),
      ...turn([]),
    ]
    const done = await run(
      { "t-1": [script] },
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start("t-1", session())
        yield* host.send("t-1", "Go.", "clientComposed")
        yield* host.state("t-1").pipe(
          Stream.takeUntil((s) => s._tag === "NeedsYou"),
          Stream.runDrain,
        )
        const queued = yield* host.send("t-1", "And then this.", "human")
        const states = yield* untilIdle("t-1")
        const receipt = yield* host.interrupt("t-1")
        return {
          queued,
          receipt,
          states: yield* Fiber.join(states),
          transcript: yield* (yield* Files).messages("t-1"),
        }
      }),
      waitForTest,
      { cancelAsync: "refuse" },
    )
    expect(done.receipt).toEqual({ stillQueued: [done.queued], cancelled: [] })
    // The queued message is outstanding through the interrupted turn: Working, never Failed.
    expect(done.states.map((s) => s._tag)).toEqual(["NeedsYou", "Working", "Idle"])
    const raw = done.transcript.map((item) => item.message as unknown as Record<string, unknown>)
    expect(raw.filter((m) => m.type === "result").map((m) => m.user_message_uuids)).toEqual([
      [expect.any(String)],
      [done.queued],
    ])
    expect(raw.filter((m) => m.subtype === "session_state_changed" && m.state === "idle")).toEqual([
      expect.anything(),
    ])
  })

  test("each send has its command_lifecycle; idle waits for the last queued turn", async () => {
    const script = [
      wait,
      init(),
      sessionState("running"),
      canUseTool("Bash", { command: "sleep 60" }),
      result(),
      sessionState("idle"),
      ...turn([]),
    ]
    const done = await run(
      { "t-1": [script] },
      Effect.gen(function* () {
        const host = yield* AgentHost
        const attention = yield* Attention
        yield* host.start("t-1", session())
        const first = yield* host.send("t-1", "Go.", "clientComposed")
        yield* host.state("t-1").pipe(
          Stream.takeUntil((s) => s._tag === "NeedsYou"),
          Stream.runDrain,
        )
        const second = yield* host.send("t-1", "Continue.", "clientComposed")
        const states = yield* untilIdle("t-1")
        yield* attention.answer("r1", { _tag: "Allow" }, "screen")
        return {
          first,
          second,
          states: yield* Fiber.join(states),
          transcript: yield* (yield* Files).messages("t-1"),
        }
      }),
    )
    expect(done.states.map((s) => s._tag)).toEqual(["NeedsYou", "Working", "Idle"])
    const raw = done.transcript.map((item) => item.message as unknown as Record<string, unknown>)
    const lifecycle = (uuid: string) =>
      raw
        .filter((m) => m.type === "command_lifecycle" && m.command_uuid === uuid)
        .map((m) => m.state)
    expect(lifecycle(done.first)).toEqual(["queued", "started", "completed"])
    expect(lifecycle(done.second)).toEqual(["queued", "started", "completed"])
    expect(raw.filter((m) => m.type === "result").map((m) => m.user_message_uuids)).toEqual([
      [done.first],
      [done.second],
    ])
    // The first turn's idle is held back: the CLI says idle once, after the last queued turn.
    expect(raw.at(-1)).toMatchObject({ subtype: "session_state_changed", state: "idle" })
    expect(raw.filter((m) => m.subtype === "session_state_changed" && m.state === "idle")).toEqual([
      expect.anything(),
    ])
  })

  test("a resume is recorded with its message, and its messages go to the transcript", async () => {
    const done = await run(
      { "t-1": [turn([...bash("bd update t-1 --claim")]), turn([])] },
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* startAndWatch("t-1", 3)
        yield* host.close("t-1")
        const messages = yield* host
          .messages("t-1")
          .pipe(Stream.take(7), Stream.runCollect, Effect.forkChild)
        yield* Effect.yieldNow
        const resumed = yield* watch("t-1", 4)
        yield* host.resume("t-1", session(), {
          text: "Your question is answered.",
          from: "clientComposed",
        })
        return {
          states: yield* Fiber.join(resumed),
          messages: yield* Fiber.join(messages),
          transcript: yield* (yield* Files).messages("t-1"),
          sent: yield* (yield* Recording).sentTo("t-1"),
        }
      }),
    )
    expect(done.states).toEqual([
      WorkerState.Closed(),
      WorkerState.Starting(),
      working,
      WorkerState.Idle({ at: 0 }),
    ])
    expect(done.sent.map((s) => s._tag)).toEqual([
      "Started",
      "Message",
      "Closed",
      "Resumed",
      "Message",
    ])
    expect(done.sent[3]).toEqual(Sent.Resumed({ ticket: "t-1", session: session() }))
    // The message's command_lifecycle, queued and started, the turn, and its completed before idle.
    expect(done.messages.map((m: SessionMessage) => [m.session, m.message.type])).toEqual([
      ["s-1", "command_lifecycle"],
      ["s-1", "command_lifecycle"],
      ["s-1", "system"],
      ["s-1", "system"],
      ["s-1", "result"],
      ["s-1", "command_lifecycle"],
      ["s-1", "system"],
    ])
    // The first session's 10 messages (a tool call's 2 and a send's 4 among them, the message
    // itself first), then the resumed one's 8.
    expect(done.transcript.map((item) => item.seq)).toEqual(
      Array.from({ length: 18 }, (_, i) => i + 1),
    )
    expect(done.transcript.every((item) => item.session === "s-1")).toBe(true)
  })

  test("end closes the session and ends its streams", async () => {
    const done = await run(
      { "t-1": [turn([])] },
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start("t-1", session())
        const listening = yield* Deferred.make<void>()
        const states = yield* host.state("t-1").pipe(
          Stream.tap(() => Deferred.succeed(listening, undefined)),
          Stream.runCollect,
          Effect.forkChild,
        )
        yield* Deferred.await(listening)
        yield* host.end("t-1")
        return {
          states: yield* Fiber.join(states),
          now: yield* Effect.flip(host.current("t-1")),
          sent: yield* (yield* Recording).sentTo("t-1"),
        }
      }),
    )
    expect(done.states[0]).toEqual(WorkerState.Starting())
    expect(done.now._tag).toBe("AgentGone")
    expect(done.sent.map((s) => s._tag)).toEqual(["Started", "Closed", "Ended"])
  })
})
