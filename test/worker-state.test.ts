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
  WorkerEvent.Message({ session: "s", message: message as unknown as SDKMessage })
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
// A task's end, as the CLI sends it: task_updated, then task_notification, before the set changes.
const taskEnded = (id: string) => [
  sdk({ type: "system", subtype: "task_updated", task_id: id, patch: { status: "completed" } }),
  sdk({ type: "system", subtype: "task_notification", task_id: id, status: "completed" }),
]
const reportLate = (since: number) => WorkerEvent.ReportLate({ session: "s", since })
const rateLimit = (status: "allowed" | "allowed_warning" | "rejected", resetsAt?: number) =>
  sdk({
    type: "rate_limit_event",
    rate_limit_info: { status, rateLimitType: "five_hour", ...(resetsAt ? { resetsAt } : {}) },
  })
const assistant = (fields: object = {}) =>
  sdk({ type: "assistant", message: { content: [] }, parent_tool_use_id: null, ...fields })
const streamEvent = sdk({ type: "stream_event", event: { type: "message_start" } })
// A send of tutti's: pushed, its command_lifecycle (not in the SDK's union), and its cancellation.
const sent = (uuid: string) => WorkerEvent.Sent({ session: "s", uuid })
const lifecycle = (uuid: string, state: "queued" | "started" | "completed" | "cancelled") =>
  sdk({ type: "command_lifecycle", command_uuid: uuid, state })
const cancelled = (...uuids: ReadonlyArray<string>) =>
  WorkerEvent.Cancelled({ session: "s", uuids })

const hook = (input: object): WorkerEvent =>
  WorkerEvent.Hook({ session: "s", input: input as unknown as HookInput })
const preTool = (tool_name: string, tool_input: object = {}) =>
  hook({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "toolu_1" })
const postTool = (tool_name: string) =>
  hook({ hook_event_name: "PostToolUse", tool_name, tool_input: {}, tool_use_id: "toolu_1" })
const subagentStart = (agent_id: string) =>
  hook({ hook_event_name: "SubagentStart", agent_id, agent_type: "verifier" })
const subagentStop = (agent_id: string) =>
  hook({ hook_event_name: "SubagentStop", agent_id, agent_type: "verifier" })
const preCompact = hook({ hook_event_name: "PreCompact", trigger: "auto" })
const requests = (pending: number) => WorkerEvent.Requests({ session: "s", pending })

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
  test("a clean result, then idle, with no tasks is Idle, from when idle came", () => {
    expect(stateAfter(init, preTool("Read"), result(), idle)).toEqual(WorkerState.Idle({ at: 3 }))
  })

  test("Idle keeps the time it began", () => {
    expect(stateAfter(init, result(), idle, requests(0))).toEqual(WorkerState.Idle({ at: 2 }))
  })

  test("a result alone ends a turn, not the worker's work: Working until idle", () => {
    expect(stateAfter(init, result())).toEqual(WorkerState.Working({ doing: "working" }))
    expect(stateAfter(init, result(), idle)._tag).toBe("Idle")
  })

  test("queued turns keep a worker Working until idle after the last result", () => {
    expect(stateAfter(init, result(), running, init, result())._tag).toBe("Working")
    expect(stateAfter(init, result(), running, init, result(), idle)._tag).toBe("Idle")
    // An idle from before the last result doesn't count.
    expect(stateAfter(init, result(), idle, running, init, result())._tag).toBe("Working")
  })

  test("queued_turn_count isn't read", () => {
    expect(stateAfter(init, result({ queued_turn_count: 2 }), idle)._tag).toBe("Idle")
  })

  test("a live background task keeps a worker Working; Idle after the turn reporting its end", () => {
    const live = [init, tasks({ id: "b1" }), result(), idle]
    expect(stateAfter(...live)).toEqual(WorkerState.Working({ doing: "working" }))
    expect(stateAfter(...live, tasks())).toEqual(WorkerState.Working({ doing: "working" }))
    const reported = [...live, tasks(), running, init, result(), idle]
    expect(stateAfter(...reported)).toEqual(WorkerState.Idle({ at: 8 }))
  })

  test("background_tasks_changed replaces the set each time", () => {
    const events = [init, tasks({ id: "b1" }), tasks({ id: "b1" }, { id: "b2" })]
    expect(stateAfter(...events, result(), idle)._tag).toBe("Working")
    expect(stateAfter(...events, tasks({ id: "b2" }), result(), idle)._tag).toBe("Working")
    expect(stateAfter(...events, tasks({ id: "b2" }), tasks(), result(), idle)._tag).toBe("Idle")
  })

  test("ambient tasks never keep a worker Working", () => {
    const watch = tasks({ id: "watch", ambient: true })
    expect(stateAfter(init, watch, result(), idle)._tag).toBe("Idle")
    expect(stateAfter(init, result(), idle, watch)._tag).toBe("Idle")
    expect(
      stateAfter(init, tasks({ id: "a", ambient: true }, { id: "b" }), result(), idle)._tag,
    ).toBe("Working")
    // A task that becomes ambient stops counting.
    expect(
      stateAfter(init, tasks({ id: "a" }), result(), idle, tasks({ id: "a", ambient: true }))._tag,
    ).toBe("Idle")
  })

  test("session_state_changed idle confirms, and doesn't make Idle without a result", () => {
    expect(stateAfter(init, idle)._tag).toBe("Working")
    expect(stateAfter(init, tasks({ id: "b1" }), result(), idle)._tag).toBe("Working")
    expect(stateAfter(init, result(), idle)._tag).toBe("Idle")
  })

  test("a new turn after Idle is Working again", () => {
    expect(stateAfter(init, result(), idle, running)).toEqual(
      WorkerState.Working({ doing: "working" }),
    )
  })
})

