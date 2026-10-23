// WorkerState (§ 4.2): what a worker is doing, as a tagged union, and a pure reducer that folds the
// session's SDK messages, its hook callbacks and its open attention requests into it. The message
// shapes are those docs/spikes/01-sdk-session.md recorded (SDK 0.3.301, Claude Code 2.1.301).
//
// The reducer keeps a Worker: the state and what it is derived from. Each step updates the facts
// the event changes, then derives the state from them afresh, so no order of events can leave a
// stale state behind; only Idle's and Failed's `at` carries over, from the step that first made it
// so.
//
// The fields the reducer reads of a message are decoded with a Schema, not trusted to the SDK's
// types: a CLI of another version may send a message without one, and such a message is no change
// (unreadable says why, for the host to log).
import type { HookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Data, type Duration, Result, Schema } from "effect"
import { RateLimitInfo, rateLimitOf } from "./UsageLimits.ts"

/** What a working worker is doing, from its hook callbacks, as orchestra classifies it. */
export type Doing = "testing" | "editing" | "reading" | "subagent" | "working"

/** A variant with no fields. */
type Empty = Record<never, never>

/** A worker's state (§ 4.2). Times are epoch milliseconds. */
export type WorkerState = Data.TaggedEnum<{
  /** The session is spawned and its first `system/init` hasn't arrived. */
  Starting: Empty
  /**
   * A turn is under way, more turns follow, a send of tutti's is outstanding, a task is live, or a
   * finished task's report is still to come.
   */
  Working: { readonly doing: Doing }
  /** An `api_retry` message, until the next message of the turn. `status` is null without a response. */
  Retrying: { readonly attempt: number; readonly max: number; readonly status: number | null }
  /** Pending `canUseTool` calls or elicitations, or `requires_action`: how many there are. */
  NeedsYou: { readonly requests: number }
  /** The turn ended on the account's usage limit (§ 4.12); `resetsAt` null when nothing said when. */
  UsageLimited: { readonly resetsAt: number | null }
  /**
   * The turns are over (`idle` after the last result, which was clean), none of tutti's sends is
   * outstanding and no background task is live or report to come, since `at`.
   */
  Idle: { readonly at: number }
  /**
   * The last turn ended on an error other than the usage limit, and otherwise as for Idle, since
   * `at`; `interrupted` when it was cut off (`error_during_execution`).
   */
  Failed: { readonly at: number; readonly error: string; readonly interrupted: boolean }
  /** tutti closed the session on purpose, keeping its ID (§ 4.8). */
  Closed: Empty
  /**
   * The session's stream ended or failed without tutti closing it; `setup` when tutti ended it over
   * a setup problem its first system/init showed (§ 4.1), before it did anything.
   */
  Gone: { readonly why: string; readonly setup?: true }
}>

export const WorkerState = Data.taggedEnum<WorkerState>()

/** Whether a worker in `state` has settled: Idle, Failed, Closed or Gone, never anything else. */
export const settled = (state: WorkerState): boolean =>
  state._tag === "Idle" ||
  state._tag === "Failed" ||
  state._tag === "Closed" ||
  state._tag === "Gone"

/**
 * What reaches the reducer: an SDK message, a send of tutti's or its cancellation, a hook callback,
 * attention, or the session's end. Each names the session it is of, by its ID: the host folds only
 * those of the worker's session now (makeWorkers), and the reducer itself reads none.
 */
