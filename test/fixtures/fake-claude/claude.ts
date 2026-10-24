// A fake Claude Code for test/agent-host-live.test.ts and test/agent-sdk-language-model.test.ts:
// started by the Agent SDK in place of the real one (pathToClaudeCodeExecutable), it speaks the
// SDK's stream-json protocol on stdin and stdout, with the message shapes
// docs/spikes/01-sdk-session.md and 02-sdk-lifecycle.md recorded
// (SDK 0.3.301, Claude Code 2.1.301). It answers the SDK's initialize, interrupt and
// cancel_async_message control requests, plays one turn per message it is sent (a message sent
// during a turn waits in its queue and runs as the next turn, with those of its kind waiting behind
// it, or a wait step folds it into the running turn), and ends when its stdin closes, which it logs as `{ closed: true }`. Each
// message gets its command_lifecycle (queued, started, then completed or cancelled), each result
// lists in `user_message_uuids` every message its turn took, `idle` comes only after the last
// queued turn, and `queued_turn_count` counts only queued messages sent without `client_composed`,
// as the spike saw them. A background step's task ends after `idle`, and the fake starts a turn by
// itself to report it, whose result lists no message.
//
// What it does is the scenario in FAKE_CLAUDE_SCENARIO, as JSON. It appends its arguments and every
// line it reads to the scenario's log, one JSON line each, for the test to read back.
import { spawn } from "node:child_process"
import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

/** A step of a turn, played after its system/init. */
type Step =
  /** An assistant message with this text. */
  | { readonly text: string }
  /** Waits until the turn is interrupted. */
  | { readonly hang: true }
  /**
   * Folds the messages queued into the running turn, as the CLI does between tool rounds: takes
   * them all, or waits for one when none is queued.
   */
  | { readonly wait: true }
  /** A background task with this ID, live until the turns are over; then it ends and is reported. */
  | { readonly background: string }
  /** The process exits with this code, mid-turn. */
  | { readonly exit: number }
  /** Writes this to stderr. */
  | { readonly stderr: string }
  /** Calls the SDK's hook callbacks for the event, and waits for their answers. */
  | {
      readonly hook: {
        readonly hook_event_name: string
        readonly tool_name: string
        readonly tool_input: Record<string, unknown>
      }
    }
  /** Asks the SDK's canUseTool, waits for the answer, and says what it was. */
  | { readonly permission: { readonly tool_name: string; readonly input: Record<string, unknown> } }
  /** Writes this message as it is, with the session's ID. */
  | { readonly message: Record<string, unknown> }
  /** Fields laid over the turn's result: a structured output, an error subtype, a cost. */
  | { readonly result: Record<string, unknown> }

interface Scenario {
  /** Fields laid over every system/init. */
  readonly init?: Record<string, unknown>
  /** Fields laid over the initialize control request's answer. */
  readonly initialize?: Record<string, unknown>
  /** In place of the initialize's answer, a startup failure's result with this reason, then exit 1. */
  readonly startupFailure?: string
  /** The process exits with this code at once, before reading anything. */
  readonly exitAtStart?: number
  /** Written to stderr at once, before reading anything. */
  readonly stderrAtStart?: string
  /** The servers the mcp_status control request answers with; it answers `{}` without them. */
  readonly mcpStatus?: ReadonlyArray<Record<string, unknown>>
  /** The get_settings control request's answer, in place of `{}`. */
  readonly settings?: Record<string, unknown>
  /** The get_context_usage control request's answer, in place of `{}`. */
  readonly contextUsage?: Record<string, unknown>
  /**
   * Starts a process of its own that runs until killed, in the fake's process group, and logs
   * `{ descendant: <pid> }`.
   */
  readonly descendant?: boolean
  /** Each turn's steps, in order; a turn past them answers `ECHO: <its messages>`. */
  readonly turns?: ReadonlyArray<ReadonlyArray<Step>>
  /** The file the arguments and every line read are appended to. */
  readonly log?: string
  /** Environment variables logged with the arguments, unset ones as null. */
  readonly env?: ReadonlyArray<string>
  /** Reads stdin's end only once the running turns are over, as Claude Code does, then ends. */
  readonly eofAfterTurn?: boolean
  /**
   * How long, in ms, an interrupted turn takes to end after the interrupt's receipt: a
   * `cancel_async_message` sent at once lands before the next turn takes the queue. 0 by default.
   */
  readonly interruptLag?: number
  /** "unanswered": the interrupt control request is never answered, nor the turn interrupted. */
  readonly interrupt?: "unanswered"
  /**
   * How `cancel_async_message` is answered: by default it drops the message if it is still queued
   * (`cancelled: true`, then its command_lifecycle `cancelled`), else `cancelled: false`;
   * "refuse" fails the request, "notQueued" answers `cancelled: false` and leaves it queued, and
   * "unanswered" never answers it.
   */
  readonly cancelAsync?: "refuse" | "notQueued" | "unanswered"
  /** How long, in ms, the initialize's answer waits: a start still under way. */
  readonly initializeLag?: number
  /**
   * How long, in ms, the process lingers after its stdin ends, ignoring SIGTERM, as Claude Code
   * winds down; it logs `{ exited: <pid> }` as it exits.
   */
  readonly lingerOnClose?: number
}

