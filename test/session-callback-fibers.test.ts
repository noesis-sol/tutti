// The SDK's callbacks as fibers of their session's scope (src/agent/callbacks.ts): closing the
// session interrupts what they still run, and both MCP servers' handlers follow one rule.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { CanUseTool, HookInput } from "@anthropic-ai/claude-agent-sdk"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Duration, Effect, Exit, Layer, Option, Scope, Stream } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import { Attention } from "../src/agent/Attention.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { sessionFibers, toolAnswer, toolHandler } from "../src/agent/callbacks.ts"
import { activityHooks } from "../src/agent/hooks.ts"
import { noServersNote } from "../src/agent/mcp.ts"
import type { WorkerState } from "../src/agent/WorkerState.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"
import { workersIn } from "./workerEnv.ts"

// The live host's test starts the fake Claude Code as a process.
setDefaultTimeout(30_000)

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

/** Attention's test layer, every request left open, over test logs and events. */
const attention = attentionLayer(waitForTest).pipe(
  Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer())),
)

const sdkOptions = (): Parameters<CanUseTool>[2] => ({
  signal: new AbortController().signal,
  toolUseID: "toolu_1",
  requestId: "req",
})

/** Waits until `n` requests are open. */
const opened = (n: number) =>
  Effect.flatMap(Attention, (a) =>
    a.open.pipe(
      Stream.filter((all) => all.length === n),
      Stream.runHead,
    ),
  )

describe("a session's callbacks end with its scope", () => {
  test("a permission request still open is withdrawn, its call rejected", async () => {
    const { open, settled } = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const fibers = yield* Scope.provide(sessionFibers, scope)
        const canUseTool = yield* (yield* Attention).request("t-1", fibers)
        const call = canUseTool("Bash", { command: "rm -rf build" }, sdkOptions())
        yield* opened(1)
        yield* Scope.close(scope, Exit.void)
        const settled = yield* Effect.promise(() =>
          call.then(
            () => "answered",
            () => "rejected",
          ),
        )
        return { open: yield* (yield* Attention).current, settled }
      }).pipe(Effect.provide(attention)),
    )
    expect(settled).toBe("rejected")
    expect(open).toEqual([])
  })

  test("a hook's recording under way is interrupted", async () => {
    const interrupted = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const stopped = yield* Deferred.make<void>()
        const scope = yield* Scope.make()
        const fibers = yield* Scope.provide(sessionFibers, scope)
        const hooks = yield* activityHooks(
          "t-1",
          {
            activity: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
              ),
            compaction: () => Effect.void,
          },
          fibers,
        )
        const callback = hooks.PostToolUse?.[0]?.hooks[0]
        const input = { hook_event_name: "PostToolUse" } as unknown as HookInput
        yield* Effect.promise(async () =>
          callback?.(input, "toolu_1", { signal: new AbortController().signal }),
        )
        yield* Deferred.await(started)
        yield* Scope.close(scope, Exit.void)
        return yield* Deferred.await(stopped).pipe(
          Effect.timeout(Duration.seconds(5)),
          Effect.as(true),
        )
      }),
    )
    expect(interrupted).toBe(true)
  })
})