export type WorkerEvent = Data.TaggedEnum<{
  /** A message from the session's stream. */
  Message: { readonly session: string; readonly message: SDKMessage }
  /** tutti is pushing the message `uuid` into the session's inbox: it is outstanding from now. */
  Sent: { readonly session: string; readonly uuid: string }
  /** An interrupt's receipt or `cancel_async_message` cancelled these sends. */
  Cancelled: { readonly session: string; readonly uuids: ReadonlyArray<string> }
  /** An in-process hook callback's input (PreToolUse, PostToolUse, SubagentStart, …). */
  Hook: { readonly session: string; readonly input: HookInput }
  /**
   * No turn came within `reportWait` to report the task that ended at `since`: tutti stops waiting
   * for that report.
   */
  ReportLate: { readonly session: string; readonly since: number }
  /** How many of the worker's `canUseTool` calls and elicitations are open now. */
  Requests: { readonly session: string; readonly pending: number }
  /** tutti closed the session on purpose. */
  Closed: { readonly session: string }
  /**
   * The session's stream ended or failed without tutti closing it; `setup` when tutti ended it over
   * a setup problem.
   */
  Ended: { readonly session: string; readonly why: string; readonly setup?: true }
}>

export const WorkerEvent = Data.taggedEnum<WorkerEvent>()

/** How long a finished task's report has to start its turn before tutti stops waiting for it. */
export const reportWait: Duration.Input = "30 seconds"

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
  /** The turn's result arrived clean. */
  Ended: Empty
  /** The turn's result arrived with is_error on the usage limit. */
  Limited: Empty
  /** The turn's result arrived with is_error for another reason: a failed turn. */
  Failed: { readonly error: string; readonly interrupted: boolean }
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
  /** Whether `session_state_changed: idle` came after the last result: no turn runs or is queued. */
  readonly idle: boolean
  /**
   * tutti's sends, by uuid, pushed and not yet completed or cancelled per `command_lifecycle`,
   * listed in a result's `user_message_uuids`, or cancelled by an interrupt's receipt.
   */
  readonly outstanding: ReadonlyArray<string>
  /** Why the session ended, when it did: Closed by tutti, or Gone. */
  readonly end:
    | { readonly closed: true }
    | { readonly closed: false; readonly why: string; readonly setup?: true }
    | null
  /** The live background tasks that count: `background_tasks_changed`'s, but for ambient ones. */
  readonly tasks: ReadonlyArray<string>
  /**
   * When a task that counts left the live set after `idle`, so the CLI's turn to report it is still
   * to come; null when no report is awaited. The next turn, or ReportLate, ends the wait.
   */
  readonly report: number | null
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
  /**
   * The usage limit's latest `rate_limit_event` in this turn: whether it is rejected, and when it
   * resets.
   */
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
  idle: false,
  outstanding: [],
  end: null,
  tasks: [],
  report: null,
  pending: 0,
  requiresAction: false,
  retry: null,
  tool: null,
  subagents: [],
  limit: { rejected: false, resetsAt: null },
  rateLimited: false,
})

// The fields the reducer reads of each message it reads any of. Those it can do without are
// optional: a result without `errors` fails with its subtype for the error.
const ApiRetry = Schema.Struct({
  attempt: Schema.Number,
  max_retries: Schema.Number,
  error_status: Schema.optional(Schema.NullOr(Schema.Number)),
})
const StateChanged = Schema.Struct({ state: Schema.String })
const TasksChanged = Schema.Struct({
  tasks: Schema.Array(
    Schema.Struct({ task_id: Schema.String, ambient: Schema.optional(Schema.Boolean) }),
  ),
})
const RateLimitEvent = Schema.Struct({ rate_limit_info: RateLimitInfo })
const TurnResult = Schema.Struct({
  subtype: Schema.String,
  is_error: Schema.Boolean,
  user_message_uuids: Schema.optional(Schema.Array(Schema.String)),
  startup_failure_reason: Schema.optional(Schema.String),
  api_error_status: Schema.optional(Schema.NullOr(Schema.Number)),
  result: Schema.optional(Schema.String),
  errors: Schema.optional(Schema.Array(Schema.String)),
})

const decodeApiRetry = Schema.decodeUnknownResult(ApiRetry)
const decodeStateChanged = Schema.decodeUnknownResult(StateChanged)
const decodeTasksChanged = Schema.decodeUnknownResult(TasksChanged)
const decodeRateLimitEvent = Schema.decodeUnknownResult(RateLimitEvent)
const decodeResult = Schema.decodeUnknownResult(TurnResult)

