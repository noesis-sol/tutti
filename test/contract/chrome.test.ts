// Contract tests for Claude in Chrome against the real Agent SDK (§ 13), run only with
// TUTTI_LIVE=1: Claude Code turns Chrome on by itself once it is set up on the machine, past strict
// MCP config, so workers get --no-chrome unless workers.mcp_servers chooses claude-in-chrome. Each
// test starts one session with a worker's options in a fresh temp folder and reads its first
// system/init. The test with Chrome on runs only where Claude Code has Chrome set up.
import { expect } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { query, type SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Exit } from "effect"
import { paneVariable } from "../../src/agent/env.ts"
import { type ChosenServers, checkInit, chromeServer, noServersNote } from "../../src/agent/mcp.ts"
import { type WorkerCallbacks, workerOptions } from "../../src/agent/options.ts"
import { defaultSettings } from "../../src/cli/AppConfig.ts"
import { appConfig } from "../../src/testing/AppConfig.ts"
import { live } from "../gates.ts"

const testLimit = 120_000

/** Whether this machine's Claude Code has Chrome set up, in any of the keys orchestra reads. */
const chromeSetUp = (() => {
  const dir = process.env.CLAUDE_CONFIG_DIR || process.env.HOME || homedir()
  try {
    const user: Record<string, unknown> = JSON.parse(
      readFileSync(join(dir, ".claude.json"), "utf8"),
    )
    return [
      "claudeInChromeDefaultEnabled",
      "cachedChromeExtensionInstalled",
      "hasCompletedClaudeInChromeOnboarding",
    ].some((key) => user[key] === true)
  } catch {
    return false
  }
})()

/** tutti's environment without the variables of a Claude Code session or terminal pane. */
const hostEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !/^CLAUDE(CODE$|_CODE_|_PID$|_EFFORT$)/.test(entry[0]) &&
        !paneVariable(entry[0]),
    ),
  )

const callbacks: WorkerCallbacks = {
  canUseTool: async () => ({ behavior: "deny", message: "not in this test" }),
  onElicitation: async () => ({ action: "decline" }),
  hooks: {},
  stderr: () => {},
}

/** The first system/init of a worker's session given `servers`, in a fresh folder. */
const firstInit = async (servers: ChosenServers): Promise<SDKSystemMessage> => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-chrome-contract-")))
  const config = appConfig(
    {
      claude: null,
      settings: {
        ...defaultSettings,
        workers: { ...defaultSettings.workers, permission_mode: "default", model: "haiku" },
      },
    },
    dir,
  )
  const session = query({
    prompt: "Reply with the single word OK.",
    options: {
      ...workerOptions({
        config,
        ticket: "contract-chrome",
        worktree: dir,
        prompt: null,
        servers,
        skills: false,
        callbacks,
        session: { _tag: "New", sessionId: crypto.randomUUID() },
        env: hostEnv(),
        abortController: new AbortController(),
      }),
      persistSession: false,
    },
  })
  try {
    for await (const message of session) {
      if (message.type === "system" && message.subtype === "init") return message
    }
    throw new Error("the session ended without a system/init")
  } finally {
    session.close()
  }
}

const problems = async (init: SDKSystemMessage, servers: ChosenServers) => {
  const exit = await Effect.runPromise(Effect.exit(checkInit(init, servers)))
  return Exit.isSuccess(exit) ? [] : String(exit.cause)
}

const chromeTools = (init: SDKSystemMessage) =>
  init.tools.filter((tool) => tool.startsWith(`mcp__${chromeServer}__`))

live.describe("Agent SDK contract: Claude in Chrome", () => {
  live.test(
    "not chosen, system/init lists no Chrome server and no Chrome tools, even where it is set up",
    async () => {
      const servers: ChosenServers = { servers: [], note: noServersNote }
      const init = await firstInit(servers)
      expect(init.mcp_servers.map((server) => server.name)).not.toContain(chromeServer)
      expect(chromeTools(init)).toEqual([])
      expect(await problems(init, servers)).toEqual([])
    },
    testLimit,
  )

  live.test.skipIf(!chromeSetUp)(
    "chosen, where it is set up, system/init lists Chrome as dynamic, with its tools",
    async () => {
      const servers: ChosenServers = { servers: [], chrome: true, note: null }
      const init = await firstInit(servers)
      expect(init.mcp_servers.map((server) => [server.name, server.source])).toEqual([
        [chromeServer, "dynamic"],
      ])
      expect(chromeTools(init).length).toBeGreaterThan(0)
      expect(await problems(init, servers)).toEqual([])
    },
    testLimit,
  )
})
