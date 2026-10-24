import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Exit, Fiber, Layer, Option, Schedule, Stream } from "effect"
import type { Billing } from "../src/agent/Account.ts"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { endedWhy, layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import { Attention, type Policy } from "../src/agent/Attention.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { type ChosenServers, noServersNote, notGivenProblem } from "../src/agent/mcp.ts"
import { apiKeyProblem } from "../src/agent/sessionChecks.ts"
import type { Transcripts } from "../src/agent/Transcripts.ts"
import { WorkerState } from "../src/agent/WorkerState.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import type { Log } from "../src/run/log.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { allowAll, layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { Files, layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"
import { workersIn } from "./workerEnv.ts"

// Each test starts the fake Claude Code as a process, up to a second on an idle machine: bun's 5 s
// default fails them when other checks run beside this one.
setDefaultTimeout(30_000)

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

/** A scenario for the fake Claude Code (test/fixtures/fake-claude/claude.ts). */
interface Scenario {
  readonly init?: Record<string, unknown>
  readonly startupFailure?: string
  readonly turns?: ReadonlyArray<ReadonlyArray<object>>
  readonly interruptLag?: number
  readonly cancelAsync?: "refuse" | "notQueued"
}

interface Setup {
  readonly policy?: Policy
  readonly servers?: ChosenServers
  readonly billing?: Billing
}

type Env = AgentHost | Attention | Transcripts | Files | Log | EventStream

/** What the fake logged: its arguments for each session, and every line it read, in order. */
interface Logged {
  readonly args: ReadonlyArray<ReadonlyArray<string>>
  readonly stdin: ReadonlyArray<Record<string, unknown>>
  readonly closed: number
}

/** A folder for a test: the worktree the fake runs in and its log. */
const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-host-live-"))
  return { dir, log: join(dir, "fake.jsonl") }
}

const readLog = (file: string): Logged => {
  const entries = existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l))
    : []
  return {
    args: entries.flatMap((e) => (e.args === undefined ? [] : [e.args])),
    stdin: entries.flatMap((e) => (e.stdin === undefined ? [] : [e.stdin])),
    closed: entries.filter((e) => e.closed === true).length,
  }
}

/** A user message the fake read. */
interface Read {
  readonly uuid?: string
  readonly message: { readonly role: string; readonly content: unknown }
  readonly client_composed?: boolean
  readonly origin?: { readonly kind: string }
}

/** The user messages the fake read. */
const usersIn = (logged: Logged) =>
  logged.stdin.filter((m) => m.type === "user") as unknown as ReadonlyArray<Read>

/** The interrupt control request the fake read. */
const interruptIn = (logged: Logged) =>
  logged.stdin
    .filter((m) => m.type === "control_request")
    .map((m) => m.request as { readonly subtype?: string; readonly cancel_queued?: boolean })
    .find((request) => request.subtype === "interrupt")

const noServers: ChosenServers = { servers: [], note: noServersNote }

/**
 * Runs `effect` with the live host over the fake, playing `scenario` in a fresh folder; the
 * effect gets that folder and the fake's log file. The layer's scope closes when it is done.
 */
const run = <A, E>(
  scenario: Scenario,
  effect: (where: { dir: string; log: string }) => Effect.Effect<A, E, Env>,
  setup: Setup = {},
): Promise<A> => {
  const where = workspace()
  const config = appConfig(
    {
      claude: fake,
      settings: {
        ...defaultSettings,
        checks: {
          ...defaultSettings.checks,
          fast: { ...defaultSettings.checks.fast, command: "scripts/check-fast.sh" },
        },
      },
    },
    where.dir,
  )
  const host = liveLayer({
    prompt: { text: "Work on TICKET_ID.", file: null },
    servers: setup.servers ?? noServers,
    account: {
      billing: setup.billing ?? { _tag: "Subscription", keyUnused: false },
    },
  })
  return Effect.runPromise(
    effect(where).pipe(
      Effect.provide(
        host.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              attentionLayer(setup.policy ?? waitForTest),
              transcriptsLayer(),
              ClaudeCode.layer.pipe(
                Layer.provide(
                  workersIn({
                    ...testEnv,
                    FAKE_CLAUDE_SCENARIO: JSON.stringify({ ...scenario, log: where.log }),
                  }),
                ),
              ),
            ),
          ),
          Layer.provideMerge(
            Layer.mergeAll(logLayer(), eventsLayer(), configLayer(config), BunServices.layer),
          ),
        ),
      ),
    ),
  )
}

