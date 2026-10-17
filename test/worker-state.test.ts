import { describe, expect, test } from "bun:test"
import type { HookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import fc from "fast-check"
import {
  classify,
  type Doing,
  failure,
  initial,
  settled,
  step,
  type Worker,
  WorkerEvent,
  WorkerState,
} from "../src/agent/WorkerState.ts"

// SDK messages as docs/spikes/01-sdk-session.md recorded them, with only the fields the reducer
// reads (and the ones beside them that make each recognisable).
const sdk = (message: object): WorkerEvent =>
  WorkerEvent.Message({ message: message as unknown as SDKMessage })
const init = sdk({ type: "system", subtype: "init", permissionMode: "auto", session_id: "s" })
const sessionState = (state: "running" | "requires_action" | "idle") =>
  sdk({ type: "system", subtype: "session_state_changed", state })
const running = sessionState("running")
const idle = sessionState("idle")
const result = (fields: object = {}) =>
  sdk({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "DONE",
    num_turns: 1,
    queued_turn_count: 0,
    ...fields,
  })
const errorResult = (fields: object = {}) =>
  sdk({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: [],
    num_turns: 1,
    ...fields,
  })
const retry = (attempt: number, status: number | null = 529) =>
  sdk({
    type: "system",
    subtype: "api_retry",
    attempt,
    max_retries: 10,
    retry_delay_ms: 519,
    error_status: status,
    error: "overloaded",
  })
interface Task {
  readonly id: string
  readonly ambient?: boolean
}
const tasks = (...live: ReadonlyArray<Task>) =>
  sdk({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: live.map(({ id, ambient }) => ({
      task_id: id,
      task_type: "local_bash",
      description: id,
      ...(ambient === undefined ? {} : { ambient }),
    })),
  })
const rateLimit = (status: "allowed" | "allowed_warning" | "rejected", resetsAt?: number) =>
  sdk({
    type: "rate_limit_event",
    rate_limit_info: { status, rateLimitType: "five_hour", ...(resetsAt ? { resetsAt } : {}) },
  })
const assistant = (fields: object = {}) =>
  sdk({ type: "assistant", message: { content: [] }, parent_tool_use_id: null, ...fields })
const streamEvent = sdk({ type: "stream_event", event: { type: "message_start" } })

const hook = (input: object): WorkerEvent =>
  WorkerEvent.Hook({ input: input as unknown as HookInput })
const preTool = (tool_name: string, tool_input: object = {}) =>
  hook({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "toolu_1" })
const postTool = (tool_name: string) =>
  hook({ hook_event_name: "PostToolUse", tool_name, tool_input: {}, tool_use_id: "toolu_1" })
const subagentStart = (agent_id: string) =>
  hook({ hook_event_name: "SubagentStart", agent_id, agent_type: "verifier" })
const subagentStop = (agent_id: string) =>
  hook({ hook_event_name: "SubagentStop", agent_id, agent_type: "verifier" })
const preCompact = hook({ hook_event_name: "PreCompact", trigger: "auto" })
const requests = (pending: number) => WorkerEvent.Requests({ pending })

const check = "scripts/check-fast.sh"

/** The worker after `events`, the nth at time n. */
const fold = (events: ReadonlyArray<WorkerEvent>, worker: Worker = initial([check])): Worker =>
  events.reduce((w, event, n) => step(w, event, n), worker)
const stateAfter = (...events: ReadonlyArray<WorkerEvent>): WorkerState => fold(events).state

describe("Starting", () => {
  test("a spawned session is Starting until its first system/init", () => {
    expect(initial().state).toEqual(WorkerState.Starting())
    expect(stateAfter(running)).toEqual(WorkerState.Starting())
    expect(stateAfter(retry(1))).toEqual(WorkerState.Starting())
    expect(stateAfter(running, init)._tag).toBe("Working")
  })

  test("system/init on every turn starts the turn again", () => {
    const states = fold([init, result(), idle, running, init]).state
    expect(states).toEqual(WorkerState.Working({ doing: "working" }))
  })
})

describe("Idle", () => {
  test("a clean result with nothing queued and no tasks is Idle, from when it came", () => {
    expect(stateAfter(init, preTool("Read"), result())).toEqual(WorkerState.Idle({ at: 2 }))
  })

  test("Idle keeps the time it began", () => {
    expect(stateAfter(init, result(), idle, requests(0))).toEqual(WorkerState.Idle({ at: 1 }))
  })

  test("queued_turn_count absent counts as 0", () => {
    const absent = sdk({ type: "result", subtype: "success", is_error: false, result: "DONE" })
    expect(stateAfter(init, absent)._tag).toBe("Idle")
  })

  test("queued turns keep a worker Working until the last result", () => {
    expect(stateAfter(init, result({ queued_turn_count: 2 }))).toEqual(
      WorkerState.Working({ doing: "working" }),
    )
    expect(stateAfter(init, result({ queued_turn_count: 1 }), init, result())._tag).toBe("Idle")
  })

  test("a live background task keeps a worker Working; its end makes it Idle", () => {
    const live = [init, tasks({ id: "b1" }), result(), idle]
    expect(stateAfter(...live)).toEqual(WorkerState.Working({ doing: "working" }))
    expect(stateAfter(...live, tasks())).toEqual(WorkerState.Idle({ at: 4 }))
  })

  test("background_tasks_changed replaces the set each time", () => {
    const events = [init, tasks({ id: "b1" }), tasks({ id: "b1" }, { id: "b2" }), result()]
    expect(stateAfter(...events)._tag).toBe("Working")
    expect(stateAfter(...events, tasks({ id: "b2" }))._tag).toBe("Working")
    expect(stateAfter(...events, tasks({ id: "b2" }), tasks())._tag).toBe("Idle")
  })

  test("ambient tasks never keep a worker Working", () => {
    expect(stateAfter(init, tasks({ id: "watch", ambient: true }), result())._tag).toBe("Idle")
    expect(stateAfter(init, result(), tasks({ id: "watch", ambient: true }))._tag).toBe("Idle")
    expect(stateAfter(init, tasks({ id: "a", ambient: true }, { id: "b" }), result())._tag).toBe(
      "Working",
    )
    // A task that becomes ambient stops counting.
    expect(
      stateAfter(init, tasks({ id: "a" }), result(), tasks({ id: "a", ambient: true }))._tag,
    ).toBe("Idle")
  })

  test("session_state_changed idle confirms, and doesn't make Idle without a result", () => {
    expect(stateAfter(init, idle)._tag).toBe("Working")
    expect(stateAfter(init, tasks({ id: "b1" }), result(), idle)._tag).toBe("Working")
    expect(stateAfter(init, result(), idle)._tag).toBe("Idle")
  })

  test("a new turn after Idle is Working again", () => {
    expect(stateAfter(init, result(), running)).toEqual(WorkerState.Working({ doing: "working" }))
  })
})

describe("error results", () => {
  test("a success result with is_error true is Failed and settled, from when it came", () => {
    const apiError = result({ is_error: true, api_error_status: 500, result: "API Error: 500" })
    const worker = fold([init, apiError, idle])
    expect(worker.state).toEqual(
      WorkerState.Failed({ at: 1, error: "API Error: 500", interrupted: false }),
    )
    expect(settled(worker.state)).toBe(true)
    expect(failure(worker)).toBe("API Error: 500")
  })

  test("an interrupted turn (error_during_execution) is Failed and interrupted", () => {
    const interrupted = errorResult({ errors: ["[ede_diagnostic] stop_reason=tool_use"] })
    expect(stateAfter(init, preTool("Bash"), interrupted)).toEqual(
      WorkerState.Failed({
        at: 2,
        error: "[ede_diagnostic] stop_reason=tool_use",
        interrupted: true,
      }),
    )
  })

  test("another error subtype is Failed, not interrupted; its subtype says why without errors", () => {
    const maxTurns = errorResult({ subtype: "error_max_turns", errors: [] })
    expect(stateAfter(init, maxTurns)).toEqual(
      WorkerState.Failed({ at: 1, error: "error_max_turns", interrupted: false }),
    )
  })

  test("Failed keeps the time it began", () => {
    expect(stateAfter(init, errorResult(), idle, requests(0))).toEqual(
      WorkerState.Failed({ at: 1, error: "error_during_execution", interrupted: true }),
    )
  })

  test("a live background task keeps a failed worker Working; its end makes it Failed", () => {
    const live = [init, tasks({ id: "b1" }), errorResult()]
    expect(stateAfter(...live)._tag).toBe("Working")
    expect(stateAfter(...live, tasks())._tag).toBe("Failed")
    expect(stateAfter(init, tasks({ id: "w", ambient: true }), errorResult())._tag).toBe("Failed")
  })

  test("the turn after a failed one is Working again, and a second failure starts afresh", () => {
    expect(stateAfter(init, errorResult(), init)).toEqual(WorkerState.Working({ doing: "working" }))
    expect(stateAfter(init, errorResult(), running, errorResult())).toEqual(
      WorkerState.Failed({ at: 3, error: "error_during_execution", interrupted: true }),
    )
  })

  test("a clean result after a failed turn is Idle", () => {
    const worker = fold([init, errorResult(), init, result()])
    expect(worker.state._tag).toBe("Idle")
    expect(failure(worker)).toBeNull()
  })

  test("a result with a startup_failure_reason is Gone", () => {
    const startup = errorResult({ startup_failure_reason: "cwd_unavailable", errors: ["no cwd"] })
    expect(stateAfter(startup)).toEqual(WorkerState.Gone({ why: "cwd_unavailable" }))
  })
})

describe("UsageLimited", () => {
  const limited = result({ is_error: true, api_error_status: 429, result: "limit reached" })

  test("a success result with is_error and status 429 is UsageLimited", () => {
    expect(stateAfter(init, limited)).toEqual(WorkerState.UsageLimited({ resetsAt: null }))
  })

  test("resetsAt comes from the rate_limit_event, in milliseconds", () => {
    expect(stateAfter(rateLimit("rejected", 1_700_000_000), init, limited)).toEqual(
      WorkerState.UsageLimited({ resetsAt: 1_700_000_000_000 }),
    )
  })

  test("a rejected rate_limit_event marks an error result as the limit", () => {
    const apiError = result({ is_error: true, result: "API Error" })
    expect(stateAfter(init, rateLimit("rejected", 1_700_000_000), apiError)._tag).toBe(
      "UsageLimited",
    )
    expect(stateAfter(init, rateLimit("allowed_warning"), apiError)._tag).toBe("Failed")
    expect(stateAfter(rateLimit("rejected"), rateLimit("allowed"), init, apiError)._tag).toBe(
      "Failed",
    )
  })

  test("an assistant message with the rate_limit error marks the turn's error result", () => {
    const apiError = result({ is_error: true, result: "API Error" })
    expect(stateAfter(init, assistant({ error: "rate_limit" }), apiError)._tag).toBe("UsageLimited")
    expect(stateAfter(init, assistant({ error: "rate_limit" }), init, apiError)._tag).toBe("Failed")
  })

  test("a clean result is never UsageLimited", () => {
    expect(stateAfter(init, rateLimit("rejected"), result())._tag).toBe("Idle")
  })

  test("UsageLimited is not settled, and the next turn is Working", () => {
    expect(settled(stateAfter(init, limited))).toBe(false)
    expect(stateAfter(init, limited, running, init)._tag).toBe("Working")
  })
})

describe("Retrying", () => {
  test("api_retry is Retrying with its attempt, max and status", () => {
    expect(stateAfter(init, retry(3))).toEqual(
      WorkerState.Retrying({ attempt: 3, max: 10, status: 529 }),
    )
    expect(stateAfter(init, retry(1), retry(2, null))).toEqual(
      WorkerState.Retrying({ attempt: 2, max: 10, status: null }),
    )
  })

  test("the next message of the turn ends it", () => {
    expect(stateAfter(init, retry(1), streamEvent)._tag).toBe("Working")
    expect(stateAfter(init, retry(1), assistant())._tag).toBe("Working")
    expect(stateAfter(init, retry(1), result())._tag).toBe("Idle")
  })

  test("hooks and attention don't end it", () => {
    expect(stateAfter(init, retry(1), requests(0))._tag).toBe("Retrying")
  })
})

describe("NeedsYou", () => {
  test("pending canUseTool calls or elicitations give NeedsYou with their count", () => {
    expect(stateAfter(init, requests(1))).toEqual(WorkerState.NeedsYou({ requests: 1 }))
    expect(stateAfter(init, requests(3))).toEqual(WorkerState.NeedsYou({ requests: 3 }))
    expect(stateAfter(init, requests(2), requests(0))._tag).toBe("Working")
  })

  test("requires_action gives NeedsYou until the session runs again", () => {
    const asked = [init, preTool("Bash", { command: "touch x" }), sessionState("requires_action")]
    expect(stateAfter(...asked)).toEqual(WorkerState.NeedsYou({ requests: 1 }))
    expect(stateAfter(...asked, running)).toEqual(WorkerState.Working({ doing: "working" }))
    expect(stateAfter(...asked, requests(2))).toEqual(WorkerState.NeedsYou({ requests: 2 }))
  })

  test("a request open after the turn's result still needs you", () => {
    expect(stateAfter(init, result(), requests(1))._tag).toBe("NeedsYou")
    expect(stateAfter(init, requests(1), result(), requests(0))._tag).toBe("Idle")
  })

  test("NeedsYou outranks Retrying and Starting", () => {
    expect(stateAfter(init, retry(1), requests(1))._tag).toBe("NeedsYou")
    expect(stateAfter(requests(1))._tag).toBe("NeedsYou")
  })
})

describe("doing", () => {
  const doing = (...events: ReadonlyArray<WorkerEvent>): Doing | null => {
    const state = stateAfter(init, ...events)
    return state._tag === "Working" ? state.doing : null
  }

  test.each([
    ["Bash", { command: "scripts/check-fast.sh" }, "testing"],
    ["Bash", { command: "cd /x && scripts/check-fast.sh 2>&1 | tail" }, "testing"],
    ["Bash", { command: "bun test test/worker-state.test.ts" }, "testing"],
    ["Bash", { command: "go test ./..." }, "testing"],
    ["Bash", { command: "git status" }, "working"],
    ["Edit", { file_path: "a.ts" }, "editing"],
    ["Write", { file_path: "a.ts" }, "editing"],
    ["Read", { file_path: "a.ts" }, "reading"],
    ["Grep", { pattern: "x" }, "reading"],
    ["Glob", { pattern: "*" }, "reading"],
    ["Agent", { prompt: "verify" }, "subagent"],
    ["TodoWrite", {}, "working"],
  ] as const)("PreToolUse %s %j is %s", (tool, input, expected) => {
    expect(doing(preTool(tool, input))).toBe(expected)
  })

  test("PostToolUse and PreCompact go back to working", () => {
    expect(doing(preTool("Edit"), postTool("Edit"))).toBe("working")
    expect(doing(preTool("Read"), preCompact)).toBe("working")
  })

  test("a subagent started and not stopped is subagent between its tools", () => {
    const started = [preTool("Agent"), subagentStart("a1"), preTool("Read"), postTool("Read")]
    expect(doing(...started.slice(0, 3))).toBe("reading")
    expect(doing(...started)).toBe("subagent")
    expect(doing(...started, subagentStop("a1"), postTool("Agent"))).toBe("working")
  })

  test("a new turn forgets the last turn's tool", () => {
    expect(doing(preTool("Edit"), result(), init)).toBe("working")
  })
})

describe("Closed and Gone", () => {
  test("tutti's close is Closed; nothing after it changes that", () => {
    expect(stateAfter(init, WorkerEvent.Closed())).toEqual(WorkerState.Closed())
    expect(stateAfter(init, WorkerEvent.Closed(), init, requests(1))).toEqual(WorkerState.Closed())
  })

  test("a stream that ends without tutti closing it is Gone", () => {
    expect(stateAfter(init, WorkerEvent.Ended({ why: "exited with 1" }))).toEqual(
      WorkerState.Gone({ why: "exited with 1" }),
    )
    expect(stateAfter(init, WorkerEvent.Ended({ why: "x" }), WorkerEvent.Closed())._tag).toBe(
      "Gone",
    )
  })
})

describe("settled", () => {
  test.each([
    [WorkerState.Starting(), false],
    [WorkerState.Working({ doing: "testing" }), false],
    [WorkerState.Retrying({ attempt: 1, max: 10, status: 529 }), false],
    [WorkerState.NeedsYou({ requests: 1 }), false],
    [WorkerState.UsageLimited({ resetsAt: null }), false],
    [WorkerState.Idle({ at: 0 }), true],
    [WorkerState.Failed({ at: 0, error: "API Error: 500", interrupted: false }), true],
    [WorkerState.Closed(), true],
    [WorkerState.Gone({ why: "exited" }), true],
  ] as const)("%o is settled: %p", (state, expected) => {
    expect(settled(state)).toBe(expected)
  })
})

describe("properties", () => {
  const doings = ["testing", "editing", "reading", "subagent", "working"]

  test("classify gives one of the five categories for any tool and command", () => {
    fc.assert(
      fc.property(fc.string(), fc.anything(), fc.array(fc.string()), (tool, input, checks) => {
        expect(doings).toContain(classify(tool, input, checks))
        expect(doings).toContain(classify("Bash", { command: tool }, checks))
      }),
    )
  })

  test("a Bash command holding the check command is testing", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (before, after) => {
        expect(classify("Bash", { command: `${before}${check}${after}` }, [check])).toBe("testing")
      }),
    )
  })

  const task = fc.record({ id: fc.constantFrom("b1", "b2", "b3"), ambient: fc.boolean() })
  const anyEvent = fc.oneof(
    fc.constant(init),
    fc.constantFrom(running, idle, sessionState("requires_action"), streamEvent, assistant()),
    fc.integer({ min: 1, max: 10 }).map((n) => retry(n)),
    fc.array(task, { maxLength: 3 }).map((live) => tasks(...live)),
    fc.nat({ max: 3 }).map((n) => result({ queued_turn_count: n })),
    fc.constant(result({ is_error: true, api_error_status: 429 })),
    fc.constant(errorResult()),
    fc
      .constantFrom("rejected", "allowed", "allowed_warning")
      .map((s) => rateLimit(s as "rejected", 1_700_000_000)),
    fc.nat({ max: 3 }).map(requests),
    fc.constantFrom("Bash", "Edit", "Read", "Agent").map((t) => preTool(t)),
    fc.constantFrom(postTool("Edit"), subagentStart("a1"), subagentStop("a1"), preCompact),
  )

  test("a sequence ending in a clean result with no live tasks settles", () => {
    fc.assert(
      fc.property(
        fc.array(anyEvent, { maxLength: 40 }),
        fc.array(
          task.map((t) => ({ ...t, ambient: true })),
          { maxLength: 3 },
        ),
        (events, ambient) => {
          const end = [requests(0), init, tasks(...ambient), result()]
          expect(settled(fold([...events, ...end]).state)).toBe(true)
        },
      ),
    )
  })

  test("a live non-ambient task never lets a worker settle while its session runs", () => {
    fc.assert(
      fc.property(fc.array(anyEvent, { maxLength: 40 }), (events) => {
        const worker = fold([...events, init, tasks({ id: "b1" }), result()])
        expect(settled(worker.state)).toBe(false)
      }),
    )
  })
})
