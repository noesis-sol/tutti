// The event stream's records (§ 10), defined with Effect Schema: orchestra v0.7.7's kinds, with
// their fields as its docs/events.md gives them, and tutti's new and changed ones. Every record has
// `v` (1), `time`, `run` and `kind`. Field names are snake_case, as orchestra's are, and a field
// without a value is left out. Text from tickets, models and tools is kept as it came: JSON
// encoding escapes what a terminal would act on, and keeps each record on one line.
//
// Readers read the kinds and fields they know and skip the rest: a record decodes with its unknown
// keys dropped, and one of an unknown kind doesn't decode.
import { Result, Schema } from "effect"
import { billings } from "../cli/flags.ts"

/** The records' version, `v` in each. */
export const version = 1

// RFC 3339 with fractional seconds, in local time, as orchestra writes `time` and `run`.
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u),
)

const pad = (n: number, width = 2): string => n.toString().padStart(width, "0")

/**
 * `date` in RFC 3339, in local time, as Go's RFC3339Nano gives it: the fraction of a second
 * without trailing zeros (none when it is 0), and `Z` for UTC.
 */
export const timestamp = (date: Date): string => {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const ms = date.getMilliseconds()
  const fraction = ms === 0 ? "" : `.${pad(ms, 3).replace(/0+$/, "")}`
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  const offset = -date.getTimezoneOffset()
  const zone =
    offset === 0
      ? "Z"
      : `${offset > 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  return `${day}T${clock}${fraction}${zone}`
}

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const optional = Schema.optionalKey

// What every record begins with: the version, when it was written, when the run started (the same
// in each of a run's records, and in its lock's `started`) and what it is.
const head = <const Kind extends string>(kind: Kind) => ({
  v: Schema.Literal(version),
  time: Timestamp,
  run: Timestamp,
  kind: Schema.Literal(kind),
})

/** How many ready tickets each reason holds back, as in `{"overlap":3,"merge":1}`. */
export const HeldBy = Schema.Struct({
  overlap: optional(Count),
  parent: optional(Count),
  merge: optional(Count),
  solo: optional(Count),
  /** Back in the queue as the setup failed in their worktrees, until a ticket merges or a probe. */
  setup: optional(Count),
})

/** The solo ticket running, or next. */
export const Solo = Schema.Struct({ ticket: Schema.String, next: optional(Schema.Literal(true)) })

// The queue's counts, on dispatch and queue records. held and held_by are there only while a
// ticket is held back; unclosed is left out only before the run could read it.
const queueFields = {
  queued: Count,
  held: optional(Count),
  held_by: optional(HeldBy),
  unclosed: optional(Count),
  solo: optional(Solo),
  /** The run holds a free slot at --machine-workers (`HOLD: MACHINE`). */
  machine_full: optional(Schema.Literal(true)),
}

// A record about one ticket, with its log line: closed, deferred, asked, answered, waits, triage.
const ticketRecord = <const Kind extends string>(kind: Kind) =>
  Schema.Struct({
    ...head(kind),
    ticket: Schema.String,
    title: Schema.String,
    detail: optional(Schema.String),
    text: Schema.String,
  })

// A record that is only its log line: drain, resume, probed, done.
const lineRecord = <const Kind extends string>(kind: Kind) =>
  Schema.Struct({ ...head(kind), text: Schema.String })

/** The run's first record. `terminal` is gone; `billing` and `permission_mode` are tutti's. */
export const Start = Schema.Struct({
  ...head("start"),
  version: Schema.String,
  /** The main checkout. */
  repo: Schema.String,
  /** Where finished tickets land. */
  branch: Schema.String,
  /** The ticket the run is scoped to; absent for the whole of bd ready. */
  scope: optional(Schema.String),
  /** The feature request. */
  feature: optional(Schema.String),
  concurrency: Count,
  billing: Schema.Literals(billings),
  /** The permission mode in effect, as the login probe reports it (§ 4.13). */
  permission_mode: Schema.String,
})

/** Progress: the START block, worktrees, how workers settled… */
export const Info = Schema.Struct({
  ...head("info"),
  ticket: optional(Schema.String),
  text: Schema.String,
})

/** A ticket was picked up: `n` and `limit` as in `[n/limit]`; no `limit` for a run without one. */
export const Dispatch = Schema.Struct({
  ...head("dispatch"),
  ticket: Schema.String,
  title: Schema.String,
  n: Count,
  limit: optional(Count),
  ...queueFields,
  text: Schema.String,
})

/** The queue's counts changed: the dashboard's In queue. It has no log line. */
export const Queue = Schema.Struct({ ...head("queue"), ...queueFields })

/** Closed and merged (`detail`: `ffd6ce4 merged into main`), or `no change to merge`. */
export const Closed = ticketRecord("closed")
/** Set aside; `detail` says why. */
export const Deferred = ticketRecord("deferred")
/** Waits on a question for you; `detail` is the question's ID and title. */
export const Asked = ticketRecord("asked")
/** Its question was answered. */
export const Answered = ticketRecord("answered")
/** Back in the queue until a blocker merges (`WAITS_FOR_MERGE`); `detail` lists them. */
export const Waits = ticketRecord("waits")
/** The triage organ's verdict: `title` is its summary, `detail` as in `environment · high`. */
export const Triage = ticketRecord("triage")

/** A ticket set aside was put back in the queue by an environment hold. */
export const Reopened = Schema.Struct({
  ...head("reopened"),
  ticket: Schema.String,
  detail: Schema.String,
  text: Schema.String,
})

/** Something to review while the run goes on: `CHECKS_FAILED`, `MERGE_CONFLICT`, … */
export const Warn = Schema.Struct({
  ...head("warn"),
  ticket: optional(Schema.String),
  /** The ticket is left for review, out of this run; `detail` says why. */
  aside: optional(Schema.Literal(true)),
  detail: optional(Schema.String),
  /** Its work is done but it can't merge until you act, as in `merge conflict in a.go`. */
  blocked: optional(Schema.String),
  text: Schema.String,
})

/**
 * No new tickets while the running ones finish. The text starts with `HOLD: ` and the word,
 * `USAGE_LIMIT` among them; `lifted` when the hold is lifted.
 */
export const Hold = Schema.Struct({
  ...head("hold"),
  ticket: optional(Schema.String),
  blocked: optional(Schema.String),
  lifted: optional(Schema.Literal(true)),
  text: Schema.String,
})

export const Drain = lineRecord("drain")
export const Resume = lineRecord("resume")
/** The probe found the machine working after an environment hold. */
export const Probed = lineRecord("probed")

/** Another tutti or orchestra run on the machine started (`SHARED_MACHINE: …`), or ended. */
export const SharedMachine = Schema.Struct({
  ...head("shared_machine"),
  /** How many other runs are going, which can be 0. */
  shared: Count,
  text: Schema.String,
})

/** A ready ticket waits for a free slot across the machine (`HOLD: MACHINE: …`), once a hold. */
export const MachineHold = lineRecord("machine_hold")

/** The words a stop's `detail` takes that are tutti's: `TERMINAL_FAILED` became `AGENT_FAILED`. */
export const StopWord = { agentFailed: "AGENT_FAILED", usageLimit: "USAGE_LIMIT" } as const

/** The loop stopped and needs you; `detail` is the word its text starts with (`PAUSED`, …). */
export const Stop = Schema.Struct({
  ...head("stop"),
  detail: Schema.String,
  ticket: optional(Schema.String),
  blocked: optional(Schema.String),
  text: Schema.String,
})

/** The loop finished: `READY_EMPTY`, `LIMIT_REACHED` or `DRAINED`, as its text starts. */
export const Done = lineRecord("done")

/** How the full check went. */
export const fullCheckOutcomes = ["passed", "failed", "timed out", "skipped", "not run"] as const

/** The full check after a run that ended by itself and merged a ticket. */
export const FullCheck = Schema.Struct({
  ...head("full_check"),
  detail: Schema.Literals(fullCheckOutcomes),
  /** The suite it failed in; none when the setup before it failed. */
  suite: optional(Schema.String),
  /** Where its whole output is. */
  output: optional(Schema.String),
  /** The ticket filed for the suite, or the one already open for it. */
  ticket: optional(Schema.String),
  text: Schema.String,
})

/** The run's last record: the exit code. */
export const End = Schema.Struct({ ...head("end"), code: Count })

/** The phases of § 5.1, by their tags. */
export const phaseNames = [
  "Queued",
  "HeldBack",
  "Working",
  "ToMerge",
  "Merging",
  "Resolving",
  "Fixing",
  "Done",
  "Asked",
  "Waiting",
  "Deferred",
  "Review",
  "Blocked",
  "Stopped",
] as const

/** The steps of a merge under way. */
export const mergeSteps = ["rebase", "setup", "check", "fast-forward"] as const

/** A ticket moved from one phase to another (§ 5.1), with the new phase's details. */
export const Phase = Schema.Struct({
  ...head("phase"),
  ticket: Schema.String,
  /** Absent as the ticket enters the machine, ready in bd. */
  from: optional(Schema.Literals(phaseNames)),
  /** Absent as the ticket leaves the machine, no longer in bd ready. */
  to: optional(Schema.Literals(phaseNames)),
  cause: Schema.String,
  /** ToMerge: its place in the merge queue, 1 for next. */
  place: optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  /** Merging: the step under way. */
  step: optional(Schema.Literals(mergeSteps)),
  /** Resolving, Fixing: which hand-back this is. */
  attempt: optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  /** HeldBack, Deferred, Review, Blocked, Stopped: why. */
  why: optional(Schema.String),
  text: optional(Schema.String),
})

export const attentionTypes = ["permission", "question", "elicitation"] as const

/** A question of AskUserQuestion's, as the worker asked it. */
export const AttentionQuestion = Schema.Struct({
  question: Schema.String,
  header: optional(Schema.String),
  options: Schema.Array(
    Schema.Struct({ label: Schema.String, description: optional(Schema.String) }),
  ),
  multi_select: optional(Schema.Boolean),
})

/** A worker waits on you (§ 4.5). */
export const Attention = Schema.Struct({
  ...head("attention"),
  ticket: Schema.String,
  /** The request's ID, as `tutti answer` takes it. */
  request: Schema.String,
  type: Schema.Literals(attentionTypes),
  /** A permission: the tool, and a one-line summary of its input; an elicitation: the server. */
  tool: optional(Schema.String),
  summary: optional(Schema.String),
  /** A question: what it asks. */
  questions: optional(Schema.Array(AttentionQuestion)),
  default_to_no: Schema.Boolean,
  text: optional(Schema.String),
})

export const permissionAnswers = ["allow", "deny", "allow_run"] as const
export const answeredVia = ["screen", "answer_command"] as const

/** A request was answered, or withdrawn by the SDK (`cancelled`, with no answer). */
export const AttentionAnswered = Schema.Struct({
  ...head("attention_answered"),
  ticket: Schema.String,
  request: Schema.String,
  /** A permission's answer, or the labels chosen for a question, in the questions' order. */
  answer: optional(Schema.Union([Schema.Literals(permissionAnswers), Schema.Array(Schema.String)])),
  via: optional(Schema.Literals(answeredVia)),
  /** How long the request was open. */
  after_ms: Count,
  cancelled: optional(Schema.Literal(true)),
  text: optional(Schema.String),
})

/** The classifier, the safety check, a rule or the mode denied a tool call. */
export const Denied = Schema.Struct({
  ...head("denied"),
  ticket: Schema.String,
  tool: Schema.String,
  /** The SDK's `decision_reason_type`: `classifier`, `safetyCheck`, `mode`, `rule`, or another. */
  reason_type: Schema.String,
  reason: Schema.String,
  text: optional(Schema.String),
})

export const usageLimitStatuses = ["warning", "rejected", "lifted"] as const

/** The usage limit's status changed (§ 4.12). */
export const UsageLimit = Schema.Struct({
  ...head("usage_limit"),
  status: Schema.Literals(usageLimitStatuses),
  /** The SDK's `rateLimitType`: `five_hour`, `seven_day`, … */
  limit: Schema.String,
  /** When it resets, RFC 3339; absent when the SDK doesn't say. */
  resets_at: optional(Timestamp),
  /** How much of it is used, 0 to 1. */
  utilization: optional(Schema.Finite),
  text: optional(Schema.String),
})

/** You sent a worker a message. Its text is recorded nowhere. */
export const Message = Schema.Struct({
  ...head("message"),
  ticket: Schema.String,
  length: Count,
  text: optional(Schema.String),
})

const workerRecord = <const Kind extends string>(kind: Kind) =>
  Schema.Struct({ ...head(kind), ticket: Schema.String, text: optional(Schema.String) })

/** You took a worker over (§ 4.3). */
export const Steered = workerRecord("steered")
/** You handed it back. */
export const Released = workerRecord("released")

/** A worker's session was suspended as the run ended: `why` as state.json has it. */
export const Suspended = Schema.Struct({
  ...head("suspended"),
  ticket: Schema.String,
  session: Schema.String,
  /** `quit`, `PAUSED`, `TICKET_LIMIT`, `waiting on you`, … */
  why: Schema.String,
  text: optional(Schema.String),
})

export const resumedWhy = ["suspended", "answered", "gone", "hand_back"] as const

/** A worker's session was resumed (the log's `RESUMED`). */
export const Resumed = Schema.Struct({
  ...head("resumed"),
  ticket: Schema.String,
  session: Schema.String,
  why: Schema.Literals(resumedWhy),
  text: optional(Schema.String),
})

/** Every kind's schema, by kind. */
export const kinds = {
  start: Start,
  info: Info,
  dispatch: Dispatch,
  queue: Queue,
  closed: Closed,
  deferred: Deferred,
  asked: Asked,
  answered: Answered,
  waits: Waits,
  reopened: Reopened,
  triage: Triage,
  warn: Warn,
  hold: Hold,
  drain: Drain,
  resume: Resume,
  probed: Probed,
  shared_machine: SharedMachine,
  machine_hold: MachineHold,
  stop: Stop,
  done: Done,
  full_check: FullCheck,
  end: End,
  phase: Phase,
  attention: Attention,
  attention_answered: AttentionAnswered,
  denied: Denied,
  usage_limit: UsageLimit,
  message: Message,
  steered: Steered,
  released: Released,
  suspended: Suspended,
  resumed: Resumed,
} as const

export type Kind = keyof typeof kinds

/** A record of the event stream, of any kind. */
export const EventRecord = Schema.Union(Object.values(kinds)).annotate({
  title: "tutti event record",
  description: "one line of .tutti/run/events.jsonl",
})
export type EventRecord = typeof EventRecord.Type

/** A record without its head, as the run gives it to the EventStream, which stamps the rest. */
export type Event = EventRecord extends infer R
  ? R extends EventRecord
    ? Omit<R, "v" | "time" | "run">
    : never
  : never

/** A record as one line of events.jsonl, the newline after it left out. */
export const EventLine = Schema.fromJsonString(EventRecord)

const encodeJson = Schema.encodeResult(EventLine)

// What JSON leaves as it is but a terminal showing the file (tail -f) may act on, or show in
// another order: DEL, the C1 controls, the line and paragraph separators, the bidi overrides and
// isolates. JSON.stringify escapes the C0 controls already. Each is escaped as \uXXXX, which
// decodes to the same text.
const unsafe = /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g

const escapeUnsafe = (c: string): string => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`

/** A line of JSON with those characters escaped: the same JSON, safe to show in a terminal. */
export const terminalSafe = (json: string): string => json.replace(unsafe, escapeUnsafe)

/** `record` as its line in events.jsonl, without the newline; fails on a record that doesn't fit. */
export const encodeLine = (record: EventRecord): Result.Result<string, Schema.SchemaError> =>
  Result.map(encodeJson(record), terminalSafe)

/** A line of events.jsonl as a record; fails on an unknown kind or a field that doesn't fit. */
export const decodeLine = Schema.decodeUnknownResult(EventLine)
