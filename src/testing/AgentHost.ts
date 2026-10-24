// AgentHost's test layer (§ 3.3, § 13): the live AgentHost (src/agent/AgentHostLive.ts) over
// scripted sessions (src/testing/ClaudeCode.ts). Each ticket has a script, one list of steps per
// session: each start or resume plays the next, and one with none left fails AgentStartFailed. So a
// scenario's sessions are started, read, checked, interrupted and closed by the code a run's are:
// their messages recorded in Transcripts and folded into the workers' state, their first
// system/init and initialize answers checked (a setup problem ending the worker Gone with `setup`),
// their hooks, canUseTool and onElicitation the live host's. Its environment is a test one: a
// FileSystem where every folder is there and the project has no skills, the run's AppConfig where
// the scenario gives one (`options` laid over it), and a worker prompt of a line.
//
// Everything the host is sent is recorded, in order: starts, resumes, messages as the SDK gets them
// (client_composed or origin human, a resume's with the notes the live host puts before it),
// interrupts and their receipts, cancel_async_message requests and their answers, the answers to
// permission requests and elicitations, closes of open sessions and ends. Recording reads them
// back. The uuids of the messages a caller didn't draw are drawn here, in order:
// 00000000-0000-4000-8000-000000000001, then ...-000000000002, and so on.
import type {
  CanUseTool,
  ElicitationRequest,
  HookInput,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { Context, type Duration, Effect, FileSystem, Layer, Option, Ref } from "effect"
import type { Billing, PermissionModeInEffect } from "../agent/Account.ts"
import { AgentHost } from "../agent/AgentHost.ts"
import { layer as liveLayer, resumedNotes } from "../agent/AgentHostLive.ts"
import type { Attention } from "../agent/Attention.ts"
import { LaunchFailed } from "../agent/ClaudeCode.ts"
import { type ChosenServers, noServers } from "../agent/mcp.ts"
import type { Transcripts } from "../agent/Transcripts.ts"
import { AppConfig, type AppConfigValue } from "../cli/AppConfig.ts"
import { coresNote } from "../project/prompt.ts"
import type { Settings } from "../project/settings.ts"
import type { Log } from "../run/log.ts"
import { appConfig } from "./AppConfig.ts"
import { layer as claudeCodeLayer, Sent, type SessionScript, Step } from "./ClaudeCode.ts"

export { Sent, type SessionScript, Step } from "./ClaudeCode.ts"

/** A ticket's sessions, in the order they are started or resumed. */
export type Script = ReadonlyArray<SessionScript>

/** What the layer was sent, for a test to look at. */
export class Recording extends Context.Service<
  Recording,
  {
    /** Everything, in order. */
    readonly all: Effect.Effect<ReadonlyArray<Sent>>
    /** What the ticket's worker was sent, in order. */
    sentTo(ticket: string): Effect.Effect<ReadonlyArray<Sent>>
    /** The messages the ticket's worker was sent, in order. */
    messages(ticket: string): Effect.Effect<ReadonlyArray<SDKUserMessage>>
    /** The names of each requires list the run took from a merge (takeRequires), in order. */
    readonly requires: Effect.Effect<ReadonlyArray<ReadonlyArray<string>>>
  }
>()("tutti/testing/AgentHost/Recording") {}

/**
 * A resumed worker's message without the notes the live host puts before it where its session
 * began in an earlier run, or with other notes (resumedNotes): the text its caller sent.
 */
export const withoutNotes = (text: string): string => {
  const end = `${coresNote}\n\n`
  const at = text.indexOf(end)
  return text.startsWith(resumedNotes("").trimEnd()) && at !== -1
    ? text.slice(at + end.length)
    : text
}

// A message's uuid, as the SDK's UUID type has them: the nth is ...-000000000001 and so on.
const uuidOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

/** What `layer` takes beside the scripts. */
export interface Options {
  /** The project's check commands, at most three: tool calls running them are `testing`. */
  readonly checks?: ReadonlyArray<string>
  /** The MCP servers workers get, which their first system/init is checked against: none. */
  readonly servers?: ChosenServers
  /** The permission mode workers ask for, which system/init's is checked against: auto. */
  readonly permissionMode?: PermissionModeInEffect["requested"]
  /** How workers are billed, which their API key source is checked against: the subscription. */
  readonly billing?: Billing
  /**
   * How the CLI answers `cancel_async_message`, which an interrupt sends for each message still
   * queued where the session's CLI doesn't list `interrupt_cancel_queued_v1` (§ 4.8): by default it
   * drops the message (`cancelled: true`), which never runs; "refuse" fails the request, and
   * "notQueued" answers `cancelled: false`, as for a message its turn has already taken. A message
   * not dropped stays queued and runs.
   */
  readonly cancelAsync?: "refuse" | "notQueued"
  /** The process each ticket's Claude Code would have while its session runs: none by default. */
  readonly processes?: ReadonlyMap<string, number>
  /**
   * How long a closed session's Claude Code takes to exit, on the Clock, which `close` and `end`
   * wait for: none by default. The wait holds no other ticket's start, resume or close, as the live
   * layer's doesn't.
   */
  readonly closeTakes?: Duration.Input
}

/**
 * The settings `base` with the check commands `commands` (checkCommands' order: the merge check's,
 * the full check's, the worker's own), the others none.
 */
const withChecks = (base: Settings, commands: ReadonlyArray<string>): Settings => {
  if (commands.length > 3) throw new Error(`at most three check commands: ${commands.join(", ")}`)
  const [fast = null, full = null, own = null] = commands
  return {
    ...base,
    checks: {
      ...base.checks,
      fast: { ...base.checks.fast, command: fast },
      full: { ...base.checks.full, command: full },
      own: { ...base.checks.own, command: own },
    },
  }
}

/** The run's configuration, as the scripted host's live host reads it: `options` over `base`. */
const configOf = (base: AppConfigValue, options: Options): AppConfigValue => {
  const settings = withChecks(base.settings, options.checks ?? [])
  return {
    ...base,
    settings: {
      ...settings,
      workers: { ...settings.workers, permission_mode: options.permissionMode ?? "auto" },
    },
  }
}

/** A folder is always there; nothing else is: no skills, no settings files. */
const fileSystem = FileSystem.layerNoop({ exists: () => Effect.succeed(true) })

/** Whether the ticket's worker has a session open: one that hasn't been closed or gone. */
const isOpen = (host: AgentHost["Service"], ticket: string) =>
  Effect.map(
    Effect.option(host.current(ticket)),
    (state) => Option.isSome(state) && state.value._tag !== "Closed" && state.value._tag !== "Gone",
  )

/**
 * The scripted AgentHost, playing `scripts`' sessions for each ticket, and Recording. A start or
 * resume with no session left in its ticket's script fails AgentStartFailed.
 */
export const layer = (
  scripts: Readonly<Record<string, Script>>,
  options: Options = {},
): Layer.Layer<AgentHost | Recording, never, Attention | Transcripts | Log> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const base = Option.getOrElse(yield* Effect.serviceOption(AppConfig), () => appConfig())
      const left = new Map(Object.entries(scripts).map(([ticket, script]) => [ticket, [...script]]))
      const sent: Array<Sent> = []
      const requires: Array<ReadonlyArray<string>> = []
      const drawn = yield* Ref.make(0)
      const draw = Ref.updateAndGet(drawn, (k) => k + 1)
      // The tickets whose starts and resumes are under way, by the session ID each opens, in order.
      const opening = new Map<string, Array<{ readonly ticket: string }>>()

      const record = (item: Sent) => Effect.sync(() => void sent.push(item))

      const claudeCode = claudeCodeLayer({
        next: (launch) =>
          Effect.suspend(() => {
            const sessionId = launch.options.sessionId ?? launch.options.resume ?? ""
            const ticket = opening.get(sessionId)?.shift()?.ticket
            const steps = ticket === undefined ? undefined : left.get(ticket)?.shift()
            return ticket === undefined || steps === undefined
              ? Effect.fail(new LaunchFailed({ reason: "the script has no more sessions" }))
              : Effect.succeed({ ticket, steps })
          }),
        record,
        draw,
        ...(options.cancelAsync === undefined ? {} : { cancelAsync: options.cancelAsync }),
        ...(options.processes === undefined ? {} : { processes: options.processes }),
        ...(options.closeTakes === undefined ? {} : { closeTakes: options.closeTakes }),
      })
      const built = yield* Layer.build(
        liveLayer({
          prompt: { text: "Work on TICKET_ID.", file: null },
          servers: options.servers ?? noServers,
          account: { billing: options.billing ?? { _tag: "Subscription", keyUnused: false } },
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              claudeCode,
              Layer.succeed(AppConfig, configOf(base, options)),
              fileSystem,
            ),
          ),
        ),
      )
      const live = Context.get(built, AgentHost)

      // Runs `start`, a start or resume of the ticket's session `sessionId`, its session opened
      // playing the ticket's next script.
      const opened = <A, E>(ticket: string, sessionId: string, start: Effect.Effect<A, E>) =>
        Effect.suspend(() => {
          const entry = { ticket }
          const each = opening.get(sessionId) ?? []
          opening.set(sessionId, [...each, entry])
          return Effect.ensuring(
            start,
            Effect.sync(() => {
              const now = opening.get(sessionId)?.filter((other) => other !== entry) ?? []
              if (now.length === 0) opening.delete(sessionId)
              else opening.set(sessionId, now)
            }),
          )
        })

      const uuid = (given: string | undefined) =>
        given === undefined ? Effect.map(draw, uuidOf) : Effect.succeed(given)

      const host = AgentHost.of({
        ...live,
        start: (ticket, s) =>
          Effect.andThen(
            record(Sent.Started({ ticket, session: s })),
            opened(ticket, s.sessionId, live.start(ticket, s)),
          ),
        resume: (ticket, s, message) =>
          Effect.gen(function* () {
            yield* record(Sent.Resumed({ ticket, session: s }))
            const drawn = yield* uuid(message.uuid)
            return yield* opened(
              ticket,
              s.sessionId,
              live.resume(ticket, s, { ...message, uuid: drawn }),
            )
          }),
        send: (ticket, text, from, given) =>
          Effect.flatMap(uuid(given), (drawn) => live.send(ticket, text, from, drawn)),
        interrupt: (ticket) =>
          Effect.tap(live.interrupt(ticket), (receipt) =>
            record(Sent.Interrupted({ ticket, receipt })),
          ),
        close: (ticket) =>
          Effect.gen(function* () {
            if (yield* isOpen(live, ticket)) yield* record(Sent.Closed({ ticket }))
            yield* live.close(ticket)
          }),
        end: (ticket) =>
          Effect.gen(function* () {
            if (yield* isOpen(live, ticket)) yield* record(Sent.Closed({ ticket }))
            yield* live.close(ticket)
            yield* record(Sent.Ended({ ticket }))
            yield* live.end(ticket)
          }),
        takeRequires: (names) =>
          Effect.andThen(
            Effect.sync(() => void requires.push(names)),
            live.takeRequires(names),
          ),
      })

      const recording = Recording.of({
        all: Effect.sync(() => [...sent]),
        sentTo: (ticket) => Effect.sync(() => sent.filter((item) => item.ticket === ticket)),
        messages: (ticket) =>
          Effect.sync(() =>
            sent.flatMap((item) =>
              item._tag === "Message" && item.ticket === ticket ? [item.message] : [],
            ),
          ),
        requires: Effect.sync(() => [...requires]),
      })
      return Context.make(AgentHost, host).pipe(Context.add(Recording, recording))
    }),
  )