interface UserMessage {
  readonly type: "user"
  readonly uuid?: string
  readonly client_composed?: boolean
  readonly message: { readonly content: unknown }
}

const scenario: Scenario = JSON.parse(process.env.FAKE_CLAUDE_SCENARIO ?? "{}")
const args = process.argv.slice(2)

const log = (entry: object) => {
  if (scenario.log !== undefined) appendFileSync(scenario.log, `${JSON.stringify(entry)}\n`)
}

/** The value of `--name=value` or `--name value` among the arguments. */
const flag = (name: string): string | undefined => {
  for (const [i, arg] of args.entries()) {
    if (arg === name) return args[i + 1]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

const sessionId = flag("--session-id") ?? flag("--resume") ?? crypto.randomUUID()

const write = (message: object) =>
  new Promise<void>((resolve) =>
    process.stdout.write(`${JSON.stringify(message)}\n`, () => resolve()),
  )

const exit = async (code: number) => {
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()))
  process.exit(code)
}

log({
  args,
  pid: process.pid,
  cwd: process.cwd(),
  env: Object.fromEntries((scenario.env ?? []).map((name) => [name, process.env[name] ?? null])),
})
if (scenario.stderrAtStart !== undefined) process.stderr.write(scenario.stderrAtStart)
if (scenario.exitAtStart !== undefined) await exit(scenario.exitAtStart)
if (scenario.descendant === true) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {
    stdio: "ignore",
  })
  child.unref()
  log({ descendant: child.pid })
}

/** The hook callback IDs the SDK registered, by event. */
let hookIds: Record<string, ReadonlyArray<string>> = {}
/** Answers to the control requests this process sent, by request ID. */
const answers = new Map<string, (response: unknown) => void>()
let requests = 0

const ask = (request: object) =>
  new Promise<unknown>((resolve) => {
    const id = `fake_req_${++requests}`
    answers.set(id, resolve)
    void write({ type: "control_request", request_id: id, request })
  })

/** Messages sent during a turn, waiting for the next. */
let queued: Array<UserMessage> = []
let turns = 0
let running = false
/** The background tasks live, ending once the turns are over, each reported in a turn of its own. */
const tasks: Array<string> = []
/** Ends the running turn's hang, when it is interrupted. */
let interrupted: (() => void) | undefined
/** Takes the next message, for a turn waiting for one. */
let waiting: ((message: UserMessage) => void) | undefined

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("")
      : ""

const assistant = (text: string) =>
  write({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: crypto.randomUUID(),
  })

const lifecycle = (messages: ReadonlyArray<UserMessage>, state: string) =>
  Promise.all(
    messages.flatMap((m) =>
      m.uuid === undefined
        ? []
        : [
            write({
              type: "command_lifecycle",
              command_uuid: m.uuid,
              state,
              session_id: sessionId,
            }),
          ],
    ),
  )

const result = (
  text: string,
  uuids: ReadonlyArray<string>,
  overrides: Record<string, unknown> = {},
) =>
  write({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    queued_turn_count: queued.filter((m) => m.client_composed !== true).length,
    user_message_uuids: uuids,
    session_id: sessionId,
    uuid: crypto.randomUUID(),
    ...overrides,
  })

