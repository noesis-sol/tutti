// What a session AgentHost opens is for (src/agent/sessionKind.ts): a worker's when it doesn't say,
// and the MCP servers each kind is given, the one rule both of AgentHost's layers read.
import { describe, expect, test } from "bun:test"
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk"
import { type ChosenServers, noServers } from "../src/agent/mcp.ts"
import { interviewBuiltins } from "../src/agent/options.ts"
import { kindOf, SessionKind, serversOf } from "../src/agent/sessionKind.ts"
import { serverName } from "../src/agent/ticketTools.ts"

const workers: ChosenServers = {
  servers: [{ name: "docs", scope: "project", definition: { command: "docs-server" } }],
  chrome: true,
  note: null,
}

const setup = {
  prompt: "Talk it through.",
  server: createSdkMcpServer({ name: serverName }),
  builtins: interviewBuiltins,
  allowed: [],
  headless: false,
  effort: null,
  tools: [],
}

describe("kindOf", () => {
  test("a session that doesn't say is a worker's", () => {
    expect(kindOf({ sessionId: "s", cwd: "/w" })).toEqual(SessionKind.Worker())
    expect(kindOf({ sessionId: "s", cwd: "/w", kind: SessionKind.Probe() })).toEqual(
      SessionKind.Probe(),
    )
  })
})

describe("serversOf", () => {
  test("a worker gets the workers' servers", () => {
    expect(serversOf(SessionKind.Worker(), workers)).toBe(workers)
  })

  test("the environment probe gets none, nor Chrome", () => {
    expect(serversOf(SessionKind.Probe(), workers)).toBe(noServers)
  })

  test("a session of the Interview kind gets tutti's own server alone, and Chrome as workers have it", () => {
    const given = serversOf(SessionKind.Interview(setup), workers)
    expect(given.servers).toEqual([{ name: serverName, scope: "sdk", definition: setup.server }])
    expect(given.chrome).toBe(true)
    expect(serversOf(SessionKind.Interview(setup), { ...workers, chrome: false }).chrome).toBe(
      false,
    )
  })
})