describe("a finished task's report", () => {
  // The spike's order at a task's end, after idle: task_updated, task_notification, the emptied
  // set, then running ~70 ms later and the turn the CLI starts by itself to report the task.
  const watching = [init, tasks({ id: "b1" }), result(), idle]
  const ends = [...taskEnded("b1"), tasks()]
  const report = [running, init, preTool("Read"), postTool("Read"), result(), idle]

  test("a task ending after idle keeps the worker Working through its report's turn", () => {
    const states = [...watching, ...ends, ...report].map(
      (_, n, all) => fold(all.slice(0, n + 1)).state._tag,
    )
    expect(states.slice(watching.length - 1)).toEqual([
      "Working", // idle with the task live
      "Working", // task_updated
      "Working", // task_notification
      "Working", // the emptied set, before running
      "Working", // running
      "Working",
      "Working",
      "Working",
      "Working", // the report's result
      "Idle",
    ])
    expect(fold([...watching, ...ends, ...report]).report).toBeNull()
  })

  test("the emptied set before running awaits the report from when it came", () => {
    const worker = fold([...watching, ...ends])
    expect(worker.report).toBe(watching.length + ends.length - 1)
    expect(worker.state).toEqual(WorkerState.Working({ doing: "working" }))
  })

  test("a report that never comes: ReportLate ends the wait, and the worker settles", () => {
    const since = watching.length + ends.length - 1
    const events = [...watching, ...ends]
    expect(stateAfter(...events, reportLate(since))).toEqual(WorkerState.Idle({ at: since + 1 }))
    // A ReportLate for another wait leaves this one be.
    expect(stateAfter(...events, reportLate(since - 1))._tag).toBe("Working")
    // A ReportLate after the report came changes nothing.
    expect(stateAfter(...events, ...report, reportLate(since))).toEqual(
      WorkerState.Idle({ at: since + report.length }),
    )
  })

  test("a failed worker whose report never comes settles as Failed", () => {
    const events = [init, tasks({ id: "b1" }), errorResult(), idle, tasks()]
    expect(stateAfter(...events)._tag).toBe("Working")
    expect(stateAfter(...events, reportLate(4))._tag).toBe("Failed")
  })

  test("a Monitor watch live after idle keeps the worker Working however long it lives", () => {
    const watch = sdk({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "m1", task_type: "local_bash", description: "Monitor tutti.log" }],
    })
    const worker = [init, watch, result(), idle].reduce(
      (w, event, n) => step(w, event, n * 60 * 60 * 1000),
      initial(),
    )
    expect(worker.state).toEqual(WorkerState.Working({ doing: "working" }))
    expect(step(worker, requests(0), 30 * 60 * 60 * 1000).state._tag).toBe("Working")
    // Each event it sees starts a turn; the worker stays Working after it.
    expect(fold([running, init, result(), idle], worker).state._tag).toBe("Working")
  })

  test("a task ending while a turn runs needs no report wait", () => {
    expect(fold([init, tasks({ id: "b1" }), tasks(), result(), idle]).report).toBeNull()
    expect(stateAfter(init, tasks({ id: "b1" }), tasks(), result(), idle)._tag).toBe("Idle")
    // Between a result and idle, more turns may follow: idle comes after the task's report.
    expect(stateAfter(init, tasks({ id: "b1" }), result(), tasks(), idle)._tag).toBe("Idle")
  })

  test("only a task that counted and ended awaits a report", () => {
    const ambient = tasks({ id: "w", ambient: true })
    expect(stateAfter(init, ambient, result(), idle, tasks())._tag).toBe("Idle")
    // A task that becomes ambient hasn't ended.
    const turned = tasks({ id: "b1", ambient: true })
    expect(stateAfter(init, tasks({ id: "b1" }), result(), idle, turned)._tag).toBe("Idle")
    // A new task starting after idle isn't one ending.
    expect(fold([init, result(), idle, tasks({ id: "b2" })]).report).toBeNull()
  })

  test("a second task ending keeps the first wait's time", () => {
    const two = [init, tasks({ id: "b1" }, { id: "b2" }), result(), idle]
    const worker = fold([...two, tasks({ id: "b2" }), tasks()])
    expect(worker.report).toBe(4)
    expect(step(worker, reportLate(4), 6).state).toEqual(WorkerState.Idle({ at: 6 }))
  })

  test("a session that goes while a report is awaited is Gone", () => {
    expect(
      stateAfter(...watching, ...ends, WorkerEvent.Ended({ session: "s", why: "exited" })),
    ).toEqual(WorkerState.Gone({ why: "exited" }))
  })
})