// Step constructors.

export const emit = (message: object): Step => Step.Emit({ message: message as SDKMessage })
export const hook = (input: object): Step => Step.Hook({ input: input as HookInput })
export const canUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: Partial<Omit<Parameters<CanUseTool>[2], "signal">> = {},
): Step => Step.CanUseTool({ toolName, input, options })
export const elicit = (request: ElicitationRequest): Step => Step.Elicit({ request })
export const wait: Step = Step.Wait()
export const fold: Step = Step.Fold()
export const coalesce: Step = Step.Coalesce()
export const awaitInterrupt: Step = Step.AwaitInterrupt()
export const sleep = (duration: Duration.Input): Step => Step.Sleep({ duration })
export const context = (answer: object): Step => Step.Context({ answer })
export const run = (effect: Effect.Effect<void>): Step => Step.Do({ effect })
/** The session's stream ends without tutti closing it, Claude Code having written `why`. */
export const gone = (why: string): Step => Step.Gone({ why })
/**
 * The session's initialize answer, as the live layer reads it (`account`, `capabilities`), and its
 * mcpServerStatus() answer, `status`, when it gave one.
 */
export const initialize = (answer: object = {}, status?: unknown): Step =>
  Step.Initialize({ answer, ...(status === undefined ? {} : { status }) })
