// Messages a CLI of another version may send without the fields tutti reads: the reducer takes
// such a message as no change, the host logs it, and a message that still dies is skipped, so the
// worker goes on rather than going Gone.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { type Query, query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer, Option, Stream } from "effect"
import fc from "fast-check"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import { noServersNote } from "../src/agent/mcp.ts"
import { rateLimitOf } from "../src/agent/UsageLimits.ts"
import { answerOf } from "../src/agent/UsageProbe.ts"
import {
  initial,
  step,
  unreadable,
  type Worker,
  WorkerEvent,
  type WorkerState,
} from "../src/agent/WorkerState.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"

// The live tests start the fake Claude Code as a process: bun's 5 s default fails them when other
// checks run beside this one.
setDefaultTimeout(30_000)

const sdk = (message: object): WorkerEvent =>
  WorkerEvent.Message({ session: "s", message: message as unknown as SDKMessage })
const init = sdk({ type: "system", subtype: "init", permissionMode: "auto", session_id: "s" })
const running = sdk({ type: "system", subtype: "session_state_changed", state: "running" })
const idle = sdk({ type: "system", subtype: "session_state_changed", state: "idle" })

const fold = (events: ReadonlyArray<WorkerEvent>, from: Worker = initial()): Worker =>
  events.reduce((worker, event, i) => step(worker, event, 1000 + i), from)

/** A worker mid-turn: started, running, a task live. */
const working = fold([
  running,
  init,
  sdk({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: [{ task_id: "b1", task_type: "local_bash", description: "b1" }],
  }),
])

// Each message missing a field the reducer reads, as a CLI of another version might send it.
const missing: ReadonlyArray<readonly [string, object]> = [
  [
    "background_tasks_changed without tasks",
    { type: "system", subtype: "background_tasks_changed" },
  ],
  [
    "background_tasks_changed whose task has no ID",
    { type: "system", subtype: "background_tasks_changed", tasks: [{ task_type: "local_bash" }] },
  ],
  ["rate_limit_event without rate_limit_info", { type: "rate_limit_event" }],
  [
    "rate_limit_event whose info has no status",
    { type: "rate_limit_event", rate_limit_info: { resetsAt: 1 } },
  ],
  ["api_retry without attempt", { type: "system", subtype: "api_retry", max_retries: 10 }],
  ["session_state_changed without state", { type: "system", subtype: "session_state_changed" }],
  ["result without is_error", { type: "result", subtype: "success", result: "DONE" }],
]

describe("WorkerState: a message missing a field it reads", () => {
  for (const [name, message] of missing) {
    test(`${name} is no change, and unreadable says why`, () => {
      expect(step(working, sdk(message), 5000)).toEqual(working)
      expect(unreadable(message as SDKMessage)).toBeString()
    })
  }

  test("a result without errors fails with its subtype, the worker going on to Failed", () => {
    const message = { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 3 }
    expect(unreadable(message as unknown as SDKMessage)).toBeUndefined()
    const worker = fold([running, init, sdk(message), idle])
    expect(worker.state).toEqual({
      _tag: "Failed",
      at: 1003,
      error: "error_max_turns",
      interrupted: false,
    } as WorkerState)
  })

  test("an api_retry without error_status is a retry without a status", () => {
    const message = { type: "system", subtype: "api_retry", attempt: 2, max_retries: 10 }
    expect(unreadable(message as unknown as SDKMessage)).toBeUndefined()
    expect(step(working, sdk(message), 5000).state).toEqual({
      _tag: "Retrying",
      attempt: 2,
      max: 10,
      status: null,
    } as WorkerState)
  })

  test("the messages it reads nothing of, and well-formed ones, are readable", () => {
    for (const message of [
      { type: "assistant", message: { content: [] } },
      { type: "system", subtype: "init" },
      { type: "system", subtype: "something_new" },
      { type: "user" },
      { type: "result", subtype: "success", is_error: false, result: "DONE" },
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1 } },
    ]) {
      expect(unreadable(message as unknown as SDKMessage)).toBeUndefined()
    }
  })

  test("property: no message of the types it reads, whatever its fields, throws", () => {
    const kinds = [
      { type: "system", subtype: "api_retry" },
      { type: "system", subtype: "session_state_changed" },
      { type: "system", subtype: "background_tasks_changed" },
      { type: "system", subtype: "init" },
      { type: "rate_limit_event" },
      { type: "result", subtype: "success" },
      { type: "result", subtype: "error_during_execution" },
      { type: "assistant" },
      { type: "command_lifecycle" },
    ]
    const fields = fc.dictionary(
      fc.constantFrom(
        "tasks",
        "errors",
        "rate_limit_info",
        "attempt",
        "max_retries",
        "error_status",
        "state",
        "is_error",
        "result",
        "user_message_uuids",
        "startup_failure_reason",
        "api_error_status",
        "error",
        "command_uuid",
      ),
      fc.anything(),
    )
    fc.assert(
      fc.property(fc.constantFrom(...kinds), fields, (kind, rest) => {
        const message = { ...rest, ...kind } as unknown as SDKMessage
        step(working, sdk(message), 5000)
        unreadable(message)
      }),
    )
  })
})

