// Claude in Chrome (§ 4.6): built into Claude Code, which turns it on by itself once it is set up,
// past strict MCP config. Sessions get --chrome when workers.mcp_servers chooses claude-in-chrome,
// --no-chrome otherwise: workers and the interview as the project chose, the probe and organs never.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Exit } from "effect"
import fc from "fast-check"
import {
  type ChosenServers,
  checkInit,
  chromeArgs,
  chromeServer,
  inProcess,
  noServersNote,
  notGivenProblem,
  resolveServers,
} from "../src/agent/mcp.ts"
import {
  interviewOptions,
  probeOptions,
  type WorkerCallbacks,
  workerOptions,
} from "../src/agent/options.ts"
import { mcpSteps } from "../src/init/workers.ts"
import { organOptions } from "../src/organs/AgentSdkLanguageModel.ts"
import { type Started, startBlock } from "../src/run/startup.ts"
import * as TestAccount from "../src/testing/Account.ts"
import { appConfig } from "../src/testing/AppConfig.ts"

const config = appConfig({}, "/work/project")
const env = { PATH: "/usr/bin" }
const callbacks: WorkerCallbacks = {
  canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
  onElicitation: async () => ({ action: "decline" }),
  hooks: {},
  stderr: () => {},
}
const on = { chrome: null }
const off = { "no-chrome": null }

const worker = (servers: ChosenServers) =>
  workerOptions({
    config,
    ticket: "tutti-abc.1",
    worktree: "/work/project-tutti/tutti-abc.1",
    prompt: { text: "You work on TICKET_ID.", file: null },
    servers,
    skills: false,
    callbacks,
    session: { _tag: "New", sessionId: "s" },
    env,
    abortController: new AbortController(),
  })

const interview = (chrome: boolean) =>
  interviewOptions({
    config,
    setup: { prompt: "Talk it through.", server: createSdkMcpServer({ name: "tutti" }) },
    chrome,
    callbacks,
    session: { _tag: "New", sessionId: "s" },
    env,
    abortController: new AbortController(),
  })

describe("Chrome's arguments", () => {
  test("--chrome when chosen, --no-chrome when not or left out", () => {
    expect(chromeArgs({ chrome: true })).toEqual(on)
    expect(chromeArgs({ chrome: false })).toEqual(off)
    expect(chromeArgs({})).toEqual(off)
  })

  test("a worker gets Chrome as its servers say", () => {
    expect(worker({ servers: [], chrome: true, note: null }).extraArgs).toEqual(on)
    expect(worker({ servers: [], chrome: false, note: null }).extraArgs).toEqual(off)
    expect(worker({ servers: [], note: noServersNote }).extraArgs).toEqual(off)
  })

  test("the interview gets Chrome as the project chose", () => {
    expect(interview(true).extraArgs).toEqual(on)
    expect(interview(false).extraArgs).toEqual(off)
  })

  test("the login probe and an organ never get it", () => {
    const probe = probeOptions({
      config,
      env,
      stderr: () => {},
      spawned: () => {},
      abortController: new AbortController(),
    })
    expect(probe.extraArgs).toEqual(off)
    const organ = organOptions({
      turn: { systemPrompt: "Answer.", userText: ["Hi."] },
      jsonSchema: undefined,
      call: { organ: "triage" },
      cwd: "/tmp",
      env,
      claude: null,
      abortController: new AbortController(),
      partial: false,
      stderr: () => {},
    })
    expect(organ.extraArgs).toEqual(off)
  })
})

/** Resolves `names` with a user .claude.json defining exa, in a home of its own. */
const resolve = async (names: ReadonlyArray<string>): Promise<ChosenServers> => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "tutti-chrome-")))
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { exa: { type: "http", url: "https://exa.example" } } }),
  )
  const exit = await Effect.runPromise(
    Effect.exit(
      resolveServers(join(home, "repo"), names).pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: home } }))),
        Effect.provide(BunServices.layer),
      ),
    ),
  )
  if (Exit.isFailure(exit)) throw new Error(`${exit.cause}`)
  return exit.value
}

describe("choosing Chrome in workers.mcp_servers", () => {
  test("isn't looked up in a config file: it sets chrome, and is no server", async () => {
    expect(await resolve([chromeServer])).toEqual({ servers: [], chrome: true, note: null })
    const both = await resolve(["exa", chromeServer])
    expect(both.servers.map((server) => server.name)).toEqual(["exa"])
    expect(both.chrome).toBe(true)
  })

  test("left out, sessions don't get it", async () => {
    expect((await resolve(["exa"])).chrome).toBeUndefined()
    expect(await resolve([])).toEqual({ servers: [], note: noServersNote })
  })

  test("tutti init doesn't call it missing: no config file defines it", () => {
    expect(mcpSteps([chromeServer], [], true).map((s) => s.kind)).toEqual(["done"])
    expect(mcpSteps([chromeServer, "redis"], ["exa"], true).map((s) => s.kind)).toEqual([
      "done",
      "missing",
    ])
  })

  test("the START block names it with the servers", () => {
    const started: Started = {
      config,
      base: "main",
      prompt: { text: "Work on TICKET_ID.", file: null },
      mcp: { servers: [], chrome: true, note: null },
      account: TestAccount.accountProbe(),
      organs: "AgentSdk",
      warnings: [],
    }
    expect(startBlock(started, "0.1.0").join("\n")).toContain(`MCP servers: ${chromeServer}`)
  })
})

const check = async (
  listed: ReadonlyArray<{ name: string; status: string; source?: string }>,
  chosen: ChosenServers,
) => {
  const exit = await Effect.runPromise(Effect.exit(checkInit({ mcp_servers: [...listed] }, chosen)))
  if (Exit.isSuccess(exit)) return []
  const reason = exit.cause.reasons[0]
  if (reason?._tag !== "Fail") throw new Error(`${exit.cause}`)
  return reason.error.problems
}

describe("system/init's Chrome", () => {
  const listed = { name: chromeServer, status: "connected", source: "dynamic" }

  test("chosen, it may be listed as dynamic, or not at all where it isn't set up", async () => {
    expect(await check([listed], { servers: [], chrome: true, note: null })).toEqual([])
    expect(await check([], { servers: [], chrome: true, note: null })).toEqual([])
    const server = inProcess("tutti", createSdkMcpServer({ name: "tutti" }), true)
    expect(
      await check([listed, { name: "tutti", status: "connected", source: "sdk" }], server),
    ).toEqual([])
  })

  test("not chosen, or listed from a config file, it is a server workers weren't given", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<ChosenServers>(
          { servers: [], note: noServersNote },
          { servers: [], chrome: false, note: null },
          inProcess("tutti", createSdkMcpServer({ name: "tutti" }), false),
        ),
        fc.constantFrom("dynamic", "user", "project", "claudeai"),
        async (chosen, source) => {
          const given = chosen.servers.map((s) => ({ name: s.name, status: "ok", source: "sdk" }))
          expect(await check([...given, { ...listed, source }], chosen)).toEqual([
            notGivenProblem([chromeServer]),
          ])
        },
      ),
    )
    expect(
      await check([{ ...listed, source: "user" }], { servers: [], chrome: true, note: null }),
    ).toEqual([notGivenProblem([chromeServer])])
  })
})
