// WorkerState (§ 4.2): what a worker is doing, as a tagged union, and a pure reducer that folds the
// session's SDK messages, its hook callbacks and its open attention requests into it. The message
// shapes are those docs/spikes/01-sdk-session.md recorded (SDK 0.3.301, Claude Code 2.1.301).
//
// The reducer keeps a Worker: the state and what it is derived from. Each step updates the facts
// the event changes, then derives the state from them afresh, so no order of events can leave a
// stale state behind; only Idle's and Failed's `at` carries over, from the step that first made it
// so.
//
// The reducer folds a message as the host read it, once (src/agent/reading.ts): a message a CLI of
// another version sent without a field it reads is Unreadable, and no change. Each reading, and
// each event, has its handler in a table of its own, made once.
import type { HookInput } from "@anthropic-ai/claude-agent-sdk"
import { Data, type Duration } from "effect"
import type { Reading } from "./reading.ts"
import { aboutOf, type Doing, toolOf } from "./tools.ts"
import { endedOnLimit, noTurnLimit, type TurnLimit, turnLimitStep } from "./UsageLimits.ts"

export type { Doing } from "./tools.ts"

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
   * The turn ended on Claude's login refused (`authentication_failed`, § 4.13): `error` is its
   * result's text, and `told` the texts of the sends it was to answer, for the next run to send
   * again. It never settles: no turn goes on until the login is renewed.
   */
  LoginRefused: { readonly error: string; readonly told: ReadonlyArray<string> }
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
  /** A message from the session's stream, as the host read it. */
  Message: { readonly session: string; readonly reading: Reading }
  /**
   * tutti is pushing the message `uuid` into the session's inbox: it is outstanding from now. Its
   * `text` is kept while it is, for a turn refused for the login to tell again.
   */
  Sent: { readonly session: string; readonly uuid: string; readonly text?: string }
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

/**
 * What a tool call is doing, as orchestra's DoingOf classifies it: testing (Bash running one of
 * the `checks` commands or a known test runner), editing, reading, subagent (the Agent tool), or
 * working, as the table of tools (tools.ts) has it for the rest.
 */
export const classify = (
  tool: string,
  input: unknown,
  checks: ReadonlyArray<string> = [],
): Doing => {
  const doing = toolOf(tool)?.doing ?? "working"
  if (tool !== "Bash") return doing
  const command = (aboutOf(tool, input) ?? "").trim()
  const isCheck = checks.some((check) => check !== "" && command.includes(check))
  return isCheck || testRunner.test(command) ? "testing" : doing
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
  /**
   * The turn's result arrived with is_error, an assistant message of it having said
   * `authentication_failed`; `told` the texts of the sends it listed.
   */
  LoginRefused: { readonly error: string; readonly told: ReadonlyArray<string> }
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
  /** The texts of the outstanding sends that came with one, by uuid. */
  readonly texts: ReadonlyMap<string, string>
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
  /** What this turn's messages said of the usage limit. */
  readonly limit: TurnLimit
  /** Whether an assistant message of this turn said `authentication_failed` (§ 4.13). */
  readonly loginRefused: boolean
}

/** A worker whose session has just been spawned; `checks` are the project's check commands. */
export const initial = (checks: ReadonlyArray<string> = []): Worker => ({
  state: WorkerState.Starting(),
  checks,
  started: false,
  turn: Turn.None(),
  idle: false,
  outstanding: [],
  texts: new Map(),
  end: null,
  tasks: [],
  report: null,
  pending: 0,
  requiresAction: false,
  retry: null,
  tool: null,
  subagents: [],
  limit: noTurnLimit,
  loginRefused: false,
})

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
  limit: noTurnLimit,
  loginRefused: false,
})

/** `worker` with the sends `uuids` no longer outstanding. */
const done = (worker: Worker, uuids: ReadonlyArray<string>): Worker => {
  if (!uuids.some((uuid) => worker.texts.has(uuid))) {
    return { ...worker, outstanding: worker.outstanding.filter((uuid) => !uuids.includes(uuid)) }
  }
  const texts = new Map(worker.texts)
  for (const uuid of uuids) texts.delete(uuid)
  return {
    ...worker,
    outstanding: worker.outstanding.filter((uuid) => !uuids.includes(uuid)),
    texts,
  }
}

/** A step's handling of `value`, for `worker` at `now`. */
type Handle<E> = (worker: Worker, value: E, now: number) => Worker

/**
 * A handler of each variant of `E`, by tag; looked up by the value's tag, it is called as a
 * Handle<E>, which TypeScript can't tell from the lookup alone.
 */
type Handlers<E extends { readonly _tag: string }> = {
  readonly [K in E["_tag"]]: Handle<Extract<E, { readonly _tag: K }>>
}

/** `worker` with no api_retry holding: any message of the turn but another api_retry ends one. */
const unretried = (worker: Worker): Worker =>
  worker.retry === null ? worker : { ...worker, retry: null }

