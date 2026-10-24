import { describe, expect, test } from "bun:test"
import type { HookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect } from "effect"
import { activityEvents, activityHooks } from "../src/agent/hooks.ts"
import { type Doing, initial, step, WorkerEvent } from "../src/agent/WorkerState.ts"

// A call that fails (a check exiting non-zero) or is denied ends with PostToolUseFailure or
// PermissionDenied, not PostToolUse: the card goes back to working then too (§ 4.2).
const check = "scripts/check-fast.sh"
const init = WorkerEvent.Message({
  session: "s",
  message: { type: "system", subtype: "init", session_id: "s" } as unknown as SDKMessage,
})
const hook = (input: object): WorkerEvent =>
  WorkerEvent.Hook({ session: "s", input: input as unknown as HookInput })
const call = { tool_name: "Bash", tool_input: { command: check }, tool_use_id: "toolu_1" }
const preTool = hook({ hook_event_name: "PreToolUse", ...call })
const failed = hook({ hook_event_name: "PostToolUseFailure", ...call, error: "Exit code 1" })
const denied = hook({ hook_event_name: "PermissionDenied", ...call, reason: "classifier" })

const doing = (...events: ReadonlyArray<WorkerEvent>): Doing | null => {
  const state = [init, ...events].reduce((w, event, n) => step(w, event, n), initial([check])).state
  return state._tag === "Working" ? state.doing : null
}

describe("a failed or denied tool call", () => {
  test("a failing check is testing until it fails, then working", () => {
    expect(doing(preTool)).toBe("testing")
    expect(doing(preTool, failed)).toBe("working")
  })

  test("a denied call goes back to working", () => {
    expect(doing(preTool, denied)).toBe("working")
  })

  test("a subagent still running is subagent after its call fails", () => {
    const started = hook({ hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "x" })
    expect(doing(started, preTool, failed)).toBe("subagent")
  })

  test("the worker's hooks record both events", async () => {
    const recorded: Array<string> = []
    const hooks = await Effect.runPromise(
      activityHooks("t", {
        activity: (input) => Effect.sync(() => recorded.push(input.hook_event_name)),
        compaction: () => Effect.void,
      }),
    )
    expect(activityEvents).toContain("PostToolUseFailure")
    expect(activityEvents).toContain("PermissionDenied")
    const signal = { signal: new AbortController().signal }
    for (const event of ["PostToolUseFailure", "PermissionDenied"] as const) {
      const callback = hooks[event]?.[0]?.hooks[0]
      const input = { hook_event_name: event, ...call } as unknown as HookInput
      expect(await callback?.(input, "toolu_1", signal)).toEqual({})
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(recorded).toEqual(["PostToolUseFailure", "PermissionDenied"])
  })
})