export const failStart = (reason: string, startupFailureReason?: string): Step =>
  Step.FailStart({
    reason,
    ...(startupFailureReason === undefined ? {} : { startupFailureReason }),
  })

// SDK messages, as docs/spikes/01-sdk-session.md recorded them, with the fields tutti reads.

/** `system/init`, which starts every turn. */
export const init = (fields: object = {}) =>
  emit({
    type: "system",
    subtype: "init",
    permissionMode: "auto",
    apiKeySource: "none",
    cwd: "",
    tools: [],
    mcp_servers: [],
    model: "claude",
    slash_commands: [],
    output_style: "default",
    ...fields,
  })

export const sessionState = (state: "running" | "requires_action" | "idle") =>
  emit({ type: "system", subtype: "session_state_changed", state })

/** A turn's clean result. */
export const result = (text = "DONE", fields: object = {}) =>
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    num_turns: 1,
    ...fields,
  })

/** A turn's result with `is_error`: an API error ending it (a 429 is the usage limit, § 4.12). */
export const apiErrorResult = (text: string, status: number) =>
  emit({
    type: "result",
    subtype: "success",
    is_error: true,
    result: text,
    api_error_status: status,
    num_turns: 1,
  })

/** An interrupted turn's result, as the spike saw it. */
export const interruptedResult = emit({
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  errors: [],
  num_turns: 1,
})

