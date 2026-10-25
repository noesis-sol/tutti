import { describe, expect, test } from "bun:test"
import type { HookInput } from "@anthropic-ai/claude-agent-sdk"
import { Effect } from "effect"
import fc from "fast-check"
import {
  activityHooks,
  foregroundVerifier,
  type Hooks,
  verifierAgent,
  verifierMatcher,
} from "../src/agent/hooks.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { openFibers } from "./fibers.ts"

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
    activityHooks(
      "t" as TicketId,
      { activity: () => Effect.void, compaction: () => Effect.void },
      openFibers(),
    ),
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
