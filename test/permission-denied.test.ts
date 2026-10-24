// Calls Claude Code denies without asking (§ 4.5): each `permission_denied` is a DENIED log line, a
// `denied` event, a per-ticket tally by what denied it, and the card's latest action for 10
// seconds. The scripted sessions (src/testing/AgentHost.ts) and the fake Claude Code
// (test/fixtures/fake-claude/claude.ts) under the live host, with the messages the spike recorded
// (docs/spikes/01-sdk-session.md, item 4).
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { SDKPermissionDeniedMessage } from "@anthropic-ai/claude-agent-sdk"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Duration, Effect, Fiber, Layer, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import fc from "fast-check"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import { Attention, emptyTally } from "../src/agent/Attention.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { noServersNote } from "../src/agent/mcp.ts"
import { deniedShownFor, Transcripts } from "../src/agent/Transcripts.ts"
import type { WorkerState } from "../src/agent/WorkerState.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import type { Denied, EventRecord } from "../src/run/events.ts"
import type { EventStream } from "../src/run/eventstream.ts"
import { Log } from "../src/run/log.ts"
import {
  assistantText,
  deniedTool,
  heldRemovalMessage,
  layer as hostLayer,
  Recording,
  type Script,
  turn,
} from "../src/testing/AgentHost.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { Captured, layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"
import { workersIn } from "./workerEnv.ts"

/** The safety check's reason for a held removal, as the spike saw it. */
const heldReason =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the reason quotes a shell expansion.
  'Dangerous rm operation on possibly-empty variable path: $T/* in `rm -rf $T/*` (rewrite it as "${T:?}"/* or use a literal path)'

type Env = AgentHost | Recording | Attention | Transcripts | Log | EventStream | Captured

/** Runs `effect` with the scripted host playing `scripts`, under TestClock. */
const run = <A, E>(scripts: Readonly<Record<string, Script>>, effect: Effect.Effect<A, E, Env>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        hostLayer(scripts).pipe(
          Layer.provideMerge(Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer())),
          Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer())),
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    ),
  )

/** Starts the ticket's worker, sends it its first message, and gives the states it had until Idle. */
const playToIdle = (ticket: string) =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    yield* host.start(ticket, { sessionId: "s-1", cwd: `/work/${ticket}` })
    const listening = yield* Deferred.make<void>()
    const states = yield* host.state(ticket).pipe(
      Stream.tap(() => Deferred.succeed(listening, undefined)),
      Stream.takeUntil((s: WorkerState) => s._tag === "Idle"),
      Stream.runCollect,
      Effect.forkChild,
    )
    yield* Deferred.await(listening)
    yield* host.send(ticket, `Your ticket is ${ticket}.`, "clientComposed")
    return yield* Fiber.join(states)
  })

/** The `denied` events captured so far. */
const deniedEvents = Effect.map(
  Effect.flatMap(Captured, (captured) => captured.records),
  (records) => records.filter((r): r is EventRecord & typeof Denied.Type => r.kind === "denied"),
)

/** The DENIED lines logged so far. */
const deniedLines = Effect.map(texts, (all) => all.filter((each) => each.includes("DENIED")))

describe("a held removal in auto mode", () => {
  test("is denied by the safety check without asking: logged, recorded, tallied and shown", async () => {
    const script = turn([
      assistantText("Clearing the build folder."),
      ...deniedTool(
        "Bash",
        { command: "rm -rf $T/*" },
        { by: "safetyCheck", reason: heldReason, message: heldRemovalMessage },
      ),
    ])
    const seen = await run(
      { "t-1": [script] },
      Effect.gen(function* () {
        const states = yield* playToIdle("t-1")
        const transcripts = yield* Transcripts
        const shown = yield* transcripts.latestAction("t-1")
        yield* TestClock.adjust(Duration.millis(deniedShownFor - 1))
        const stillShown = yield* transcripts.latestAction("t-1")
        yield* TestClock.adjust(Duration.millis(1))
        const after = yield* transcripts.latestAction("t-1")
        const attention = yield* Attention
        return {
          states,
          shown,
          stillShown,
          after,
          lines: yield* deniedLines,
          events: yield* deniedEvents,
          tally: yield* attention.tally("t-1"),
          open: yield* attention.current,
          sent: yield* (yield* Recording).all,
        }
      }),
    )
    expect(seen.lines).toEqual([
      `  DENIED: t-1's worker: Bash(rm -rf $T/*), by the safety check: ${heldReason}`,
    ])
    expect(seen.events).toHaveLength(1)
    expect(seen.events[0]).toMatchObject({
      kind: "denied",
      ticket: "t-1",
      tool: "Bash",
      reason_type: "safetyCheck",
      reason: heldReason,
    })
    expect(seen.tally).toEqual({ ...emptyTally, deniedBy: { safetyCheck: 1 } })
    // Nothing to answer: no request opened, no canUseTool answered, never NeedsYou.
    expect(seen.open).toEqual([])
    expect(seen.sent.some((s) => s._tag === "Answered")).toBe(false)
    expect(seen.states.some((s) => s._tag === "NeedsYou")).toBe(false)
    expect(seen.shown).toBe("Bash(rm -rf $T/*) denied by the safety check")
    expect(seen.stillShown).toBe(seen.shown)
    expect(seen.after).toBe("Clearing the build folder.")
  })
})