/** The fields the reducer reads of `message`, decoded; undefined when it reads none of it. */
const decode = (message: SDKMessage): Result.Result<unknown, Schema.SchemaError> | undefined => {
  switch (message.type) {
    case "system":
      switch (message.subtype) {
        case "api_retry":
          return decodeApiRetry(message)
        case "session_state_changed":
          return decodeStateChanged(message)
        case "background_tasks_changed":
          return decodeTasksChanged(message)
      }
      return undefined
    case "rate_limit_event":
      return decodeRateLimitEvent(message)
    case "result":
      return decodeResult(message)
  }
  return undefined
}

/**
 * Why the reducer can't read `message`, a field it reads missing or of another type: the message is
 * no change. Undefined when it can.
 */
export const unreadable = (message: SDKMessage): string | undefined => {
  const decoded = decode(message)
  return decoded !== undefined && Result.isFailure(decoded) ? decoded.failure.message : undefined
}

/**
 * A new turn: what the last one left about its retries and limit goes, so that a turn failing for
 * another reason after one refused for the limit reads as Failed, not UsageLimited; the new turn's
 * own `rate_limit_event`s come after its `system/init`. Its tool calls and subagents went with its
 * result; a tool or subagent set now came from a hook of this turn, folded before its
 * `system/init` (hooks come on the SDK's control channel, messages through its queue), and stays.
 */
const newTurn = (worker: Worker): Worker => ({
  ...worker,
  turn: Turn.Running(),
  idle: false,
  report: null,
  retry: null,
  limit: { rejected: false, resetsAt: null },
  rateLimited: false,
})

/** `worker` with the sends `uuids` no longer outstanding. */
const done = (worker: Worker, uuids: ReadonlyArray<string>): Worker => ({
  ...worker,
  outstanding: worker.outstanding.filter((uuid) => !uuids.includes(uuid)),
})

/**
 * A `command_lifecycle` message's send, when it says the send is no longer outstanding: completed
 * or cancelled. It isn't in the SDK's SDKMessage union, so it is read from the raw message.
 */
const lifecycleEnd = (message: SDKMessage): string | null => {
  const raw = message as { readonly type: string } & Record<string, unknown>
  if (raw.type !== "command_lifecycle" || typeof raw.command_uuid !== "string") return null
  return raw.state === "completed" || raw.state === "cancelled" ? raw.command_uuid : null
}

