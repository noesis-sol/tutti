// What tutti reads of an SDK message (§ 4.2), once: the host reads each message of a worker's
// session here as it comes (makeWorkers' emit), and the worker's state, the denials it keeps the
// calls for, UsageLimits and Spending all take that one Reading. A message is read by the table
// below, keyed on its type and subtype, else its type: a `stream_event`, the most frequent, is
// never looked into, and an assistant message's content blocks are walked once, by hand.
//
// The fields read aren't trusted to the SDK's types: a CLI of another version may send a message
// without one, or of another type. Such a message reads as Unreadable, with why, for the host to
// log; the worker's state takes it as no change. A field read only where it is there (a result's
// `errors`, an api_retry's `error_status`) may be left out.
import type {
  SDKMessage,
  SDKPermissionDeniedMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { Data, Predicate, Result } from "effect"
import {
  noTurnLimit,
  type RateLimit,
  readRateLimit,
  type TurnLimit,
  turnLimitStep,
  type WindowFigure,
  windowsOf,
} from "./UsageLimits.ts"

/** A variant with no fields. */
type Empty = Record<never, never>

/** A tool call an assistant message makes: its tool use ID and its input. */
export type Call = readonly [id: string, input: Readonly<Record<string, unknown>>]

/** What tutti reads of one SDK message. */
export type Reading = Data.TaggedEnum<{
  /** A `system/init`: a turn starts; the capabilities it lists. */
  Init: { readonly capabilities: ReadonlyArray<string> }
  /** A `session_state_changed`: `running`, `requires_action`, `idle`, or another state. */
  State: { readonly state: string }
  /** An `api_retry`; `status` null when the attempt had no response. */
  Retry: { readonly attempt: number; readonly max: number; readonly status: number | null }
  /** A `background_tasks_changed`: the live tasks' IDs, and those of them that aren't ambient. */
  Tasks: { readonly live: ReadonlyArray<string>; readonly counted: ReadonlyArray<string> }
  /** A `rate_limit_event`: its info, and the account's windows it carries (`windowsOf`). */
  RateLimit: { readonly info: RateLimit; readonly windows: ReadonlyMap<string, WindowFigure> }
  /** An assistant message: its tool calls, its subagents' too, and whether it has `rate_limit`. */
  Assistant: { readonly calls: ReadonlyArray<Call>; readonly rateLimited: boolean }
  /** A `permission_denied`: a call Claude Code denied without asking. */
  Denied: { readonly message: SDKPermissionDeniedMessage }
  /** A result: the turn's end. */
  Result: {
    readonly message: SDKResultMessage
    /** The sends it lists, `user_message_uuids`; null when it has none, from a CLI that doesn't. */
    readonly sends: ReadonlyArray<string> | null
    /**
     * Its `startup_failure_reason`, when it isn't a success: Claude Code refused to start. Such a
     * result is read whatever its other fields are.
     */
    readonly startupFailure: string | null
    /** The turn's error, when it is `is_error`: its result's text, or its errors, or subtype. */
    readonly error: string | null
    /** Its `api_error_status`, when it is a success that has one. */
    readonly apiStatus: number | null
    /** Whether it was cut off (`error_during_execution`). */
    readonly interrupted: boolean
  }
  /** A `command_lifecycle`: the send it says is no longer outstanding (completed or cancelled). */
  Lifecycle: { readonly ended: string | null }
  /** A partial message, `stream_event`. */
  Partial: Empty
  /** A message tutti reads nothing of. */
  Other: Empty
  /**
   * A message of a kind tutti reads (`kind`, its type and subtype) missing a field it reads, or
   * with one of another type: `why`. A `rate_limit_event`'s `windows` are read apart from its info.
   */
  Unreadable: {
    readonly kind: string
    readonly why: string
    readonly windows?: ReadonlyMap<string, WindowFigure>
  }
}>

export const Reading = Data.taggedEnum<Reading>()

/** A message's fields, as read before they are checked. */
type Raw = Readonly<Record<string, unknown>>

/** Reads a message of `kind` (its type and subtype), once its type has picked the reader. */
type Reader = (raw: Raw, kind: string) => Reading

const partial = Reading.Partial()
const other = Reading.Other()
const noCalls: ReadonlyArray<Call> = []
const noCapabilities: ReadonlyArray<string> = []

const unreadable = (kind: string, why: string): Reading => Reading.Unreadable({ kind, why })

/** Whether `value` is an array of strings. */
const isStrings = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((each) => typeof each === "string")

/** The capabilities listed in `value`'s `capabilities`, when it has them. */
export const capabilitiesOf = (value: unknown): ReadonlyArray<string> => {
  if (!Predicate.isObject(value) || !Array.isArray(value.capabilities)) return noCapabilities
  return value.capabilities.filter((c): c is string => typeof c === "string")
}

const init: Reader = (raw) => Reading.Init({ capabilities: capabilitiesOf(raw) })

const state: Reader = (raw, kind) =>
  typeof raw.state === "string"
    ? Reading.State({ state: raw.state })
    : unreadable(kind, "its state isn't a string")

const retry: Reader = (raw, kind) => {
  const { attempt, max_retries: max, error_status: status } = raw
  if (typeof attempt !== "number") return unreadable(kind, "its attempt isn't a number")
  if (typeof max !== "number") return unreadable(kind, "its max_retries isn't a number")
  if (status !== undefined && status !== null && typeof status !== "number") {
    return unreadable(kind, "its error_status isn't a number")
  }
  return Reading.Retry({ attempt, max, status: status ?? null })
}

const tasks: Reader = (raw, kind) => {
  if (!Array.isArray(raw.tasks)) return unreadable(kind, "its tasks aren't a list")
  const live: Array<string> = []
  const counted: Array<string> = []
  for (const task of raw.tasks) {
    if (!Predicate.isObject(task) || typeof task.task_id !== "string") {
      return unreadable(kind, "a task of its has no task_id")
    }
    if (task.ambient !== undefined && typeof task.ambient !== "boolean") {
      return unreadable(kind, `task ${task.task_id}'s ambient isn't a boolean`)
    }
    live.push(task.task_id)
    if (task.ambient !== true) counted.push(task.task_id)
  }
  return Reading.Tasks({ live, counted })
}

// The windows are read apart from the info: an info this SDK can't read may still carry them.
const rateLimit: Reader = (raw, kind) => {
  const windows = windowsOf(raw.rate_limit_info)
  const info = readRateLimit(raw.rate_limit_info)
  if (Result.isSuccess(info)) return Reading.RateLimit({ info: info.success, windows })
  return Reading.Unreadable({ kind, why: info.failure, ...(windows.size > 0 ? { windows } : {}) })
}

// The frequent case, so a loop over the content blocks, allocating only for a tool call.
const assistant: Reader = (raw) => {
  const rateLimited = raw.error === "rate_limit"
  const content = Predicate.isObject(raw.message) ? raw.message.content : undefined
  let calls: Array<Call> | undefined
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!Predicate.isObject(block) || block.type !== "tool_use") continue
      const { id, input } = block
      if (typeof id !== "string" || !Predicate.isObject(input)) continue
      if (calls === undefined) calls = []
      calls.push([id, input])
    }
  }
  return Reading.Assistant({ calls: calls ?? noCalls, rateLimited })
}

