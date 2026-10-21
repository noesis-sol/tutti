import { describe, expect, test } from "bun:test"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk"
import fc from "fast-check"
import { probeOptions, type WorkerCallbacks, workerOptions } from "../src/agent/options.ts"
import type { AppConfigValue } from "../src/cli/AppConfig.ts"
import { efforts, permissionModes } from "../src/project/settings.ts"
import { appConfig } from "../src/testing/AppConfig.ts"

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

const env = { PATH: "/usr/bin", CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" }

const probeFor = (
  config: AppConfigValue = configWith(),
  stderr: (data: string) => void = () => {},
  spawned: (child: ChildProcessWithoutNullStreams) => void = () => {},
  abortController = new AbortController(),
) => probeOptions({ config, env, stderr, spawned, abortController })

describe("probeOptions", () => {
  test("the probe's options are the workers', in the main checkout, field by field", () => {
    const stderr = (_: string) => {}
    const abortController = new AbortController()
    const options = probeFor(
      configWith(
        { model: "opus", effort: "high", ask_user_question: false },
        { claude: "/opt/claude/bin/claude" },
      ),
      stderr,
      () => {},
      abortController,
    )
    const { spawnClaudeCodeProcess, ...rest } = options
    expect(rest).toEqual({
      cwd: "/work/project",
      projectConfigRoot: "/work/project",
      settingSources: ["user", "project", "local"],
      permissionMode: "auto",
      model: "opus",
      effort: "high",
      mcpServers: {},
      strictMcpConfig: true,
      extraArgs: { "no-chrome": null },
      disallowedTools: ["AskUserQuestion"],
      persistSession: false,
      stderr,
      env,
      pathToClaudeCodeExecutable: "/opt/claude/bin/claude",
      abortController,
    })
    expect(rest.abortController).toBe(abortController)
    expect(typeof spawnClaudeCodeProcess).toBe("function")
  })

  test("it has no prompt, session, callbacks, hooks or MCP servers of a worker's", () => {
    const options = probeFor()
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
          const abortController = new AbortController()
          const {
            spawnClaudeCodeProcess: _probeSpawn,
            cwd: _probeCwd,
            mcpServers: _probeServers,
            persistSession: _persist,
            ...probe
          } = probeOptions({ config, env, stderr, spawned: () => {}, abortController })
          const {
            spawnClaudeCodeProcess: _workerSpawn,
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
            ticket: "tutti-abc.1",
            worktree: "/work/project-tutti/tutti-abc.1",
            prompt: { text: "You work on TICKET_ID.", file: null },
            servers: { servers: [], note: null },
            callbacks: workerCallbacks,
            session: { _tag: "New", sessionId: "s" },
            env,
            abortController,
          })
          expect(probe).toEqual(worker)
        },
      ),
    )
  })

  test("Claude Code starts in a process group of its own, its stderr and process reported", async () => {
    const received: Array<string> = []
    const children: Array<ChildProcessWithoutNullStreams> = []
    const options = probeFor(
      configWith(),
      (data) => received.push(data),
      (child) => children.push(child),
    )
    const child = options.spawnClaudeCodeProcess?.({
      command: "/bin/sh",
      args: ["-c", 'echo "$$ $(ps -o pgid= -p $$)"; echo oops >&2'],
      cwd: "/",
      env: { PATH: process.env.PATH },
      signal: new AbortController().signal,
    } satisfies SpawnOptions) as ChildProcessWithoutNullStreams
    expect(children).toEqual([child])
    let stdout = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    await new Promise<void>((resolve) => child.once("close", () => resolve()))
    const [pid, pgid] = stdout.trim().split(/\s+/)
    expect(pid).toBe(pgid)
    expect(received.join("")).toBe("oops\n")
  })
})
