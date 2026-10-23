// A Claude Code process tutti spawns for the SDK, kept one way (src/agent/sessionProcess.ts): its
// stderr's end kept for the reason its session failed (tutti-7l57), its exit waited for once its
// session is closed, its group killed when the exit doesn't come in time or at once when asked.

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Options, SpawnOptions } from "@anthropic-ai/claude-agent-sdk"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer, Option, Stream } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { endedWhy, layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import { noServers } from "../src/agent/mcp.ts"
import { withSessionProcess, withStderr } from "../src/agent/sessionProcess.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import { processAlive } from "../src/services/processTree.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"

setDefaultTimeout(30_000)

/** A SessionProcess over sh running `script`, spawned as the SDK would, with what it got on stderr. */
const shell = (script: string) => {
  const received: Array<string> = []
  const { options, process } = withSessionProcess({
    stderr: (data: string) => received.push(data),
  } satisfies Options)
  const child = options.spawnClaudeCodeProcess?.({
    command: "/bin/sh",
    args: ["-c", script],
    cwd: "/",
    env: { PATH: testEnv.PATH },
    signal: new AbortController().signal,
  } satisfies SpawnOptions)
  return { process, child, received }
}

describe("withSessionProcess", () => {
  test("keeps the end of the stderr, still passing it on", async () => {
    const { process, received } = shell("echo one >&2; echo two >&2")
    await Effect.runPromise(process.exited)
    await Effect.runPromise(process.closeAndWait(() => {}, Duration.seconds(5)))
    expect(received.join("")).toBe("one\ntwo\n")
    expect(process.stderrTail()).toBe("one\ntwo")
    expect(process.stderrTail(4)).toBe("two")
  })

  test("closeAndWait closes the session and waits for its process to exit", async () => {
    const { process, child } = shell("cat > /dev/null; echo bye >&2")
    let closed = false
    await Effect.runPromise(
      process.closeAndWait(() => {
        closed = true
        child?.stdin.end()
      }, Duration.seconds(5)),
    )
    expect(closed).toBe(true)
    expect(child?.exitCode).toBe(0)
    expect(process.stderrTail()).toBe("bye")
  })

  test("closeAndWait kills a process that doesn't exit in time", async () => {
    const { process, child } = shell("trap '' TERM; while :; do sleep 1; done")
    const pid = process.child()?.pid as number
    await Effect.runPromise(process.closeAndWait(() => {}, Duration.millis(200)))
    await Effect.runPromise(process.exited)
    expect(child?.signalCode).toBe("SIGKILL")
    expect(processAlive(pid)).toBe(false)
  })

  test("kill ends it at once", async () => {
    const { process, child } = shell("while :; do sleep 1; done")
    await Effect.runPromise(process.kill)
    await Effect.runPromise(process.exited)
    expect(child?.signalCode).toBe("SIGKILL")
  })

  test("never spawned: closing only closes, and there is no stderr", async () => {
    const { process } = withSessionProcess({})
    let closed = false
    await Effect.runPromise(
      process.closeAndWait(() => {
        closed = true
      }, Duration.seconds(1)),
    )
    await Effect.runPromise(process.kill)
    expect(closed).toBe(true)
    expect(process.child()).toBeUndefined()
    expect(process.stderrTail()).toBe("")
  })
})

describe("withStderr", () => {
  test("adds the stderr on one line, when there is any", () => {
    expect(withStderr("exited with code 1", "")).toBe("exited with code 1")
    expect(withStderr("exited with code 1", "No conversation\n  found")).toBe(
      "exited with code 1: No conversation found",
    )
  })
})

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

describe("a worker whose Claude Code exits", () => {
  test("is Gone with what Claude Code last wrote to stderr", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tutti-session-process-"))
    const scenario = {
      turns: [[{ stderr: "Error: the transcript is missing\n" }, { exit: 1 }]],
      log: join(dir, "fake.jsonl"),
    }
    const config = appConfig({ claude: fake, settings: defaultSettings }, dir)
    const host = liveLayer({
      prompt: { text: "Work on TICKET_ID.", file: null },
      servers: noServers,
      account: { billing: { _tag: "Subscription", keyUnused: false }, subscription: true },
      env: { ...testEnv, FAKE_CLAUDE_SCENARIO: JSON.stringify(scenario) },
    })
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const agents = yield* AgentHost
        yield* agents.start("t-1", {
          sessionId: "11111111-1111-4111-8111-111111111111",
          cwd: dir,
        })
        yield* agents.send("t-1", "go", "clientComposed")
        const found = yield* agents.state("t-1").pipe(
          Stream.filter((each) => each._tag === "Gone"),
          Stream.runHead,
          Effect.timeout(Duration.seconds(10)),
        )
        return Option.getOrThrow(found)
      }).pipe(
        Effect.provide(
          host.pipe(
            Layer.provideMerge(Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer())),
            Layer.provideMerge(
              Layer.mergeAll(logLayer(), eventsLayer(), configLayer(config), BunServices.layer),
            ),
          ),
        ),
      ),
    )
    const why = (state as { why: string }).why
    expect(why.startsWith(endedWhy)).toBe(true)
    expect(why).toContain("Error: the transcript is missing")
  })
})
