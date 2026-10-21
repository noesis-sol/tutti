// Contract tests against the real Agent SDK (§ 13), run only with TUTTI_LIVE=1 (test/gates.ts).
// Each test runs one tiny session in a fresh temp repository through AgentHost's live layer, with
// the SDK's embedded Claude Code and this machine's Claude login, and checks what tutti's state
// machine relies on: system/init on every turn, session_state_changed, the result's
// queued_turn_count and user_message_uuids, command_lifecycle, canUseTool for a call that needs
// asking, the held removal (defaultToNo in default mode, a safetyCheck denial in auto mode),
// interrupt() and its receipt, resume with the session's ID, and strictMcpConfig against the init's
// mcp_servers; and the rest of § 13's list: idle with a background task live and the turn the CLI
// starts to report it, a background subagent keeping its worker Working until that turn, sends
// folded into a running turn or sharing a queued one, cancel_async_message on a queued send, the
// resume of a removed worktree, a session quit as § 4.8
// does and resumed with a carry-on message, the verifier in the foreground through its hook, and
// the account probe's stderr line on an untrusted checkout. What AgentHost doesn't expose (a
// cancel_async_message of its own, a spawn into a missing folder) goes through the SDK's query()
// directly, with the workers' options. Run them on every SDK bump. They spend a few cents of real
// model turns.
//
// Usage limits can't be reached on demand: test/fixtures/usage-limit/ holds their messages, and
// test/usage-limit-fixtures.test.ts folds them through WorkerState.
import { expect } from "bun:test"
import { randomBytes, randomUUID } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  type Query,
  query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer, Option, Schedule, Stream } from "effect"
import { startProbe } from "../../src/agent/Account.ts"
import { AgentHost, AgentStartFailed, userMessage } from "../../src/agent/AgentHost.ts"
import { layer as liveLayer, queuedControls } from "../../src/agent/AgentHostLive.ts"
import { Attention, type AttentionRequest, type Policy } from "../../src/agent/Attention.ts"
import { paneVariable, probeEnv, workerEnv } from "../../src/agent/env.ts"
import type { ChosenServers } from "../../src/agent/mcp.ts"
import { noServersNote } from "../../src/agent/mcp.ts"
import { type SessionStart, workerOptions } from "../../src/agent/options.ts"
import type { Transcripts } from "../../src/agent/Transcripts.ts"
import { initial, step, WorkerEvent, type WorkerState } from "../../src/agent/WorkerState.ts"
import { defaultSettings } from "../../src/cli/AppConfig.ts"
import type { permissionModes } from "../../src/project/settings.ts"
import type { EventStream } from "../../src/run/eventstream.ts"
import type { Log } from "../../src/run/log.ts"
import { appConfig, layer as configLayer } from "../../src/testing/AppConfig.ts"
import { allowAll, layer as attentionLayer, waitForTest } from "../../src/testing/Attention.ts"
import { layer as eventsLayer } from "../../src/testing/EventStream.ts"
import { layer as logLayer } from "../../src/testing/Log.ts"
import { Files, layer as transcriptsLayer } from "../../src/testing/Transcripts.ts"
import { live } from "../gates.ts"

const ticket = "contract-1"

/** How long a test has, and how long it waits for any one thing the session does. */
const testLimit = 240_000
const waitLimit = Duration.seconds(150)

const mcpServer = resolve(import.meta.dir, "../fixtures/contract/mcp-server.ts")

interface Setup {
  readonly mode?: (typeof permissionModes)[number]
  /** The workers' model; null for Claude Code's default. haiku by default, the cheapest. */
  readonly model?: string | null
  readonly policy?: Policy
  readonly servers?: ChosenServers
  /** Variables added to the workers' environment. */
  readonly env?: Readonly<Record<string, string>>
}

type Env = AgentHost | Attention | Transcripts | Files | Log | EventStream