const session = (dir: string, sessionId = "11111111-1111-4111-8111-111111111111") => ({
  sessionId,
  cwd: dir,
})

/** Waits, at most 10 s, for the ticket's worker to reach a state `matches`; that state. */
const until = (ticket: string, matches: (state: WorkerState) => boolean) =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    const found = yield* host.state(ticket).pipe(
      Stream.filter(matches),
      Stream.runHead,
      Effect.timeoutOrElse({
        duration: Duration.seconds(10),
        orElse: () =>
          Effect.flatMap(host.current(ticket), (state) =>
            Effect.die(`no matching state for ${ticket}; it is ${JSON.stringify(state)}`),
          ),
      }),
    )
    return Option.getOrThrow(found)
  })

const idle = (state: WorkerState) => state._tag === "Idle"
const gone = (state: WorkerState) => state._tag === "Gone"

/** Waits, at most 10 s, until the fake's log shows `matches`. */
const logShows = (file: string, matches: (logged: Logged) => boolean) =>
  Effect.sync(() => readLog(file)).pipe(
    Effect.repeat({
      until: matches,
      schedule: Schedule.spaced(Duration.millis(20)),
    }),
    Effect.timeoutOrElse({
      duration: Duration.seconds(10),
      orElse: () => Effect.die(`the fake's log never showed it: ${JSON.stringify(readLog(file))}`),
    }),
  )

