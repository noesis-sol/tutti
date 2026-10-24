// Contract tests for the tools workers start without (§ 4.1) against the real Agent SDK (§ 13),
// run only with TUTTI_LIVE=1. Each test starts sessions with a worker's options in a fresh temp
// folder and reads their first system/init's tools: a worker's lacks only the tools it is denied,
// and keeps what it works with; Skill stays in a project with skills of its own.
import { expect } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { paneVariable } from "../../src/agent/env.ts"
import { noServersNote } from "../../src/agent/mcp.ts"
import { type WorkerCallbacks, workerOptions } from "../../src/agent/options.ts"
import { deniedTools, unusedTools } from "../../src/agent/unusedTools.ts"
import { defaultSettings } from "../../src/cli/AppConfig.ts"
import { appConfig } from "../../src/testing/AppConfig.ts"
import { live } from "../gates.ts"

const testLimit = 180_000

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

/** A fresh project folder; with a command of its own, a skill, when `skills` says so. */
const project = (skills: boolean): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-tools-contract-")))
  if (skills) {
    mkdirSync(join(dir, ".claude", "commands"), { recursive: true })
    writeFileSync(join(dir, ".claude", "commands", "ship.md"), "Say that it shipped.\n")
  }
  return dir
}

/**
 * The tools in the first system/init of a worker's session in `dir`, keeping Skill as `skills`
 * says; with `denying` false, without any tool denied, as Claude Code would start it.
 */
const initTools = async (
  dir: string,
  skills: boolean,
  denying = true,
): Promise<ReadonlyArray<string>> => {
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
  const { disallowedTools, ...options } = workerOptions({
    config,
    ticket: "contract-tools",
    worktree: dir,
    prompt: null,
    servers: { servers: [], note: noServersNote },
    skills,
    callbacks,
    session: { _tag: "New", sessionId: crypto.randomUUID() },
  })
  const session = query({
    prompt: "Reply with the single word OK.",
    options: {
      ...options,
      ...(denying && disallowedTools !== undefined ? { disallowedTools } : {}),
      env: hostEnv(),
      persistSession: false,
    },
  })
  try {
    for await (const message of session) {
      if (message.type === "system" && message.subtype === "init") return message.tools
    }
    throw new Error("the session ended without a system/init")
  } finally {
    session.close()
  }
}

/** What a worker works with: Agent (named Task in system/init), Bash, Read, Edit, Write, ToolSearch. */
const kept = (tools: ReadonlyArray<string>) => {
  expect(tools.some((tool) => tool === "Agent" || tool === "Task")).toBe(true)
  for (const tool of ["Bash", "Read", "Edit", "Write", "ToolSearch", "AskUserQuestion"]) {
    expect(tools).toContain(tool)
  }
}

live.describe("Agent SDK contract: the tools workers start without", () => {
  live.test(
    "a worker's system/init lacks only the tools it is denied, Skill with them in a project without skills",
    async () => {
      const dir = project(false)
      const [denied, all] = await Promise.all([initTools(dir, false), initTools(dir, false, false)])
      kept(denied)
      for (const tool of [...unusedTools, "Skill"]) expect(denied).not.toContain(tool)
      // Every tool it has, Claude Code gives it anyway; every one it lacks is one tutti denied.
      for (const tool of denied) expect(all).toContain(tool)
      const lacking = all.filter((tool) => !denied.includes(tool))
      for (const tool of lacking) expect(deniedTools(false)).toContain(tool)
      // The denial is no mere name: this Claude Code has some of these tools to deny.
      expect(lacking).toContain("Skill")
      expect(lacking.length).toBeGreaterThan(1)
    },
    testLimit,
  )

  live.test(
    "a worker keeps Skill in a project with skills of its own",
    async () => {
      const tools = await initTools(project(true), true)
      kept(tools)
      expect(tools).toContain("Skill")
      for (const tool of unusedTools) expect(tools).not.toContain(tool)
    },
    testLimit,
  )
})