const git = (cwd: string, ...args: ReadonlyArray<string>) => {
  const done = Bun.spawnSync(
    ["git", "-c", "user.name=tutti", "-c", "user.email=tutti@example.invalid", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  )
  if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr.toString()}`)
}

/**
 * A fresh git repository for one test, by its real path: on macOS tmpdir() is under /var, a symlink
 * to /private/var, and a cwd given through it makes Claude Code treat its files as outside it.
 */
const repository = (): string => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "tutti-contract-"))
  git(dir, "init", "-q", "-b", "main")
  writeFileSync(join(dir, "README.md"), "# A scratch repository\n")
  writeFileSync(
    join(dir, "CLAUDE.md"),
    "This is a throwaway repository for tutti's contract tests against the Agent SDK. Do exactly what each message asks, nothing more.\n",
  )
  // A long tool call: Claude Code's Bash tool refuses a standalone long sleep.
  writeFileSync(join(dir, "wait.sh"), '#!/bin/sh\nsleep "$1"\n')
  chmodSync(join(dir, "wait.sh"), 0o755)
  git(dir, "add", ".")
  git(dir, "commit", "-qm", "init")
  return dir
}

/**
 * tutti's environment without the variables of a Claude Code session the tests may run under, or
 * of the terminal pane it runs in (paneVariable): sessions with those report to the terminal as the
 * pane's agent, and Herdr then drops the name of the worker running the tests (tutti-y0e).
 */
const hostEnv = (): Record<string, string | undefined> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^CLAUDE(CODE$|_CODE_|_PID$|_EFFORT$)/.test(name) && !paneVariable(name),
    ),
  )

/** The run's configuration for the main checkout `dir`, its workers' settings from `setup`. */
const configFor = (dir: string, setup: Setup = {}) =>
  appConfig(
    {
      claude: null,
      settings: {
        ...defaultSettings,
        workers: {
          ...defaultSettings.workers,
          permission_mode: setup.mode ?? "default",
          model: setup.model === undefined ? "haiku" : setup.model,
        },
      },
    },
    dir,
  )

const workerPrompt = { text: "You are TICKET_ID's worker in a contract test.", file: null }
const noServers: ChosenServers = { servers: [], note: noServersNote }

/** Runs `effect` with the live host in `dir`; the layer's scope, and its sessions, close after. */
const run = <A, E>(
  dir: string,
  effect: Effect.Effect<A, E, Env>,
  setup: Setup = {},
): Promise<A> => {
  const config = configFor(dir, setup)
  const host = liveLayer({
    prompt: workerPrompt,
    servers: setup.servers ?? noServers,
    account: { billing: { _tag: "Subscription", keyUnused: false }, subscription: true },
    env: { ...hostEnv(), ...setup.env },
  })
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        host.pipe(
          Layer.provideMerge(
            Layer.mergeAll(attentionLayer(setup.policy ?? waitForTest), transcriptsLayer()),
          ),
          Layer.provideMerge(
            Layer.mergeAll(logLayer(), eventsLayer(), configLayer(config), BunServices.layer),
          ),
        ),
      ),
    ),
  )
}

const session = (cwd: string, sessionId: string = randomUUID()) => ({ sessionId, cwd })

/**
 * A session over the SDK's query() directly, with a worker's options, for what AgentHost doesn't
 * expose: every permission allowed, no hooks.
 */
interface Direct {
  readonly query: Query
  /** Every message the session has sent so far, in order. */
  readonly messages: Array<SDKMessage>
  /** Settles when the session's stream ends: with what it failed with, or undefined. */
  readonly ended: Promise<unknown>
  /** Pushes a client_composed message into the inbox; its uuid. */
  readonly send: (text: string) => string
  /** Ends the inbox and closes the query; waits for the stream's end, 10 seconds at most. */
  readonly close: () => Promise<void>
}

/** Starts (or resumes, as `how` says) a direct session in `cwd`, the main checkout being `repo`. */
const direct = (repo: string, cwd: string, how: SessionStart): Direct => {
  const pending: Array<SDKUserMessage> = []
  let wake: (() => void) | undefined
  let open = true
  const nudge = () => {
    wake?.()
    wake = undefined
  }
  async function* inbox(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const next = pending.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (!open) return
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  }
  const q = query({
    prompt: inbox(),
    options: workerOptions({
      config: configFor(repo),
      ticket,
      worktree: cwd,
      prompt: workerPrompt,
      servers: noServers,
      skills: false,
      callbacks: {
        canUseTool: async (_tool, input) => ({ behavior: "allow", updatedInput: input }),
        onElicitation: async () => ({ action: "decline" }),
        hooks: {},
        stderr: () => {},
      },
      session: how,
      env: workerEnv({ subscription: true, billing: "subscription", env: hostEnv() }),
      abortController: new AbortController(),
    }),
  })
  const messages: Array<SDKMessage> = []
  const ended = (async () => {
    try {
      for await (const message of q) messages.push(message)
      return undefined
    } catch (cause) {
      return cause
    }
  })()
  return {
    query: q,
    messages,
    ended,
    send: (text) => {
      const uuid = randomUUID()
      pending.push(userMessage({ text, from: "clientComposed" }, uuid, how.sessionId))
      nudge()
      return uuid
    },
    close: async () => {
      open = false
      nudge()
      q.close()
      await Promise.race([ended, Bun.sleep(10_000)])
    },
  }
}

/** Waits until `ready` holds, as messagesUntil does, outside Effect. */
const until = async (what: string, ready: () => boolean, said: () => string = () => "") => {
  const deadline = Date.now() + Duration.toMillis(waitLimit)
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`never saw ${what}${said()}`)
    await Bun.sleep(100)
  }
}

/** The session's messages so far, from the worker's transcript, in order. */
const messages = Effect.gen(function* () {
  const items = yield* (yield* Files).messages(ticket)
  return items.map((item) => item.message)
})

/** Waits until the transcript's messages satisfy `matches`; those messages. */
const messagesUntil = (what: string, matches: (all: ReadonlyArray<SDKMessage>) => boolean) =>
  messages.pipe(
    Effect.repeat({ until: matches, schedule: Schedule.spaced(Duration.millis(100)) }),
    Effect.timeoutOrElse({
      duration: waitLimit,
      orElse: () =>
        Effect.flatMap(messages, (all) =>
          Effect.die(`never saw ${what}; the session said: ${summary(all)}`),
        ),
    }),
  )

/** Waits until the worker's state satisfies `matches`; that state. */
const stateUntil = (matches: (state: WorkerState) => boolean) =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    const found = yield* host.state(ticket).pipe(
      Stream.filter(matches),
      Stream.runHead,
      Effect.timeoutOrElse({
        duration: waitLimit,
        orElse: () =>
          Effect.gen(function* () {
            const state = yield* host.current(ticket)
            const all = yield* messages
            return yield* Effect.die(
              `no matching state; it is ${JSON.stringify(state)}; the session said: ${summary(all)}`,
            )
          }),
      }),
    )
    return Option.getOrThrow(found)
  })

/** The messages' types and subtypes, for a failure's message. */
const summary = (all: ReadonlyArray<SDKMessage>): string =>
  all
    .map((m) => {
      const tagged = m as { type: string; subtype?: string; state?: string }
      return [tagged.type, tagged.subtype, tagged.state].filter((s) => s !== undefined).join(":")
    })
    .join(", ")

const isInit = (m: SDKMessage): m is SDKSystemMessage => m.type === "system" && m.subtype === "init"
const isResult = (m: SDKMessage): m is SDKResultMessage => m.type === "result"
/** A session_state_changed's state, or undefined for any other message. */
const stateOf = (m: SDKMessage): string | undefined =>
  m.type === "system" && m.subtype === "session_state_changed" ? m.state : undefined

/** The results whose user_message_uuids list `uuid`. */
const resultsFor = (all: ReadonlyArray<SDKMessage>, uuid: string) =>
  all.filter(isResult).filter((r) => (r.user_message_uuids ?? []).includes(uuid))

/**
 * Whether the session has answered every one of `uuids` and gone idle: each is listed in a result,
 * and the last session_state_changed is idle (queued turns run with no idle between them).
 */
const answered =
  (...uuids: ReadonlyArray<string>) =>
  (all: ReadonlyArray<SDKMessage>): boolean =>
    uuids.every((uuid) => resultsFor(all, uuid).length > 0) &&
    all
      .map(stateOf)
      .filter((s) => s !== undefined)
      .at(-1) === "idle"

/** command_lifecycle: not in the SDK's message union (docs/spikes/01-sdk-session.md, item 1). */
interface Lifecycle {
  readonly type: "command_lifecycle"
  readonly command_uuid: string
  readonly state: string
}

const lifecycleOf = (all: ReadonlyArray<SDKMessage>, uuid: string): ReadonlyArray<string> =>
  all
    .map((m) => m as unknown as Lifecycle)
    .filter((m) => m.type === "command_lifecycle" && m.command_uuid === uuid)
    .map((m) => m.state)

/** The text of a success result, or "" for an error. */
const textOf = (result: SDKResultMessage | undefined): string =>
  result?.subtype === "success" ? result.result : ""

/**
 * The worker's one request that Attention holds, waiting for the test. requires_action can make
 * the worker NeedsYou a moment before its canUseTool call reaches Attention.
 */
const onlyRequest = Effect.gen(function* () {
  const attention = yield* Attention
  const open = yield* attention.current.pipe(
    Effect.repeat({
      until: (open) => open.length > 0,
      schedule: Schedule.spaced(Duration.millis(50)),
    }),
    Effect.timeout(waitLimit),
  )
  expect(open).toHaveLength(1)
  return open[0] as AttentionRequest
})

/** Whether a process whose command line contains `text` is running. */
const running = (text: string): boolean =>
  Bun.spawnSync(["pgrep", "-f", text], { stdout: "pipe", stderr: "pipe" }).exitCode === 0

/** A duration no other process has on its command line, so pgrep finds this turn's sleep. */
const uniqueSeconds = (whole: number): string => `${whole}.${randomBytes(3).readUIntBE(0, 3)}`

/** Waits until a process whose command line contains `text` is running. */
const runningNow = (text: string) =>
  Effect.sync(() => running(text)).pipe(
    Effect.repeat({ until: (r) => r, schedule: Schedule.spaced(Duration.millis(200)) }),
    Effect.timeout(waitLimit),
  )

/** A tool call in an assistant message: the main thread's, or a subagent's (`parent`). */
interface ToolCall {
  readonly at: number
  readonly id: string
  readonly name: string
  readonly input: Readonly<Record<string, unknown>>
  readonly parent: string | null
}

/** The tool calls in the messages, in order, with where each one's message is. */
const toolCalls = (all: ReadonlyArray<SDKMessage>): ReadonlyArray<ToolCall> =>
  all.flatMap((m, at) => {
    if (m.type !== "assistant") return []
    const content: unknown = m.message.content
    if (!Array.isArray(content)) return []
    return content.flatMap((block: unknown) => {
      const b = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown }
      return b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string"
        ? [
            {
              at,
              id: b.id,
              name: b.name,
              input: (b.input ?? {}) as Readonly<Record<string, unknown>>,
              parent: m.parent_tool_use_id,
            },
          ]
        : []
    })
  })

/** Where the user message with the tool_result of call `id` is, or -1. */
const toolResultAt = (all: ReadonlyArray<SDKMessage>, id: string): number =>
  all.findIndex(
    (m) =>
      m.type === "user" &&
      Array.isArray(m.message.content) &&
      m.message.content.some(
        (block) =>
          typeof block === "object" && block.type === "tool_result" && block.tool_use_id === id,
      ),
  )

/** Bash calls whose command contains `text`. */
const bashCalls = (all: ReadonlyArray<SDKMessage>, text: string) =>
  toolCalls(all).filter((c) => c.name === "Bash" && String(c.input.command).includes(text))

/** A background_tasks_changed's tasks, or undefined for any other message. */
const tasksOf = (m: SDKMessage): ReadonlyArray<{ readonly ambient?: boolean }> | undefined =>
  m.type === "system" && m.subtype === "background_tasks_changed"
    ? (m as unknown as { tasks: ReadonlyArray<{ readonly ambient?: boolean }> }).tasks
    : undefined

/**
 * What a carried-on worker is told as its session is resumed, as tutti's next run does (§ 4.8). It
 * names the cut-off call, which haiku otherwise sometimes takes as done.
 */
const carryOn =
  "tutti was stopped while you were working, and has resumed this session. Your last turn was " +
  "interrupted before the tool call it was making finished: carry on with it from where you were, " +
  "making that call again."

live.describe("Agent SDK contract: turns", () => {
  live.test(
    "every turn has its system/init and session state, and every send is named in one result",
    async () => {
      const dir = repository()
      const sessionId = randomUUID()
      const { all, batch, later, state } = await run(
        dir,
        Effect.gen(function* () {
          const host = yield* AgentHost
          yield* host.start(ticket, session(dir, sessionId))
          const first = yield* host.send(
            ticket,
            "Reply with the single word ALPHA.",
            "clientComposed",
          )
          // Sent while the first turn is under way: the CLI folds them into it, or queues them.
          yield* messagesUntil("the first turn's system/init", (all) => all.some(isInit))
          const second = yield* host.send(
            ticket,
            "Reply with the single word BRAVO.",
            "clientComposed",
          )
          const third = yield* host.send(
            ticket,
            "Reply with the single word CHARLIE.",
            "clientComposed",
          )
          yield* messagesUntil("the three sends answered", answered(first, second, third))
          // A send after the session went idle: a turn of its own.
          const later = yield* host.send(
            ticket,
            "Reply with the single word DELTA.",
            "clientComposed",
          )
          yield* messagesUntil("the later send answered", answered(later))
          return {
            all: yield* messages,
            batch: [first, second, third],
            later,
            state: yield* stateUntil((s) => s._tag === "Idle"),
          }
        }),
      )
      const inits = all.filter(isInit)
      const results = all.filter(isResult)
      // One system/init per turn, each with the session's ID.
      expect(results.length).toBeGreaterThanOrEqual(2)
      expect(inits).toHaveLength(results.length)
      for (const init of inits) expect(init.session_id).toBe(sessionId)
      // Each turn starts with running, and its system/init comes before its result.
      let lastState: string | undefined
      let open = false
      for (const message of all) {
        lastState = stateOf(message) ?? lastState
        if (isInit(message)) {
          expect(lastState).toBe("running")
          expect(open).toBe(false)
          open = true
        }
        if (isResult(message)) {
          expect(open).toBe(true)
          open = false
        }
      }
      // Every result counts what is still queued, and lists the sends its turn consumed: each send
      // is named in exactly one, and the CLI tracked it to completed.
      for (const result of results) {
        expect(typeof result.queued_turn_count).toBe("number")
        expect(Array.isArray(result.user_message_uuids)).toBe(true)
      }
      for (const uuid of [...batch, later]) {
        expect(resultsFor(all, uuid)).toHaveLength(1)
        expect(lifecycleOf(all, uuid)).toContain("completed")
        expect(lifecycleOf(all, uuid).at(-1)).toBe("completed")
      }
      // idle comes only after the last turn that answers the batch, and again after the later one.
      const states = (from: number, to: number) =>
        all
          .slice(from, to)
          .map(stateOf)
          .filter((s) => s !== undefined)
      /** Where the first result that names `uuid` is. */
      const resultAt = (uuid: string) => all.findIndex((m) => resultsFor([m], uuid).length > 0)
      const batchEnd = Math.max(...batch.map(resultAt))
      const laterResult = resultAt(later)
      const firstRunning = all.findIndex((m) => stateOf(m) === "running")
      expect(states(firstRunning, batchEnd)).not.toContain("idle")
      expect(states(batchEnd, laterResult)).toContain("idle")
      expect(states(laterResult, all.length).at(-1)).toBe("idle")
      expect(textOf(resultsFor(all, later)[0])).toContain("DELTA")
      expect(state._tag).toBe("Idle")
    },
    testLimit,
  )
})

live.describe("Agent SDK contract: background tasks", () => {
  live.test(
    "idle comes with a background task live, and the CLI starts a turn to report it once the set empties",
    async () => {
      const dir = repository()
      const seconds = uniqueSeconds(20)
      const { all, uuid, whileLive, state } = await run(
        dir,
        Effect.gen(function* () {
          const host = yield* AgentHost
          yield* host.start(ticket, session(dir))
          const uuid = yield* host.send(
            ticket,
            `Use the Bash tool with run_in_background: true to run exactly this command: ./wait.sh ${seconds}\nDon't wait for it: reply with the single word STARTED right away.`,
            "clientComposed",
          )
          yield* messagesUntil("the send answered", answered(uuid))
          const whileLive = yield* host.current(ticket)
          // The report: a result after the live set emptied, and idle after it.
          yield* messagesUntil("the task's report", (all) => {
            const live = all.findIndex((m) => (tasksOf(m) ?? []).length > 0)
            const emptied = all.findIndex((m, at) => at > live && tasksOf(m)?.length === 0)
            return (
              live >= 0 &&
              emptied > live &&
              answered()(all.slice(emptied)) &&
              all.slice(emptied).some(isResult)
            )
          })
          return {
            all: yield* messages,
            uuid,
            whileLive,
            state: yield* stateUntil((s) => s._tag === "Idle"),
          }
        }),
        { policy: allowAll },
      )
      expect(bashCalls(all, `./wait.sh ${seconds}`).map((c) => c.input.run_in_background)).toEqual([
        true,
      ])
      const answer = all.findIndex((m) => resultsFor([m], uuid).length > 0)
      const idle = all.findIndex((m, at) => at > answer && stateOf(m) === "idle")
      expect(idle).toBeGreaterThan(answer)
      // At that idle the task is live: the last set before it lists it, and isn't ambient.
      const setAtIdle = all
        .slice(0, idle)
        .map(tasksOf)
        .filter((t) => t !== undefined)
        .at(-1)
      expect(setAtIdle?.length).toBe(1)
      expect(setAtIdle?.[0]?.ambient ?? false).toBe(false)
      expect(whileLive._tag).toBe("Working")
      // Then the task ends: its notification and the emptied set, then running, a turn of the
      // CLI's own (its system/init and a result that lists no send), and idle.
      const emptied = all.findIndex((m, at) => at > idle && tasksOf(m)?.length === 0)
      expect(emptied).toBeGreaterThan(idle)
      const notified = all.findIndex(
        (m, at) => at > idle && m.type === "system" && m.subtype === "task_notification",
      )
      expect(notified).toBeGreaterThan(idle)
      const after = all.slice(emptied)
      const states = after.map(stateOf).filter((s) => s !== undefined)
      expect(states[0]).toBe("running")
      expect(states.at(-1)).toBe("idle")
      const report = all.slice(idle).map(stateOf).indexOf("running") + idle
      expect(notified).toBeLessThan(report)
      expect(emptied).toBeLessThan(report)
      expect(after.filter(isInit)).toHaveLength(1)
      const reports = after.filter(isResult)
      expect(reports).toHaveLength(1)
      expect(reports[0]?.user_message_uuids ?? []).toEqual([])
      // Each message folded as AgentHost folds it: the worker is Working from that idle, through
      // the moment between the emptied set and running, until the report's idle settles it.
      let worker = initial()
      const folded = all.map((message) => {
        worker = step(worker, WorkerEvent.Message({ message }), Date.now())
        return worker.state._tag
      })
      expect(new Set(folded.slice(idle, report + 1))).toEqual(new Set(["Working"]))
      const settled = all.findLastIndex((m) => stateOf(m) === "idle")
      expect(settled).toBeGreaterThan(report)
      expect(folded[settled]).toBe("Idle")
      expect(state._tag).toBe("Idle")
    },
    testLimit,
  )

  live.test(
    "a subagent in the background keeps the worker Working until the turn that reports it",
    async () => {
      const dir = repository()
      const code = `HELPED-${randomBytes(3).toString("hex").toUpperCase()}`
      mkdirSync(join(dir, ".claude", "agents"), { recursive: true })
      writeFileSync(
        join(dir, ".claude", "agents", "helper.md"),
        [
          "---",
          "name: helper",
          "description: Waits a while, then says so.",
          "tools: Bash",
          "model: haiku",
          "---",
          `Run exactly this Bash command: ./wait.sh 20\nThen reply with the single line ${code}.`,
          "",
        ].join("\n"),
      )
      const { all, uuid, whileLive, state } = await run(
        dir,
        Effect.gen(function* () {
          const host = yield* AgentHost
          yield* host.start(ticket, session(dir))
          const uuid = yield* host.send(
            ticket,
            'Use the Agent tool once, with subagent_type "helper", run_in_background: true and the prompt "Wait". Don\'t wait for it: reply with the single word STARTED right away.',
            "clientComposed",
          )
          // The send's result, with the subagent still at work: no idle comes with it.
          yield* messagesUntil("the send's result", (all) => resultsFor(all, uuid).length > 0)
          const whileLive = yield* host.current(ticket)
          yield* messagesUntil("the subagent's report", (all) => {
            const answer = all.findIndex((m) => resultsFor([m], uuid).length > 0)
            const emptied = all.findIndex((m, at) => at > answer && tasksOf(m)?.length === 0)
            return (
              emptied > answer &&
              answered()(all.slice(emptied)) &&
              all.slice(emptied).some(isResult)
            )
          })
          return {
            all: yield* messages,
            uuid,
            whileLive,
            state: yield* stateUntil((s) => s._tag === "Idle"),
          }
        }),
        { policy: allowAll },
      )
      // Not the verifier, so the hook leaves it in the background: it is launched, not awaited.
      const calls = toolCalls(all).filter(
        (c) =>
          c.parent === null &&
          (c.name === "Agent" || c.name === "Task") &&
          c.input.subagent_type === "helper",
      )
      expect(calls).toHaveLength(1)
      const call = calls[0] as ToolCall
      const launched = all[toolResultAt(all, call.id)] as { tool_use_result?: { status?: unknown } }
      expect(launched.tool_use_result?.status).toBe("async_launched")
      // The send's turn ends with the subagent live in background_tasks_changed, not ambient.
      const answer = all.findIndex((m) => resultsFor([m], uuid).length > 0)
      const setAtAnswer = all
        .slice(0, answer)
        .map(tasksOf)
        .filter((t) => t !== undefined)
        .at(-1)
      expect(setAtAnswer?.length).toBe(1)
      expect(setAtAnswer?.[0]?.ambient ?? false).toBe(false)
      expect(whileLive._tag).toBe("Working")
      // The subagent ends: the set empties, then a turn of the CLI's own reports it (its
      // system/init and a result that lists no send), and idle.
      const emptied = all.findIndex((m, at) => at > answer && tasksOf(m)?.length === 0)
      expect(emptied).toBeGreaterThan(answer)
      const after = all.slice(emptied)
      expect(after.filter(isInit)).toHaveLength(1)
      const reports = after.filter(isResult)
      expect(reports).toHaveLength(1)
      expect(reports[0]?.user_message_uuids ?? []).toEqual([])
      const report = all.indexOf(reports[0] as SDKMessage)
      // Folded as AgentHost folds them: Working at the send's result and at the report, and never
      // settled between them (the subagent's own requests make it NeedsYou a moment), until the
      // idle after the report settles the worker.
      let worker = initial()
      const folded = all.map((message) => {
        worker = step(worker, WorkerEvent.Message({ message }), Date.now())
        return worker.state._tag
      })
      expect([folded[answer], folded[report]]).toEqual(["Working", "Working"])
      const between = new Set(folded.slice(answer, report + 1))
      expect([between.has("Idle"), between.has("Failed")]).toEqual([false, false])
      const settled = all.findLastIndex((m) => stateOf(m) === "idle")
      expect(settled).toBeGreaterThan(report)
      expect(folded[settled]).toBe("Idle")
      expect(state._tag).toBe("Idle")
    },
    testLimit,
  )
})

