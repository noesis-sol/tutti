import { expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type CanUseTool,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { workerEnv } from "../src/agent/env.ts"
import { initial, step, type Worker, WorkerEvent } from "../src/agent/WorkerState.ts"
import { live } from "./gates.ts"

// § 13's contract test: idle comes with a background task live, and when the task ends the CLI
// starts a turn by itself to report it, after the live set empties (docs/spikes/01-sdk-session.md,
// item 4). WorkerState, folding the session's messages, stays Working until that turn's idle.

/** A message's `system` subtype, or "" for another message. */
const subtype = (message: SDKMessage): string =>
  message.type === "system" ? (message as { readonly subtype: string }).subtype : ""

const isIdle = (message: SDKMessage): boolean =>
  subtype(message) === "session_state_changed" &&
  (message as { readonly state: string }).state === "idle"

const isRunning = (message: SDKMessage): boolean =>
  subtype(message) === "session_state_changed" &&
  (message as { readonly state: string }).state === "running"

/** The live tasks a `background_tasks_changed` lists, or null for another message. */
const liveTasks = (message: SDKMessage): ReadonlyArray<unknown> | null =>
  subtype(message) === "background_tasks_changed"
    ? (message as { readonly tasks: ReadonlyArray<unknown> }).tasks
    : null

live.describe("a background task after idle, against the real SDK", () => {
  // Allows the background sleep and the reads of its output, and nothing else that needs asking.
  const canUseTool: CanUseTool = async (tool, input) => {
    const command = typeof input.command === "string" ? input.command : ""
    if ((tool === "Bash" && command.startsWith("sleep ")) || tool === "Read") {
      return { behavior: "allow", updatedInput: input }
    }
    return { behavior: "deny", message: "This test allows only the sleep and reading its output." }
  }

  test(
    "idle comes with the task live, and the CLI's own turn reports it after the set empties",
    async () => {
      const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-background-")))
      Bun.spawnSync(["git", "init", "-q", repo])
      let finish: () => void = () => {}
      const finished = new Promise<void>((resolve) => {
        finish = resolve
      })
      const inbox = async function* (): AsyncGenerator<SDKUserMessage> {
        yield {
          type: "user",
          message: {
            role: "user",
            content:
              "Run the Bash command `sleep 8` with run_in_background set to true. Don't wait " +
              "for it: as soon as it has started, reply with one word, STARTED, and stop. When " +
              "it has finished, reply with one word, FINISHED.",
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
          mcpServers: {},
          strictMcpConfig: true,
          persistSession: false,
          env: workerEnv({ subscription: false, billing: "subscription" }),
        },
      })
      const messages: Array<SDKMessage> = []
      // The worker's state after each message, folded as AgentHost folds it.
      const states: Array<Worker> = []
      let worker = initial()
      const reading = (async () => {
        for await (const message of session) {
          messages.push(message)
          worker = step(worker, WorkerEvent.Message({ message }), Date.now())
          states.push(worker)
          if (messages.filter(isIdle).length === 2) finish()
        }
      })()
      const hardStop = setTimeout(() => finish(), 150_000)
      await Promise.race([finished, reading])
      clearTimeout(hardStop)
      session.close()
      await reading.catch(() => {})

      // The first idle comes with the task still listed, and the worker is Working.
      const firstIdle = messages.findIndex(isIdle)
      expect(firstIdle).toBeGreaterThanOrEqual(0)
      const listed = messages
        .slice(0, firstIdle)
        .map(liveTasks)
        .filter((tasks) => tasks !== null)
        .at(-1)
      expect(listed?.length ?? 0).toBeGreaterThan(0)
      expect(states[firstIdle]?.state._tag).toBe("Working")

      // Then the set empties, and running follows with no send between: the CLI's own turn.
      const emptied = messages.findIndex(
        (message, i) => i > firstIdle && liveTasks(message)?.length === 0,
      )
      expect(emptied).toBeGreaterThan(firstIdle)
      const next = messages.findIndex((message, i) => i > emptied && isRunning(message))
      expect(next).toBeGreaterThan(emptied)
      expect(messages.slice(emptied + 1, next).filter((m) => m.type === "user")).toEqual([])

      // In the moment between the emptied set and running, the report is still to come.
      for (const between of states.slice(emptied, next + 1)) {
        expect(between.state._tag).toBe("Working")
      }
      // The turn's idle settles the worker.
      const secondIdle = messages.findIndex((message, i) => i > next && isIdle(message))
      expect(secondIdle).toBeGreaterThan(next)
      const turn = messages.slice(next, secondIdle)
      expect(turn.some((message) => subtype(message) === "init")).toBe(true)
      expect(turn.some((message) => message.type === "result")).toBe(true)
      expect(states[secondIdle]?.state._tag).toBe("Idle")
    },
    { timeout: 180_000 },
  )
})