describe("denials of each type", () => {
  test("the classifier, the mode, a rule, a type tutti doesn't know and none: each named", async () => {
    const script = turn([
      ...deniedTool(
        "Bash",
        { command: 'rm -rf "$T"' },
        { by: "classifier", reason: "[Unverifiable Deletion Target]" },
      ),
      ...deniedTool("Write", { file_path: "/etc/hosts" }, { by: "mode", reason: "dontAsk" }),
      ...deniedTool("WebFetch", { url: "https://example.com" }, { by: "rule" }),
      ...deniedTool("Bash", { command: "ls" }, { by: "asyncAgent", reason: "headless" }),
      ...deniedTool("Bash", { command: "pwd" }, { by: undefined, reason: "no type" }),
      ...deniedTool("Bash", { command: "rm -rf build" }, { by: "classifier", agentId: "a-1" }),
    ])
    const seen = await run(
      { "t-2": [script] },
      Effect.gen(function* () {
        yield* playToIdle("t-2")
        return {
          lines: yield* deniedLines,
          events: yield* deniedEvents,
          tally: yield* (yield* Attention).tally("t-2"),
          shown: yield* (yield* Transcripts).latestAction("t-2"),
        }
      }),
    )
    expect(seen.lines).toEqual([
      '  DENIED: t-2\'s worker: Bash(rm -rf "$T"), by the classifier: [Unverifiable Deletion Target]',
      "  DENIED: t-2's worker: Write(/etc/hosts), by the permission mode: dontAsk",
      // Without a decision_reason, the reason is the message the worker was told.
      "  DENIED: t-2's worker: WebFetch(https://example.com), by a rule: Permission to use WebFetch has been denied.",
      "  DENIED: t-2's worker: Bash(ls), by asyncAgent: headless",
      "  DENIED: t-2's worker: Bash(pwd), by Claude Code: no type",
      "  DENIED: t-2's worker: Bash(rm -rf build), by the classifier: Permission to use Bash has been denied.",
    ])
    expect(seen.events.map((e) => [e.tool, e.reason_type])).toEqual([
      ["Bash", "classifier"],
      ["Write", "mode"],
      ["WebFetch", "rule"],
      ["Bash", "asyncAgent"],
      ["Bash", "unknown"],
      ["Bash", "classifier"],
    ])
    expect(seen.tally.deniedBy).toEqual({
      classifier: 2,
      mode: 1,
      rule: 1,
      asyncAgent: 1,
      unknown: 1,
    })
    expect(seen.tally.denied).toBe(0)
    expect(seen.shown).toBe("Bash(rm -rf build) denied by the classifier")
  })
})

/** A `permission_denied` as the SDK types it. */
const denial = (fields: Partial<SDKPermissionDeniedMessage>): SDKPermissionDeniedMessage => ({
  type: "system",
  subtype: "permission_denied",
  tool_name: "Bash",
  tool_use_id: "toolu_1",
  message: "Permission to use Bash has been denied.",
  uuid: "00000000-0000-4000-8000-000000000001",
  session_id: "s-1",
  ...fields,
})

/** Runs `effect` with Attention over a captured Log and EventStream. */
const withAttention = <A>(effect: Effect.Effect<A, never, Attention | Log | Captured>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        attentionLayer(waitForTest).pipe(
          Layer.provideMerge(Layer.mergeAll(logLayer(), eventsLayer())),
        ),
      ),
    ),
  )

