// WorkerState (§ 4.2): what a worker is doing, as a tagged union, and a pure reducer that folds the
// session's SDK messages, its hook callbacks and its open attention requests into it. The message
// shapes are those docs/spikes/01-sdk-session.md recorded (SDK 0.3.301, Claude Code 2.1.301).
//
// The reducer keeps a Worker: the state and what it is derived from. Each step updates the facts
// the event changes, then derives the state from them afresh, so no order of events can leave a
// stale state behind; only Idle's and Failed's `at` carries over, from the step that first made it
// so.
import type { HookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Data } from "effect"

/** What a working worker is doing, from its hook callbacks, as orchestra classifies it. */
export type Doing = "testing" | "editing" | "reading" | "subagent" | "working"

/** A variant with no fields. */
type Empty = Record<never, never>

/** A worker's state (§ 4.2). Times are epoch milliseconds. */
export type WorkerState = Data.TaggedEnum<{
  /** The session is spawned and its first `system/init` hasn't arrived. */
  Starting: Empty
  /** A turn is under way, more turns follow, or a background task is live. */
  Working: { readonly doing: Doing }
  /** An `api_retry` message, until the next message of the turn. `status` is null without a response. */
  Retrying: { readonly attempt: number; readonly max: number; readonly status: number | null }
  /** Pending `canUseTool` calls or elicitations, or `requires_action`: how many there are. */
  NeedsYou: { readonly requests: number }
  /** The turn ended on the account's usage limit (§ 4.12); `resetsAt` null when nothing said when. */
  UsageLimited: { readonly resetsAt: number | null }
  /** The turn ended cleanly, nothing is queued and no background task is live, since `at`. */
  Idle: { readonly at: number }
  /**
   * The turn ended on an error other than the usage limit, nothing is queued and no background
   * task is live, since `at`; `interrupted` when it was cut off (`error_during_execution`).
   */
  Failed: { readonly at: number; readonly error: string; readonly interrupted: boolean }
  /** tutti closed the session on purpose, keeping its ID (§ 4.8). */
  Closed: Empty
  /** The session's stream ended or failed without tutti closing it. */
  Gone: { readonly why: string }
}>

export const WorkerState = Data.taggedEnum<WorkerState>()

/** Whether a worker in `state` has settled: Idle, Failed, Closed or Gone, never anything else. */
export const settled = (state: WorkerState): boolean =>
  state._tag === "Idle" ||
  state._tag === "Failed" ||
  state._tag === "Closed" ||
  state._tag === "Gone"

/** What reaches the reducer: an SDK message, a hook callback, attention, or the session's end. */
export type WorkerEvent = Data.TaggedEnum<{
  /** A message from the session's stream. */
  Message: { readonly message: SDKMessage }
  /** An in-process hook callback's input (PreToolUse, PostToolUse, SubagentStart, …). */
  Hook: { readonly input: HookInput }
  /** How many of the worker's `canUseTool` calls and elicitations are open now. */
  Requests: { readonly pending: number }
  /** tutti closed the session on purpose. */
  Closed: Empty
  /** The session's stream ended or failed without tutti closing it. */
  Ended: { readonly why: string }
}>

export const WorkerEvent = Data.taggedEnum<WorkerEvent>()

// testRunner matches commands that run a test suite, for projects whose check command is not the
// one being run: orchestra's pattern (internal/dispatch/activity.go), as it is.
const testRunner = new RegExp(
  "(^|[\\s;&|(])(" +
    "go test|swift test|cargo test|py\\.?test|jest|vitest|rspec|phpunit|mix test|dotnet test|ctest|tox|" +
    "(npm|pnpm|yarn|bun)( run)? test|make (test|check)|gradlew? test|mvnw? test|xcodebuild\\b.*\\btest" +
    ")\\b",
)

const editing = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"])
const reading = new Set(["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch"])

/** Bash's command in a tool call's input, or "" when it has none. */
const commandOf = (input: unknown): string => {
  if (typeof input !== "object" || input === null || !("command" in input)) {
    return ""
  }
  return typeof input.command === "string" ? input.command : ""
}

/**
 * What a tool call is doing, as orchestra's DoingOf classifies it: testing (Bash running one of
 * the `checks` commands or a known test runner), editing, reading, subagent (the Agent tool), or
 * working for anything else.
 */