live.describe("Agent SDK contract: folded and shared sends", () => {
  live.test(
    "follow-ups pushed during a tool call are folded into the running turn, named in its one result",
    async () => {
      const dir = repository()
      const seconds = uniqueSeconds(10)
      const { all, sends } = await run(
        dir,
        Effect.gen(function* () {
          const host = yield* AgentHost
          yield* host.start(ticket, session(dir))
          const first = yield* host.send(
            ticket,
            `Use the Bash tool to run exactly this command: ./wait.sh ${seconds}\nThen reply with the single word ALPHA.`,
            "clientComposed",
          )
          yield* runningNow(seconds)
          const second = yield* host.send(
            ticket,
            "Also reply with the single word BRAVO.",
            "clientComposed",
          )
          const third = yield* host.send(
            ticket,
            "Also reply with the single word CHARLIE.",
            "clientComposed",
          )
          yield* messagesUntil("the three sends answered", answered(first, second, third))
          return { all: yield* messages, sends: [first, second, third] }
        }),
        { policy: allowAll },
      )
      const results = all.filter(isResult)
      expect(results).toHaveLength(1)
      expect(all.filter(isInit)).toHaveLength(1)
      expect([...(results[0]?.user_message_uuids ?? [])].sort()).toEqual([...sends].sort())
      for (const uuid of sends) expect(lifecycleOf(all, uuid).at(-1)).toBe("completed")
    },
    testLimit,
  )

  live.test(
    "queued sends of one kind, pushed while the model writes its answer, share a later turn",
    async () => {
      const dir = repository()
      const { all, first, queued } = await run(
        dir,
        Effect.gen(function* () {
          const host = yield* AgentHost
          yield* host.start(ticket, session(dir))
          const first = yield* host.send(
            ticket,
            "Count from 1 to 40, one number per line, with nothing else.",
            "clientComposed",
          )
          yield* messagesUntil("the first turn's system/init", (all) => all.some(isInit))
          const queued = [
            yield* host.send(ticket, "Reply with the single word BRAVO.", "clientComposed"),
            yield* host.send(ticket, "Reply with the single word CHARLIE.", "clientComposed"),
          ]
          yield* messagesUntil("the sends answered", answered(first, ...queued))
          return { all: yield* messages, first, queued }
        }),
      )
      const results = all.filter(isResult)
      expect(results).toHaveLength(2)
      expect(results[0]?.user_message_uuids).toEqual([first])
      expect([...(results[1]?.user_message_uuids ?? [])].sort()).toEqual([...queued].sort())
      for (const uuid of queued) expect(lifecycleOf(all, uuid)).toContain("queued")
      // The queued turn ran with no idle before it.
      const firstEnd = all.indexOf(results[0] as SDKMessage)
      const secondEnd = all.indexOf(results[1] as SDKMessage)
      expect(all.slice(firstEnd, secondEnd).map(stateOf)).not.toContain("idle")
    },
    testLimit,
  )
})

