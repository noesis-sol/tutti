// The Log service (§ 3.3): .tutti/tutti.log, for people. Each line is orchestra's: the local time
// as `2006-01-02 15:04:05`, a space, and the text. A run-level line starts at the margin (START,
// HOLD, the stop reasons); a line about one ticket is indented two spaces under it (RESOLVING,
// CHECKS_FAILED, PERMISSION, …) and names the ticket by its ID, not a tab (§ 5 "Changed").
//
// Text reaches the log only as a Line, which the `line` template and the builders below make: the
// template's literal parts are tutti's own words, and every argument goes through sanitizeLine
// (§ 7.10), so a ticket title or a model's words can't put an escape sequence or a line break in
// the log. In plain mode (§ 7.6) the same lines go to stdout too.
import { Clock, Console, Context, Effect, FileSystem, Layer, Ref, Semaphore } from "effect"
import { sanitizeLine } from "../ui/sanitize.ts"

/** Where the log is, below the repository. */
export const logFile = ".tutti/tutti.log"

declare const lineBrand: unique symbol

/** One line of text for the log, its arguments sanitised: made by `line` and the builders here. */
export type Line = string & { readonly [lineBrand]: true }

/** What a line's template takes: text, a number, or a list, written as `a, b, c`. */
export type Arg = string | number | ReadonlyArray<string | number>

const show = (arg: Arg): string =>
  typeof arg === "number"
    ? String(arg)
    : typeof arg === "string"
      ? sanitizeLine(arg)
      : arg.map((each) => show(each)).join(", ")

const compose = (strings: TemplateStringsArray, args: ReadonlyArray<Arg>): string =>
  strings.reduce((text, part, i) => text + show(args[i - 1] as Arg) + part)

/** A line from a template: its literal parts as written, each argument sanitised to one line. */
export const line = (strings: TemplateStringsArray, ...args: ReadonlyArray<Arg>): Line =>
  compose(strings, args) as Line

/** A line indented under the one before: a ticket's, or a detail of a run-level line. */
export const detail = (strings: TemplateStringsArray, ...args: ReadonlyArray<Arg>): Line =>
  `  ${compose(strings, args)}` as Line

/** The words tutti's lines start with, as orchestra's do; scripts and people search for them. */
export const Tag = {
  start: "START",
  hold: "HOLD",
  resolving: "RESOLVING",
  fixing: "FIXING",
  recheck: "RECHECK",
  badTicketId: "BAD_TICKET_ID",
  runFilesOutside: "RUN_FILES_OUTSIDE",
  startFailed: "START_FAILED",
  deferFailed: "DEFER_FAILED",
  asked: "ASKED",
  answered: "ANSWERED",
  waitsForMerge: "WAITS_FOR_MERGE",
  reopenFailed: "REOPEN_FAILED",
  probe: "PROBE",
  probeOk: "PROBE_OK",
  paused: "PAUSED",
  ticketLimit: "TICKET_LIMIT",
  longRunning: "LONG_RUNNING",
  blocked: "BLOCKED",
  resumed: "RESUMED",
  workerGone: "WORKER_GONE",
  closedWithoutCommit: "CLOSED_WITHOUT_COMMIT",
  closedUncommitted: "CLOSED_UNCOMMITTED",
  mergeConflict: "MERGE_CONFLICT",
  checksFailed: "CHECKS_FAILED",
  offBranch: "OFF_BRANCH",
  dirtyWorktree: "DIRTY_WORKTREE",
  rebaseFailed: "REBASE_FAILED",
  setup: "SETUP",
  setupFailed: "SETUP_FAILED",
  setupWaits: "SETUP_WAITS",
  settingsUnread: "SETTINGS_UNREAD",
  requires: "REQUIRES",
  readmeStale: "README_STALE",
  flaky: "FLAKY",
  fullCheck: "FULL_CHECK",
  fullCheckFailed: "FULL_CHECK_FAILED",
  fullCheckNotRun: "FULL_CHECK_NOT_RUN",
  fullCheckSkipped: "FULL_CHECK_SKIPPED",
  cleanupFailed: "CLEANUP_FAILED",
  labelFailed: "LABEL_FAILED",
  closedUnmerged: "CLOSED_UNMERGED",
  notifyFailed: "NOTIFY_FAILED",
  dirtyTree: "DIRTY_TREE",
  gitFailed: "GIT_FAILED",
  mergeFailed: "MERGE_FAILED",
  permission: "PERMISSION",
  question: "QUESTION",
  allowed: "ALLOWED",
  denied: "DENIED",
  steered: "STEERED",
  released: "RELEASED",
  message: "MESSAGE",
  organ: "ORGAN",
  feature: "FEATURE",
  triageFailed: "TRIAGE_FAILED",
  usage: "USAGE",
  usageLimit: "USAGE_LIMIT",
  phaseBug: "PHASE_BUG",
} as const