export const classify = (
  tool: string,
  input: unknown,
  checks: ReadonlyArray<string> = [],
): Doing => {
  switch (tool) {
    case "Agent":
    case "Task":
      return "subagent"
    case "Bash": {
      const command = commandOf(input).trim()
      const isCheck = checks.some((check) => check !== "" && command.includes(check))
      return isCheck || testRunner.test(command) ? "testing" : "working"
    }
  }
  if (editing.has(tool)) {
    return "editing"
  }
  return reading.has(tool) ? "reading" : "working"
}

/** How the session's last turn went. */
export type Turn = Data.TaggedEnum<{
  /** No turn has started yet. */
  None: Empty
  /** A turn is under way. */
  Running: Empty
  /** The turn's result arrived clean; `queued` sends follow without further input. */
  Ended: { readonly queued: number }
  /** The turn's result arrived with is_error on the usage limit. */
  Limited: Empty
  /** The turn's result arrived with is_error for another reason: a failed turn; `queued` as Ended's. */
  Failed: { readonly error: string; readonly interrupted: boolean; readonly queued: number }
}>

export const Turn = Data.taggedEnum<Turn>()

/** A worker's state and what it is derived from. */
export interface Worker {
  readonly state: WorkerState
  /** The commands whose runs count as testing: the project's check commands. */
  readonly checks: ReadonlyArray<string>
  /** Whether a `system/init` has arrived. */
  readonly started: boolean
  readonly turn: Turn
  /** Why the session ended, when it did: Closed by tutti, or Gone. */
  readonly end: { readonly closed: true } | { readonly closed: false; readonly why: string } | null
  /** The live background tasks that count: `background_tasks_changed`'s, but for ambient ones. */
  readonly tasks: ReadonlyArray<string>
  /** Open `canUseTool` calls and elicitations. */
  readonly pending: number
  /** `session_state_changed: requires_action` came, and nothing since said it was answered. */
  readonly requiresAction: boolean
  /** The last `api_retry` of the turn, until the turn's next message. */
  readonly retry: {
    readonly attempt: number
    readonly max: number
    readonly status: number | null
  } | null
  /** The current tool call's category; null between tool calls. */
  readonly tool: Doing | null
  /** Subagents started and not stopped in this turn, by agent ID. */
  readonly subagents: ReadonlyArray<string>
  /** The usage limit's latest `rate_limit_event`: whether it is rejected, and when it resets. */
  readonly limit: { readonly rejected: boolean; readonly resetsAt: number | null }
  /** Whether an assistant message of this turn carried the `rate_limit` error. */
  readonly rateLimited: boolean
}

/** A worker whose session has just been spawned; `checks` are the project's check commands. */
export const initial = (checks: ReadonlyArray<string> = []): Worker => ({
  state: WorkerState.Starting(),
  checks,
  started: false,
  turn: Turn.None(),
  end: null,
  tasks: [],
  pending: 0,
  requiresAction: false,
  retry: null,
  tool: null,
  subagents: [],
  limit: { rejected: false, resetsAt: null },
  rateLimited: false,
})

// rate_limit_info.resetsAt is in seconds since the epoch, as the API's reset header is; a value
// already in milliseconds is kept.
const epochMillis = (at: number): number => (at < 1e12 ? at * 1000 : at)

/** A new turn: what the last one left about its tool calls, retries and limit goes. */
const newTurn = (worker: Worker): Worker => ({
  ...worker,
  turn: Turn.Running(),
  retry: null,
  tool: null,
  subagents: [],
  rateLimited: false,
})