const onMessage = (worker: Worker, message: SDKMessage, now: number): Worker => {
  // A send's lifecycle isn't a message of the turn, so it leaves an api_retry be.
  if ((message as { readonly type: string }).type === "command_lifecycle") {
    const ended = lifecycleEnd(message)
    return ended === null ? worker : done(worker, [ended])
  }
  // An api_retry holds until the turn's next message, whatever that is; a message whose fields the
  // reducer can't read is no change, to an api_retry neither.
  const next =
    message.type === "system" && message.subtype === "api_retry"
      ? worker
      : { ...worker, retry: null }
  switch (message.type) {
    case "system":
      switch (message.subtype) {
        case "init":
          return { ...newTurn(next), started: true }
        case "session_state_changed": {
          const read = decodeStateChanged(message)
          if (Result.isFailure(read)) return worker
          switch (read.success.state) {
            case "running":
              return {
                ...(next.turn._tag === "Running" ? next : newTurn(next)),
                requiresAction: false,
              }
            case "requires_action":
              return { ...next, requiresAction: true }
            case "idle":
              // No turn runs or is queued. It comes with background tasks live and after an error
              // result too (docs/spikes/01-sdk-session.md), so those are checked beside it.
              return { ...next, idle: true, requiresAction: false }
          }
          return next
        }
        case "api_retry": {
          const read = decodeApiRetry(message)
          if (Result.isFailure(read)) return worker
          const retry = read.success
          return {
            ...next,
            retry: {
              attempt: retry.attempt,
              max: retry.max_retries,
              status: retry.error_status ?? null,
            },
          }
        }
        case "background_tasks_changed": {
          const read = decodeTasksChanged(message)
          if (Result.isFailure(read)) return worker
          const { tasks } = read.success
          const live = tasks.map((task) => task.task_id)
          // A task that counted and has ended, between idle and the next running: the CLI starts a
          // turn to report it, about 70 ms after this message (docs/spikes/01-sdk-session.md).
          const ended = next.tasks.some((task) => !live.includes(task))
          return {
            ...next,
            tasks: tasks.filter((task) => task.ambient !== true).map((task) => task.task_id),
            report: next.idle && ended && next.report === null ? now : next.report,
          }
        }
      }
      return next
    case "rate_limit_event": {
      const info = rateLimitOf(message.rate_limit_info)
      if (info === undefined) return worker
      return {
        ...next,
        limit: {
          rejected: info.status === "rejected",
          resetsAt: info.resetsAt ?? next.limit.resetsAt,
        },
      }
    }
    case "assistant":
      return message.error === "rate_limit" ? { ...next, rateLimited: true } : next
    case "result": {
      const read = decodeResult(message)
      if (Result.isFailure(read)) return worker
      const result = read.success
      // A result that lists no sends, from a CLI that doesn't report them, answered them all.
      const listed = result.user_message_uuids ?? next.outstanding
      const ended = {
        ...done(next, listed),
        idle: false,
        requiresAction: false,
        tool: null,
        subagents: [],
      }
      if (result.subtype !== "success" && result.startup_failure_reason !== undefined) {
        return { ...ended, end: { closed: false, why: result.startup_failure_reason } }
      }
      if (!result.is_error) {
        return { ...ended, turn: Turn.Ended() }
      }
      const status = result.subtype === "success" ? result.api_error_status : undefined
      if (status === 429 || next.limit.rejected || next.rateLimited) {
        return { ...ended, turn: Turn.Limited() }
      }
      const error =
        result.subtype === "success"
          ? (result.result ?? result.subtype)
          : result.errors?.join("\n") || result.subtype
      const interrupted = result.subtype === "error_during_execution"
      return { ...ended, turn: Turn.Failed({ error, interrupted }) }
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
    if (worker.end.closed) return WorkerState.Closed()
    const { why, setup } = worker.end
    return WorkerState.Gone({ why, ...(setup === true ? { setup } : {}) })
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
  // The turns are over, none of tutti's sends is outstanding, and no background task is live or
  // report to come.
  const over =
    worker.idle &&
    worker.outstanding.length === 0 &&
    worker.tasks.length === 0 &&
    worker.report === null
  switch (worker.turn._tag) {
    case "Limited":
      return WorkerState.UsageLimited({ resetsAt: worker.limit.resetsAt })
    case "Ended":
      if (over) {
        return worker.state._tag === "Idle" ? worker.state : WorkerState.Idle({ at: now })
      }
      return working()
    case "Failed":
      if (over) {
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
    Message: ({ message }) => onMessage(worker, message, now),
    Sent: ({ uuid }) => ({ ...worker, outstanding: [...worker.outstanding, uuid] }),
    Cancelled: ({ uuids }) => done(worker, uuids),
    Hook: ({ input }) => onHook(worker, input),
    ReportLate: ({ since }) => (worker.report === since ? { ...worker, report: null } : worker),
    Requests: ({ pending }) => ({ ...worker, pending: Math.max(0, pending) }),
    Closed: () => ({ ...worker, end: { closed: true as const } }),
    Ended: ({ why, setup }) => ({
      ...worker,
      end: { closed: false as const, why, ...(setup === true ? { setup } : {}) },
    }),
  })
  return { ...next, state: derive(next, now) }
}

/** The last failed turn's error text, when the worker's last turn failed. */
export const failure = (worker: Worker): string | null =>
  worker.turn._tag === "Failed" ? worker.turn.error : null
