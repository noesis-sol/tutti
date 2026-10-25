// The setup check before a session's first turn (§ 4.1): the API key source of its initialize's
// account and the MCP servers its mcpServerStatus() lists are checked as it starts, before it is
// sent anything: a setup problem ends the worker Gone with `setup`, as system/init's check, which
// stays as a backstop, does, and the start or resume sends nothing. Either way the worker's process
// group is killed at once, not given the SDK's grace.

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Exit, Layer, Option, Stream } from "effect"
import fc from "fast-check"
import type { Billing } from "../src/agent/Account.ts"
import { AgentHost, MessageUuid } from "../src/agent/AgentHost.ts"
import { layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import {
  type ChosenServers,
  checkStatus,
  noServersNote,
  notGivenProblem,
} from "../src/agent/mcp.ts"
import { apiKeyProblem } from "../src/agent/sessionChecks.ts"
import { WorkerState } from "../src/agent/WorkerState.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"
import { workersIn } from "./workerEnv.ts"

// The tests start the fake Claude Code as a process: bun's 5 s default fails them when other checks
// run beside this one.
setDefaultTimeout(30_000)

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

const noServers: ChosenServers = { servers: [], note: noServersNote }

const beads: ChosenServers = {
  servers: [{ name: "beads", scope: "project", definition: { command: "bd-mcp" } }],
  note: null,
}

const gmail = { name: "claude.ai Gmail", status: "connected", source: "claudeai" }

/** An initialize answer's account with an API key beside the subscription login. */
const keyed = { account: { apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" } }

/** How long the fake lingers after its stdin ends, ignoring SIGTERM: far past the SDK's grace. */
const linger = 8000

/** The user messages the fake read, from its log. */
const usersRead = (file: string): number =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l !== "" && JSON.parse(l).stdin?.type === "user").length
    : 0

/** Checks a session with `servers`, billed as `billing`, the fake playing `scenario`. */
const run = <A, E>(
  scenario: Record<string, unknown>,
  effect: (dir: string, log: string) => Effect.Effect<A, E, AgentHost>,
  servers: ChosenServers = noServers,
  billing: Billing = { _tag: "Subscription", keyUnused: false },
): Promise<A> => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-before-turn-"))
  const log = join(dir, "fake.jsonl")
  const config = appConfig({ claude: fake, settings: defaultSettings }, dir)
  const host = liveLayer({
    prompt: { text: "Work on TICKET_ID.", file: null },
    servers,
    account: { billing },
  })
  return Effect.runPromise(
    effect(dir, log).pipe(
      Effect.provide(
        host.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              attentionLayer(waitForTest),
              transcriptsLayer(),
              ClaudeCode.layer.pipe(
                Layer.provide(
                  workersIn(
                    { ...testEnv, FAKE_CLAUDE_SCENARIO: JSON.stringify({ ...scenario, log }) },
                    billing._tag === "Subscription",
                  ),
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

/** Waits, at most 10 s, for the worker to reach a state `matches`. */
const until = (matches: (state: WorkerState) => boolean) =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    const found = yield* host.state("t-1" as TicketId).pipe(
      Stream.filter(matches),
      Stream.runHead,
      Effect.timeoutOrElse({
        duration: Duration.seconds(10),
        orElse: () => Effect.die("the worker never reached the state"),
      }),
    )
    return Option.getOrThrow(found)
  })

/**
 * Starts the worker: whether its start failed, its state then, the messages the fake read, and how
 * long, in ms, its session took to end once closed.
 */
const started = (dir: string, log: string) =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    const exit = yield* Effect.exit(
      host.start("t-1" as TicketId, { sessionId: crypto.randomUUID(), cwd: dir }),
    )
    const state = yield* host.current("t-1" as TicketId)
    const from = Date.now()
    yield* host.close("t-1" as TicketId)
    return {
      failed: Exit.isFailure(exit),
      state,
      users: usersRead(log),
      closing: Date.now() - from,
    }
  })

describe("AgentHost live: the setup check before the first turn", () => {
  test("an API key in the initialize's account ends the worker before anything is sent", async () => {
    const found = await run({ initialize: keyed, lingerOnClose: linger }, started)
    const problem = apiKeyProblem("ANTHROPIC_API_KEY")
    expect(found.failed).toBe(false)
    expect(found.state).toEqual(WorkerState.Gone({ why: problem, setup: true }))
    expect(found.users).toBe(0)
    // Killed at once: the fake would linger past the SDK's grace, ignoring SIGTERM.
    expect(found.closing).toBeLessThan(linger / 2)
  })

  test("an MCP server it wasn't given, in mcpServerStatus(), ends the worker", async () => {
    const found = await run({ mcpStatus: [gmail], lingerOnClose: linger }, started)
    const problem = notGivenProblem(["claude.ai Gmail"])
    expect(found.failed).toBe(false)
    expect(found.state).toEqual(WorkerState.Gone({ why: problem, setup: true }))
    expect(found.users).toBe(0)
    expect(found.closing).toBeLessThan(linger / 2)
  })

  test("a resume stopped so sends nothing, and gives the message's uuid all the same", async () => {
    const found = await run({ initialize: keyed }, (dir, log) =>
      Effect.gen(function* () {
        const host = yield* AgentHost
        const sessionId = crypto.randomUUID()
        const uuid = MessageUuid.draw()
        const sent = yield* host.resume(
          "t-1" as TicketId,
          { sessionId, cwd: dir },
          { text: "carry on", from: "clientComposed", uuid },
        )
        return { uuid, sent, state: yield* host.current("t-1" as TicketId), users: usersRead(log) }
      }),
    )
    expect(found.sent).toBe(found.uuid)
    expect(found.state).toEqual(
      WorkerState.Gone({ why: apiKeyProblem("ANTHROPIC_API_KEY"), setup: true }),
    )
    expect(found.users).toBe(0)
  })

  test("the API key is fine when billing is the API key", async () => {
    const found = await run({ initialize: keyed }, started, noServers, { _tag: "ApiKey" })
    expect(found.failed).toBe(false)
    expect(found.state._tag).toBe("Starting")
  })

  test("a chosen server not listed yet, or servers without a source, leave it to system/init", async () => {
    const listed = { mcp_servers: [{ name: "beads", status: "connected", source: "dynamic" }] }
    for (const [mcpStatus, servers] of [
      [[], beads],
      [[{ name: "claude.ai Gmail", status: "connected" }], noServers],
    ] as const) {
      const state = await run(
        { mcpStatus, init: servers === beads ? listed : {} },
        (dir) =>
          Effect.gen(function* () {
            const host = yield* AgentHost
            yield* host.start("t-1" as TicketId, { sessionId: crypto.randomUUID(), cwd: dir })
            yield* host.send("t-1" as TicketId, { text: "go", from: "clientComposed" })
            return yield* until((s) => s._tag === "Idle" || s._tag === "Gone")
          }),
        servers,
      )
      expect(state._tag).toBe("Idle")
    }
  })

  test("a problem only system/init shows kills the worker at once, its turn under way", async () => {
    const found = await run(
      {
        init: { apiKeySource: "ANTHROPIC_API_KEY" },
        turns: [[{ hang: true }]],
        lingerOnClose: linger,
      },
      (dir) =>
        Effect.gen(function* () {
          const host = yield* AgentHost
          yield* host.start("t-1" as TicketId, { sessionId: crypto.randomUUID(), cwd: dir })
          yield* host.send("t-1" as TicketId, { text: "go", from: "clientComposed" })
          const state = yield* until((s) => s._tag === "Gone")
          const from = Date.now()
          yield* host.close("t-1" as TicketId)
          return { state, closing: Date.now() - from }
        }),
    )
    expect(found.state).toEqual(
      WorkerState.Gone({ why: apiKeyProblem("ANTHROPIC_API_KEY"), setup: true }),
    )
    expect(found.closing).toBeLessThan(linger / 2)
  })
})

/** checkStatus's problems for `status`: none when it passes. */
const problemsOf = async (status: unknown, chosen: ChosenServers = beads) => {
  const exit = await Effect.runPromise(Effect.exit(checkStatus(status, chosen)))
  if (Exit.isSuccess(exit)) return []
  const reason = exit.cause.reasons[0]
  if (reason?._tag !== "Fail") throw new Error(`${exit.cause}`)
  return reason.error.problems
}

describe("checkStatus: the MCP servers mcpServerStatus() lists", () => {
  test("a server not chosen, or chosen with another source, is one workers weren't given", async () => {
    expect(await problemsOf([gmail])).toEqual([notGivenProblem(["claude.ai Gmail"])])
    expect(await problemsOf([{ name: "beads", source: "claudeai" }])).toEqual([
      notGivenProblem(["beads"]),
    ])
  })

  test("the chosen servers, as dynamic, sdk or their scope, or not yet listed, pass", async () => {
    for (const source of ["dynamic", "sdk", "project"]) {
      expect(await problemsOf([{ name: "beads", status: "pending", source }])).toEqual([])
    }
    expect(await problemsOf([])).toEqual([])
  })

  test("an answer it can't read, or a server without a source, is left to system/init", async () => {
    for (const status of [undefined, null, {}, [{ source: "claudeai" }], [{ name: "x" }]]) {
      expect(await problemsOf(status)).toEqual([])
    }
  })

  test("property: whatever the answer holds, the check fails or passes, never dies", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.anything(),
          fc.array(
            fc.record(
              { name: fc.string(), source: fc.oneof(fc.string(), fc.anything()) },
              { requiredKeys: [] },
            ),
          ),
        ),
        async (status) => {
          const problems = await problemsOf(status)
          expect(problems.length).toBeLessThanOrEqual(1)
        },
      ),
    )
  })
})