const onMessage = (worker: Worker, message: SDKMessage): Worker => {
  // An api_retry holds until the turn's next message, whatever that is.
  const next =
    message.type === "system" && message.subtype === "api_retry"
      ? worker
      : { ...worker, retry: null }
  switch (message.type) {
    case "system":
      switch (message.subtype) {
        case "init":
          return { ...newTurn(next), started: true }
        case "session_state_changed":
          switch (message.state) {
            case "running":
              return {
                ...(next.turn._tag === "Running" ? next : newTurn(next)),
                requiresAction: false,
              }
            case "requires_action":
              return { ...next, requiresAction: true }
            case "idle":
              // It confirms a turn's end, but it also comes with background tasks live and after
              // an error result (docs/spikes/01-sdk-session.md), so the result decides.
              return { ...next, requiresAction: false }
          }
          return next
        case "api_retry":
          return {
            ...next,
            retry: {
              attempt: message.attempt,
              max: message.max_retries,
              status: message.error_status,
            },
          }
        case "background_tasks_changed":
          return {
            ...next,
            tasks: message.tasks
              .filter((task) => task.ambient !== true)
              .map((task) => task.task_id),
          }
      }
      return next
    case "rate_limit_event": {
      const info = message.rate_limit_info
      return {
        ...next,
        limit: {
          rejected: info.status === "rejected",
          resetsAt: info.resetsAt === undefined ? next.limit.resetsAt : epochMillis(info.resetsAt),
        },
      }
    }
    case "assistant":
      return message.error === "rate_limit" ? { ...next, rateLimited: true } : next
    case "result": {
      const ended = { ...next, requiresAction: false, tool: null, subagents: [] }
      if (message.subtype !== "success" && message.startup_failure_reason !== undefined) {
        return { ...ended, end: { closed: false, why: message.startup_failure_reason } }
      }
      if (!message.is_error) {
        return { ...ended, turn: Turn.Ended({ queued: message.queued_turn_count ?? 0 }) }
      }
      const status = message.subtype === "success" ? message.api_error_status : undefined
      if (status === 429 || next.limit.rejected || next.rateLimited) {
        return { ...ended, turn: Turn.Limited() }
      }
      const error =
        message.subtype === "success"
          ? message.result
          : message.errors.join("\n") || message.subtype
      const interrupted = message.subtype === "error_during_execution"
      const queued = message.queued_turn_count ?? 0
      return { ...ended, turn: Turn.Failed({ error, interrupted, queued }) }
    }
  }
  return next
}

const onHook = (worker: Worker, input: HookInput): Worker => {
  switch (input.hook_event_name) {
    case "PreToolUse":
      return { ...worker, tool: classify(input.tool_name, input.tool_input, worker.checks) }
    case "PostToolUse":
    case "PreCompact":
      return { ...worker, tool: null }
    case "SubagentStart":
      return { ...worker, subagents: [...worker.subagents, input.agent_id] }
    case "SubagentStop":
      return { ...worker, subagents: worker.subagents.filter((id) => id !== input.agent_id) }
  }
  return worker
}

/** The state `worker`'s facts give, `now` being the time of the step that brought them. */
const derive = (worker: Worker, now: number): WorkerState => {
  if (worker.end !== null) {
    return worker.end.closed ? WorkerState.Closed() : WorkerState.Gone({ why: worker.end.why })
  }
  const requests = Math.max(worker.pending, worker.requiresAction ? 1 : 0)
  if (requests > 0) {
    return WorkerState.NeedsYou({ requests })
  }
  if (!worker.started) {
    return WorkerState.Starting()
  }
  if (worker.retry !== null) {
    return WorkerState.Retrying(worker.retry)
  }
  const working = (): WorkerState =>
    WorkerState.Working({
      doing: worker.tool ?? (worker.subagents.length > 0 ? "subagent" : "working"),
    })
  switch (worker.turn._tag) {
    case "Limited":
      return WorkerState.UsageLimited({ resetsAt: worker.limit.resetsAt })
    case "Ended":
      if (worker.turn.queued === 0 && worker.tasks.length === 0) {
        return worker.state._tag === "Idle" ? worker.state : WorkerState.Idle({ at: now })
      }
      return working()
    case "Failed":
      if (worker.turn.queued === 0 && worker.tasks.length === 0) {
        return worker.state._tag === "Failed"
          ? worker.state
          : WorkerState.Failed({
              at: now,
              error: worker.turn.error,
              interrupted: worker.turn.interrupted,
            })
      }
      return working()
  }
  return working()
}

/** `worker` with `event` folded in, `now` (epoch milliseconds) being when it came. */
export const step = (worker: Worker, event: WorkerEvent, now: number): Worker => {
  if (worker.end !== null) {
    return worker
  }
  const next = WorkerEvent.$match(event, {
    Message: ({ message }) => onMessage(worker, message),
    Hook: ({ input }) => onHook(worker, input),
    Requests: ({ pending }) => ({ ...worker, pending: Math.max(0, pending) }),
    Closed: () => ({ ...worker, end: { closed: true as const } }),
    Ended: ({ why }) => ({ ...worker, end: { closed: false as const, why } }),
  })
  return { ...next, state: derive(next, now) }
}

/** The last failed turn's error text, when the worker's last turn failed. */
export const failure = (worker: Worker): string | null =>
  worker.turn._tag === "Failed" ? worker.turn.error : null