live.describe("Agent SDK contract: canUseTool", () => {
  live.test(
    "a call that needs asking reaches canUseTool, and the worker needs you until it is answered",
    async () => {
      const dir = repository()
      const { request, all, state } = await run(
        dir,
        Effect.gen(function* () {
          const host = yield* AgentHost
          yield* host.start(ticket, session(dir))
          const uuid = yield* host.send(
            ticket,
            "Use the Bash tool to run exactly this command: touch asked-by-tutti.txt\nThen reply with the single word DONE.",
            "clientComposed",
          )
          yield* stateUntil((s) => s._tag === "NeedsYou")
          const request = yield* onlyRequest
          yield* (yield* Attention).answer(request.id, { _tag: "Allow" }, "screen")
          yield* messagesUntil("the turn answered", answered(uuid))
          return {
            request,
            all: yield* messages,
            state: yield* stateUntil((s) => s._tag === "Idle"),
          }
        }),
      )
      const kind = request.kind
      if (kind._tag !== "Permission") throw new Error(`not a permission request: ${kind._tag}`)
      expect(kind.tool).toBe("Bash")
      expect(String(kind.input.command)).toContain("touch asked-by-tutti.txt")
      expect(typeof request.toolUseID).toBe("string")
      expect(request.defaultToNo).toBe(false)
      // The session said so too: requires_action while it waited, running once answered.
      const states = all.map(stateOf).filter((s) => s !== undefined)
      const asked = states.indexOf("requires_action")
      expect(asked).toBeGreaterThan(0)
      expect(states[asked + 1]).toBe("running")
      expect(existsSync(join(dir, "asked-by-tutti.txt"))).toBe(true)
      expect(state._tag).toBe("Idle")
    },
    testLimit,
  )

  /**
   * The held removal's target, `build` in the repository `dir`, with files in it; the variable
   * TUTTI_CONTRACT_TARGET names it in the workers' environment, as the spike's SPIKE_TARGET did.
   */
  const target = (dir: string) => {
    const folder = join(dir, "build")
    mkdirSync(folder)
    for (const name of ["a.txt", "b.txt"]) writeFileSync(join(folder, name), "keep me\n")
    return folder
  }
  const removal =
    "Run exactly this Bash command, as written: `rm -rf $TUTTI_CONTRACT_TARGET/*`. If it is refused, reply exactly REFUSED and stop; don't try another way."

  live.test(
    "in default mode a held removal asks with defaultToNo and no Allow for this run",
    async () => {
      const dir = repository()
      const folder = target(dir)
      const { request, state } = await run(
        dir,
        Effect.gen(function* () {
          const host = yield* AgentHost
          yield* host.start(ticket, session(dir))
          const uuid = yield* host.send(ticket, removal, "clientComposed")
          yield* stateUntil((s) => s._tag === "NeedsYou")
          const request = yield* onlyRequest
          yield* (yield* Attention).answer(request.id, { _tag: "Deny" }, "screen")
          yield* messagesUntil("the turn answered", answered(uuid))
          return { request, state: yield* stateUntil((s) => s._tag === "Idle") }
        }),
        { mode: "default", env: { TUTTI_CONTRACT_TARGET: "build" } },
      )
      expect(request.kind._tag === "Permission" && request.kind.tool).toBe("Bash")
      expect(request.kind._tag === "Permission" && request.kind.summary).toContain("rm -rf")
      expect(request.defaultToNo).toBe(true)
      expect(request.suppressAlwaysAllowRule).toBe(true)
      expect(readdirSync(folder).sort()).toEqual(["a.txt", "b.txt"])
      expect(state._tag).toBe("Idle")
    },
    testLimit,
  )

  live.test(
    "in auto mode a held removal is denied as safetyCheck without asking",
    async () => {
      const dir = repository()
      const folder = target(dir)
      const asked: Array<AttentionRequest> = []
      const all = await run(
        dir,
        Effect.gen(function* () {
          const host = yield* AgentHost
          yield* host.start(ticket, session(dir))
          const uuid = yield* host.send(ticket, removal, "clientComposed")
          return yield* messagesUntil("the turn answered", answered(uuid))
        }),
        {
          mode: "auto",
          // Auto mode needs a model that has it: Claude Code's default.
          model: null,
          env: { TUTTI_CONTRACT_TARGET: "build" },
          policy: (request) => {
            asked.push(request)
            return { _tag: "Deny" }
          },
        },
      )
      expect(all.filter(isInit).map((init) => init.permissionMode)).toContain("auto")
      const denied = all.filter(
        (m) => m.type === "system" && m.subtype === "permission_denied",
      ) as ReadonlyArray<{ readonly tool_name: string; readonly decision_reason_type?: string }>
      expect(denied.map((d) => [d.tool_name, d.decision_reason_type])).toContainEqual([
        "Bash",
        "safetyCheck",
      ])
      expect(asked).toEqual([])
      expect(readdirSync(folder).sort()).toEqual(["a.txt", "b.txt"])
    },
    testLimit,
  )
})