describe("AgentHost live: the inbox", () => {
  test("a session starts with its ID and takes tutti's and your messages as the SDK sends them", async () => {
    const { logged, items, state } = await run({}, ({ dir, log }) =>
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start("t-1", session(dir))
        expect(yield* host.current("t-1")).toEqual(WorkerState.Starting())
        const first = yield* host.send("t-1", { text: "Work on t-1.", from: "clientComposed" })
        yield* until("t-1", idle)
        const second = yield* host.send("t-1", { text: "/context", from: "human" })
        yield* logShows(log, (l) => usersIn(l).length === 2)
        yield* until("t-1", idle)
        const logged = readLog(log)
        expect(usersIn(logged).map((m) => m.uuid)).toEqual([first, second])
        return {
          logged,
          items: yield* (yield* Files).messages("t-1"),
          state: yield* host.current("t-1"),
        }
      }),
    )
    const [composed, human] = usersIn(logged)
    expect(composed).toMatchObject({
      message: { role: "user", content: "Work on t-1." },
      client_composed: true,
    })
    expect(composed).not.toHaveProperty("origin")
    expect(human).toMatchObject({ message: { content: "/context" }, origin: { kind: "human" } })
    expect(human).not.toHaveProperty("client_composed")
    const args = logged.args[0] ?? []
    expect(args).toContain("--session-id=11111111-1111-4111-8111-111111111111")
    expect(args).toContain("--permission-mode=auto")
    expect(args).not.toContain("--fork-session")
    expect(state._tag).toBe("Idle")
    // Every message is in the transcript, with the session's ID.
    const types = items.map((item) => item.message.type)
    expect(types.filter((t) => t === "result")).toHaveLength(2)
    expect(items.every((item) => item.session === "11111111-1111-4111-8111-111111111111")).toBe(
      true,
    )
  })

  test("a follow-up pushed during a turn waits for it, then has its own turn", async () => {
    const { results, users } = await run(
      { turns: [[{ permission: { tool_name: "Bash", input: { command: "rm -rf build" } } }]] },
      ({ dir, log }) =>
        Effect.gen(function* () {
          const host = yield* AgentHost
          const attention = yield* Attention
          const files = yield* Files
          // The turns' results, as the transcript records them.
          const resultsNow = Effect.map(files.messages("t-1"), (items) =>
            items.flatMap(({ message }) =>
              message.type === "result" && message.subtype === "success" ? [message.result] : [],
            ),
          )
          yield* host.start("t-1", session(dir))
          yield* host.send("t-1", { text: "first", from: "clientComposed" })
          // The turn waits on its permission request: a message sent now is queued.
          expect(yield* until("t-1", (s) => s._tag === "NeedsYou")).toEqual(
            WorkerState.NeedsYou({ requests: 1 }),
          )
          yield* host.send("t-1", { text: "second", from: "clientComposed" })
          yield* logShows(log, (l) => usersIn(l).length === 2)
          yield* attention.answer("r1", { _tag: "Allow" }, "screen")
          const results = yield* resultsNow.pipe(
            Effect.repeat({
              until: (r) => r.length === 2,
              schedule: Schedule.spaced(Duration.millis(20)),
            }),
            Effect.timeout(Duration.seconds(10)),
          )
          yield* until("t-1", idle)
          return { results, users: usersIn(readLog(log)) }
        }),
    )
    expect(results).toEqual(["PERMISSION: allow", "ECHO: second"])
    expect(users.map((m) => m.message.content)).toEqual(["first", "second"])
  })

  test("two queued client_composed sends keep it Working though queued_turn_count is 0", async () => {
    const { results, lifecycles } = await run(
      { turns: [[{ permission: { tool_name: "Bash", input: { command: "rm -rf build" } } }]] },
      ({ dir, log }) =>
        Effect.gen(function* () {
          const host = yield* AgentHost
          const attention = yield* Attention
          yield* host.start("t-1", session(dir))
          yield* host.send("t-1", { text: "first", from: "clientComposed" })
          yield* until("t-1", (s) => s._tag === "NeedsYou")
          yield* host.send("t-1", { text: "second", from: "clientComposed" })
          yield* host.send("t-1", { text: "third", from: "clientComposed" })
          yield* logShows(log, (l) => usersIn(l).length === 3)
          yield* attention.answer("r1", { _tag: "Allow" }, "screen")
          // The first Idle comes only after the queued sends' turn: the transcript, recorded before
          // each message is folded in, holds both results by then.
          yield* until("t-1", idle)
          const items = yield* (yield* Files).messages("t-1")
          const raw = items.map((item) => item.message as unknown as Record<string, unknown>)
          return {
            results: raw
              .filter((m) => m.type === "result")
              .map((m) => [m.result, m.queued_turn_count]),
            lifecycles: raw.filter((m) => m.type === "command_lifecycle").map((m) => m.state),
          }
        }),
    )
    expect(results).toEqual([
      ["PERMISSION: allow", 0],
      ["ECHO: second\nthird", 0],
    ])
    expect(lifecycles.filter((state) => state === "completed")).toHaveLength(3)
  })
})

describe("AgentHost live: state, hooks and stderr", () => {
  test("hook callbacks reach the worker's state: the check command is testing", async () => {
    const doing = await run(
      {
        turns: [
          [
            {
              hook: {
                hook_event_name: "PreToolUse",
                tool_name: "Bash",
                tool_input: { command: "scripts/check-fast.sh" },
              },
            },
            { hang: true },
          ],
        ],
      },
      ({ dir }) =>
        Effect.gen(function* () {
          const host = yield* AgentHost
          yield* host.start("t-1", session(dir))
          yield* host.send("t-1", { text: "go", from: "clientComposed" })
          // The fake sends system/init and calls the hook back to back, so the hook may be folded
          // in before the init: the turn keeps its tool all the same.
          return yield* until("t-1", (s) => s._tag === "Working" && s.doing === "testing")
        }),
    )
    expect(doing).toEqual(WorkerState.Working({ doing: "testing" }))
  })

  test("a permission request is asked through Attention and answered to the CLI", async () => {
    const { logged, state } = await run(
      { turns: [[{ permission: { tool_name: "Bash", input: { command: "rm -rf build" } } }]] },
      ({ dir, log }) =>
        Effect.gen(function* () {
          const host = yield* AgentHost
          yield* host.start("t-1", session(dir))
          yield* host.send("t-1", { text: "go", from: "clientComposed" })
          const state = yield* until("t-1", idle)
          return { logged: readLog(log), state }
        }),
      { policy: allowAll },
    )
    expect(state._tag).toBe("Idle")
    const answers = logged.stdin.filter((m) => m.type === "control_response")
    expect(answers).toHaveLength(1)
    expect(answers[0]).toMatchObject({ response: { response: { behavior: "allow" } } })
  })

  test("the session's stderr goes to the transcript's stderr log", async () => {
    const stderr = await run({ turns: [[{ stderr: "a warning from claude\n" }]] }, ({ dir }) =>
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start("t-1", session(dir))
        yield* host.send("t-1", { text: "go", from: "clientComposed" })
        yield* until("t-1", idle)
        const files = yield* Files
        return yield* Effect.flatMap(files.stderr("t-1"), (text) =>
          text.includes("a warning") ? Effect.succeed(text) : Effect.fail("not yet"),
        ).pipe(
          Effect.retry(Schedule.spaced(Duration.millis(20))),
          Effect.timeout(Duration.seconds(10)),
        )
      }),
    )
    expect(stderr).toContain("a warning from claude")
  })
})

