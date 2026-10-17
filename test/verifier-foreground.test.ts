import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type CanUseTool,
  type HookInput,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { Effect } from "effect"
import fc from "fast-check"
import { workerEnv } from "../src/agent/env.ts"
import {
  activityHooks,
  foregroundVerifier,
  type Hooks,
  verifierAgent,
  verifierMatcher,
} from "../src/agent/hooks.ts"
import { live } from "./gates.ts"

const signal = { signal: new AbortController().signal }

/** A PreToolUse input for `tool` with `toolInput`. */
const preToolUse = (tool: string, toolInput: unknown): HookInput => ({
  hook_event_name: "PreToolUse",
  session_id: "s",
  transcript_path: "/t",
  cwd: "/w",
  tool_name: tool,
  tool_input: toolInput,
  tool_use_id: "toolu_1",
})

const verifierCall = {
  description: "Verify the ticket",
  prompt: "Check ticket tutti-abc.1",
  subagent_type: "verifier",
}

/** The verifier's matcher among the hooks activityHooks gives. */
const verifierHooks = async () => {
  const hooks: Hooks = await Effect.runPromise(
    activityHooks("t", { activity: () => Effect.void, compaction: () => Effect.void }),
  )
  return hooks.PreToolUse?.filter((matcher) => matcher.matcher !== undefined) ?? []
}

describe("the verifier's foreground hook", () => {
  test("is one PreToolUse callback with matcher Agent, after the activity one", async () => {
    const matchers = await verifierHooks()
    expect(matchers).toEqual([verifierMatcher])
    expect(verifierMatcher.matcher).toBe("Agent")
    expect(verifierMatcher.hooks).toHaveLength(1)
  })

  test("gives the verifier's Agent call run_in_background: false and keeps the rest", async () => {
    const [matcher] = await verifierHooks()
    const callback = matcher?.hooks[0]
    if (callback === undefined) throw new Error("no verifier hook")
    expect(await callback(preToolUse("Agent", verifierCall), "toolu_1", signal)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { ...verifierCall, run_in_background: false },
      },
    })
  })

  test("overrides a model's run_in_background: true", () => {
    expect(
      foregroundVerifier(preToolUse("Agent", { ...verifierCall, run_in_background: true })),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { ...verifierCall, run_in_background: false },
      },
    })
  })

  test("sets no permission decision", () => {
    const output = foregroundVerifier(preToolUse("Agent", verifierCall))
    expect(JSON.stringify(output)).not.toContain("permissionDecision")
    expect(output).not.toHaveProperty("decision")
  })

  test("gives {} for any other subagent, and for an Agent call that names none", () => {
    expect(
      foregroundVerifier(preToolUse("Agent", { ...verifierCall, subagent_type: "Explore" })),
    ).toEqual({})
    expect(
      foregroundVerifier(preToolUse("Agent", { ...verifierCall, subagent_type: "Verifier" })),
    ).toEqual({})
    expect(foregroundVerifier(preToolUse("Agent", { prompt: "go" }))).toEqual({})
  })

  test("gives {} for another event or input it can't read", () => {
    const postToolUse = {
      ...preToolUse("Agent", verifierCall),
      hook_event_name: "PostToolUse",
      tool_response: {},
    } as HookInput
    expect(foregroundVerifier(postToolUse)).toEqual({})
    expect(foregroundVerifier(preToolUse("Agent", null))).toEqual({})
    expect(foregroundVerifier(preToolUse("Agent", "verifier"))).toEqual({})
    expect(foregroundVerifier(preToolUse("Agent", [verifierCall]))).toEqual({})
  })

  test("never fails, even on input that throws when read", () => {
    const throwing = new Proxy(
      { subagent_type: verifierAgent },
      {
        ownKeys: () => {
          throw new Error("unreadable")
        },
      },
    )
    expect(foregroundVerifier(preToolUse("Agent", throwing))).toEqual({})
  })

  test("returns at once", async () => {
    const [matcher] = await verifierHooks()
    const callback = matcher?.hooks[0]
    if (callback === undefined) throw new Error("no verifier hook")
    const result = await Promise.race([
      callback(preToolUse("Agent", verifierCall), "toolu_1", signal),
      new Promise((resolve) => setTimeout(() => resolve("timed out"), 200)),
    ])
    expect(result).not.toBe("timed out")
  })

  test("any input gives updatedInput only for the verifier, and never throws", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("PreToolUse", "PostToolUse", "SubagentStart"),
        fc.oneof(
          fc.jsonValue(),
          fc.dictionary(fc.string(), fc.jsonValue()),
          fc.record({
            subagent_type: fc.oneof(fc.constant(verifierAgent), fc.string(), fc.jsonValue()),
            run_in_background: fc.jsonValue(),
          }),
        ),
        (event, toolInput) => {
          const input = { ...preToolUse("Agent", toolInput), hook_event_name: event } as HookInput
          const output = foregroundVerifier(input)
          const verifier =
            event === "PreToolUse" &&
            typeof toolInput === "object" &&
            toolInput !== null &&
            !Array.isArray(toolInput) &&
            (toolInput as { subagent_type?: unknown }).subagent_type === verifierAgent
          expect(output).toEqual(
            verifier
              ? {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    updatedInput: { ...toolInput, run_in_background: false },
                  },
                }
              : {},
          )
        },
      ),
    )
  })
})