describe("Attention.denial", () => {
  test("a call whose input never came is named by its tool alone", async () => {
    const lines = await withAttention(
      Effect.gen(function* () {
        yield* (yield* Attention).denial("t-3", denial({ decision_reason_type: "classifier" }))
        return yield* deniedLines
      }),
    )
    expect(lines).toEqual([
      "  DENIED: t-3's worker: Bash, by the classifier: Permission to use Bash has been denied.",
    ])
  })

  test("tallies a type named like an Object property as any other", async () => {
    const tally = await withAttention(
      Effect.gen(function* () {
        const attention = yield* Attention
        for (const by of ["__proto__", "constructor", "toString", "constructor"]) {
          yield* attention.denial("t-3", denial({ decision_reason_type: by }))
        }
        return yield* attention.tally("t-3")
      }),
    )
    expect(Object.entries(tally.deniedBy)).toEqual([
      ["__proto__", 1],
      ["constructor", 2],
      ["toString", 1],
    ])
  })

  test("whatever the SDK's text, one sanitised line, a valid event and a count", async () => {
    const text = fc.string({ unit: "binary" })
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          tool: text,
          by: fc.option(fc.oneof(text, fc.constantFrom("classifier", "safetyCheck", "__proto__"))),
          reason: fc.option(text),
          message: text,
          command: text,
        }),
        async ({ tool, by, reason, message, command }) => {
          const seen = await withAttention(
            Effect.gen(function* () {
              const attention = yield* Attention
              yield* attention.denial(
                "t-4",
                denial({
                  tool_name: tool,
                  message,
                  ...(by === null ? {} : { decision_reason_type: by }),
                  ...(reason === null ? {} : { decision_reason: reason }),
                }),
                { command },
              )
              return {
                lines: yield* (yield* Log).lines,
                events: yield* deniedEvents,
                tally: yield* attention.tally("t-4"),
              }
            }),
          )
          expect(seen.lines).toHaveLength(1)
          // biome-ignore lint/suspicious/noControlCharactersInRegex: the property is their absence.
          expect(seen.lines[0]?.text).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
          expect(seen.events).toHaveLength(1)
          expect(Object.values(seen.tally.deniedBy)).toEqual([1])
        },
      ),
      { numRuns: 100 },
    )
  })
})

describe("the live host", () => {
  test("a permission_denied from Claude Code reaches the log, the events and the tally", async () => {
    const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")
    const dir = mkdtempSync(join(tmpdir(), "tutti-denied-"))
    const id = "toolu_live1"
    const scenario = {
      log: join(dir, "fake.jsonl"),
      turns: [
        [
          {
            message: {
              type: "assistant",
              message: {
                role: "assistant",
                content: [
                  { type: "tool_use", id, name: "Bash", input: { command: "rm -rf $T/*" } },
                ],
              },
              parent_tool_use_id: null,
            },
          },
          {
            message: {
              type: "system",
              subtype: "permission_denied",
              tool_name: "Bash",
              tool_use_id: id,
              decision_reason_type: "safetyCheck",
              decision_reason: heldReason,
              message: heldRemovalMessage,
              uuid: "00000000-0000-4000-8000-0000000000d1",
            },
          },
        ],
      ],
    }
    const host = liveLayer({
      prompt: { text: "Work on TICKET_ID.", file: null },
      servers: { servers: [], note: noServersNote },
      account: { billing: { _tag: "Subscription", keyUnused: false } },
    })
    const config = appConfig({ claude: fake, settings: defaultSettings }, dir)
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const agents = yield* AgentHost
        yield* agents.start("t-5", { sessionId: "11111111-1111-4111-8111-111111111111", cwd: dir })
        yield* agents.send("t-5", "Work on t-5.", "clientComposed")
        const idle = yield* agents.state("t-5").pipe(
          Stream.filter((s) => s._tag === "Idle"),
          Stream.runHead,
          Effect.timeout(Duration.seconds(10)),
        )
        return {
          idle: Option.isSome(idle),
          lines: yield* deniedLines,
          events: yield* deniedEvents,
          tally: yield* (yield* Attention).tally("t-5"),
        }
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
              Layer.mergeAll(logLayer(), eventsLayer(), configLayer(config), BunServices.layer),
            ),
          ),
        ),
      ),
    )
    expect(seen.idle).toBe(true)
    expect(seen.lines).toEqual([
      `  DENIED: t-5's worker: Bash(rm -rf $T/*), by the safety check: ${heldReason}`,
    ])
    expect(seen.events.map((e) => e.reason_type)).toEqual(["safetyCheck"])
    expect(seen.tally.deniedBy).toEqual({ safetyCheck: 1 })
  })
})
