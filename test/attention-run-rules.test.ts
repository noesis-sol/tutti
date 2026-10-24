import { describe, expect, test } from "bun:test"
import type { CanUseTool, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  Attention,
  type AttentionRequest,
  allowsForRun,
  fits,
  runRules,
} from "../src/agent/Attention.ts"
import { layer as attentionLayer } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { openFibers } from "./fibers.ts"

// Allow for this run passes only the addRules suggestions that allow (§ 4.5): in the session spike
// a Write suggested only setMode acceptEdits, and passing setMode back switched the session to
// acceptEdits. A request without such a rule has no Allow for this run.

/** Asks canUseTool for `tool` with the SDK's `suggestions`, and gives the request it opens. */
const requestFor = (
  tool: string,
  input: Record<string, unknown>,
  suggestions: ReadonlyArray<PermissionUpdate>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const attention = yield* Attention
      const canUseTool = yield* attention.request("tut-1", openFibers())
      const controller = new AbortController()
      const sdk = {
        signal: controller.signal,
        toolUseID: "toolu_1",
        requestId: "req",
        suggestions: [...suggestions],
      } as Parameters<CanUseTool>[2]
      canUseTool(tool, input, sdk)
      const seen = yield* attention.open.pipe(
        Stream.filter((all) => all.length > 0),
        Stream.runHead,
      )
      controller.abort()
      return (seen._tag === "Some" ? seen.value[0] : undefined) as AttentionRequest
    }).pipe(
      Effect.provide(
        attentionLayer().pipe(
          Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer())),
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

const setMode: PermissionUpdate = { type: "setMode", mode: "acceptEdits", destination: "session" }
const addDirectories: PermissionUpdate = {
  type: "addDirectories",
  directories: ["/work"],
  destination: "session",
}
const write = { file_path: "/work/notes.txt", content: "x" }

describe("Attention: Allow for this run needs an addRules suggestion", () => {
  test("a Write suggesting only setMode has no Allow for this run", async () => {
    const request = await requestFor("Write", write, [setMode])
    expect(runRules(request)).toEqual([])
    expect(allowsForRun(request)).toBe(false)
    expect(fits(request, { _tag: "AllowForRun" })).toBe(false)
    expect(fits(request, { _tag: "Allow" })).toBe(true)
  })

  test("setMode and addDirectories alone offer none", async () => {
    const request = await requestFor("Bash", { command: "touch a" }, [addDirectories, setMode])
    expect(allowsForRun(request)).toBe(false)
  })

  test("an addRules suggestion that denies or asks offers none", async () => {
    const request = await requestFor("Bash", { command: "touch a" }, [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "touch a" }],
        behavior: "ask",
        destination: "localSettings",
      },
      setMode,
    ])
    expect(allowsForRun(request)).toBe(false)
  })

  test("beside an allow rule, only the rule is passed, in session", async () => {
    const request = await requestFor("Bash", { command: "touch a" }, [
      setMode,
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "touch a" }],
        behavior: "allow",
        destination: "localSettings",
      },
      addDirectories,
    ])
    expect(allowsForRun(request)).toBe(true)
    expect(runRules(request)).toEqual([
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "touch a" }],
        behavior: "allow",
        destination: "session",
      },
    ])
  })
})
