import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer, Schema, Stream } from "effect"
import { type AiError, LanguageModel, Prompt } from "effect/ai"
import fc from "fast-check"
import {
  layer,
  OrganCall,
  type OrganCallConfig,
  organOptions,
  subtypeOf,
  toTurn,
} from "../src/organs/AgentSdkLanguageModel.ts"
import { costLine, OrganCost } from "../src/organs/OrganCost.ts"
import type { Log } from "../src/run/log.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { texts } from "../src/testing/Log.ts"
import { layer as costLayer } from "../src/testing/OrganCost.ts"

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

/** What the fake logged at its start: its arguments, PID, folder and the variables asked for. */
interface Started {
  readonly args: ReadonlyArray<string>
  readonly pid: number
  readonly cwd: string
  readonly env: Record<string, string | null>
}

interface Logged {
  readonly started: ReadonlyArray<Started>
  readonly stdin: ReadonlyArray<Record<string, unknown>>
}

const readLog = (file: string): Logged => {
  const entries = existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l))
    : []
  return {
    started: entries.filter((e) => e.args !== undefined),
    stdin: entries.flatMap((e) => (e.stdin === undefined ? [] : [e.stdin])),
  }
}

/** A turn of the fake: its steps (test/fixtures/fake-claude/claude.ts). */
type Steps = ReadonlyArray<object>

/**
 * Runs `effect` with the provider over the fake, whose sessions (one per call) each play `steps`,
 * with a subscription login and an API key in tutti's environment. It gives the effect's exit and
 * what the fake logged.
 */
const run = async <A, E>(
  steps: Steps,
  effect: Effect.Effect<A, E, LanguageModel.LanguageModel | OrganCost | Log>,
) => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-organ-test-"))
  const log = join(dir, "fake.jsonl")
  const scenario = {
    turns: [steps],
    eofAfterTurn: true,
    log,
    env: ["ANTHROPIC_API_KEY", "CLAUDE_AGENT_SDK_CLIENT_APP"],
  }
  const exit = await Effect.runPromiseExit(
    effect.pipe(
      Effect.provide(
        layer({
          account: { subscription: true },
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: "sk-ant-test",
            FAKE_CLAUDE_SCENARIO: JSON.stringify(scenario),
          },
        }).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              costLayer(),
              configLayer(appConfig({ claude: fake }, dir)),
              BunServices.layer,
            ),
          ),
        ),
      ),
    ),
  )
  return { exit, logged: readLog(log) }
}

const value = <A, E>(exit: import("effect").Exit.Exit<A, E>): A => {
  if (exit._tag === "Failure") throw new Error(`failed: ${String(exit.cause)}`)
  return exit.value
}

/** The schema of the M0 spike: a literal union, a nested struct, an array, an optional field. */
const Verdict = Schema.Struct({
  verdict: Schema.Literals(["merge", "hold", "hand-back"]),
  ticket: Schema.Struct({ id: Schema.String, title: Schema.String }),
  reasons: Schema.Array(
    Schema.Struct({ file: Schema.String, line: Schema.Int, note: Schema.String }),
  ),
  follow_up: Schema.optional(Schema.String),
})

const prompt: Prompt.RawInput = [
  { role: "system", content: "You are the triage organ." },
  { role: "user", content: "What became of tut-1?" },
]

const triage: OrganCallConfig = { organ: "triage", model: "haiku", effort: "low" }

/** generateObject with Verdict, as the triage organ. */
const verdict = LanguageModel.generateObject({ prompt, schema: Verdict }).pipe(
  Effect.provideService(OrganCall, triage),
)

const structured = {
  verdict: "hand-back",
  ticket: { id: "tut-1", title: "A ticket" },
  reasons: [{ file: "src/a.ts", line: 12, note: "fails" }],
  follow_up: null,
}

/** A structured-output result, as Claude Code ends one: on the StructuredOutput tool call. */
const answer = {
  structured_output: structured,
  result: JSON.stringify(structured),
  stop_reason: "tool_use",
  terminal_reason: "completed",
  num_turns: 2,
  total_cost_usd: 0.0123,
  duration_ms: 4200,
}

const answered: Steps = [{ result: answer }]

/** The run's organ cost total so far. */
const total = Effect.flatMap(OrganCost, (costs) => costs.total)

/** The AiError a failed exit holds. */
const aiError = <A>(exit: import("effect").Exit.Exit<A, unknown>): AiError.AiError => {
  if (exit._tag === "Success") throw new Error("succeeded")
  const error = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (error === undefined || error._tag !== "Fail") throw new Error(String(exit.cause))
  return error.error as AiError.AiError
}

