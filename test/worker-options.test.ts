import { describe, expect, test } from "bun:test"
import type {
  CanUseTool,
  HookCallback,
  HookInput,
  OnElicitation,
  PreCompactHookInput,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk"
import { Effect, Layer } from "effect"
import fc from "fast-check"
import { activityEvents, activityHooks, type Hooks, type Recorder } from "../src/agent/hooks.ts"
import type { ChosenServers } from "../src/agent/mcp.ts"
import {
  type SessionStart,
  spawnInOwnProcessGroup,
  type WorkerCallbacks,
  workerCallbacks,
  workerOptions,
} from "../src/agent/options.ts"
import type { AppConfigValue } from "../src/cli/AppConfig.ts"
import { permissionModes } from "../src/project/settings.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { Files, layer as transcriptsLayer } from "../src/testing/Transcripts.ts"

const canUseTool: CanUseTool = async () => ({ behavior: "allow" })
const onElicitation: OnElicitation = async () => ({ action: "decline" })
const hooks: Hooks = { PreToolUse: [{ hooks: [async () => ({})] }] }
const stderr = (_: string) => {}
const callbacks: WorkerCallbacks = { canUseTool, onElicitation, hooks, stderr }

const servers: ChosenServers = {
  servers: [
    { name: "docs", scope: "project", definition: { command: "docs-server", args: ["--stdio"] } },
    { name: "web", scope: "user", definition: { type: "http", url: "https://example.com/mcp" } },
  ],
  note: null,
}

const prompt = { text: "You work on TICKET_ID. Close TICKET_ID when done.", file: null }

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

const optionsFor = (
  session: SessionStart,
  config: AppConfigValue = configWith(),
  abortController = new AbortController(),
) =>
  workerOptions({
    config,
    ticket: "tutti-abc.1",
    worktree: "/work/project-tutti/tutti-abc.1",
    prompt,
    servers,
    callbacks,
    session,
    env: { PATH: "/usr/bin", CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" },
    abortController,
  })

describe("workerOptions", () => {
  test("a new session's options are § 4.1's block, field by field", () => {
    const abortController = new AbortController()
    const options = optionsFor(
      { _tag: "New", sessionId: "11111111-2222-4333-8444-555555555555" },
      configWith({ model: "opus", effort: "high" }, { claude: "/opt/claude/bin/claude" }),
      abortController,
    )
    const { spawnClaudeCodeProcess, ...rest } = options
    expect(rest).toEqual({
      cwd: "/work/project-tutti/tutti-abc.1",
      projectConfigRoot: "/work/project",
      settingSources: ["user", "project", "local"],
      permissionMode: "auto",
      model: "opus",
      effort: "high",
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: "You work on tutti-abc.1. Close tutti-abc.1 when done.",
        snapshot: true,
      },
      sessionId: "11111111-2222-4333-8444-555555555555",
      mcpServers: {
        docs: { command: "docs-server", args: ["--stdio"] },
        web: { type: "http", url: "https://example.com/mcp" },
      },
      strictMcpConfig: true,
      canUseTool,
      onElicitation,
      hooks,
      forwardSubagentText: true,
      includePartialMessages: true,
      stderr,
      env: { PATH: "/usr/bin", CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" },
      pathToClaudeCodeExecutable: "/opt/claude/bin/claude",
      abortController,
    })
    expect(rest.canUseTool).toBe(canUseTool)
    expect(rest.onElicitation).toBe(onElicitation)
    expect(rest.hooks).toBe(hooks)
    expect(rest.stderr).toBe(stderr)
    expect(rest.abortController).toBe(abortController)
    expect(typeof spawnClaudeCodeProcess).toBe("function")
  })

  test("a resumed session's options resume its ID, with no sessionId", () => {
    const options = optionsFor({ _tag: "Resume", sessionId: "saved-session" })
    expect(options.resume).toBe("saved-session")
    expect("sessionId" in options).toBe(false)
    const fresh = optionsFor({ _tag: "New", sessionId: "drawn-session" })
    expect(fresh.sessionId).toBe("drawn-session")
    expect("resume" in fresh).toBe(false)
    // Everything else is the same for both.
    const { resume: _r, spawnClaudeCodeProcess: _s1, ...resumed } = options
    const { sessionId: _i, spawnClaudeCodeProcess: _s2, ...started } = fresh
    expect(resumed).toEqual(started)
  })

  test("the permission mode is always passed, auto by default", () => {
    expect(optionsFor({ _tag: "New", sessionId: "s" }).permissionMode).toBe("auto")
    for (const mode of permissionModes) {
      const options = optionsFor(
        { _tag: "Resume", sessionId: "s" },
        configWith({ permission_mode: mode }),
      )
      expect(options.permissionMode).toBe(mode)
    }
  })

  test("Claude Code's defaults are left to it: no model, effort or executable when unset", () => {
    const options = optionsFor({ _tag: "New", sessionId: "s" })
    expect("model" in options).toBe(false)
    expect("effort" in options).toBe(false)
    expect("pathToClaudeCodeExecutable" in options).toBe(false)
  })

  test("AskUserQuestion is disallowed only when workers.ask_user_question is false", () => {
    expect("disallowedTools" in optionsFor({ _tag: "New", sessionId: "s" })).toBe(false)
    const options = optionsFor(
      { _tag: "New", sessionId: "s" },
      configWith({ ask_user_question: false }),
    )
    expect(options.disallowedTools).toEqual(["AskUserQuestion"])
  })

  test("no servers chosen gives none, strictly", () => {
    const options = workerOptions({
      config: configWith(),
      ticket: "t",
      worktree: "/w",
      prompt,
      servers: { servers: [], note: "none" },
      callbacks,
      session: { _tag: "New", sessionId: "s" },
      env: {},
      abortController: new AbortController(),
    })
    expect(options.mcpServers).toEqual({})
    expect(options.strictMcpConfig).toBe(true)
  })

  test("the standing rules name the ticket, whatever its ID", () => {
    fc.assert(
      fc.property(fc.string(), (ticket) => {
        const options = workerOptions({
          config: configWith(),
          ticket,
          worktree: "/w",
          prompt,
          servers,
          callbacks,
          session: { _tag: "New", sessionId: "s" },
          env: {},
          abortController: new AbortController(),
        })
        const system = options.systemPrompt
        if (typeof system !== "object" || Array.isArray(system) || system.type !== "preset") {
          throw new Error("not a preset system prompt")
        }
        expect(system.append).toBe(prompt.text.replaceAll("TICKET_ID", ticket))
      }),
    )
  })
})

describe("spawnInOwnProcessGroup", () => {
  const spawnSh = (script: string, received: Array<string>) =>
    spawnInOwnProcessGroup((data) => received.push(data))({
      command: "/bin/sh",
      args: ["-c", script],
      cwd: "/",
      env: { PATH: process.env.PATH },
      signal: new AbortController().signal,
    } satisfies SpawnOptions)

  const stdoutOf = (child: ReturnType<typeof spawnSh>) =>
    new Promise<string>((resolve) => {
      let text = ""
      child.stdout.on("data", (chunk: Buffer) => {
        text += chunk.toString()
      })
      child.once("exit", () => setTimeout(() => resolve(text), 50))
    })

  test("starts Claude Code leading a process group of its own", async () => {
    const child = spawnSh('echo "$$ $(ps -o pgid= -p $$)"', [])
    const [pid, pgid] = (await stdoutOf(child)).trim().split(/\s+/)
    expect(pid).toBeDefined()
    expect(pgid).toBe(pid as string)
    expect(Number(pgid)).not.toBe(process.pid)
  })

  test("passes its stderr to the callback", async () => {
    const received: Array<string> = []
    const child = spawnSh("printf 'one\\n' >&2; printf 'two ✓\\n' >&2", received)
    await stdoutOf(child)
    expect(received.join("")).toBe("one\ntwo ✓\n")
  })

  test("a callback that throws doesn't end the process", async () => {
    const child = spawnInOwnProcessGroup(() => {
      throw new Error("disk full")
    })({
      command: "/bin/sh",
      args: ["-c", "echo oops >&2; echo done"],
      env: { PATH: process.env.PATH },
      signal: new AbortController().signal,
    })
    expect(await stdoutOf(child)).toBe("done\n")
    expect(child.exitCode).toBe(0)
  })
})

const preToolUse: HookInput = {
  hook_event_name: "PreToolUse",
  session_id: "s",
  transcript_path: "/t",
  cwd: "/w",
  tool_name: "Bash",
  tool_input: { command: "scripts/check-fast.sh" },
  tool_use_id: "toolu_1",
}

const preCompact: PreCompactHookInput = {
  hook_event_name: "PreCompact",
  session_id: "s",
  transcript_path: "/t",
  cwd: "/w",
  trigger: "auto",
  custom_instructions: null,
}

/** The callback the hooks give `event`. */
const callbackFor = (hooks: Hooks, event: (typeof activityEvents)[number]): HookCallback => {
  const callback = hooks[event]?.[0]?.hooks[0]
  if (callback === undefined) throw new Error(`no ${event} hook`)
  return callback
}

const signal = { signal: new AbortController().signal }

/** Waits for the forked recordings to run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe("activityHooks", () => {
  test("covers § 4.2's events, each with one callback", async () => {
    const hooks = await Effect.runPromise(
      activityHooks("t", { activity: () => Effect.void, compaction: () => Effect.void }),
    )
    expect(Object.keys(hooks).sort()).toEqual([...activityEvents].sort())
    for (const event of activityEvents) {
      expect(hooks[event]).toHaveLength(1)
      expect(hooks[event]?.[0]?.hooks).toHaveLength(1)
      expect(hooks[event]?.[0]?.matcher).toBeUndefined()
    }
  })

  test("records activity and compactions after returning {}", async () => {
    const activity: Array<string> = []
    const compactions: Array<string> = []
    const hooks = await Effect.runPromise(
      activityHooks("t", {
        activity: (input) => Effect.sync(() => activity.push(input.hook_event_name)),
        compaction: (input) => Effect.sync(() => compactions.push(input.trigger)),
      }),
    )
    expect(await callbackFor(hooks, "PreToolUse")(preToolUse, "toolu_1", signal)).toEqual({})
    expect(await callbackFor(hooks, "PreCompact")(preCompact, undefined, signal)).toEqual({})
    await settle()
    expect(activity).toEqual(["PreToolUse", "PreCompact"])
    expect(compactions).toEqual(["auto"])
  })

  test("returns {} at once while recording is still going on", async () => {
    let started = false
    const hooks = await Effect.runPromise(
      activityHooks("t", {
        activity: () =>
          Effect.andThen(
            Effect.sync(() => {
              started = true
            }),
            Effect.never,
          ),
        compaction: () => Effect.never,
      }),
    )
    const result = await Promise.race([
      callbackFor(hooks, "PreToolUse")(preToolUse, "toolu_1", signal),
      new Promise((resolve) => setTimeout(() => resolve("timed out"), 200)),
    ])
    expect(result).toEqual({})
    await settle()
    expect(started).toBe(true)
  })

  const failing: ReadonlyArray<readonly [string, Recorder]> = [
    [
      "fails",
      { activity: () => Effect.fail("no state"), compaction: () => Effect.fail("no file") },
    ],
    [
      "dies",
      { activity: () => Effect.die(new Error("boom")), compaction: () => Effect.die("boom") },
    ],
    [
      "throws",
      {
        activity: () => {
          throw new Error("thrown")
        },
        compaction: () => {
          throw new Error("thrown")
        },
      },
    ],
  ]

  for (const [how, recorder] of failing) {
    test(`a recorder that ${how} is logged, and the callback still returns {}`, async () => {
      const warnings: Array<string> = []
      const hooks = await Effect.runPromise(
        activityHooks("tutti-abc.1", recorder, (message) =>
          Effect.sync(() => warnings.push(message)),
        ),
      )
      expect(await callbackFor(hooks, "PreToolUse")(preToolUse, "toolu_1", signal)).toEqual({})
      expect(await callbackFor(hooks, "PreCompact")(preCompact, undefined, signal)).toEqual({})
      await settle()
      expect(warnings).toHaveLength(2)
      expect(warnings[0]).toStartWith("tutti-abc.1's PreToolUse hook failed to record: ")
      expect(warnings[1]).toStartWith("tutti-abc.1's PreCompact hook failed to record: ")
    })
  }

  test("a warning that fails too is swallowed", async () => {
    const hooks = await Effect.runPromise(
      activityHooks("t", { activity: () => Effect.fail("no"), compaction: () => Effect.void }, () =>
        Effect.die("the log is gone"),
      ),
    )
    expect(await callbackFor(hooks, "PostToolUse")(preToolUse, "toolu_1", signal)).toEqual({})
    await settle()
  })

  test("any input, however the recorder ends, gives {}", async () => {
    const outcomes = [Effect.void, Effect.fail("x"), Effect.die("y"), Effect.never]
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...activityEvents),
        fc.dictionary(fc.string(), fc.jsonValue()),
        fc.nat(outcomes.length - 1),
        async (event, fields, outcome) => {
          const hooks = await Effect.runPromise(
            activityHooks(
              "t",
              {
                activity: () => outcomes[outcome] ?? Effect.void,
                compaction: () => outcomes[outcome] ?? Effect.void,
              },
              () => Effect.void,
            ),
          )
          const input = { ...fields, hook_event_name: event } as unknown as HookInput
          expect(await callbackFor(hooks, event)(input, undefined, signal)).toEqual({})
        },
      ),
    )
  })
})

describe("workerCallbacks", () => {
  test("gives Attention's callbacks, the hooks, and the transcript's stderr", async () => {
    const recorded: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const callbacks = yield* workerCallbacks("tutti-abc.1", {
          activity: (input) => Effect.sync(() => recorded.push(input.hook_event_name)),
          compaction: () => Effect.void,
        })
        callbacks.stderr("warning: something\n")
        const files = yield* Files
        expect(
          yield* Effect.promise(() =>
            callbackFor(callbacks.hooks, "SubagentStop")(
              {
                hook_event_name: "SubagentStop",
                session_id: "s",
                transcript_path: "/t",
                cwd: "/w",
                stop_hook_active: false,
                agent_id: "a1",
                agent_transcript_path: "/t/a1",
                agent_type: "verifier",
              },
              undefined,
              signal,
            ),
          ),
        ).toEqual({})
        expect(typeof callbacks.canUseTool).toBe("function")
        expect(typeof callbacks.onElicitation).toBe("function")
        return yield* files.stderr("tutti-abc.1")
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            attentionLayer().pipe(Layer.provide(Layer.mergeAll(logLayer(), eventsLayer()))),
            transcriptsLayer(),
          ),
        ),
      ),
    )
    expect(result).toBe("warning: something\n")
    await settle()
    expect(recorded).toEqual(["SubagentStop"])
  })
})
