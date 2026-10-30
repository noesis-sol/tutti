// A feature's breakdown or a question's talk whose turn is refused for Claude's login (§ 4.13) once
// the tree is filed or the answer given: its worker is LoginRefused, not Failed, and never settles,
// so the breakdown ends as filed and the talk with its answer, as they did on a failed turn, rather
// than wait until the user leaves or end as failed.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Layer, type Scope, SubscriptionRef } from "effect"
import type { AgentHost } from "../src/agent/AgentHost.ts"
import { type AnswerTalk, startAnswerTalk, TalkEnd } from "../src/agent/answerTalk.ts"
import { startFeature } from "../src/agent/breakdown.ts"
import type { BreakdownTools } from "../src/agent/breakdownTools.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { interviewWorker, turnOver } from "../src/agent/inView.ts"
import { serverName } from "../src/agent/ticketTools.ts"
import { WorkerState } from "../src/agent/WorkerState.ts"
import type { AppConfig } from "../src/cli/AppConfig.ts"
import type { Log } from "../src/run/log.ts"
import type { Beads, TicketId } from "../src/services/Beads.ts"
import type { Git } from "../src/services/Git.ts"
import {
  assistantText,
  emit,
  init,
  Recording,
  type Script,
  type Step,
  layer as scriptedHost,
  sessionState,
  tool,
  wait,
} from "../src/testing/AgentHost.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { type Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as memoryGit } from "../src/testing/Git.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"

const refusal = "Failed to authenticate: OAuth session expired and could not be refreshed"

/** The end of a turn refused for the login, as tutti-djtt's was on 2026-10-28. */
const refusedEnd: ReadonlyArray<Step> = [
  assistantText(refusal, { error: "authentication_failed" }),
  emit({
    type: "result",
    subtype: "success",
    is_error: true,
    result: refusal,
    api_error_status: null,
    num_turns: 1,
  }),
  sessionState("idle"),
]

const sessionInit = init({
  mcp_servers: [{ name: serverName, status: "connected", source: "sdk" }],
})

/** A question q-1 for the talk. */
const backlog: ReadonlyArray<Seed> = [{ id: "q-1", title: "Which flag name?", labels: ["human"] }]

/** Runs `effect` in a fresh main checkout with the scripted host playing `script`. */
const scenario = <T, A, E>(
  script: (ready: Deferred.Deferred<T>) => Script,
  effect: (
    ready: Deferred.Deferred<T>,
  ) => Effect.Effect<
    A,
    E,
    AgentHost | Recording | Backlog | Beads | AppConfig | Git | Log | Scope.Scope
  >,
) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-interview-login-")))
  return Effect.runPromise(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<T>()
      return yield* effect(ready).pipe(
        Effect.scoped,
        Effect.provide(
          scriptedHost({ [interviewWorker]: script(ready) }).pipe(
            Layer.provideMerge(
              Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer(), ClaudeCode.layer),
            ),
            Layer.provideMerge(
              Layer.mergeAll(
                logLayer(),
                eventsLayer(),
                configLayer(appConfig({}, repo)),
                beadsLayer(backlog),
                memoryGit({ dir: repo, files: { "README.md": "# demo\n" } }),
              ),
            ),
          ),
        ),
      )
    }),
  )
}

/** Calls the session's tool `name` with `input`, as the session would. */
const call = (
  tools: BreakdownTools | AnswerTalk["tools"],
  name: string,
  input: Record<string, unknown>,
) => {
  const found = tools.tools.find((t) => t.name === name)
  if (found === undefined) throw new Error(`no tool ${name}`)
  return Effect.promise(() => found.handler(input as never, {}))
}

const root = {
  title: "A --json flag for list",
  description: "list prints JSON with --json.",
  priority: 2,
}

/** file_breakdown's input once file_root has filed `epic`. */
const tree = (epic: string) => ({
  root: epic,
  issues: [
    {
      key: "json",
      parent: "",
      type: "task",
      priority: 2,
      title: "JSON output for list",
      description: "Why and what.",
      acceptance: "The tests pass.",
      labels: [],
      files: ["README.md"],
      waits_for: [],
    },
  ],
})

describe("a turn refused for the login", () => {
  test("is over, as an idle or a failed one is", () => {
    expect(turnOver(WorkerState.LoginRefused({ error: refusal, told: [] }))).toBe(true)
    expect(turnOver(WorkerState.Idle({ at: 0 }))).toBe(true)
    expect(turnOver(WorkerState.Starting())).toBe(false)
  })

  test("after the tree is filed ends a feature's breakdown as filed", async () => {
    const value = await scenario<BreakdownTools, unknown, unknown>(
      (ready) => [
        [
          wait,
          sessionInit,
          sessionState("running"),
          ...tool(
            "mcp__tutti__file_breakdown",
            {},
            Effect.gen(function* () {
              const tools = yield* Deferred.await(ready)
              yield* call(tools, "file_root", root)
              const epic = (yield* SubscriptionRef.get(tools.state)).root ?? ""
              yield* call(tools, "file_breakdown", tree(epic))
            }),
          ),
          ...refusedEnd,
        ],
      ],
      (ready) =>
        Effect.gen(function* () {
          const breakdown = yield* startFeature({
            description: "Add a --json flag to list.\n",
            effort: null,
          })
          yield* Deferred.succeed(ready, breakdown.tools)
          const ended = yield* breakdown.ended
          const recording = yield* Recording
          return {
            ended: ended._tag,
            tickets: ended.state.tickets,
            last: (yield* recording.sentTo(interviewWorker)).at(-1)?._tag,
          }
        }),
    )
    expect(value).toEqual({ ended: "Filed", tickets: 1, last: "Ended" })
  })

  test("after the answer is given ends the talk with it", async () => {
    const value = await scenario<AnswerTalk, unknown, unknown>(
      (ready) => [
        [
          wait,
          sessionInit,
          sessionState("running"),
          ...tool(
            "mcp__tutti__give_answer",
            { answer: "--long-flag" },
            Effect.flatMap(Deferred.await(ready), (talk) =>
              Effect.asVoid(call(talk.tools, "give_answer", { answer: "--long-flag" })),
            ),
          ),
          ...refusedEnd,
        ],
      ],
      (ready) =>
        Effect.gen(function* () {
          const talk = yield* startAnswerTalk("q-1" as TicketId)
          yield* Deferred.succeed(ready, talk)
          const ended = yield* talk.ended
          const recording = yield* Recording
          return { ended, last: (yield* recording.sentTo(interviewWorker)).at(-1)?._tag }
        }),
    )
    expect(value).toEqual({ ended: TalkEnd.Answered({ answer: "--long-flag" }), last: "Ended" })
  })
})