describe("tutti's sends", () => {
  const first = "00000000-0000-4000-8000-000000000001"
  const second = "00000000-0000-4000-8000-000000000002"

  test("two queued client_composed sends with queued_turn_count 0 keep a worker Working", () => {
    // docs/spikes/01-sdk-session.md, item 1: the first result said 0, yet a further turn followed.
    const events = [
      sent(first),
      lifecycle(first, "queued"),
      running,
      init,
      lifecycle(first, "started"),
      sent(second),
      lifecycle(second, "queued"),
      result({ queued_turn_count: 0, user_message_uuids: [first] }),
      lifecycle(first, "completed"),
    ]
    expect(stateAfter(...events)._tag).toBe("Working")
    // Even an idle wouldn't do while the second is outstanding.
    expect(stateAfter(...events, idle)._tag).toBe("Working")
    const next = [
      init,
      lifecycle(second, "started"),
      result({ queued_turn_count: 0, user_message_uuids: [second] }),
      lifecycle(second, "completed"),
    ]
    expect(stateAfter(...events, ...next)._tag).toBe("Working")
    expect(stateAfter(...events, ...next, idle)._tag).toBe("Idle")
  })

  test("a send is outstanding from its push until a result lists it", () => {
    expect(stateAfter(init, result(), idle, sent(first))._tag).toBe("Working")
    const answered = [init, sent(first), result({ user_message_uuids: [first] }), idle]
    expect(stateAfter(...answered)._tag).toBe("Idle")
    const other = [init, sent(first), result({ user_message_uuids: [second] }), idle]
    expect(stateAfter(...other)._tag).toBe("Working")
  })

  test("a turn that lists none of tutti's sends leaves them outstanding", () => {
    // A turn the CLI starts by itself, to report a finished background task.
    const events = [init, sent(first), result({ user_message_uuids: [] }), idle]
    expect(stateAfter(...events)._tag).toBe("Working")
  })

  test("command_lifecycle completed or cancelled ends a send; queued or started doesn't", () => {
    const pushed = [init, result({ user_message_uuids: [] }), sent(first)]
    expect(stateAfter(...pushed, lifecycle(first, "queued"), idle)._tag).toBe("Working")
    expect(stateAfter(...pushed, lifecycle(first, "started"), idle)._tag).toBe("Working")
    expect(stateAfter(...pushed, lifecycle(first, "completed"), idle)._tag).toBe("Idle")
    expect(stateAfter(...pushed, lifecycle(first, "cancelled"), idle)._tag).toBe("Idle")
    expect(stateAfter(...pushed, lifecycle(second, "completed"), idle)._tag).toBe("Working")
  })

  test("command_lifecycle doesn't end an api_retry", () => {
    expect(stateAfter(init, retry(2), lifecycle(first, "queued"))._tag).toBe("Retrying")
  })

  test("an interrupt's receipt cancelling a send ends it", () => {
    const events = [init, sent(first), sent(second), errorResult({ user_message_uuids: [first] })]
    expect(stateAfter(...events, idle)._tag).toBe("Working")
    expect(stateAfter(...events, cancelled(second), idle)).toEqual(
      WorkerState.Failed({ at: 5, error: "error_during_execution", interrupted: true }),
    )
  })

  test("a result without user_message_uuids answers every send", () => {
    // A CLI that doesn't report sends: settle's answers reads it the same way.
    const absent = sdk({ type: "result", subtype: "success", is_error: false, result: "DONE" })
    expect(stateAfter(init, sent(first), sent(second), absent, idle)._tag).toBe("Idle")
  })
})