describe("AgentHost live: the first system/init", () => {
  test("a permission mode other than the one asked for is logged once", async () => {
    const { states, lines } = await run({ init: { permissionMode: "default" } }, ({ dir }) =>
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start("t-1", session(dir))
        yield* host.send("t-1", { text: "one", from: "clientComposed" })
        yield* until("t-1", idle)
        yield* host.send("t-1", { text: "two", from: "clientComposed" })
        yield* host.close("t-1")
        yield* host.start("t-2", session(dir, "22222222-2222-4222-8222-222222222222"))
        yield* host.send("t-2", { text: "three", from: "clientComposed" })
        const second = yield* until("t-2", idle)
        return { states: [second], lines: yield* texts }
      }),
    )
    // Not a setup problem: the worker goes on.
    expect(states.map((state) => state._tag)).toEqual(["Idle"])
    expect(lines.filter((l) => l.includes("permission mode"))).toEqual([
      "permission mode: default (auto mode isn't available here)",
    ])
  })

  test("the mode asked for, no servers and no key: nothing is found", async () => {
    const { state, lines } = await run({}, ({ dir }) =>
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start("t-1", session(dir))
        yield* host.send("t-1", { text: "go", from: "clientComposed" })
        return { state: yield* until("t-1", idle), lines: yield* texts }
      }),
    )
    expect(state._tag).toBe("Idle")
    expect(lines.filter((l) => l.includes("t-1:") || l.includes("permission mode"))).toEqual([])
  })

  test("an MCP server the worker wasn't given ends it as a setup problem", async () => {
    const extra = [{ name: "claude.ai Gmail", status: "connected", source: "claudeai" }]
    const { state, sent, logged, lines } = await run(
      { init: { mcp_servers: extra } },
      ({ dir, log }) =>
        Effect.gen(function* () {
          const host = yield* AgentHost
          yield* host.start("t-1", session(dir))
          yield* host.send("t-1", { text: "go", from: "clientComposed" })
          const state = yield* until("t-1", gone)
          const sent = yield* Effect.exit(
            host.send("t-1", { text: "more", from: "clientComposed" }),
          )
          return {
            state,
            sent,
            logged: readLog(log),
            lines: yield* texts,
          }
        }),
    )
    const problem = notGivenProblem(["claude.ai Gmail"])
    expect(state).toEqual(WorkerState.Gone({ why: problem, setup: true }))
    expect(lines).toContain(`  t-1: ${problem}`)
    expect(Exit.isFailure(sent)).toBe(true)
    expect(usersIn(logged)).toHaveLength(1)
  })

  test("a chosen server listed as dynamic is accepted", async () => {
    const state = await run(
      { init: { mcp_servers: [{ name: "beads", status: "connected", source: "dynamic" }] } },
      ({ dir }) =>
        Effect.gen(function* () {
          const host = yield* AgentHost
          yield* host.start("t-1", session(dir))
          yield* host.send("t-1", { text: "go", from: "clientComposed" })
          return yield* until("t-1", idle)
        }),
      {
        servers: {
          servers: [{ name: "beads", scope: "project", definition: { command: "bd-mcp" } }],
          note: null,
        },
      },
    )
    expect(state._tag).toBe("Idle")
  })

  test("an API key billed beside the subscription login ends the worker", async () => {
    const state = await run({ init: { apiKeySource: "ANTHROPIC_API_KEY" } }, ({ dir }) =>
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start("t-1", session(dir))
        yield* host.send("t-1", { text: "go", from: "clientComposed" })
        return yield* until("t-1", gone)
      }),
    )
    expect(state).toEqual(
      WorkerState.Gone({ why: apiKeyProblem("ANTHROPIC_API_KEY"), setup: true }),
    )
  })

  test("the API key is fine when billing is the API key", async () => {
    const state = await run(
      { init: { apiKeySource: "ANTHROPIC_API_KEY" } },
      ({ dir }) =>
        Effect.gen(function* () {
          const host = yield* AgentHost
          yield* host.start("t-1", session(dir))
          yield* host.send("t-1", { text: "go", from: "clientComposed" })
          return yield* until("t-1", idle)
        }),
      { billing: { _tag: "ApiKey" } },
    )
    expect(state._tag).toBe("Idle")
  })
})