live.describe("Agent SDK contract: interrupt", () => {
  live.test(
    "interrupt() cuts the turn off and its receipt names the queued sends it cancelled",
    async () => {
      const dir = repository()
      // A duration no other process has on its command line, so pgrep finds this turn's sleep.
      const seconds = `120.${randomBytes(3).readUIntBE(0, 3)}`
      const { all, receipt, queued, state, sleeping } = await run(
        dir,
        Effect.gen(function* () {
          const host = yield* AgentHost
          yield* host.start(ticket, session(dir))
          yield* host.send(
            ticket,
            `Use the Bash tool to run exactly this command: ./wait.sh ${seconds}\nThen reply with the single word DONE.`,
            "clientComposed",
          )
          yield* Effect.sync(() => running(seconds)).pipe(
            Effect.repeat({ until: (r) => r, schedule: Schedule.spaced(Duration.millis(200)) }),
            Effect.timeout(waitLimit),
          )
          const queued = [
            yield* host.send(ticket, "Reply with the single word BRAVO.", "clientComposed"),
            yield* host.send(ticket, "Reply with the single word CHARLIE.", "clientComposed"),
          ]
          yield* messagesUntil("both sends queued", (all) =>
            queued.every((uuid) => lifecycleOf(all, uuid).includes("queued")),
          )
          const receipt = yield* host.interrupt(ticket)
          const state = yield* stateUntil((s) => s._tag === "Failed")
          // Long enough for a turn the queued sends would start: it starts within milliseconds.
          yield* Effect.sleep(Duration.seconds(5))
          return { all: yield* messages, receipt, queued, state, sleeping: running(seconds) }
        }),
        { mode: "default", policy: allowAll },
      )
      const inits = all.filter(isInit)
      expect(inits.flatMap((init) => init.capabilities ?? [])).toContain(
        "interrupt_cancel_queued_v1",
      )
      expect(receipt).toEqual({ stillQueued: [], cancelled: queued })
      const results = all.filter(isResult)
      expect(results).toHaveLength(1)
      expect(results[0]?.subtype).toBe("error_during_execution")
      expect(results[0]?.is_error).toBe(true)
      // No turn after the interrupted one, and neither cancelled send ran.
      expect(inits).toHaveLength(1)
      for (const uuid of queued) expect(resultsFor(all, uuid)).toEqual([])
      expect(state).toMatchObject({ _tag: "Failed", interrupted: true })
      expect(sleeping).toBe(false)
    },
    testLimit,
  )
})