/** A run-level line starting with `tag`: `HOLD: …`. */
export const tagged =
  (tag: string) =>
  (strings: TemplateStringsArray, ...args: ReadonlyArray<Arg>): Line =>
    `${tag}: ${compose(strings, args)}` as Line

/** A ticket's line starting with `tag`, indented: `  CHECKS_FAILED: …`. */
export const ticketLine =
  (tag: string) =>
  (strings: TemplateStringsArray, ...args: ReadonlyArray<Arg>): Line =>
    `  ${tag}: ${compose(strings, args)}` as Line

/** The branch a ticket's work is on (§ 11). */
const branch = (id: string): Line => line`tutti/${id}`

/** What the START block says. */
export interface Start {
  readonly version: string
  readonly repo: string
  readonly base: string
  /** What the run is limited to, if anything, as in `spec .tutti/specs/x.md` or `ticket tut-1`. */
  readonly scope?: string
  /** How it runs, in order, as label and value: `concurrent: 4`, `ticket limit: none`, … */
  readonly settings: ReadonlyArray<readonly [label: string, value: string]>
  /** What it says once, below: the permission mode or billing in effect, a scheme not used, … */
  readonly notes?: ReadonlyArray<string>
}

/** The START block: `START tutti <version> in <repo> on <base> (…)`, then its notes indented. */
export const start = (s: Start): ReadonlyArray<Line> => {
  const scope = s.scope === undefined ? "" : line` · ${s.scope}`
  const settings = s.settings.map(([label, value]) => line`${label}: ${value}`).join(", ")
  return [
    `${Tag.start} tutti ${line`${s.version} in ${s.repo} on ${s.base}`}${scope} (${settings})` as Line,
    ...(s.notes ?? []).map((note) => detail`${note}`),
  ]
}

/** HOLD: no new tickets for `reason`, while the running ones, if any, finish. */
export const hold = (reason: string, running: number): Line =>
  running === 0
    ? tagged(Tag.hold)`${reason}`
    : tagged(Tag.hold)`${reason}; no new tickets while the ${running} running finish`

/** RESOLVING: a ticket's rebase stopped on conflicts, handed back to its worker. */
export const resolving = (r: {
  readonly id: string
  readonly base: string
  readonly files: ReadonlyArray<string>
  /** How long the worker has, as in `20m`. */
  readonly limit: string
  /** What the worker is told of the setup, as `; told to run '<setup>' …` (setup.ts); "" for nothing. */
  readonly told?: Line
}): Line =>
  ticketLine(
    Tag.resolving,
  )`${branch(r.id)} conflicts with ${r.base} in ${r.files}; handed back to its worker to resolve (up to ${r.limit})${r.told ?? ""}`

/**
 * FIXING: the check failed on a ticket's branch, rebased or on top of the base already, handed back
 * to its worker.
 */
export const fixing = (f: {
  readonly id: string
  readonly base: string
  /** What failed, as in `'scripts/check-fast.sh' fails`. */
  readonly failure: string
  /** This hand-back's number, of `attempts` (`check_hand_backs`). */
  readonly attempt: number
  readonly attempts: number
  readonly limit: string
  /** The branch was on top of the base already, not rebased. */
  readonly onTop?: boolean
}): Line =>
  ticketLine(
    Tag.fixing,
  )`${f.failure} on ${branchOn(branch(f.id), f.base, f.onTop === true)}; handed back to its worker to fix (${f.attempt} of ${f.attempts}, up to ${f.limit})`

/** The branch as its check ran on it: `tutti/a rebased onto main`, or `tutti/a on top of main`. */
export const branchOn = (name: string, base: string, onTop: boolean): string =>
  onTop ? `${name} on top of ${base}` : `${name} rebased onto ${base}`

/** A permission request as `<what>`: the request's title, else its tool and input. */
const request = (id: string, what: string): Line => line`${id}'s worker asks: ${what}`