export const apiRetry = (attempt: number, status: number | null = 529, max = 10) =>
  emit({
    type: "system",
    subtype: "api_retry",
    attempt,
    max_retries: max,
    retry_delay_ms: 500,
    error_status: status,
    error: "overloaded",
  })

/** `background_tasks_changed`: the live tasks, replacing the set; ambient ones don't count. */
export const backgroundTasks = (
  ...tasks: ReadonlyArray<{ readonly id: string; readonly ambient?: boolean }>
) =>
  emit({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: tasks.map(({ id, ambient }) => ({
      task_id: id,
      task_type: "local_bash",
      description: id,
      ...(ambient === undefined ? {} : { ambient }),
    })),
  })

/**
 * A background task's end, as the CLI sends it (docs/spikes/01-sdk-session.md, item 4):
 * `task_updated` (completed), `task_notification`, then the live set without it, `left`.
 */
export const taskEnds = (
  id: string,
  ...left: ReadonlyArray<{ readonly id: string; readonly ambient?: boolean }>
): ReadonlyArray<Step> => [
  emit({ type: "system", subtype: "task_updated", task_id: id, patch: { status: "completed" } }),
  emit({
    type: "system",
    subtype: "task_notification",
    task_id: id,
    status: "completed",
    output_file: `/tmp/tasks/${id}.output`,
    summary: `Background command "${id}" completed`,
  }),
  backgroundTasks(...left),
]

/**
 * The turn the CLI starts by itself, with no send of tutti's: to report a finished task, about
 * 70 ms after the set emptied (the spike saw 69), or for an event a Monitor watch saw.
 */
export const selfStartedTurn = (
  steps: ReadonlyArray<Step> = [],
  end: Step = result(),
): ReadonlyArray<Step> => [
  sleep("70 millis"),
  sessionState("running"),
  init(),
  ...steps,
  end,
  sessionState("idle"),
]

