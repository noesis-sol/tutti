// A spec's breakdown, the session side (§ 4.14): its instructions rendered for each mode, its options
// (the built-in tools it has, dontAsk when nobody is there, its effort, its own tools allowed), a
// refinement that files its tree and one that is left, and a headless one past its time limit.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CanUseTool, OnElicitation } from "@anthropic-ai/claude-agent-sdk"
import { Deferred, Duration, Effect, Stream } from "effect"
import { AgentHost } from "../src/agent/AgentHost.ts"
import {
  type Breakdown,
  BreakdownEnd,
  BreakdownMode,
  breakdownBuiltins,
  breakdownMessage,
  breakdownPrompt,
  breakdownWorker,
  renderPrompt,
  startBreakdown,
} from "../src/agent/breakdown.ts"
import { qualifiedBreakdownTools } from "../src/agent/breakdownTools.ts"
import type { ToolAnswer } from "../src/agent/callbacks.ts"
import { interviewWorker } from "../src/agent/inView.ts"
import { interviewOptions, type WorkerCallbacks } from "../src/agent/options.ts"
import { serverName } from "../src/agent/ticketTools.ts"
import type { Issue, TicketId } from "../src/services/Beads.ts"
import { init, result, sessionState, tool, wait } from "../src/testing/AgentHost.ts"
import { appConfig } from "../src/testing/AppConfig.ts"
import { rootInput, specLayers, specOf, ticket } from "./specScenario.ts"

describe("renderPrompt", () => {
  test("keeps or drops each section by its flag, on its own line or inline, nested", () => {
    const text = [
      "<!-- a note for whoever edits it -->",
      "a",
      "{{#if x}}",
      "x{{#if not y}}, not y{{/if}}",
      "{{else}}",
      "not x",
      "{{/if}}",
      "b",
      "",
    ].join("\n")
    expect(renderPrompt(text, { x: true, y: false })).toBe("a\nx, not y\nb\n")
    expect(renderPrompt(text, { x: true, y: true })).toBe("a\nx\nb\n")
    expect(renderPrompt(text, {})).toBe("a\nnot x\nb\n")
  })

  test("each mode's instructions are whole, with nothing of the template's syntax left", () => {
    for (const refine of [false, true]) {
      for (const update of [false, true]) {
        const prompt = breakdownPrompt({ refine, update })
        expect(prompt).not.toContain("{{")
        expect(prompt).not.toContain("<!--")
        expect(prompt).toStartWith("# Spec breakdown\n")
        expect(prompt.includes("## Questions")).toBe(refine)
        expect(prompt.includes("## Choices the spec leaves open")).toBe(!refine)
        expect(prompt.includes("## Updating the tree")).toBe(update)
        expect(prompt.includes("`file_root`, once")).toBe(!update)
        expect(prompt.includes("AskUserQuestion")).toBe(refine)
      }
    }
  })
})

describe("the breakdown's first message", () => {
  const spec = specOf()
  const base = { spec, commit: "c0ffee", refine: false, timeLimit: Duration.minutes(90) }
  const root = { id: "shop-1", type: "epic", status: "open", title: "Shop" } as unknown as Issue

  test("names the spec, its version and its time; with you, no time", () => {
    expect(breakdownMessage({ ...base, mode: BreakdownMode.New() })).toBe(
      `Break the spec at docs/shop.md down into Beads tickets (sha256 ${spec.sha256}, commit c0ffee). You have 1h30m.`,
    )
    expect(breakdownMessage({ ...base, refine: true, mode: BreakdownMode.New() })).toBe(
      `Break the spec at docs/shop.md down into Beads tickets with me (sha256 ${spec.sha256}, commit c0ffee).`,
    )
  })

  test("an update names the root epic, the version its tree was filed for, and the change's file", () => {
    const text = breakdownMessage({
      ...base,
      mode: BreakdownMode.Update({ root, filedFor: "0123456789abcdef" }),
    })
    expect(text).toContain("Update the tree of the spec at docs/shop.md for its change")
    expect(text).toContain(
      "Its root epic is shop-1, whose tree was filed for the spec at commit 0123456789ab. .tutti/run/spec-update.md holds the change and the tree.",
    )
  })
})

describe("the breakdown's options", () => {
  const canUseTool: CanUseTool = async () => ({ behavior: "allow" })
  const onElicitation: OnElicitation = async () => ({ action: "decline" })
  const callbacks: WorkerCallbacks = { canUseTool, onElicitation, hooks: {}, stderr: () => {} }
  const optionsFor = (headless: boolean) =>
    interviewOptions({
      config: appConfig({}, "/work/shop"),
      setup: {
        prompt: "instructions",
        server: { type: "sdk", name: serverName } as never,
        builtins: breakdownBuiltins(!headless),
        allowed: qualifiedBreakdownTools,
        headless,
        effort: "xhigh",
        tools: [],
      },
      chrome: false,
      callbacks,
      session: { _tag: "New", sessionId: "s-1" },
    })

  test("headless: no AskUserQuestion, dontAsk, its effort, its four tools allowed", () => {
    const options = optionsFor(true)
    expect(options.tools).toEqual(["Read", "Grep", "Glob", "Agent"])
    expect(options.permissionMode).toBe("dontAsk")
    expect(options.effort).toBe("xhigh")
    expect(options.hooks?.PreToolUse?.at(-1)?.matcher).toBe(
      "mcp__tutti__tickets_list|mcp__tutti__ticket_show|mcp__tutti__file_root|mcp__tutti__file_breakdown",
    )
  })

  test("with you: AskUserQuestion, and the workers' permission mode", () => {
    const options = optionsFor(false)
    expect(options.tools).toEqual(["Read", "Grep", "Glob", "Agent", "AskUserQuestion"])
    expect(options.permissionMode).toBe("auto")
  })
})

