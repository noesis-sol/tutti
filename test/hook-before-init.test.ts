// A turn's first hook callback can be folded before the turn's system/init: hooks reach the host on
// the SDK's control channel, messages through its queue to the host's reader fiber (tutti-nrg.42).
import { describe, expect, test } from "bun:test"
import type { HookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { read } from "../src/agent/reading.ts"
import { initial, step, type Worker, WorkerEvent, WorkerState } from "../src/agent/WorkerState.ts"

const sdk = (message: object): WorkerEvent =>
  WorkerEvent.Message({ session: "s", reading: read(message as unknown as SDKMessage) })
const init = sdk({ type: "system", subtype: "init", permissionMode: "auto", session_id: "s" })
const running = sdk({ type: "system", subtype: "session_state_changed", state: "running" })
const idle = sdk({ type: "system", subtype: "session_state_changed", state: "idle" })
const result = sdk({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "DONE",
  num_turns: 1,
})
const hook = (input: object): WorkerEvent =>
  WorkerEvent.Hook({ session: "s", input: input as unknown as HookInput })
const preTool = (tool_name: string, tool_input: object = {}) =>
  hook({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "toolu_1" })
const postTool = (tool_name: string) =>
  hook({ hook_event_name: "PostToolUse", tool_name, tool_input: {}, tool_use_id: "toolu_1" })
const subagentStart = (agent_id: string) =>
  hook({ hook_event_name: "SubagentStart", agent_id, agent_type: "verifier" })

const check = "scripts/check-fast.sh"
const testing = preTool("Bash", { command: check })

/** The worker after `events`, the nth at time n. */
const fold = (events: ReadonlyArray<WorkerEvent>): Worker =>
  events.reduce((w, event, n) => step(w, event, n), initial([check]))
const stateAfter = (...events: ReadonlyArray<WorkerEvent>): WorkerState => fold(events).state

describe("a hook folded before its turn's system/init", () => {
  test("a PreToolUse before the first turn's init is that turn's tool", () => {
    expect(stateAfter(testing, running, init)).toEqual(WorkerState.Working({ doing: "testing" }))
    expect(stateAfter(running, testing, init)).toEqual(WorkerState.Working({ doing: "testing" }))
  })

  test("a PreToolUse before a later turn's init is that turn's tool", () => {
    const before = [init, preTool("Read"), postTool("Read"), result, idle]
    expect(stateAfter(...before, preTool("Edit"), running, init)).toEqual(
      WorkerState.Working({ doing: "editing" }),
    )
  })

  test("its PostToolUse goes back to working", () => {
    expect(stateAfter(testing, running, init, postTool("Bash"))).toEqual(
      WorkerState.Working({ doing: "working" }),
    )
  })

  test("a SubagentStart before init is that turn's subagent", () => {
    expect(stateAfter(subagentStart("a1"), running, init)).toEqual(
      WorkerState.Working({ doing: "subagent" }),
    )
  })

  test("the last turn's tool and subagents still go with its result", () => {
    const left = [init, preTool("Edit"), subagentStart("a1"), result, idle, running, init]
    expect(stateAfter(...left)).toEqual(WorkerState.Working({ doing: "working" }))
  })
})