live.describe("the verifier's foreground hook, against the real SDK", () => {
  // § 13: the Agent call's tool_result isn't async_launched and comes before the turn's one result
  // (docs/spikes/03-sdk-mcp-subagents.md, § 2, the hook-false variant).
  const verifierFile = [
    "---",
    "name: verifier",
    "description: Checks a finished change. Give it the ticket's ID.",
    "tools: Bash",
    "model: haiku",
    "---",
    "You are the verifier. Run exactly this Bash command: `sleep 5 && echo verified-live`. " +
      "Then reply with one line: VERIFIED followed by the command's output.",
    "",
  ].join("\n")

  /** A git repository with the verifier in .claude/agents. */
  const project = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-verifier-")))
    Bun.spawnSync(["git", "init", "-q", dir])
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true })
    writeFileSync(join(dir, ".claude", "agents", "verifier.md"), verifierFile)
    return dir
  }

  // Allows the verifier's call and its sleep, and nothing else that needs asking.
  const canUseTool: CanUseTool = async (tool, input) => {
    const command = typeof input.command === "string" ? input.command : ""
    if (tool === "Agent" || (tool === "Bash" && command.startsWith("sleep "))) {
      return { behavior: "allow", updatedInput: input }
    }
    return { behavior: "deny", message: "This test allows only the verifier and its sleep." }
  }

  test(
    "keeps the verifier's Agent call in the parent's turn",
    async () => {
      const repo = project()
      const hooks = await Effect.runPromise(
        activityHooks("t", { activity: () => Effect.void, compaction: () => Effect.void }),
      )
      let finish: () => void = () => {}
      const finished = new Promise<void>((resolve) => {
        finish = resolve
      })
      // The model isn't told to pass run_in_background: the hook sets it.
      const inbox = async function* (): AsyncGenerator<SDKUserMessage> {
        yield {
          type: "user",
          message: {
            role: "user",
            content:
              'Use the Agent tool once, with subagent_type "verifier" and the prompt ' +
              '"Check ticket live-1". When its answer is in front of you, reply with its ' +
              "VERIFIED line and stop.",
          },
          parent_tool_use_id: null,
        }
        await finished
      }
      const session = query({
        prompt: inbox(),
        options: {
          cwd: repo,
          projectConfigRoot: repo,
          settingSources: ["project", "local"],
          permissionMode: "default",
          model: "haiku",
          canUseTool,
          hooks,
          mcpServers: {},
          strictMcpConfig: true,
          persistSession: false,
          env: workerEnv({ subscription: false, billing: "subscription" }),
        },
      })
      const messages: Array<SDKMessage> = []
      let wait: ReturnType<typeof setTimeout> | undefined
      const reading = (async () => {
        for await (const message of session) {
          messages.push(message)
          // A second turn, after a background verifier's task_notification, would come by then.
          if (message.type === "result" && wait === undefined) {
            wait = setTimeout(() => finish(), 15_000)
          }
        }
      })()
      const hardStop = setTimeout(() => finish(), 150_000)
      await Promise.race([finished, reading])
      clearTimeout(wait)
      clearTimeout(hardStop)
      session.close()
      await reading.catch(() => {})

      const call = messages
        .flatMap((m) =>
          m.type === "assistant" && m.parent_tool_use_id === null ? m.message.content : [],
        )
        .find((block) => block.type === "tool_use" && block.name === "Agent")
      if (call?.type !== "tool_use") throw new Error("the model made no Agent call")
      const resultAt = messages.findIndex(
        (m) =>
          m.type === "user" &&
          Array.isArray(m.message.content) &&
          m.message.content.some(
            (block) =>
              typeof block === "object" &&
              block.type === "tool_result" &&
              block.tool_use_id === call.id,
          ),
      )
      expect(resultAt).toBeGreaterThanOrEqual(0)
      const toolResult = messages[resultAt]
      const status =
        toolResult?.type === "user"
          ? (toolResult.tool_use_result as { status?: unknown } | undefined)?.status
          : undefined
      expect(status).not.toBe("async_launched")
      const results = messages.flatMap((m, i) => (m.type === "result" ? [i] : []))
      expect(results).toHaveLength(1)
      expect(resultAt).toBeLessThan(results[0] ?? -1)
    },
    { timeout: 180_000 },
  )
})