describe("AgentSdkLanguageModel", () => {
  test("generateObject returns the structured output, decoded", async () => {
    const { exit } = await run(answered, verdict)
    const response = value(exit)
    expect(response.value).toEqual({
      verdict: "hand-back",
      ticket: { id: "tut-1", title: "A ticket" },
      reasons: [{ file: "src/a.ts", line: 12, note: "fails" }],
    })
    expect(response.finishReason).toBe("stop")
  })

  test("the session is isolated, in a temp folder removed after the call", async () => {
    const { exit, logged } = await run(answered, verdict)
    value(exit)
    const [started] = logged.started
    if (started === undefined) throw new Error("the fake didn't start")
    expect(started.args).toContain("--tools=")
    expect(started.args).toContain("--setting-sources=")
    expect(started.args).toContain("--strict-mcp-config")
    expect(started.args).toContain("--permission-prompts=none")
    expect(started.args).toContain("--no-session-persistence")
    expect(started.args.some((a) => a.startsWith("--mcp-config"))).toBe(false)
    expect(started.args.join(" ")).toContain("--model=haiku")
    expect(started.args.join(" ")).toContain("--effort=low")
    expect(started.cwd).toContain("tutti-organ-")
    expect(existsSync(started.cwd)).toBe(false)
    // A worker's environment: the key goes with a subscription login.
    expect(started.env.ANTHROPIC_API_KEY).toBeNull()
    expect(started.env.CLAUDE_AGENT_SDK_CLIENT_APP).toStartWith("tutti/")
    // The system prompt as a plain string, the AnthropicStructuredOutput JSON Schema, and the
    // user's text as the one user message.
    const initialize = logged.stdin.find((m) => m.type === "control_request")?.request as Record<
      string,
      unknown
    >
    expect(initialize.systemPrompt).toEqual(["You are the triage organ."])
    expect(initialize.jsonSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["verdict", "ticket", "reasons", "follow_up"],
      properties: { verdict: { type: "string", enum: ["merge", "hold", "hand-back"] } },
    })
    const users = logged.stdin.filter((m) => m.type === "user")
    expect(users).toEqual([
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "What became of tut-1?" }] },
        parent_tool_use_id: null,
      },
    ])
  })

  test("the options name every isolation setting", () => {
    const abortController = new AbortController()
    const options = organOptions({
      turn: { systemPrompt: "S", userText: ["U"] },
      jsonSchema: { type: "object" },
      call: { organ: "plan" },
      cwd: "/tmp/x",
      env: { A: "1" },
      claude: null,
      abortController,
      partial: false,
      stderr: () => {},
    })
    expect(options).toMatchObject({
      systemPrompt: "S",
      tools: [],
      strictMcpConfig: true,
      settingSources: [],
      permissionPrompts: "none",
      persistSession: false,
      cwd: "/tmp/x",
      env: { A: "1" },
      outputFormat: { type: "json_schema", schema: { type: "object" } },
    })
    expect(options.abortController).toBe(abortController)
    expect(options.mcpServers).toBeUndefined()
    expect(options.model).toBeUndefined()
    expect(options.pathToClaudeCodeExecutable).toBeUndefined()
  })

  test("a text answer is the result's text", async () => {
    const { exit } = await run(
      [{ text: "Plain words." }],
      LanguageModel.generateText({ prompt: "Say something." }),
    )
    expect(value(exit).text).toBe("Plain words.")
  })

  test("streamText gives the text deltas, then the finish", async () => {
    const delta = (text: string) => ({
      message: {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
        parent_tool_use_id: null,
        uuid: crypto.randomUUID(),
      },
    })
    const { exit } = await run(
      [delta("Hel"), delta("lo"), { text: "Hello" }],
      LanguageModel.streamText({ prompt: "Say hello." }).pipe(Stream.runCollect),
    )
    const parts = value(exit)
    expect(parts.flatMap((p) => (p.type === "text-delta" ? [p.delta] : []))).toEqual(["Hel", "lo"])
    expect(parts.map((p) => p.type)).toEqual([
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "response-metadata",
      "finish",
    ])
  })

  describe("refusals", () => {
    const refusals: ReadonlyArray<readonly [string, Steps]> = [
      [
        "model_refusal_no_fallback",
        [
          {
            message: {
              type: "system",
              subtype: "model_refusal_no_fallback",
              original_model: "claude-fake",
              request_id: null,
              api_refusal_category: "cyber",
              content: "Refused.",
              uuid: crypto.randomUUID(),
            },
          },
          ...answered,
        ],
      ],
      [
        "model_refusal_fallback",
        [
          {
            message: {
              type: "system",
              subtype: "model_refusal_fallback",
              trigger: "refusal",
              direction: "retry",
              original_model: "claude-fake",
              fallback_model: "claude-other",
              request_id: null,
              content: "Retried on another model.",
              uuid: crypto.randomUUID(),
            },
          },
          ...answered,
        ],
      ],
      ["stop_reason refusal", [{ result: { stop_reason: "refusal", total_cost_usd: 0.001 } }]],
    ]
    for (const [name, steps] of refusals) {
      test(`${name} is a ContentPolicyError, though the result says success`, async () => {
        const { exit } = await run(steps, verdict)
        const error = aiError(exit)
        expect(error.reason._tag).toBe("ContentPolicyError")
        expect(subtypeOf(error)).toBe("success")
      })
    }
  })

  test("structured-output retries exhausted is a StructuredOutputError with its subtype", async () => {
    const { exit } = await run(
      [
        {
          result: {
            subtype: "error_max_structured_output_retries",
            is_error: true,
            stop_reason: null,
            terminal_reason: "structured_output_retry_exhausted",
            errors: ["Failed to provide valid structured output after 5 attempts"],
            num_turns: 6,
            total_cost_usd: 0.002,
            duration_ms: 9000,
          },
        },
      ],
      Effect.all([Effect.flip(verdict), total]),
    )
    const [error, sum] = value(exit)
    expect(error.reason._tag).toBe("StructuredOutputError")
    expect(subtypeOf(error)).toBe("error_max_structured_output_retries")
    // The failed call's cost still counts.
    expect(sum).toEqual({ calls: 1, costUsd: 0.002, turns: 6, durationMs: 9000 })
  })

  test("a success without structured output is a StructuredOutputError, subtype success", async () => {
    const { exit } = await run(
      [{ text: "I won't call the tool." }, { result: { stop_reason: "end_turn" } }],
      verdict,
    )
    const error = aiError(exit)
    expect(error.reason._tag).toBe("StructuredOutputError")
    expect(subtypeOf(error)).toBe("success")
    expect((error.reason as AiError.StructuredOutputError).responseText).toBe(
      "I won't call the tool.",
    )
  })

  test("each call's cost is logged and totalled", async () => {
    const { exit } = await run(
      answered,
      Effect.gen(function* () {
        yield* verdict
        yield* verdict
        return { lines: yield* texts, sum: yield* total }
      }),
    )
    const { lines, sum } = value(exit)
    expect(lines).toEqual([
      "ORGAN triage: $0.0123 in 2 turns, 4.2s",
      "ORGAN triage: $0.0123 in 2 turns, 4.2s",
    ])
    expect(sum.calls).toBe(2)
    expect(sum.costUsd).toBeCloseTo(0.0246)
    expect(sum.turns).toBe(4)
    expect(sum.durationMs).toBe(8400)
  })

  test("an answer only the codec rejects still has its cost logged", async () => {
    // Claude Code's JSON Schema check passes it; the codec's literal union doesn't.
    const undecodable = { ...answer, structured_output: { ...structured, verdict: "maybe" } }
    const { exit } = await run(
      [{ result: undecodable }],
      Effect.all([Effect.flip(verdict), texts, total]),
    )
    const [error, lines, sum] = value(exit)
    expect(error.reason._tag).toBe("StructuredOutputError")
    expect(lines).toEqual(["ORGAN triage: $0.0123 in 2 turns, 4.2s"])
    expect(sum.calls).toBe(1)
  })

  test("the cost line says turn for one", () => {
    expect(
      costLine({ organ: "screen", costUsd: 0.0001, turns: 1, durationMs: 857, sessionId: "s" }),
    ).toBe("ORGAN screen: $0.0001 in 1 turn, 0.9s" as never)
  })

  test("interrupting the call aborts the session and removes its folder", async () => {
    const { exit, logged } = await run(
      [{ hang: true }],
      LanguageModel.generateText({ prompt: "Hang." }).pipe(
        Effect.timeoutOption(Duration.millis(500)),
      ),
    )
    expect(value(exit)._tag).toBe("None")
    const [started] = logged.started
    if (started === undefined) throw new Error("the fake didn't start")
    expect(existsSync(started.cwd)).toBe(false)
    const deadline = Date.now() + 5000
    let alive = true
    while (alive && Date.now() < deadline) {
      try {
        process.kill(started.pid, 0)
        await new Promise((r) => setTimeout(r, 50))
      } catch {
        alive = false
      }
    }
    expect(alive).toBe(false)
  })
})

describe("toTurn", () => {
  test("system messages and one user message of text make a turn", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string()),
        fc.array(fc.string(), { minLength: 1 }),
        (systems, user) => {
          const turn = toTurn(
            Prompt.make([
              ...systems.map((content) => ({ role: "system" as const, content })),
              {
                role: "user" as const,
                content: user.map((text) => ({ type: "text" as const, text })),
              },
            ]),
          )
          expect(turn).toEqual({ systemPrompt: systems.join("\n\n"), userText: user })
        },
      ),
    )
  })

  test("history doesn't fit one turn", () => {
    expect(
      toTurn(
        Prompt.make([
          { role: "user", content: "a" },
          { role: "assistant", content: "b" },
          { role: "user", content: "c" },
        ]),
      ),
    ).toBeTypeOf("string")
    expect(toTurn(Prompt.make([{ role: "system", content: "only" }]))).toBe("no user message")
  })
})