/** `rate_limit_event`; `resetsAt` in seconds since the epoch, as the API's header has it. */
export const rateLimit = (
  status: "allowed" | "allowed_warning" | "rejected",
  resetsAt?: number,
  utilization?: number,
) =>
  emit({
    type: "rate_limit_event",
    rate_limit_info: {
      status,
      rateLimitType: "five_hour",
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(utilization === undefined ? {} : { utilization }),
    },
  })

export const assistantText = (text: string, fields: object = {}) =>
  emit({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    ...fields,
  })

let toolIds = 0

/**
 * A tool call the session makes and its result: the PreToolUse hook, the assistant's tool_use,
 * `effect` (what the call does, to an in-memory Beads or Git), the tool_result and PostToolUse.
 */
export const tool = (
  name: string,
  input: Record<string, unknown>,
  effect?: Effect.Effect<void>,
): ReadonlyArray<Step> => {
  const id = `toolu_s${++toolIds}`
  return [
    hook({ hook_event_name: "PreToolUse", tool_name: name, tool_input: input, tool_use_id: id }),
    emit({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
      parent_tool_use_id: null,
    }),
    ...(effect === undefined ? [] : [run(effect)]),
    emit({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "" }] },
      parent_tool_use_id: null,
    }),
    hook({ hook_event_name: "PostToolUse", tool_name: name, tool_input: input, tool_use_id: id }),
  ]
}

/** Bash running `command`, doing `effect`. */
export const bash = (command: string, effect?: Effect.Effect<void>) =>
  tool("Bash", { command }, effect)

/** What the CLI tells the worker when the safety check denies a held removal in auto mode. */
export const heldRemovalMessage =
  "Only a person may approve such a removal, and no person did (the permission prompt timed out, or this session cannot prompt)"

/**
 * A tool call Claude Code denies without asking, as the spike saw it in auto mode
 * (docs/spikes/01-sdk-session.md): the assistant's tool_use, a `permission_denied` naming what
 * denied it (`decision_reason_type`, left out when `by` is undefined) and why, and the tool_result
 * with the refusal it tells the worker, `message`. No canUseTool call, and no hooks.
 */
export const deniedTool = (
  name: string,
  input: Record<string, unknown>,
  denial: {
    readonly by: string | undefined
    readonly reason?: string
    readonly message?: string
    readonly agentId?: string
  },
): ReadonlyArray<Step> => {
  const id = `toolu_s${++toolIds}`
  const message = denial.message ?? `Permission to use ${name} has been denied.`
  return [
    emit({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
      parent_tool_use_id: null,
    }),
    emit({
      type: "system",
      subtype: "permission_denied",
      tool_name: name,
      tool_use_id: id,
      ...(denial.agentId === undefined ? {} : { agent_id: denial.agentId }),
      ...(denial.by === undefined ? {} : { decision_reason_type: denial.by }),
      ...(denial.reason === undefined ? {} : { decision_reason: denial.reason }),
      message,
      uuid: `00000000-0000-4000-8000-d${String(toolIds).padStart(11, "0")}`,
    }),
    emit({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: message, is_error: true }],
      },
      parent_tool_use_id: null,
    }),
  ]
}

/**
 * A turn: it waits for a message, then system/init and running, `steps`, `end` (a clean result by
 * default) and idle.
 */
export const turn = (steps: ReadonlyArray<Step>, end: Step = result()): SessionScript => [
  wait,
  init(),
  sessionState("running"),
  ...steps,
  end,
  sessionState("idle"),
]

/** A turn the queued messages of one kind share (Coalesce); its result lists them all. */
export const coalescedTurn = (steps: ReadonlyArray<Step>, end: Step = result()): SessionScript => [
  coalesce,
  ...turn(steps, end).slice(1),
]

// The common scripts: one session each. A ticket's script is a list of them, one per start or
// resume. The effects stand for what the worker's commands do to an in-memory Beads or Git.

/** What a helper's commands do. */
export interface Effects {
  readonly claim?: Effect.Effect<void>
  readonly commit?: Effect.Effect<void>
  readonly close?: Effect.Effect<void>
  readonly defer?: Effect.Effect<void>
  readonly file?: Effect.Effect<void>
}