const denied: Reader = (raw) =>
  Reading.Denied({ message: raw as unknown as SDKPermissionDeniedMessage })

const result: Reader = (raw, kind) => {
  const { subtype, is_error: isError, user_message_uuids: sends, api_error_status: status } = raw
  if (typeof subtype !== "string") return unreadable(kind, "its subtype isn't a string")
  const startup = raw.startup_failure_reason
  // Claude Code refused to start: that is all there is to read, whatever else the result says.
  if (subtype !== "success" && typeof startup === "string") {
    return Reading.Result({
      message: raw as unknown as SDKResultMessage,
      sends: isStrings(sends) ? sends : null,
      startupFailure: startup,
      error: isStrings(raw.errors) ? raw.errors.join("\n") || subtype : subtype,
      apiStatus: null,
      interrupted: subtype === "error_during_execution",
    })
  }
  if (typeof isError !== "boolean") return unreadable(kind, "its is_error isn't a boolean")
  if (sends !== undefined && !isStrings(sends)) {
    return unreadable(kind, "its user_message_uuids aren't a list of strings")
  }
  if (startup !== undefined && typeof startup !== "string") {
    return unreadable(kind, "its startup_failure_reason isn't a string")
  }
  if (status !== undefined && status !== null && typeof status !== "number") {
    return unreadable(kind, "its api_error_status isn't a number")
  }
  const text = raw.result
  if (text !== undefined && typeof text !== "string") {
    return unreadable(kind, "its result isn't a string")
  }
  const errors = raw.errors
  if (errors !== undefined && !isStrings(errors)) {
    return unreadable(kind, "its errors aren't a list of strings")
  }
  const success = subtype === "success"
  const error = !isError ? null : success ? (text ?? subtype) : errors?.join("\n") || subtype
  return Reading.Result({
    message: raw as unknown as SDKResultMessage,
    sends: sends ?? null,
    startupFailure: success ? null : (startup ?? null),
    error,
    apiStatus: success ? (status ?? null) : null,
    interrupted: subtype === "error_during_execution",
  })
}

// command_lifecycle isn't in the SDK's SDKMessage union; a lifecycle that names no send, or says it
// is queued or started, ends none.
const lifecycle: Reader = (raw) => {
  const ended =
    typeof raw.command_uuid === "string" && (raw.state === "completed" || raw.state === "cancelled")
      ? raw.command_uuid
      : null
  return Reading.Lifecycle({ ended })
}

/** The readers, by type and subtype, or by type alone where every subtype is read alike. */
const readers: ReadonlyMap<string, Reader> = new Map([
  ["system/init", init],
  ["system/session_state_changed", state],
  ["system/api_retry", retry],
  ["system/background_tasks_changed", tasks],
  ["system/permission_denied", denied],
  ["rate_limit_event", rateLimit],
  ["assistant", assistant],
  ["result", result],
  ["command_lifecycle", lifecycle],
])

/** What tutti reads of `message`. */
export const read = (message: SDKMessage): Reading => {
  const raw = message as unknown as Raw
  const type = raw.type
  if (type === "stream_event") return partial
  const kind = typeof raw.subtype === "string" ? `${type}/${raw.subtype}` : `${type}`
  const reader = readers.get(kind) ?? readers.get(`${type}`)
  return reader === undefined ? other : reader(raw, kind)
}

/** What a turn's `messages` say of the usage limit, each read as a worker's is (turnLimitStep). */
export const turnLimit = (messages: ReadonlyArray<SDKMessage>): TurnLimit =>
  messages.reduce((limit, message) => turnLimitStep(limit, read(message)), noTurnLimit)