/** PERMISSION: a worker's request, and how to answer it with `tutti answer` (§ 7.6). */
export const permission = (p: {
  readonly id: string
  readonly requestId: string
  /** The tool call: `Bash(rm -rf build)`. */
  readonly what: string
  /** Why the worker is asked, when the SDK says: `held by the safety check`. */
  readonly why?: string
  /** Allowing needs `--confirm` (§ 4.5). */
  readonly defaultToNo: boolean
  /** No allow-run: the SDK offers no rule to keep. */
  readonly suppressAlwaysAllowRule: boolean
}): Line => {
  const why = p.why === undefined ? "" : line` (${p.why})`
  const answers = [
    p.defaultToNo ? "allow --confirm" : "allow",
    ...(p.suppressAlwaysAllowRule ? [] : [p.defaultToNo ? "allow-run --confirm" : "allow-run"]),
    "deny",
  ].join(" | ")
  return ticketLine(
    Tag.permission,
  )`${request(p.id, p.what)}${why}; answer with: tutti answer ${p.requestId} ${answers}`
}

/** QUESTION: a worker's AskUserQuestion, each question with its options, and how to answer it. */
export const question = (q: {
  readonly id: string
  readonly requestId: string
  readonly questions: ReadonlyArray<{
    readonly question: string
    readonly options: ReadonlyArray<string>
  }>
}): Line => {
  const asked = q.questions
    .map((each) => line`${each.question} (${each.options.join(" | ")})`)
    .join("; ")
  return ticketLine(
    Tag.question,
  )`${request(q.id, asked)}; answer with: tutti answer ${q.requestId} allow --choice <option>`
}

/** QUESTION: an MCP server's elicitation, asking for input or a URL login (§ 4.5). */
export const elicitation = (e: {
  readonly id: string
  readonly requestId: string
  readonly server: string
  readonly message: string
  /** The URL to open, for a URL login. */
  readonly url?: string
}): Line => {
  const url = e.url === undefined ? "" : line` (open ${e.url})`
  return ticketLine(
    Tag.question,
  )`${request(e.id, line`MCP server ${e.server}: ${e.message}`)}${url}; answer in tutti, request ${e.requestId}`
}

/** How a request was answered, or that the SDK withdrew it. */
export type Verdict =
  | "allowed"
  | "allowed for this run"
  | "denied"
  | "answered"
  | "declined"
  | "withdrawn"

/** A request's answer: `  PERMISSION: tut-1's worker: Bash(x) allowed, via tutti answer`. */
export const answered = (a: {
  readonly id: string
  readonly kind: "permission" | "question"
  readonly what: string
  readonly verdict: Verdict
  /** The reason given with a denial, or the options chosen for a question. */
  readonly detail?: string
  readonly via: "screen" | "tutti answer"
}): Line => {
  const tag = a.kind === "permission" ? Tag.permission : Tag.question
  const detailed = a.detail === undefined ? "" : line` (${a.detail})`
  const via = a.via === "tutti answer" ? ", via tutti answer" : ""
  return ticketLine(tag)`${a.id}'s worker: ${a.what} ${a.verdict}${detailed}${via}`
}

/** ALLOWED: a request allowed without asking, by a rule allowed for this run (§ 4.5). */
export const allowedByRule = (id: string, what: string): Line =>
  ticketLine(Tag.allowed)`${id}'s worker: ${what}, by a rule you allowed for this run`

/** What denied a tool call, from the SDK's `decision_reason_type`. */
export type DeniedBy = "classifier" | "safetyCheck" | "mode" | "rule"

/** What stands for the SDK's `decision_reason_type` when a denial comes without one. */
export const unknownDenier = "unknown"

const deniers: Record<string, string> = {
  classifier: "the classifier",
  safetyCheck: "the safety check",
  mode: "the permission mode",
  rule: "a rule",
  [unknownDenier]: "Claude Code",
}

/** What denied a tool call, in words: `the safety check`; a type tutti doesn't know, as given. */
export const denier = (by: DeniedBy | (string & {})): string =>
  Object.hasOwn(deniers, by) ? (deniers[by] ?? by) : by

/** DENIED: the classifier, the safety check, the mode or a rule refused a worker's tool call (§ 4.5). */
export const denied = (d: {
  readonly id: string
  readonly what: string
  /** A `decision_reason_type` tutti doesn't know is named as given. */
  readonly by: DeniedBy | (string & {})
  readonly reason: string
}): Line => ticketLine(Tag.denied)`${d.id}'s worker: ${d.what}, by ${denier(d.by)}: ${d.reason}`

/** A worker's context was compacted, `trigger` its PreCompact hook's (§ 4.2), as orchestra says it. */
export const compacted = (id: string, trigger: string): Line =>
  detail`${id}'s worker's context was compacted (${trigger})`

/** STEERED: you sent the worker a message or interrupted it (§ 4.3). */
export const steered = (id: string): Line => ticketLine(Tag.steered)`${id}`

/** RELEASED: the worker is no longer steered (§ 4.3). */
export const released = (id: string): Line => ticketLine(Tag.released)`${id}`