describe("AgentHost live: interrupt", () => {
  test("cancels the queued messages where the CLI advertises it", async () => {
    const { receipt, queued, state, request } = await run(
      { turns: [[{ hang: true }]] },
      ({ dir, log }) =>
        Effect.gen(function* () {
          const host = yield* AgentHost
          yield* host.start("t-1", session(dir))
          yield* host.send("t-1", { text: "first", from: "clientComposed" })
          yield* until("t-1", (s) => s._tag === "Working")
          const queued = yield* host.send("t-1", { text: "second", from: "human" })
          yield* logShows(log, (l) => usersIn(l).length === 2)
          const receipt = yield* host.interrupt("t-1")
          // The interrupted turn's result is an error, so the worker is Failed; nothing else runs.
          const state = yield* until("t-1", (s) => s._tag === "Failed")
          return { receipt, queued, state, request: interruptIn(readLog(log)) }
        }),
    )
    expect(receipt).toEqual({ stillQueued: [], cancelled: [queued] })
    expect(request).toEqual({ subtype: "interrupt", cancel_queued: true })
    expect(state).toMatchObject({ _tag: "Failed", interrupted: true })
  })

  test("where it doesn't, a message the CLI won't cancel stays queued and runs", async () => {
    const { receipt, queued, request } = await run(
      {
        init: { capabilities: ["interrupt_receipt_v1"] },
        turns: [[{ hang: true }]],
        cancelAsync: "refuse",
      },
      ({ dir, log }) =>
        Effect.gen(function* () {
          const host = yield* AgentHost
          yield* host.start("t-1", session(dir))
          yield* host.send("t-1", { text: "first", from: "clientComposed" })
          yield* until("t-1", (s) => s._tag === "Working")
          const queued = yield* host.send("t-1", { text: "second", from: "human" })
          yield* logShows(log, (l) => usersIn(l).length === 2)
          const receipt = yield* host.interrupt("t-1")
          // Idle needs a clean result: the queued message's turn, after the interrupted one.
          yield* until("t-1", idle)
          return { receipt, queued, request: interruptIn(readLog(log)) }
        }),
    )
    expect(receipt).toEqual({ stillQueued: [queued], cancelled: [] })
    expect(request).toEqual({ subtype: "interrupt" })
  })

  test("a worker with no open session can't be interrupted", async () => {
    const exit = await run({}, () =>
      Effect.exit(
        Effect.gen(function* () {
          return yield* (yield* AgentHost).interrupt("t-1")
        }),
      ),
    )
    expect(exit).toMatchObject({ _tag: "Failure" })
  })
})