/** Plays a turn for `messages`, then the next for those queued meanwhile. */
const turn = async (first: ReadonlyArray<UserMessage>) => {
  running = true
  // The turn's messages: those it started for, and those a wait step folds into it.
  const messages = [...first]
  const uuids = () => messages.flatMap((m) => (m.uuid === undefined ? [] : [m.uuid]))
  await lifecycle(messages, "started")
  const steps = scenario.turns?.[turns++] ?? [
    {
      text:
        messages.length === 0
          ? "REPORTED"
          : `ECHO: ${messages.map((m) => textOf(m.message.content)).join("\n")}`,
    },
  ]
  await write({ type: "system", subtype: "session_state_changed", state: "running" })
  await write({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd: process.cwd(),
    permissionMode: flag("--permission-mode") ?? "default",
    apiKeySource: "none",
    tools: [],
    mcp_servers: [],
    model: "claude-fake",
    slash_commands: [],
    output_style: "default",
    claude_code_version: "2.1.301",
    capabilities: ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"],
    user_message_uuids: uuids(),
    uuid: crypto.randomUUID(),
    ...scenario.init,
  })
  let last = ""
  let overrides: Record<string, unknown> = {}
  for (const step of steps) {
    if ("text" in step) {
      last = step.text
      await assistant(step.text)
    } else if ("hang" in step) {
      await new Promise<void>((resolve) => {
        interrupted = resolve
      })
      interrupted = undefined
      await write({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "[Request interrupted by user]" }],
        },
        parent_tool_use_id: null,
        session_id: sessionId,
      })
      await write({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: [],
        num_turns: 1,
        user_message_uuids: uuids(),
        session_id: sessionId,
        uuid: crypto.randomUUID(),
      })
      await lifecycle(messages, "completed")
      return next()
    } else if ("wait" in step) {
      const taken =
        queued.length > 0
          ? queued
          : [
              await new Promise<UserMessage>((resolve) => {
                waiting = resolve
              }),
            ]
      queued = []
      waiting = undefined
      messages.push(...taken)
      await lifecycle(taken, "started")
    } else if ("background" in step) {
      tasks.push(step.background)
      await backgroundTasks()
    } else if ("exit" in step) {
      await exit(step.exit)
    } else if ("message" in step) {
      await write({ ...step.message, session_id: sessionId })
    } else if ("result" in step) {
      overrides = { ...overrides, ...step.result }
    } else if ("stderr" in step) {
      process.stderr.write(step.stderr)
    } else if ("hook" in step) {
      for (const id of hookIds[step.hook.hook_event_name] ?? []) {
        await ask({
          subtype: "hook_callback",
          callback_id: id,
          input: { ...step.hook, session_id: sessionId, cwd: process.cwd() },
          tool_use_id: "toolu_fake",
        })
      }
    } else {
      await write({ type: "system", subtype: "session_state_changed", state: "requires_action" })
      const answer = (await ask({
        subtype: "can_use_tool",
        tool_name: step.permission.tool_name,
        input: step.permission.input,
        tool_use_id: "toolu_fake",
        display_name: step.permission.tool_name,
      })) as { behavior?: string } | undefined
      await write({ type: "system", subtype: "session_state_changed", state: "running" })
      last = `PERMISSION: ${answer?.behavior}`
      await assistant(last)
    }
  }
  await result(last, uuids(), overrides)
  await lifecycle(messages, "completed")
  return next()
}

const backgroundTasks = () =>
  write({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: tasks.map((id) => ({ task_id: id, task_type: "local_bash", description: id })),
    session_id: sessionId,
  })

/**
 * Plays the turn the queued messages of the first one's kind share, or says idle when none are
 * queued; then a live background task ends, and a turn of the fake's own reports it.
 */
const next = async (): Promise<void> => {
  const first = queued[0]
  if (first === undefined) {
    const task = tasks.shift()
    // With no report to come, a message sent from now starts a turn of its own.
    if (task === undefined) running = false
    await write({ type: "system", subtype: "session_state_changed", state: "idle" })
    if (task === undefined) {
      if (ended) await exit(0)
      return
    }
    await write({
      type: "system",
      subtype: "task_notification",
      task_id: task,
      status: "completed",
      output_file: `/tmp/tasks/${task}.output`,
      summary: `Background command "${task}" completed`,
      session_id: sessionId,
    })
    await backgroundTasks()
    return turn([])
  }
  const kind = (m: UserMessage) => m.client_composed === true
  const other = queued.findIndex((m) => kind(m) !== kind(first))
  const taken = other === -1 ? queued : queued.slice(0, other)
  queued = other === -1 ? [] : queued.slice(other)
  return turn(taken)
}

