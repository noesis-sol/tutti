// A first system/init from a CLI of another version, without a field the setup check reads: without
// readable MCP servers the worker ends as a setup problem; without the permission mode or the API
// key source that check is skipped, the log saying so once in the run.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { type Query, query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Exit, Layer, Option, Stream } from "effect"
import fc from "fast-check"
import type { Billing } from "../src/agent/Account.ts"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { type ChosenServers, checkInit, noServersNote, unlistedProblem } from "../src/agent/mcp.ts"
import { uncheckedLine } from "../src/agent/sessionChecks.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"
import { workersIn } from "./workerEnv.ts"

// The live tests start the fake Claude Code as a process: bun's 5 s default fails them when other
// checks run beside this one.
setDefaultTimeout(30_000)

const given: ChosenServers = {
  servers: [{ name: "exa", scope: "project", definition: { type: "sse", url: "https://exa" } }],
  note: null,
}

/** checkInit's problems for `init`: none when it passes. */
const problemsOf = async (init: unknown, chosen: ChosenServers = given) => {
  const exit = await Effect.runPromise(Effect.exit(checkInit(init, chosen)))
  if (Exit.isSuccess(exit)) return []
  const reason = exit.cause.reasons[0]
  if (reason?._tag !== "Fail") throw new Error(`${exit.cause}`)
  return reason.error.problems
}

describe("checkInit: a system/init whose MCP servers it can't read", () => {
  const unreadable: ReadonlyArray<readonly [string, unknown]> = [
    ["without mcp_servers", { type: "system", subtype: "init" }],
    ["with mcp_servers null", { mcp_servers: null }],
    ["with mcp_servers not a list", { mcp_servers: { exa: "dynamic" } }],
    ["with a server without a name", { mcp_servers: [{ status: "connected", source: "dynamic" }] }],
    ["with a source not a string", { mcp_servers: [{ name: "exa", status: "x", source: 3 }] }],
    ["not an object", "init"],
  ]
  for (const [name, init] of unreadable) {
    test(`${name} is a setup problem`, async () => {
      expect(await problemsOf(init)).toEqual([unlistedProblem])
    })
  }

  test("the same, with no servers chosen", async () => {
    expect(await problemsOf({}, { servers: [], note: noServersNote })).toEqual([unlistedProblem])
  })

  test("a server without a source, or a status, is read", async () => {
    expect(await problemsOf({ mcp_servers: [{ name: "exa", source: "dynamic" }] })).toEqual([])
    expect(await problemsOf({ mcp_servers: [{ name: "exa", status: "pending" }] })).not.toEqual([
      unlistedProblem,
    ])
  })

  test("property: whatever system/init holds, the check fails or passes, never dies", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.anything(),
          fc.record({ mcp_servers: fc.anything() }),
          fc.record({
            mcp_servers: fc.array(
              fc.record({ name: fc.anything(), source: fc.anything() }, { requiredKeys: [] }),
            ),
          }),
        ),
        async (init) => {
          const exit = await Effect.runPromise(Effect.exit(checkInit(init, given)))
          expect(Exit.isSuccess(exit) || exit.cause.reasons[0]?._tag === "Fail").toBe(true)
        },
      ),
      { numRuns: 200 },
    )
  })
})

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

/** The SDK's query, each system/init in its stream without `fields`, as another CLI might send it. */
const without =
  (fields: ReadonlyArray<string>): typeof query =>
  (params) => {
    const real = query(params)
    const messages = async function* () {
      for await (const message of real) {
        if (message.type === "system" && message.subtype === "init") {
          const kept: Record<string, unknown> = { ...message }
          for (const field of fields) delete kept[field]
          yield kept as unknown as SDKMessage
        } else {
          yield message
        }
      }
    }
    return new Proxy(real, {
      get: (target, key) => {
        if (key === Symbol.asyncIterator) return messages
        const value = Reflect.get(target, key, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    }) as Query
  }

const sessionIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]

/**
 * The live host over the fake Claude Code, each system/init without `fields`: starts a worker for
 * each of `tickets` in turn, sends it a message and waits for it to settle. Their states then, and
 * the log's lines.
 */
const settle = async (
  fields: ReadonlyArray<string>,
  tickets: ReadonlyArray<TicketId> = ["t-1" as TicketId],
  billing: Billing = { _tag: "Subscription", keyUnused: false },
) => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-first-init-"))
  const config = appConfig({ claude: fake, settings: defaultSettings }, dir)
  const host = liveLayer({
    prompt: { text: "Work on TICKET_ID.", file: null },
    servers: { servers: [], note: noServersNote },
    account: { billing },
  })
  return Effect.runPromise(
    Effect.gen(function* () {
      const agents = yield* AgentHost
      const states = []
      for (const [i, ticket] of tickets.entries()) {
        yield* agents.start(ticket, { sessionId: sessionIds[i] ?? "", cwd: dir })
        yield* agents.send(ticket, { text: "go", from: "clientComposed" })
        const state = yield* agents.state(ticket).pipe(
          Stream.filter((s) => s._tag === "Idle" || s._tag === "Failed" || s._tag === "Gone"),
          Stream.runHead,
          Effect.timeoutOrElse({
            duration: Duration.seconds(10),
            orElse: () => Effect.die("the worker never settled"),
          }),
        )
        states.push(Option.getOrThrow(state))
      }
      return { states, lines: yield* texts }
    }).pipe(
      Effect.provide(
        host.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              attentionLayer(waitForTest),
              transcriptsLayer(),
              ClaudeCode.layerWith(without(fields)).pipe(
                Layer.provide(
                  workersIn(
                    {
                      ...testEnv,
                      FAKE_CLAUDE_SCENARIO: JSON.stringify({ log: join(dir, "fake.jsonl") }),
                    },
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

describe("AgentHost live: a first system/init without a field the setup check reads", () => {
  test("without mcp_servers, the worker ends as a setup problem", async () => {
    const { states, lines } = await settle(["mcp_servers"])
    expect(states).toEqual([
      expect.objectContaining({ _tag: "Gone", why: unlistedProblem, setup: true }),
    ])
    expect(lines).toContain(`  t-1: ${unlistedProblem}`)
  })

  test("without permissionMode, the mode isn't checked, logged once in the run", async () => {
    const { states, lines } = await settle(
      ["permissionMode"],
      ["t-1" as TicketId, "t-2" as TicketId],
    )
    expect(states.map((s) => s._tag)).toEqual(["Idle", "Idle"])
    const skipped = uncheckedLine("permissionMode", "the permission mode in effect is auto")
    expect(lines.filter((l) => l.includes("system/init gives no"))).toEqual([skipped])
  })

  test("without apiKeySource, the key isn't checked, logged once in the run", async () => {
    const { states, lines } = await settle(["apiKeySource"], ["t-1" as TicketId, "t-2" as TicketId])
    expect(states.map((s) => s._tag)).toEqual(["Idle", "Idle"])
    expect(lines.filter((l) => l.includes("system/init gives no"))).toEqual([
      uncheckedLine("apiKeySource", "that workers bill the subscription login, not an API key"),
    ])
  })

  test("without apiKeySource while billing is the API key, nothing is skipped", async () => {
    const { states, lines } = await settle(["apiKeySource"], ["t-1" as TicketId], {
      _tag: "ApiKey",
    })
    expect(states.map((s) => s._tag)).toEqual(["Idle"])
    expect(lines.filter((l) => l.includes("system/init gives no"))).toEqual([])
  })
})
