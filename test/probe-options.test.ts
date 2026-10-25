import { describe, expect, test } from "bun:test"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk"
import fc from "fast-check"
import { probeOptions, type WorkerCallbacks, workerOptions } from "../src/agent/options.ts"
import { withSessionProcess } from "../src/agent/sessionProcess.ts"
import { unusedTools } from "../src/agent/unusedTools.ts"
import type { AppConfigValue } from "../src/cli/AppConfig.ts"
import { efforts, permissionModes } from "../src/project/settings.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { testEnv } from "./env.ts"

/** A config whose workers' settings have `workers` laid over the defaults. */
const configWith = (
  workers: Partial<AppConfigValue["settings"]["workers"]> = {},
  overrides: Partial<AppConfigValue> = {},
): AppConfigValue => {
  const base = appConfig(overrides, "/work/project")
  return {
    ...base,
    settings: { ...base.settings, workers: { ...base.settings.workers, ...workers } },
  }
}

const probeFor = (config: AppConfigValue = configWith()) => probeOptions({ config })

describe("probeOptions", () => {
  test("the probe's options are the workers', in the main checkout, field by field", () => {
    const options = probeFor(
      configWith(
        { model: "opus", effort: "high", ask_user_question: false },
        { claude: "/opt/claude/bin/claude" },
      ),
    )
    // The executable, the environment, the stderr, the abort and the spawn are ClaudeCode's.
    expect(options).toEqual({
      cwd: "/work/project",
      projectConfigRoot: "/work/project",
      settingSources: ["user", "project", "local"],
      permissionMode: "auto",
      model: "opus",
      effort: "high",
      mcpServers: {},
      strictMcpConfig: true,
      extraArgs: { "no-chrome": null },
      disallowedTools: [...unusedTools, "Skill", "AskUserQuestion"],
      persistSession: false,
    })
  })

  test("it has no prompt, session, callbacks, hooks or MCP servers of a worker's", () => {
    const options = probeFor(configWith({ effort: null }))
    for (const key of [
      "systemPrompt",
      "sessionId",
      "resume",
      "canUseTool",
      "onElicitation",
      "hooks",
      "model",
      "effort",
      "pathToClaudeCodeExecutable",
    ]) {
      expect(key in options).toBe(false)
    }
    expect(options.mcpServers).toEqual({})
  })

  test("whatever the workers' settings, it shares every option a worker's session has", () => {
    const stderr = (_: string) => {}
    const workerCallbacks: WorkerCallbacks = {
      canUseTool: async () => ({ behavior: "allow" }),
      onElicitation: async () => ({ action: "decline" }),
      hooks: {},
      stderr,
    }
    fc.assert(
      fc.property(
        fc.constantFrom(...permissionModes),
        fc.option(fc.string({ minLength: 1 })),
        fc.option(fc.constantFrom(...efforts)),
        fc.boolean(),
        fc.option(fc.string({ minLength: 1 })),
        (permission_mode, model, effort, ask_user_question, claude) => {
          const config = configWith(
            { permission_mode, model, effort, ask_user_question },
            { claude },
          )
          const {
            cwd: _probeCwd,
            mcpServers: _probeServers,
            persistSession: _persist,
            ...probe
          } = probeOptions({ config })
          const {
            cwd: _workerCwd,
            mcpServers: _workerServers,
            systemPrompt: _system,
            sessionId: _session,
            canUseTool: _canUseTool,
            onElicitation: _onElicitation,
            hooks: _hooks,
            forwardSubagentText: _forward,
            includePartialMessages: _partial,
            ...worker
          } = workerOptions({
            config,
            ticket: "tutti-abc.1" as TicketId,
            worktree: "/work/project-tutti/tutti-abc.1",
            prompt: { text: "You work on TICKET_ID.", file: null },
            servers: { servers: [], note: null },
            skills: false,
            callbacks: workerCallbacks,
            session: { _tag: "New", sessionId: "s" },
          })
          expect(probe).toEqual(worker)
        },
      ),
    )
  })

  test("Claude Code starts in a process group of its own, its stderr and process reported", async () => {
    const received: Array<string> = []
    const { options, process } = withSessionProcess({ stderr: (data) => received.push(data) })
    const child = options.spawnClaudeCodeProcess?.({
      command: "/bin/sh",
      args: ["-c", 'echo "$$ $(ps -o pgid= -p $$)"; echo oops >&2'],
      cwd: "/",
      env: { PATH: testEnv.PATH },
      signal: new AbortController().signal,
    } satisfies SpawnOptions) as ChildProcessWithoutNullStreams
    expect(process.child()).toBe(child)
    let stdout = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    await new Promise<void>((resolve) => child.once("close", () => resolve()))
    const [pid, pgid] = stdout.trim().split(/\s+/)
    expect(pid).toBe(pgid)
    expect(received.join("")).toBe("oops\n")
    expect(process.stderrTail()).toBe("oops")
  })
})