const control = async (id: string, request: Record<string, unknown>) => {
  const answer = (response: object) =>
    write({ type: "control_response", response: { subtype: "success", request_id: id, response } })
  const refuse = (error: string) =>
    write({ type: "control_response", response: { subtype: "error", request_id: id, error } })
  switch (request.subtype) {
    case "initialize": {
      const lag = scenario.initializeLag ?? 0
      if (lag > 0) await new Promise((resolve) => setTimeout(resolve, lag))
      hookIds = Object.fromEntries(
        Object.entries(
          (request.hooks ?? {}) as Record<string, Array<{ hookCallbackIds: string[] }>>,
        ).map(([event, matchers]) => [event, matchers.flatMap((m) => m.hookCallbackIds)]),
      )
      if (scenario.startupFailure !== undefined) {
        await write({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [`startup failed: ${scenario.startupFailure}`],
          num_turns: 0,
          startup_failure_reason: scenario.startupFailure,
          session_id: sessionId,
          uuid: crypto.randomUUID(),
        })
        await exit(1)
      }
      await answer({
        commands: [],
        agents: [],
        output_style: "default",
        available_output_styles: ["default"],
        models: [],
        account: { subscriptionType: "Claude Max", apiProvider: "firstParty" },
        ...scenario.initialize,
      })
      return
    }
    case "interrupt": {
      if (scenario.interrupt === "unanswered") return
      const uuids = queued.flatMap((m) => (m.uuid === undefined ? [] : [m.uuid]))
      if (request.cancel_queued === true) {
        const cancelled = queued
        queued = []
        await answer({ still_queued: [], cancelled: uuids })
        await lifecycle(cancelled, "cancelled")
      } else {
        await answer({ still_queued: uuids })
      }
      const lag = scenario.interruptLag ?? 0
      if (lag > 0) await new Promise((resolve) => setTimeout(resolve, lag))
      interrupted?.()
      return
    }
    case "cancel_async_message": {
      if (scenario.cancelAsync === "refuse") return refuse("cancel_async_message refused")
      if (scenario.cancelAsync === "unanswered") return
      const at = queued.findIndex((m) => m.uuid === request.message_uuid)
      if (at === -1 || scenario.cancelAsync === "notQueued") {
        await answer({ cancelled: false })
        return
      }
      const [dropped] = queued.splice(at, 1)
      await answer({ cancelled: true })
      await lifecycle(dropped === undefined ? [] : [dropped], "cancelled")
      return
    }
    case "mcp_status": {
      await answer(scenario.mcpStatus === undefined ? {} : { mcpServers: scenario.mcpStatus })
      return
    }
    case "get_settings": {
      await answer(scenario.settings ?? {})
      return
    }
    case "get_context_usage": {
      await answer(scenario.contextUsage ?? {})
      return
    }
    default:
      await answer({})
  }
}

const lines = createInterface({ input: process.stdin })
lines.on("line", (line) => {
  if (line.trim() === "") return
  const message = JSON.parse(line)
  log({ stdin: message })
  if (message.type === "control_request") {
    void control(message.request_id, message.request)
  } else if (message.type === "control_response") {
    answers.get(message.response.request_id)?.(message.response.response)
    answers.delete(message.response.request_id)
  } else if (message.type === "user") {
    void lifecycle([message], "queued")
    if (waiting !== undefined) waiting(message)
    else if (running) queued.push(message)
    else void turn([message])
  }
})
/** Whether stdin has ended, with a turn still to finish. */
let ended = false

lines.on("close", () => {
  log({ closed: true })
  const linger = scenario.lingerOnClose ?? 0
  if (linger > 0) {
    process.on("SIGTERM", () => log({ sigterm: process.pid }))
    setTimeout(() => {
      log({ exited: process.pid })
      void exit(0)
    }, linger)
  } else if (scenario.eofAfterTurn === true && running) {
    ended = true
    // With stdin gone, nothing else keeps a hanging turn's process alive.
    setInterval(() => {}, 60_000)
  } else void exit(0)
})