/** The check the helpers run; pass it in `checks` for its runs to be `testing`. */
export const checkCommand = "scripts/check-fast.sh"

/** Claims its ticket, edits, runs the check, commits and closes the ticket. */
export const claimsAndCloses = (ticket: string, effects: Effects = {}): SessionScript =>
  turn(
    [
      ...bash(`bd update ${ticket} --claim`, effects.claim),
      ...tool("Edit", { file_path: "src/main.ts", old_string: "a", new_string: "b" }),
      ...bash(checkCommand),
      ...bash(`git commit -am "Change (${ticket})"`, effects.commit),
      ...bash(`bd close ${ticket}`, effects.close),
    ],
    result(`Closed ${ticket}.`),
  )

/** Claims its ticket, notes why it can't finish and defers it. */
export const defers = (ticket: string, effects: Effects = {}): SessionScript =>
  turn(
    [
      ...bash(`bd update ${ticket} --claim`, effects.claim),
      ...bash(`bd update ${ticket} --append-notes "Can't finish: needs a design"`),
      ...bash(`bd defer ${ticket}`, effects.defer),
    ],
    result(`Deferred ${ticket}.`),
  )

/** Claims its ticket, files a question for the maintainer, and puts its ticket back to open. */
export const filesQuestion = (ticket: string, effects: Effects = {}): SessionScript =>
  turn(
    [
      ...bash(`bd update ${ticket} --claim`, effects.claim),
      ...bash(
        `bd create --type=task --labels human --deps blocks:${ticket} --title "Which way?"`,
        effects.file,
      ),
      ...bash(`bd update ${ticket} --status open --append-notes "Waiting on a question"`),
    ],
    result(`Asked about ${ticket}.`),
  )

/**
 * Asks permission for a tool call (Bash `rm -rf build` by default) and, once answered, makes it
 * and ends its turn.
 */
export const asksPermission = (
  call: {
    readonly tool?: string
    readonly input?: Record<string, unknown>
    readonly options?: Partial<Omit<Parameters<CanUseTool>[2], "signal">>
  } = {},
): SessionScript => {
  const name = call.tool ?? "Bash"
  const input = call.input ?? { command: "rm -rf build" }
  return turn([canUseTool(name, input, call.options), ...tool(name, input)])
}

/**
 * Runs Bash `command` in the background (task `b1`) and ends its turn while it runs: idle comes
 * with the task live. After `runs` the task ends and the CLI starts a turn to report it, which
 * reads its output; with `reported` false, no such turn comes.
 */
export const backgroundCommand = (
  command: string,
  runs: Duration.Input,
  options: { readonly reported?: boolean } = {},
): SessionScript => [
  ...turn([...tool("Bash", { command, run_in_background: true }), backgroundTasks({ id: "b1" })]),
  sleep(runs),
  ...taskEnds("b1"),
  ...(options.reported === false
    ? []
    : selfStartedTurn(tool("Read", { file_path: "/tmp/tasks/b1.output" }))),
]

/**
 * Sets a Monitor watch (task `m1`, `local_bash` and not ambient, as the spike saw) and ends its
 * turn while it watches. After `quiet` the watch sees an event, which starts a turn by itself; the
 * watch is still live after it.
 */
export const monitorWatch = (quiet: Duration.Input): SessionScript => [
  ...turn([
    ...tool("Monitor", { command: "tail -f .tutti/tutti.log", description: "the run's log" }),
    backgroundTasks({ id: "m1" }),
  ]),
  sleep(quiet),
  ...selfStartedTurn([assistantText("A new line in the log.")]),
]

/**
 * Hits the usage limit: a rejected rate_limit_event resetting at `resetsAt` (seconds since the
 * epoch), retries, and the turn's result with is_error and status 429.
 */
export const hitsUsageLimit = (resetsAt: number): SessionScript => [
  wait,
  init(),
  sessionState("running"),
  rateLimit("rejected", resetsAt, 1),
  apiRetry(1, 429),
  assistantText("API Error: usage limit reached", { error: "rate_limit" }),
  apiErrorResult("API Error: usage limit reached", 429),
  sessionState("idle"),
]