describe("startBreakdown", () => {
  const breakdownInit = (mode: string) =>
    init({
      permissionMode: mode,
      mcp_servers: [{ name: serverName, status: "connected", source: "sdk" }],
    })

  /** Runs `effect` on a breakdown started with `start`, the scripted host playing `script`. */
  const scenario = <A>(
    worker: TicketId,
    script: (ready: Deferred.Deferred<Breakdown>) => ReadonlyArray<ReadonlyArray<unknown>>,
    start: { readonly refine: boolean; readonly timeLimit?: Duration.Duration },
    effect: (
      breakdown: Breakdown,
      ready: Deferred.Deferred<Breakdown>,
    ) => Effect.Effect<A, unknown, AgentHost>,
  ) => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-breakdown-")))
    const ready = Effect.runSync(Deferred.make<Breakdown>())
    const spec = specOf()
    return Effect.runPromise(
      Effect.gen(function* () {
        const breakdown = yield* startBreakdown({
          spec,
          commit: "c0ffee",
          mode: BreakdownMode.New(),
          refine: start.refine,
          timeLimit: start.timeLimit ?? Duration.minutes(60),
          effort: "high",
        })
        yield* Deferred.succeed(ready, breakdown)
        return yield* effect(breakdown, ready)
      }).pipe(
        Effect.scoped,
        Effect.provide(
          specLayers({
            repo,
            scripts: { [worker]: script(ready) as never },
            files: { "README.md": "# shop\n", [spec.path]: spec.text },
          }),
        ),
      ),
    )
  }

  /** Calls the breakdown's tool `name` with `input` once it has started. */
  const call = (
    ready: Deferred.Deferred<Breakdown>,
    name: string,
    input: Record<string, unknown>,
    answers: Array<ToolAnswer>,
  ) =>
    Effect.flatMap(Deferred.await(ready), (breakdown) => {
      const found = breakdown.tools.tools.find((t) => t.name === name)
      if (found === undefined) throw new Error(`no tool ${name}`)
      return Effect.map(
        Effect.promise(() => found.handler(input as never, {})),
        (answer) => void answers.push(answer),
      )
    })

  test("a refinement that files its tree ends Filed once its turn is over, in the view's name", async () => {
    const answers: Array<ToolAnswer> = []
    const rest = { root: "test-1", issues: [ticket({ key: "list", waits_for: ["test-1.1"] })] }
    const ended = await scenario(
      interviewWorker,
      (ready) => [
        [
          wait,
          breakdownInit("auto"),
          sessionState("running"),
          result("Q1 - one question."),
          sessionState("idle"),
          wait,
          sessionState("running"),
          ...tool("mcp__tutti__file_root", rootInput, call(ready, "file_root", rootInput, answers)),
          ...tool("mcp__tutti__file_breakdown", rest, call(ready, "file_breakdown", rest, answers)),
          result("Filed; the run starts next."),
          sessionState("idle"),
        ],
      ],
      { refine: true },
      (breakdown) =>
        Effect.gen(function* () {
          const host = yield* AgentHost
          // Its first turn asks: your turn, the breakdown still going.
          yield* host.state(interviewWorker).pipe(
            Stream.filter((state) => state._tag === "Idle"),
            Stream.runHead,
          )
          yield* Effect.ignore(breakdown.send("Go ahead."))
          return yield* breakdown.ended
        }),
    )
    expect(answers.map((a) => a.isError)).toEqual([undefined, undefined])
    expect(ended._tag).toBe("Filed")
    if (ended._tag === "Filed") expect(ended.root).toBe("test-1" as TicketId)
  })

  test("a refinement left from the view ends Left, with what it filed", async () => {
    const answers: Array<ToolAnswer> = []
    const ended = await scenario(
      interviewWorker,
      (ready) => [
        [
          wait,
          breakdownInit("auto"),
          sessionState("running"),
          ...tool("mcp__tutti__file_root", rootInput, call(ready, "file_root", rootInput, answers)),
          result("Filed the root epic; shall I go on?"),
          sessionState("idle"),
          wait,
        ],
      ],
      { refine: true },
      (breakdown) =>
        Effect.gen(function* () {
          const host = yield* AgentHost
          yield* host.state(interviewWorker).pipe(
            Stream.filter((state) => state._tag === "Idle"),
            Stream.runHead,
          )
          yield* breakdown.leave
          return yield* breakdown.ended
        }),
    )
    expect(ended._tag).toBe("Left")
    expect(ended.state).toMatchObject({
      root: "test-1",
      environment: "test-1.1",
      epics: 1,
      tickets: 1,
    })
  })

  test("a headless breakdown past its time limit is closed, and fails saying so", async () => {
    const ended = await scenario(
      breakdownWorker,
      () => [[wait, breakdownInit("dontAsk"), sessionState("running"), wait]],
      { refine: false, timeLimit: Duration.millis(200) },
      (breakdown) => breakdown.ended,
    )
    expect(ended).toEqual(
      BreakdownEnd.Failed({
        why: "it ran past its time limit of 200ms",
        state: { root: null, environment: null, epics: 0, tickets: 0, answer: ended.state.answer },
      }),
    )
  })
})