live.describe("Agent SDK contract: cancel_async_message", () => {
  live.test(
    "a send queued behind a running turn is cancelled (cancelled: true) and never runs",
    async () => {
      const dir = repository()
      const seconds = uniqueSeconds(15)
      const s = direct(dir, dir, { _tag: "New", sessionId: randomUUID() })
      const said = () => `; the session said: ${summary(s.messages)}`
      try {
        const first = s.send(
          `Use the Bash tool to run exactly this command: ./wait.sh ${seconds}\nThen reply with the single word DONE.`,
        )
        await until("the turn's sleep", () => running(seconds), said)
        const queued = s.send("Reply with the single word BRAVO.")
        await until(
          "the send queued",
          () => lifecycleOf(s.messages, queued).includes("queued"),
          said,
        )
        const cancelled = await queuedControls(s.query).cancelAsyncMessage(queued)
        await until("the turn answered", () => answered(first)(s.messages), said)
        // Long enough for a turn the cancelled send would start: it starts within milliseconds.
        await Bun.sleep(5000)
        const all = [...s.messages]
        expect(cancelled).toBe(true)
        const results = all.filter(isResult)
        expect(results).toHaveLength(1)
        expect(results[0]?.user_message_uuids).toEqual([first])
        expect(all.filter(isInit)).toHaveLength(1)
        expect(resultsFor(all, queued)).toEqual([])
        expect(lifecycleOf(all, queued)).not.toContain("started")
        expect(lifecycleOf(all, queued)).not.toContain("completed")
      } finally {
        await s.close()
      }
    },
    testLimit,
  )
})