describe("error results", () => {
  test("a success result with is_error true is Failed and settled, from when it came", () => {
    const apiError = result({ is_error: true, api_error_status: 500, result: "API Error: 500" })
    const worker = fold([init, apiError, idle])
    expect(worker.state).toEqual(
      WorkerState.Failed({ at: 2, error: "API Error: 500", interrupted: false }),
    )
    expect(settled(worker.state)).toBe(true)
    expect(failure(worker)).toBe("API Error: 500")
  })

  test("an interrupted turn (error_during_execution) is Failed and interrupted", () => {
    const interrupted = errorResult({ errors: ["[ede_diagnostic] stop_reason=tool_use"] })
    expect(stateAfter(init, preTool("Bash"), interrupted, idle)).toEqual(
      WorkerState.Failed({
        at: 3,
        error: "[ede_diagnostic] stop_reason=tool_use",
        interrupted: true,
      }),
    )
  })

  test("another error subtype is Failed, not interrupted; its subtype says why without errors", () => {
    const maxTurns = errorResult({ subtype: "error_max_turns", errors: [] })
    expect(stateAfter(init, maxTurns, idle)).toEqual(
      WorkerState.Failed({ at: 2, error: "error_max_turns", interrupted: false }),
    )
  })

  test("Failed keeps the time it began", () => {
    expect(stateAfter(init, errorResult(), idle, requests(0))).toEqual(
      WorkerState.Failed({ at: 2, error: "error_during_execution", interrupted: true }),
    )
  })

  test("a live background task keeps a failed worker Working; its end makes it Failed", () => {
    const live = [init, tasks({ id: "b1" }), errorResult(), idle]
    expect(stateAfter(...live)._tag).toBe("Working")
    expect(stateAfter(...live, tasks(), reportLate(4))._tag).toBe("Failed")
    expect(stateAfter(init, tasks({ id: "w", ambient: true }), errorResult(), idle)._tag).toBe(
      "Failed",
    )
  })

  test("a failed turn is Working until idle after the last result", () => {
    expect(stateAfter(init, errorResult())._tag).toBe("Working")
    expect(stateAfter(init, errorResult(), running, init, result(), idle)._tag).toBe("Idle")
    const apiError = result({ is_error: true, result: "API Error: 500" })
    expect(stateAfter(init, apiError)._tag).toBe("Working")
    expect(stateAfter(init, apiError, idle)._tag).toBe("Failed")
  })

  test("a failed turn with a send of tutti's outstanding is Working until it is answered", () => {
    const uuid = "00000000-0000-4000-8000-000000000001"
    const events = [
      init,
      WorkerEvent.Sent({ session: "s", uuid }),
      errorResult({ user_message_uuids: [] }),
    ]
    expect(stateAfter(...events, idle)._tag).toBe("Working")
    const answered = [init, result({ user_message_uuids: [uuid] }), idle]
    expect(stateAfter(...events, idle, running, ...answered)._tag).toBe("Idle")
  })

  test("the turn after a failed one is Working again, and a second failure starts afresh", () => {
    expect(stateAfter(init, errorResult(), idle, init)).toEqual(
      WorkerState.Working({ doing: "working" }),
    )
    expect(stateAfter(init, errorResult(), idle, running, errorResult(), idle)).toEqual(
      WorkerState.Failed({ at: 5, error: "error_during_execution", interrupted: true }),
    )
  })

  test("a clean result after a failed turn is Idle", () => {
    const worker = fold([init, errorResult(), init, result(), idle])
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

  test("resetsAt comes from the turn's rate_limit_event, in milliseconds", () => {
    expect(stateAfter(init, rateLimit("rejected", 1_700_000_000), limited)).toEqual(
      WorkerState.UsageLimited({ resetsAt: 1_700_000_000_000 }),
    )
  })

  test("a rejected rate_limit_event marks an error result as the limit", () => {
    const apiError = result({ is_error: true, result: "API Error" })
    expect(stateAfter(init, rateLimit("rejected", 1_700_000_000), apiError)._tag).toBe(
      "UsageLimited",
    )
    expect(stateAfter(init, rateLimit("allowed_warning"), apiError, idle)._tag).toBe("Failed")
    expect(stateAfter(rateLimit("rejected"), rateLimit("allowed"), init, apiError, idle)._tag).toBe(
      "Failed",
    )
  })

  test("an assistant message with the rate_limit error marks the turn's error result", () => {
    const apiError = result({ is_error: true, result: "API Error" })
    expect(stateAfter(init, assistant({ error: "rate_limit" }), apiError)._tag).toBe("UsageLimited")
    expect(stateAfter(init, assistant({ error: "rate_limit" }), init, apiError, idle)._tag).toBe(
      "Failed",
    )
  })

  test("a clean result is never UsageLimited", () => {
    expect(stateAfter(init, rateLimit("rejected"), result(), idle)._tag).toBe("Idle")
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
    expect(stateAfter(init, retry(1), result())._tag).toBe("Working")
    expect(stateAfter(init, retry(1), result(), idle)._tag).toBe("Idle")
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
    expect(stateAfter(init, result(), idle, requests(1))._tag).toBe("NeedsYou")
    expect(stateAfter(init, requests(1), result(), idle, requests(0))._tag).toBe("Idle")
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
    expect(stateAfter(init, WorkerEvent.Closed({ session: "s" }))).toEqual(WorkerState.Closed())
    expect(stateAfter(init, WorkerEvent.Closed({ session: "s" }), init, requests(1))).toEqual(
      WorkerState.Closed(),
    )
  })

  test("a stream that ends without tutti closing it is Gone", () => {
    expect(stateAfter(init, WorkerEvent.Ended({ session: "s", why: "exited with 1" }))).toEqual(
      WorkerState.Gone({ why: "exited with 1" }),
    )
    expect(
      stateAfter(
        init,
        WorkerEvent.Ended({ session: "s", why: "x" }),
        WorkerEvent.Closed({ session: "s" }),
      )._tag,
    ).toBe("Gone")
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
    fc.constantFrom("u1", "u2").map(sent),
    fc
      .tuple(fc.constantFrom("u1", "u2"), fc.constantFrom("queued", "started", "completed"))
      .map(([uuid, state]) => lifecycle(uuid, state as "queued")),
    fc.subarray(["u1", "u2"]).map((uuids) => result({ user_message_uuids: uuids })),
    fc.constant(result({ is_error: true, api_error_status: 429 })),
    fc.constant(errorResult()),
    fc
      .constantFrom("rejected", "allowed", "allowed_warning")
      .map((s) => rateLimit(s as "rejected", 1_700_000_000)),
    fc.nat({ max: 3 }).map(requests),
    fc.constantFrom("Bash", "Edit", "Read", "Agent").map((t) => preTool(t)),
    fc.constantFrom(postTool("Edit"), subagentStart("a1"), subagentStop("a1"), preCompact),
  )

  test("a sequence ending in a clean result, idle, no sends and no live tasks settles", () => {
    fc.assert(
      fc.property(
        fc.array(anyEvent, { maxLength: 40 }),
        fc.array(
          task.map((t) => ({ ...t, ambient: true })),
          { maxLength: 3 },
        ),
        (events, ambient) => {
          const end = [
            requests(0),
            init,
            tasks(...ambient),
            result({ user_message_uuids: [] }),
            cancelled("u1"),
            lifecycle("u2", "completed"),
            idle,
          ]
          expect(settled(fold([...events, ...end]).state)).toBe(true)
        },
      ),
    )
  })

  test("a live non-ambient task never lets a worker settle while its session runs", () => {
    fc.assert(
      fc.property(fc.array(anyEvent, { maxLength: 40 }), (events) => {
        const worker = fold([...events, init, tasks({ id: "b1" }), result(), idle])
        expect(settled(worker.state)).toBe(false)
      }),
    )
  })

  test("a task ending after idle never lets a worker settle until a turn or ReportLate", () => {
    fc.assert(
      fc.property(
        fc.array(anyEvent, { maxLength: 40 }),
        fc.array(fc.constantFrom(requests(0), streamEvent, assistant(), idle, ...taskEnded("b1")), {
          maxLength: 6,
        }),
        (events, between) => {
          const end = [
            requests(0),
            init,
            tasks({ id: "b1" }),
            result({ user_message_uuids: [] }),
            cancelled("u1"),
            lifecycle("u2", "completed"),
            idle,
            tasks(),
            ...between,
          ]
          const worker = fold([...events, ...end])
          expect(settled(worker.state)).toBe(false)
          const since = worker.report ?? -1
          expect(settled(step(worker, reportLate(since), 999).state)).toBe(true)
        },
      ),
    )
  })

  test("an outstanding send never lets a worker settle while its session runs", () => {
    fc.assert(
      fc.property(fc.array(anyEvent, { maxLength: 40 }), (events) => {
        const end = [init, tasks(), sent("u3"), result({ user_message_uuids: ["u1"] }), idle]
        expect(settled(fold([...events, ...end]).state)).toBe(false)
      }),
    )
  })
})