describe("AgentHost live: close, resume and Gone", () => {
  test("close ends Claude Code and keeps the worker Closed; resume picks the session up", async () => {
    const { closed, afterClose, logged, resumed, state } = await run({}, ({ dir, log }) =>
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start("t-1", session(dir))
        yield* host.send("t-1", { text: "first", from: "clientComposed" })
        yield* until("t-1", idle)
        yield* host.close("t-1")
        const closed = yield* host.current("t-1")
        // close waits for Claude Code to exit: its stdin has closed.
        const afterClose = readLog(log).closed
        const sent = yield* Effect.exit(host.send("t-1", { text: "lost", from: "clientComposed" }))
        expect(Exit.isFailure(sent)).toBe(true)
        const resumed = yield* host.resume("t-1", session(dir), {
          text: "carry on",
          from: "clientComposed",
        })
        const state = yield* until("t-1", idle)
        return { closed, afterClose, logged: readLog(log), resumed, state }
      }),
    )
    expect(closed).toEqual(WorkerState.Closed())
    expect(afterClose).toBe(1)
    expect(logged.args).toHaveLength(2)
    const second = logged.args[1] ?? []
    expect(second).toContain("--resume=11111111-1111-4111-8111-111111111111")
    expect(second.some((a) => a.startsWith("--session-id"))).toBe(false)
    expect(second).not.toContain("--fork-session")
    const users = usersIn(logged)
    expect(users.map((m) => m.message.content)).toEqual(["first", "carry on"])
    expect(users[1]?.uuid).toBe(resumed)
    expect(users[1]?.client_composed).toBe(true)
    expect(state._tag).toBe("Idle")
  })

  test("a stream that ends without tutti closing it makes the worker Gone", async () => {
    const { state, sent } = await run({ turns: [[{ text: "bye" }, { exit: 1 }]] }, ({ dir }) =>
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start("t-1", session(dir))
        yield* host.send("t-1", { text: "go", from: "clientComposed" })
        const state = yield* until("t-1", gone)
        const sent = yield* Effect.exit(host.send("t-1", { text: "more", from: "clientComposed" }))
        return { state, sent }
      }),
    )
    expect(state._tag).toBe("Gone")
    expect((state as { why: string }).why.startsWith(endedWhy)).toBe(true)
    expect(Exit.isFailure(sent)).toBe(true)
  })

  test("a startup_failure_reason fails the start and leaves the worker Gone", async () => {
    const { exit, state } = await run({ startupFailure: "cwd_unavailable" }, ({ dir }) =>
      Effect.gen(function* () {
        const host = yield* AgentHost
        const exit = yield* Effect.exit(host.start("t-1", session(dir)))
        return { exit, state: yield* host.current("t-1") }
      }),
    )
    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: {
        reasons: [
          {
            error: {
              _tag: "AgentStartFailed",
              startupFailureReason: "cwd_unavailable",
              reason: "Claude Code refused to start: cwd_unavailable",
            },
          },
        ],
      },
    })
    expect(state).toEqual(WorkerState.Gone({ why: "cwd_unavailable" }))
  })

  test("a second start of an open worker, or a start in a missing folder, fails", async () => {
    const { twice, missing } = await run({}, ({ dir }) =>
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start("t-1", session(dir))
        const twice = yield* Effect.exit(host.start("t-1", session(dir)))
        const missing = yield* Effect.exit(host.start("t-2", session(join(dir, "gone"))))
        return { twice, missing }
      }),
    )
    expect(twice).toMatchObject({
      _tag: "Failure",
      cause: { reasons: [{ error: { reason: "a session is already open" } }] },
    })
    expect(missing).toMatchObject({ _tag: "Failure" })
  })

  test("closing the layer's scope closes the sessions", async () => {
    const where = { log: "" }
    await run({ turns: [[{ hang: true }]] }, ({ dir, log }) =>
      Effect.gen(function* () {
        where.log = log
        const host = yield* AgentHost
        yield* host.start("t-1", session(dir))
        yield* host.send("t-1", { text: "go", from: "clientComposed" })
        yield* until("t-1", (s) => s._tag === "Working")
      }),
    )
    // The scope waited for Claude Code to exit: its stdin closed.
    expect(readLog(where.log).closed).toBe(1)
  })

  test("end forgets the worker: its streams end", async () => {
    const after = await run({}, ({ dir }) =>
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start("t-1", session(dir))
        const states = yield* host.state("t-1").pipe(Stream.runCollect, Effect.forkChild)
        yield* host.end("t-1")
        yield* Fiber.join(states)
        return yield* Effect.exit(host.current("t-1"))
      }),
    )
    expect(Exit.isFailure(after)).toBe(true)
  })
})