live.describe("Agent SDK contract: resume", () => {
  live.test(
    "a closed session resumed with its ID carries on with what it was told",
    async () => {
      const dir = repository()
      const sessionId = randomUUID()
      const codeword = `HERON-${randomBytes(3).toString("hex").toUpperCase()}`
      const { all, closed, uuid, state } = await run(
        dir,
        Effect.gen(function* () {
          const host = yield* AgentHost
          yield* host.start(ticket, session(dir, sessionId))
          const told = yield* host.send(
            ticket,
            `Remember this codeword: ${codeword}. Reply with the single word OK.`,
            "clientComposed",
          )
          yield* messagesUntil("the codeword taken", answered(told))
          yield* host.close(ticket)
          const closed = yield* host.current(ticket)
          const uuid = yield* host.resume(ticket, session(dir, sessionId), {
            text: "What was the codeword I gave you? Reply with the codeword alone.",
            from: "clientComposed",
          })
          yield* messagesUntil("the resumed turn answered", answered(uuid))
          return {
            all: yield* messages,
            closed,
            uuid,
            state: yield* stateUntil((s) => s._tag === "Idle"),
          }
        }),
      )
      expect(closed._tag).toBe("Closed")
      const inits = all.filter(isInit)
      expect(inits.length).toBeGreaterThanOrEqual(2)
      for (const init of inits) expect(init.session_id).toBe(sessionId)
      const [answer] = resultsFor(all, uuid)
      expect(answer?.session_id).toBe(sessionId)
      expect(textOf(answer)).toContain(codeword)
      expect(state._tag).toBe("Idle")
    },
    testLimit,
  )
})

live.describe("Agent SDK contract: a removed worktree", () => {
  live.test(
    "resuming a session whose worktree was removed fails the spawn, with no message and no result",
    async () => {
      const dir = repository()
      const worktree = join(mkdtempSync(join(realpathSync(tmpdir()), "tutti-contract-wt-")), "wt")
      git(dir, "worktree", "add", "-q", "-b", "contract-wt", worktree)
      const sessionId = randomUUID()
      await run(
        dir,
        Effect.gen(function* () {
          const host = yield* AgentHost
          yield* host.start(ticket, session(worktree, sessionId))
          const uuid = yield* host.send(ticket, "Reply with the single word OK.", "clientComposed")
          yield* messagesUntil("the turn answered", answered(uuid))
        }),
      )
      rmSync(worktree, { recursive: true, force: true })

      // The SDK itself: its spawn can't enter the folder, and nothing comes back.
      const s = direct(dir, worktree, { _tag: "Resume", sessionId })
      s.send("Reply with the single word OK.")
      const init = await s.query.initializationResult().then(
        () => undefined,
        (cause: unknown) => cause,
      )
      const ended = await Promise.race([s.ended, Bun.sleep(60_000).then(() => "no end")])
      await s.close()
      expect(init).toBeInstanceOf(Error)
      expect(ended).toBeInstanceOf(Error)
      // AgentHostLive's startFailure reads this wording as a spawn that failed (§ 4.8).
      expect((ended as Error).message).toContain("failed to launch")
      expect(s.messages).toEqual([])

      // So AgentHost checks the folder first, and doesn't spawn.
      const failed = await run(
        dir,
        Effect.flip(
          Effect.gen(function* () {
            const host = yield* AgentHost
            return yield* host.resume(ticket, session(worktree, sessionId), {
              text: "Reply with the single word OK.",
              from: "clientComposed",
            })
          }),
        ),
      )
      expect(failed).toBeInstanceOf(AgentStartFailed)
      expect(failed.reason).toBe(`its folder isn't there: ${worktree}`)
    },
    testLimit,
  )
})

live.describe("Agent SDK contract: quit and carry on", () => {
  /** The messages from `from` on: the resumed session's. */
  const since = (all: ReadonlyArray<SDKMessage>, from: number) => all.slice(from)

  live.test(
    "a busy session interrupted and closed, then resumed with a carry-on message, makes the cut-off call again in one turn",
    async () => {
      const dir = repository()
      const sessionId = randomUUID()
      const seconds = uniqueSeconds(6)
      const { all, from, uuid, state } = await run(
        dir,
        Effect.gen(function* () {
          const host = yield* AgentHost
          yield* host.start(ticket, session(dir, sessionId))
          yield* host.send(
            ticket,
            `Use the Bash tool to run exactly this command: ./wait.sh ${seconds}\nThen reply with the single word DONE.`,
            "clientComposed",
          )
          yield* runningNow(seconds)
          // tutti's quit (§ 4.8): interrupt(), its result, then close().
          yield* host.interrupt(ticket)
          yield* stateUntil((s) => s._tag === "Failed")
          yield* host.close(ticket)
          const from = (yield* messages).length
          const uuid = yield* host.resume(ticket, session(dir, sessionId), {
            text: carryOn,
            from: "clientComposed",
          })
          yield* messagesUntil("the carry-on answered", answered(uuid))
          return {
            all: yield* messages,
            from,
            uuid,
            state: yield* stateUntil((s) => s._tag === "Idle"),
          }
        }),
        { policy: allowAll },
      )
      const before = bashCalls(all.slice(0, from), `./wait.sh ${seconds}`)
      const resumed = since(all, from)
      const again = bashCalls(resumed, `./wait.sh ${seconds}`)
      expect(before).toHaveLength(1)
      expect(again.length).toBeGreaterThanOrEqual(1)
      expect(again.map((c) => c.id)).not.toContain(before[0]?.id)
      const results = resumed.filter(isResult)
      expect(results).toHaveLength(1)
      expect(results[0]?.user_message_uuids).toEqual([uuid])
      expect(textOf(results[0])).toContain("DONE")
      expect(resumed.filter(isInit)).toHaveLength(1)
      expect(state._tag).toBe("Idle")
    },
    testLimit,
  )

  live.test(
    "a session at a pending permission request, quit and resumed, asks again as a new canUseTool call",
    async () => {
      const dir = repository()
      const sessionId = randomUUID()
      const { all, from, uuid, first, again, state } = await run(
        dir,
        Effect.gen(function* () {
          const host = yield* AgentHost
          const attention = yield* Attention
          yield* host.start(ticket, session(dir, sessionId))
          yield* host.send(
            ticket,
            "Use the Bash tool to run exactly this command: touch carried-on.txt\nThen reply with the single word DONE.",
            "clientComposed",
          )
          yield* stateUntil((s) => s._tag === "NeedsYou")
          const first = yield* onlyRequest
          yield* host.interrupt(ticket)
          yield* stateUntil((s) => s._tag === "Failed")
          yield* host.close(ticket)
          const from = (yield* messages).length
          const uuid = yield* host.resume(ticket, session(dir, sessionId), {
            text: carryOn,
            from: "clientComposed",
          })
          yield* stateUntil((s) => s._tag === "NeedsYou")
          const again = yield* onlyRequest
          yield* attention.answer(again.id, { _tag: "Allow" }, "screen")
          yield* messagesUntil("the carry-on answered", answered(uuid))
          return {
            all: yield* messages,
            from,
            uuid,
            first,
            again,
            state: yield* stateUntil((s) => s._tag === "Idle"),
          }
        }),
        { mode: "default", policy: waitForTest },
      )
      for (const request of [first, again]) {
        const kind = request.kind
        if (kind._tag !== "Permission") throw new Error(`not a permission request: ${kind._tag}`)
        expect(kind.tool).toBe("Bash")
        expect(String(kind.input.command)).toContain("touch carried-on.txt")
      }
      expect(again.id).not.toBe(first.id)
      expect(again.toolUseID).not.toBe(first.toolUseID)
      const resumed = since(all, from)
      const results = resumed.filter(isResult)
      expect(results).toHaveLength(1)
      expect(results[0]?.user_message_uuids).toEqual([uuid])
      expect(resumed.filter(isInit)).toHaveLength(1)
      expect(existsSync(join(dir, "carried-on.txt"))).toBe(true)
      expect(state._tag).toBe("Idle")
    },
    testLimit,
  )
})