/** MESSAGE: you sent the worker a message; its length, never its text (§ 7.5). */
export const message = (id: string, text: string): Line =>
  ticketLine(Tag.message)`you → ${id} (${[...text].length} characters)`

/** USAGE: an account's usage nears a limit (`allowed_warning`), said once per limit (§ 4.12). */
export const usageWarning = (u: {
  readonly percent: number
  /** The limit's name: `five-hour`. */
  readonly limit: string
  /** The local time it resets, as in `14:05`, when known. */
  readonly resets?: string
}): Line => {
  const resets = u.resets === undefined ? "" : line` · resets ${u.resets}`
  return tagged(Tag.usage)`${u.percent}% of the ${u.limit} limit${resets}`
}

/** USAGE_LIMIT: the account reached a limit; the run holds until it resets (§ 4.12). */
export const usageLimit = (u: { readonly limit: string; readonly resets?: string }): Line =>
  u.resets === undefined
    ? tagged(Tag.usageLimit)`the ${u.limit} limit is reached; no new tickets until it resets`
    : tagged(
        Tag.usageLimit,
      )`the ${u.limit} limit is reached; no new tickets until it resets at ${u.resets}`

/** The usage-limit hold is lifted: workers waiting for it carry on (§ 4.12). */
export const usageLimitLifted: Line = `${Tag.usageLimit} lifted` as Line

/** PHASE_BUG: the run loop asked for a transition the state machine doesn't have (§ 5.1). */
export const phaseBug = (p: {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly cause: string
}): Line => ticketLine(Tag.phaseBug)`${p.id} ${p.from} → ${p.to} (${p.cause})`

const pad = (n: number): string => String(n).padStart(2, "0")

/** The local time at `millis` as the log dates its lines: `2026-10-17 09:05:03`. */
export const stamp = (millis: number): string => {
  const t = new Date(millis)
  return (
    `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ` +
    `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`
  )
}

/** The lines as written, each dated with the time now from Effect's Clock. */
export const dated = (lines: ReadonlyArray<Line>): Effect.Effect<ReadonlyArray<string>> =>
  Effect.map(Clock.currentTimeMillis, (now) => lines.map((each) => `${stamp(now)} ${each}`))

/** Where else the log's lines go: none, or stdout, for plain mode (§ 7.6). */
export type Sink = "none" | "stdout"

/** Prints the dated lines to stdout, through Effect's Console, when `sink` says so. */
export const toSink = (sink: Sink, lines: ReadonlyArray<string>): Effect.Effect<void> =>
  sink === "stdout"
    ? Console.consoleWith((console) =>
        Effect.sync(() => {
          for (const l of lines) console.log(l)
        }),
      )
    : Effect.void

export class Log extends Context.Service<
  Log,
  {
    /** Appends the lines, dated now, together: a START block isn't split by another fiber's line. */
    write(...lines: ReadonlyArray<Line>): Effect.Effect<void>
    /**
     * Appends the lines as `write` does and runs `record`, the happening's record in events.jsonl,
     * before another fiber's line: the log and the event stream give happenings in one order.
     * `record` mustn't write the log itself.
     */
    writeWith(lines: ReadonlyArray<Line>, record: Effect.Effect<void>): Effect.Effect<void>
    /** This run's lines as written, dated, for the reviewer. */
    readonly lines: Effect.Effect<ReadonlyArray<string>>
  }
>()("tutti/run/Log") {
  /**
   * The log at `file` (`.tutti/tutti.log` below the repository), opened for appending. A line that
   * can't be written is dropped, as orchestra drops it: the run goes on. With `sink: "stdout"`,
   * each line is printed as well.
   */
  static readonly layer = (options: { readonly file: string; readonly sink?: Sink }) =>
    Layer.effect(
      Log,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const file = yield* fs.open(options.file, { flag: "a" })
        const encoder = new TextEncoder()
        const written = yield* Ref.make<ReadonlyArray<string>>([])
        const one = yield* Semaphore.make(1)
        const append = (lines: ReadonlyArray<Line>) =>
          Effect.gen(function* () {
            const text = yield* dated(lines)
            yield* file
              .writeAll(encoder.encode(text.map((l) => `${l}\n`).join("")))
              .pipe(Effect.ignore)
            yield* Ref.update(written, (all) => [...all, ...text])
            yield* toSink(options.sink ?? "none", text)
          })
        return Log.of({
          write: (...lines) => one.withPermit(append(lines)),
          writeWith: (lines, record) => one.withPermit(Effect.andThen(append(lines), record)),
          lines: Ref.get(written),
        })
      }),
    )
}
