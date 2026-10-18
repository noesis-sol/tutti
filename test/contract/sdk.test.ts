// Contract tests against the real Agent SDK (§ 13), run only with TUTTI_LIVE=1 (test/gates.ts).
// Each test runs one tiny session in a fresh temp repository through AgentHost's live layer, with
// the SDK's embedded Claude Code and this machine's Claude login, and checks what tutti's state
// machine relies on: system/init on every turn, session_state_changed, the result's
// queued_turn_count and user_message_uuids, command_lifecycle, canUseTool for a call that needs
// asking, the held removal (defaultToNo in default mode, a safetyCheck denial in auto mode),
// interrupt() and its receipt, resume with the session's ID, and strictMcpConfig against the init's
// mcp_servers. Run them on every SDK bump. They spend a few cents of real model turns.
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
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { SDKMessage, SDKResultMessage, SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer, Option, Schedule, Stream } from "effect"
import { AgentHost } from "../../src/agent/AgentHost.ts"
import { layer as liveLayer } from "../../src/agent/AgentHostLive.ts"
import { Attention, type AttentionRequest, type Policy } from "../../src/agent/Attention.ts"
import { paneVariable } from "../../src/agent/env.ts"
import type { ChosenServers } from "../../src/agent/mcp.ts"
import { noServersNote } from "../../src/agent/mcp.ts"
import type { Transcripts } from "../../src/agent/Transcripts.ts"
import type { WorkerState } from "../../src/agent/WorkerState.ts"
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

/** Runs `effect` with the live host in `dir`; the layer's scope, and its sessions, close after. */
const run = <A, E>(
  dir: string,
  effect: Effect.Effect<A, E, Env>,
  setup: Setup = {},
): Promise<A> => {
  const config = appConfig(
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
  const host = liveLayer({
    prompt: { text: "You are TICKET_ID's worker in a contract test.", file: null },
    servers: setup.servers ?? { servers: [], note: noServersNote },
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