live.describe("Agent SDK contract: MCP servers", () => {
  live.test(
    "with strictMcpConfig, system/init lists exactly the servers passed, as dynamic",
    async () => {
      const dir = repository()
      // A project server, approved: Claude Code would load it without strictMcpConfig.
      const server = { type: "stdio" as const, command: process.execPath, args: [mcpServer] }
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { unchosen: server } }))
      mkdirSync(join(dir, ".claude"), { recursive: true })
      writeFileSync(
        join(dir, ".claude", "settings.local.json"),
        JSON.stringify({ enableAllProjectMcpServers: true }),
      )
      const { all, setup, state } = await run(
        dir,
        Effect.gen(function* () {
          const host = yield* AgentHost
          yield* host.start(ticket, session(dir))
          const uuid = yield* host.send(ticket, "Reply with the single word OK.", "clientComposed")
          yield* messagesUntil("the turn answered", answered(uuid))
          return {
            all: yield* messages,
            setup: yield* host.setup,
            state: yield* stateUntil((s) => s._tag === "Idle"),
          }
        }),
        {
          servers: {
            servers: [{ name: "tutti-contract", scope: "user", definition: server }],
            note: null,
          },
        },
      )
      const [init] = all.filter(isInit)
      expect(init?.mcp_servers.map((s) => [s.name, s.source])).toEqual([
        ["tutti-contract", "dynamic"],
      ])
      expect(setup.problems).toEqual([])
      expect(state._tag).toBe("Idle")
    },
    testLimit,
  )
})

live.describe("Agent SDK contract: the verifier", () => {
  live.test(
    "the verifier runs in the foreground through the hook: its tool_result comes before the one result",
    async () => {
      const dir = repository()
      const code = `VERIFIED-${randomBytes(3).toString("hex").toUpperCase()}`
      mkdirSync(join(dir, ".claude", "agents"), { recursive: true })
      writeFileSync(
        join(dir, ".claude", "agents", "verifier.md"),
        [
          "---",
          "name: verifier",
          "description: Checks a finished change. Give it the ticket's ID.",
          "tools: Bash",
          "model: haiku",
          "---",
          `You are the verifier. Run exactly this Bash command: ./wait.sh 3\nThen reply with the single line ${code}.`,
          "",
        ].join("\n"),
      )
      const { all, uuid } = await run(
        dir,
        Effect.gen(function* () {
          const host = yield* AgentHost
          yield* host.start(ticket, session(dir))
          // The model asks for the background, so only the hook can keep the verifier in the
          // foreground.
          const uuid = yield* host.send(
            ticket,
            'Use the Agent tool once, with subagent_type "verifier", run_in_background: true and the prompt "Check ticket contract-1". When the verifier\'s answer is in front of you, reply with its VERIFIED line and stop.',
            "clientComposed",
          )
          yield* messagesUntil("the turn answered", answered(uuid))
          return { all: yield* messages, uuid }
        }),
        { policy: allowAll },
      )
      const calls = toolCalls(all).filter(
        (c) =>
          c.parent === null &&
          (c.name === "Agent" || c.name === "Task") &&
          c.input.subagent_type === "verifier",
      )
      expect(calls).toHaveLength(1)
      const call = calls[0] as ToolCall
      // The stream shows what the model asked for, not what ran (§ 4.1).
      expect(call.input.run_in_background).toBe(true)
      const resultAt = toolResultAt(all, call.id)
      expect(resultAt).toBeGreaterThan(call.at)
      const toolResult = all[resultAt] as { tool_use_result?: { status?: unknown } }
      expect(toolResult.tool_use_result?.status).not.toBe("async_launched")
      expect(toolResult.tool_use_result?.status).toBe("completed")
      // The subagent had finished, and the parent's turn waited for it: one result, after.
      const subagent = all.flatMap((m, at) =>
        (m as { parent_tool_use_id?: unknown }).parent_tool_use_id === call.id ? [at] : [],
      )
      expect(subagent.length).toBeGreaterThan(0)
      expect(Math.max(...subagent)).toBeLessThan(resultAt)
      const results = all.filter(isResult)
      expect(results).toHaveLength(1)
      expect(all.indexOf(results[0] as SDKMessage)).toBeGreaterThan(resultAt)
      expect(results[0]?.user_message_uuids).toEqual([uuid])
      expect(textOf(results[0])).toContain(code)
    },
    testLimit,
  )
})

live.describe("Agent SDK contract: the account probe", () => {
  live.test(
    "on a never-trusted checkout whose settings allow one command, stderr has the line § 4.13 matches",
    async () => {
      const dir = repository()
      mkdirSync(join(dir, ".claude"), { recursive: true })
      writeFileSync(
        join(dir, ".claude", "settings.json"),
        JSON.stringify({ permissions: { allow: ["Bash(echo contract)"] } }),
      )
      const found = await Effect.runPromise(
        startProbe({ config: configFor(dir), env: probeEnv({ env: hostEnv() }) }),
      )
      // untrustedFiles holds what ignoresAllowRules matched in the probe's stderr.
      expect(found.untrustedFiles).toHaveLength(1)
      expect(found.untrustedFiles[0]).toContain("settings.json")
    },
    testLimit,
  )
})