// What each reading of a message does. A message whose fields the reducer can't read is no change,
// to an api_retry neither; nor is a send's lifecycle, which isn't a message of the turn.
const onReading: Handlers<Reading> = {
  Init: (worker) => ({ ...newTurn(unretried(worker)), started: true }),
  State: (worker, { state }) => {
    const next = unretried(worker)
    switch (state) {
      case "running":
        return { ...(next.turn._tag === "Running" ? next : newTurn(next)), requiresAction: false }
      case "requires_action":
        return { ...next, requiresAction: true }
      case "idle":
        // No turn runs or is queued. It comes with background tasks live and after an error
        // result too (docs/spikes/01-sdk-session.md), so those are checked beside it.
        return { ...next, idle: true, requiresAction: false }
    }
    return next
  },
  Retry: (worker, { attempt, max, status }) => ({ ...worker, retry: { attempt, max, status } }),
  Tasks: (worker, { live, counted }, now) => {
    const next = unretried(worker)
    // A task that counted and has ended, between idle and the next running: the CLI starts a turn
    // to report it, about 70 ms after this message (docs/spikes/01-sdk-session.md).
    const ended = next.tasks.some((task) => !live.includes(task))
    return {
      ...next,
      tasks: counted,
      report: next.idle && ended && next.report === null ? now : next.report,
    }
  },
  RateLimit: (worker, reading) => {
    const next = unretried(worker)
    return { ...next, limit: turnLimitStep(next.limit, reading) }
  },
  Assistant: (worker, reading) => {
    const next = unretried(worker)
    const limit = turnLimitStep(next.limit, reading)
    const refused = next.loginRefused || reading.loginRefused
    return limit === next.limit && refused === next.loginRefused
      ? next
      : { ...next, limit, loginRefused: refused }
  },
  Denied: unretried,
  Result: (worker, result) => {
    const next = unretried(worker)
    // A result that lists no sends, from a CLI that doesn't report them, answered them all.
    const answered = result.sends ?? next.outstanding
    const ended = {
      ...done(next, answered),
      idle: false,
      requiresAction: false,
      tool: null,
      subagents: [],
    }
    if (result.startupFailure !== null) {
      return { ...ended, end: { closed: false, why: result.startupFailure } }
    }
    if (result.error === null) {
      return { ...ended, turn: Turn.Ended() }
    }
    if (endedOnLimit(next.limit, result.apiStatus)) {
      return { ...ended, turn: Turn.Limited() }
    }
    if (next.loginRefused) {
      const told = answered.flatMap((uuid) => {
        const text = next.texts.get(uuid)
        return text === undefined ? [] : [text]
      })
      return { ...ended, turn: Turn.LoginRefused({ error: result.error, told }) }
    }
    return {
      ...ended,
      turn: Turn.Failed({ error: result.error, interrupted: result.interrupted }),
    }
  },
  Lifecycle: (worker, { ended }) => (ended === null ? worker : done(worker, [ended])),
  Partial: unretried,
  Other: unretried,
  Unreadable: (worker) => worker,
}

const onHook = (worker: Worker, input: HookInput): Worker => {
  switch (input.hook_event_name) {
    case "PreToolUse":
      return { ...worker, tool: classify(input.tool_name, input.tool_input, worker.checks) }
    // A call that failed or was denied has ended as surely as one that succeeded.
    case "PostToolUse":
    case "PostToolUseFailure":
    case "PermissionDenied":
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
    case "LoginRefused":
      return worker.state._tag === "LoginRefused"
        ? worker.state
        : WorkerState.LoginRefused({ error: worker.turn.error, told: worker.turn.told })
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

// What each event does.
const onEvent: Handlers<WorkerEvent> = {
  Message: (worker, { reading }, now) =>
    (onReading[reading._tag] as Handle<Reading>)(worker, reading, now),
  Sent: (worker, { uuid, text }) => ({
    ...worker,
    outstanding: [...worker.outstanding, uuid],
    texts: text === undefined ? worker.texts : new Map(worker.texts).set(uuid, text),
  }),
  Cancelled: (worker, { uuids }) => done(worker, uuids),
  Hook: (worker, { input }) => onHook(worker, input),
  ReportLate: (worker, { since }) =>
    worker.report === since ? { ...worker, report: null } : worker,
  Requests: (worker, { pending }) => ({ ...worker, pending: Math.max(0, pending) }),
  Closed: (worker) => ({ ...worker, end: { closed: true } }),
  Ended: (worker, { why, setup }) => ({
    ...worker,
    end: { closed: false, why, ...(setup === true ? { setup } : {}) },
  }),
}

/** `worker` with `event` folded in, `now` (epoch milliseconds) being when it came. */
export const step = (worker: Worker, event: WorkerEvent, now: number): Worker => {
  if (worker.end !== null) {
    return worker
  }
  const next = (onEvent[event._tag] as Handle<WorkerEvent>)(worker, event, now)
  return { ...next, state: derive(next, now) }
}

/** The last failed turn's error text, when the worker's last turn failed. */
export const failure = (worker: Worker): string | null =>
  worker.turn._tag === "Failed" ? worker.turn.error : null
