// Messages a CLI of another version may send without the fields tutti reads: they read as
// Unreadable (src/agent/reading.ts), the reducer takes such a message as no change, the host logs
// it, and a message that still dies is skipped, so the worker goes on rather than going Gone.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { type Query, query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer, Option, Stream } from "effect"
import fc from "fast-check"
import { AgentHost, makeWorkers } from "../src/agent/AgentHost.ts"
import { layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { noServersNote } from "../src/agent/mcp.ts"
import { read } from "../src/agent/reading.ts"
import { rateLimitOf } from "../src/agent/UsageLimits.ts"
import { answerOf } from "../src/agent/UsageProbe.ts"
import {
  initial,
  step,
  type Worker,
  WorkerEvent,
  type WorkerState,
} from "../src/agent/WorkerState.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import { Spending } from "../src/run/spending.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"
import { workersIn } from "./workerEnv.ts"

// The live tests start the fake Claude Code as a process: bun's 5 s default fails them when other
// checks run beside this one.
setDefaultTimeout(30_000)

const sdk = (message: object): WorkerEvent =>
  WorkerEvent.Message({ session: "s", reading: read(message as unknown as SDKMessage) })

/** Why tutti can't read `message`; undefined when it can. */
const unreadable = (message: object): string | undefined => {
  const reading = read(message as unknown as SDKMessage)
  return reading._tag === "Unreadable" ? reading.why : undefined
}
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
    test(`${name} is no change, and its reading says why`, () => {
      expect(step(working, sdk(message), 5000)).toEqual(working)
      expect(unreadable(message)).toBeString()
    })
  }

  test("a result without errors fails with its subtype, the worker going on to Failed", () => {
    const message = { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 3 }
    expect(unreadable(message)).toBeUndefined()
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
    expect(unreadable(message)).toBeUndefined()
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
      expect(unreadable(message)).toBeUndefined()
    }
  })

  const kinds = [
    { type: "system", subtype: "api_retry" },
    { type: "system", subtype: "session_state_changed" },
    { type: "system", subtype: "background_tasks_changed" },
    { type: "system", subtype: "init" },
    { type: "system", subtype: "permission_denied" },
    { type: "rate_limit_event" },
    { type: "result", subtype: "success" },
    { type: "result", subtype: "error_during_execution" },
    { type: "assistant" },
    { type: "command_lifecycle" },
    { type: "stream_event" },
    { type: "user" },
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
      "capabilities",
      "message",
    ),
    fc.anything(),
  )

  test("property: no message of the types it reads, whatever its fields, throws", () => {
    fc.assert(
      fc.property(fc.constantFrom(...kinds), fields, (kind, rest) => {
        const message = { ...rest, ...kind } as unknown as SDKMessage
        step(working, sdk(message), 5000)
        unreadable(message)
      }),
    )
  })

  test("property: a message it can't read is no change, and is named by its type and subtype", () => {
    fc.assert(
      fc.property(fc.constantFrom(...kinds), fields, (kind, rest) => {
        const message = { ...rest, ...kind } as unknown as SDKMessage
        const reading = read(message)
        if (reading._tag !== "Unreadable") return
        expect(step(working, WorkerEvent.Message({ session: "s", reading }), 5000)).toEqual(working)
        expect(reading.kind).toBe("subtype" in kind ? `${kind.type}/${kind.subtype}` : kind.type)
        expect(reading.why).not.toBe("")
      }),
    )
  })

  test("property: a partial message is never looked into", () => {
    fc.assert(
      fc.property(fields, (rest) => {
        expect(read({ ...rest, type: "stream_event" } as unknown as SDKMessage)._tag).toBe(
          "Partial",
        )
      }),
    )
  })

  test("property: an assistant message's calls are its tool_use blocks with an ID and an input", () => {
    const block = fc.oneof(
      fc.record({
        type: fc.constantFrom("tool_use", "text", "server_tool_use"),
        id: fc.oneof(fc.string(), fc.integer()),
        input: fc.oneof(fc.dictionary(fc.string(), fc.jsonValue()), fc.constant(null), fc.string()),
      }),
      fc.anything(),
    )
    fc.assert(
      fc.property(fc.array(block), fc.boolean(), (content, limited) => {
        const message = {
          type: "assistant",
          message: { content },
          ...(limited ? { error: "rate_limit" } : {}),
        }
        const reading = read(message as unknown as SDKMessage)
        const calls = content.flatMap((b) => {
          const each = b as { type?: unknown; id?: unknown; input?: unknown } | null
          return typeof each === "object" &&
            each !== null &&
            !Array.isArray(each) &&
            each.type === "tool_use" &&
            typeof each.id === "string" &&
            typeof each.input === "object" &&
            each.input !== null &&
            !Array.isArray(each.input)
            ? [[each.id, each.input]]
            : []
        })
        expect(reading).toEqual(
          expect.objectContaining({ _tag: "Assistant", calls, rateLimited: limited }),
        )
      }),
    )
  })

  test("property: a result lists the sends its user_message_uuids name, or none", () => {
    fc.assert(
      fc.property(
        fc.option(fc.array(fc.uuid()), { nil: undefined }),
        fc.boolean(),
        (sends, error) => {
          const message = {
            type: "result",
            subtype: "success",
            is_error: error,
            result: "DONE",
            ...(sends === undefined ? {} : { user_message_uuids: sends }),
          }
          expect(read(message as unknown as SDKMessage)).toEqual(
            expect.objectContaining({
              _tag: "Result",
              sends: sends ?? null,
              error: error ? "DONE" : null,
            }),
          )
        },
      ),
    )
  })
})

describe("a result it can't read", () => {
  test("still ends the worker Gone when it gives a startup_failure_reason", () => {
    const refused = {
      type: "result",
      subtype: "error_during_execution",
      errors: [{ message: "not a string" }],
      startup_failure_reason: "cwd_unavailable",
    }
    expect(read(refused as unknown as SDKMessage)).toEqual(
      expect.objectContaining({ _tag: "Result", startupFailure: "cwd_unavailable" }),
    )
    expect(step(working, sdk(refused), 5000).state).toEqual({
      _tag: "Gone",
      why: "cwd_unavailable",
    } as WorkerState)
  })

  test("still goes to Spending, its turn's cost counted", async () => {
    const results = [
      { type: "result", subtype: "success", is_error: false, result: "DONE", total_cost_usd: 1 },
      { type: "result", subtype: "error_during_execution", is_error: true, errors: [{}] },
    ].map((fields) => ({ num_turns: 1, session_id: "s-1", ...fields }) as unknown as SDKMessage)
    expect(results.map((message) => read(message)._tag)).toEqual(["Result", "Unreadable"])
    const spent = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workers = yield* makeWorkers()
          const entry = yield* workers.open("t-1", "s-1", false)
          for (const message of results) yield* workers.emit(entry, "s-1", message)
          return yield* (yield* Spending).ofTicket("t-1")
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer(), Spending.layer),
        ),
        Effect.provide(Layer.mergeAll(logLayer(), eventsLayer())),
      ),
    )
    expect(spent).toMatchObject({ turns: 2, results: 2 })
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
    account: { billing: { _tag: "Subscription", keyUnused: false } },
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
          Layer.provideMerge(
            Layer.mergeAll(
              attentionLayer(waitForTest),
              transcriptsLayer(),
              ClaudeCode.layerWith(openQuery).pipe(
                Layer.provide(
                  workersIn({
                    ...testEnv,
                    FAKE_CLAUDE_SCENARIO: JSON.stringify({ turns, log: join(dir, "fake.jsonl") }),
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