describe("UsageLimits: a rate_limit_info it can't read", () => {
  test("is no event", () => {
    expect(rateLimitOf(undefined)).toBeUndefined()
    expect(rateLimitOf({ resetsAt: 1 })).toBeUndefined()
    expect(rateLimitOf({ status: "rejected", resetsAt: "soon" })).toBeUndefined()
  })

  test("the usage probe skips it, reading the events beside it", () => {
    const answer = answerOf([
      { type: "rate_limit_event" } as unknown as SDKMessage,
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 2 },
      } as unknown as SDKMessage,
    ])
    expect(answer).toEqual(
      expect.objectContaining({ _tag: "Refused", limit: "five_hour", resetsAt: 2000 }),
    )
  })
})

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

/**
 * The SDK's query, its stream with `poison` put before the first message `before` picks: a
 * message tutti can't take in at all.
 */
const poisoned =
  (poison: object, before: (message: SDKMessage) => boolean): typeof query =>
  (params) => {
    const real = query(params)
    let done = false
    const messages = async function* () {
      for await (const message of real) {
        if (!done && before(message)) {
          done = true
          yield poison as SDKMessage
        }
        yield message
      }
    }
    return new Proxy(real, {
      get: (target, key) => {
        if (key === Symbol.asyncIterator) return messages
        const value = Reflect.get(target, key, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    }) as Query
  }

/**
 * The live host over the fake Claude Code playing `turns`, the SDK's query `openQuery`: starts a
 * worker, sends it a message, and waits for it to settle. Its state then, and the log's lines.
 */
const settle = async (
  turns: ReadonlyArray<ReadonlyArray<object>>,
  openQuery: typeof query = query,
) => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-unreadable-"))
  const config = appConfig({ claude: fake, settings: defaultSettings }, dir)
  const host = liveLayer({
    prompt: { text: "Work on TICKET_ID.", file: null },
    servers: { servers: [], note: noServersNote },
    account: { billing: { _tag: "Subscription", keyUnused: false }, subscription: true },
    env: {
      ...testEnv,
      FAKE_CLAUDE_SCENARIO: JSON.stringify({ turns, log: join(dir, "fake.jsonl") }),
    },
    query: openQuery,
  })
  return Effect.runPromise(
    Effect.gen(function* () {
      const agents = yield* AgentHost
      yield* agents.start("t-1", { sessionId: "11111111-1111-4111-8111-111111111111", cwd: dir })
      yield* agents.send("t-1", "go", "clientComposed")
      const state = yield* agents.state("t-1").pipe(
        Stream.filter((s) => s._tag === "Idle" || s._tag === "Failed" || s._tag === "Gone"),
        Stream.runHead,
        Effect.timeoutOrElse({
          duration: Duration.seconds(10),
          orElse: () => Effect.die("the worker never settled"),
        }),
      )
      return { state: Option.getOrThrow(state), lines: yield* texts }
    }).pipe(
      Effect.provide(
        host.pipe(
          Layer.provideMerge(Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer())),
          Layer.provideMerge(
            Layer.mergeAll(logLayer(), eventsLayer(), configLayer(config), BunServices.layer),
          ),
        ),
      ),
    ),
  )
}

describe("AgentHost live: messages it can't read", () => {
  test("messages missing a field the reducer reads are logged, and the worker goes on", async () => {
    const { state, lines } = await settle([
      [
        { message: { type: "system", subtype: "background_tasks_changed" } },
        { message: { type: "rate_limit_event" } },
        { text: "done" },
      ],
    ])
    expect(state._tag).toBe("Idle")
    expect(lines).toContainEqual(
      expect.stringContaining(
        "t-1: a system/background_tasks_changed message it couldn't read, left out of its state:",
      ),
    )
    expect(lines).toContainEqual(
      expect.stringContaining("t-1: a rate_limit_event message it couldn't read"),
    )
  })

  test("a message that dies as it is taken in is logged and skipped, not the worker's end", async () => {
    const poison = {
      get type(): string {
        throw new Error("no type here")
      },
    }
    const { state, lines } = await settle(
      [[{ text: "done" }]],
      poisoned(poison, (message) => message.type === "assistant"),
    )
    expect(state._tag).toBe("Idle")
    expect(lines).toContainEqual(
      expect.stringContaining("t-1: a message tutti couldn't take in, skipped: no type here"),
    )
  })
})
