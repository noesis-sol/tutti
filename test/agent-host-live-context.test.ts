// The live host asks each session how full its context window is once a turn has finished
// (getContextUsage, § 7.5's resource line), against the fake Claude Code
// (test/fixtures/fake-claude/claude.ts), which answers the control request as its scenario says.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer, Option, Stream } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { noServers } from "../src/agent/mcp.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { allowAll, layer as attentionLayer } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"
import { workersIn } from "./workerEnv.ts"

// Each test starts the fake Claude Code as a process: bun's 5 s default fails it on a loaded machine.
setDefaultTimeout(30_000)

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

/** Runs `effect` against the live host over the fake playing `scenario`. */
const run = <A, E>(scenario: object, effect: (dir: string) => Effect.Effect<A, E, AgentHost>) => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-host-context-"))
  const config = appConfig({ claude: fake, settings: defaultSettings }, dir)
  const host = liveLayer({
    prompt: { text: "Work on TICKET_ID.", file: null },
    servers: noServers,
    account: { billing: { _tag: "Subscription", keyUnused: false } },
  })
  return Effect.runPromise(
    Effect.scoped(effect(dir)).pipe(
      Effect.provide(
        host.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              attentionLayer(allowAll),
              transcriptsLayer(),
              ClaudeCode.layer.pipe(
                Layer.provide(
                  workersIn({
                    ...testEnv,
                    FAKE_CLAUDE_SCENARIO: JSON.stringify({
                      ...scenario,
                      log: join(dir, "fake.jsonl"),
                    }),
                  }),
                ),
              ),
            ),
          ),
          Layer.provideMerge(
            Layer.mergeAll(logLayer(), eventsLayer(), configLayer(config), BunServices.layer),
          ),
        ),
      ),
    ),
  )
}

/** The worker's context once the host has one for it, waiting at most 10 s; none after that. */
const measured = (ticket: string) =>
  Effect.flatMap(AgentHost, (host) =>
    host.contexts.pipe(
      Stream.filter((all) => all.has(ticket)),
      Stream.runHead,
      Effect.map(Option.flatMap((all) => Option.fromNullishOr(all.get(ticket)))),
      Effect.timeoutOrElse({
        duration: Duration.seconds(10),
        orElse: () => Effect.succeed(Option.none()),
      }),
    ),
  )

describe("AgentHost live: the context window", () => {
  test("is asked of the session after its turn's result, and read", async () => {
    const context = await run(
      {
        turns: [[]],
        contextUsage: {
          categories: [
            { name: "Messages", tokens: 90_000, color: "x", kind: "used" },
            { name: "Free space", tokens: 74_000, color: "x", kind: "free" },
          ],
          totalTokens: 126_000,
          maxTokens: 200_000,
          percentage: 63,
        },
      },
      (dir) =>
        Effect.gen(function* () {
          const host = yield* AgentHost
          yield* host.start("t-1", {
            sessionId: "11111111-1111-4111-8111-111111111111",
            cwd: dir,
          })
          yield* host.send("t-1", { text: "go", from: "clientComposed" })
          return yield* measured("t-1")
        }),
    )
    expect(Option.getOrUndefined(context)).toEqual({
      tokens: 126_000,
      window: 200_000,
      percentage: 63,
      split: [{ name: "Messages", tokens: 90_000 }],
    })
  })

  test("an answer it can't read leaves the worker without one", async () => {
    const context = await run({ turns: [[]] }, (dir) =>
      Effect.gen(function* () {
        const host = yield* AgentHost
        yield* host.start("t-1", { sessionId: "11111111-1111-4111-8111-111111111111", cwd: dir })
        yield* host.send("t-1", { text: "go", from: "clientComposed" })
        yield* host.state("t-1").pipe(
          Stream.filter((state) => state._tag === "Idle"),
          Stream.runHead,
        )
        // The control request goes beside the reader: give it time to come back.
        yield* Effect.sleep(Duration.millis(300))
        return yield* host.contexts.pipe(Stream.runHead)
      }),
    )
    expect(Option.getOrUndefined(context)?.has("t-1")).toBe(false)
  })
})