describe("the MCP servers' handler rule", () => {
  /** A handler in a scope of the test's own, with that scope. */
  const handler = Effect.gen(function* () {
    const scope = yield* Scope.make()
    const run = yield* toolHandler(yield* Scope.provide(sessionFibers, scope))
    return { run, scope }
  })

  test("answers with what the call's effect gives", async () => {
    const answer = await Effect.runPromise(
      Effect.flatMap(handler, ({ run }) =>
        Effect.promise(() => run(Effect.succeed(toolAnswer("done")), {})),
      ),
    )
    expect(answer).toEqual(toolAnswer("done"))
  })

  test("a failure or a defect is the call's refusal, saying what went wrong", async () => {
    const answers = await Effect.runPromise(
      Effect.flatMap(handler, ({ run }) =>
        Effect.promise(() =>
          Promise.all([run(Effect.fail("bd is gone"), {}), run(Effect.die(new Error("boom")), {})]),
        ),
      ),
    )
    for (const answer of answers) {
      expect(answer.isError).toBe(true)
      expect(answer.content[0]).toMatchObject({ type: "text" })
    }
    expect(JSON.stringify(answers[0])).toContain("bd is gone")
    expect(JSON.stringify(answers[1])).toContain("boom")
  })

  test("a call stops with its abort signal", async () => {
    const stopped = await Effect.runPromise(
      Effect.gen(function* () {
        const { run } = yield* handler
        const stopped = yield* Deferred.make<void>()
        const abort = new AbortController()
        const call = run(
          Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(stopped, undefined))),
          { signal: abort.signal },
        )
        call.catch(() => undefined)
        abort.abort()
        return yield* Deferred.await(stopped).pipe(
          Effect.timeout(Duration.seconds(5)),
          Effect.as(true),
        )
      }),
    )
    expect(stopped).toBe(true)
  })

  test("a call under way stops as its session's scope closes", async () => {
    const stopped = await Effect.runPromise(
      Effect.gen(function* () {
        const { run, scope } = yield* handler
        const stopped = yield* Deferred.make<void>()
        const call = run(
          Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(stopped, undefined))),
          {},
        )
        call.catch(() => undefined)
        yield* Effect.yieldNow
        yield* Scope.close(scope, Exit.void)
        return yield* Deferred.await(stopped).pipe(
          Effect.timeout(Duration.seconds(5)),
          Effect.as(true),
        )
      }),
    )
    expect(stopped).toBe(true)
  })
})

describe("the live host", () => {
  test("closing a session with an open request withdraws the request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tutti-callback-fibers-"))
    const scenario = {
      turns: [[{ permission: { tool_name: "Bash", input: { command: "rm -rf build" } } }]],
    }
    const host = liveLayer({
      prompt: { text: "Work on TICKET_ID.", file: null },
      servers: { servers: [], note: noServersNote },
      account: { billing: { _tag: "Subscription", keyUnused: false } },
    })
    const until = (matches: (state: WorkerState) => boolean) =>
      Effect.flatMap(AgentHost, (h) =>
        h
          .state("t-1")
          .pipe(
            Stream.filter(matches),
            Stream.runHead,
            Effect.timeout(Duration.seconds(10)),
            Effect.map(Option.getOrThrow),
          ),
      )
    const { before, after, answered } = await Effect.runPromise(
      Effect.gen(function* () {
        const agents = yield* AgentHost
        const attention = yield* Attention
        yield* agents.start("t-1", { sessionId: "11111111-1111-4111-8111-111111111111", cwd: dir })
        yield* agents.send("t-1", "go", "clientComposed")
        yield* until((s) => s._tag === "NeedsYou")
        const before = (yield* attention.current).map((r) => r.id)
        yield* agents.close("t-1")
        const after = yield* attention.current
        const answered = yield* Effect.exit(attention.answer("r1", { _tag: "Allow" }, "screen"))
        return { before, after, answered }
      }).pipe(
        Effect.provide(
          host.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                attentionLayer(waitForTest),
                transcriptsLayer(),
                ClaudeCode.layer.pipe(
                  Layer.provide(
                    workersIn({ ...testEnv, FAKE_CLAUDE_SCENARIO: JSON.stringify(scenario) }),
                  ),
                ),
              ),
            ),
            Layer.provideMerge(
              Layer.mergeAll(
                logLayer(),
                eventsLayer(),
                configLayer(appConfig({ claude: fake }, dir)),
                BunServices.layer,
              ),
            ),
          ),
        ),
      ),
    )
    expect(before).toEqual(["r1"])
    expect(after).toEqual([])
    expect(Exit.isFailure(answered)).toBe(true)
  })
})
