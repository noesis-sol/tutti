// A talk whose answer bd refuses (tutti-fnvd.8): bd human respond fails, say on a lock, so the
// question stays open. The news says NotAnswered, then Talked not answered, with no why of its own:
// the one toast is NotAnswered's, the box opens again at the same question, and the question stays
// on the panel.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Layer, SubscriptionRef } from "effect"
import type { TalkTools } from "../src/agent/answerTalk.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { interviewWorker } from "../src/agent/inView.ts"
import { serverName } from "../src/agent/ticketTools.ts"
import type { InterviewInputs } from "../src/run/interview.ts"
import { QuestionNews, talkThrough } from "../src/run/questionNews.ts"
import type { TicketId } from "../src/services/Beads.ts"
import {
  init,
  Recording,
  result,
  layer as scriptedHost,
  sessionState,
  tool,
  wait,
} from "../src/testing/AgentHost.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { Backlog, layer as beadsLayer, type Seed } from "../src/testing/Beads.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as memoryGit } from "../src/testing/Git.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { answersAfter } from "../src/ui/Dashboard.tsx"
import { newsToast, returnTo } from "../src/ui/QuestionsBox.tsx"

const backlog: ReadonlyArray<Seed> = [
  { id: "tut-1", title: "Add the flag", blockedBy: ["q-1"] },
  { id: "q-1", title: "Which flag name?", labels: ["human"] },
  { id: "q-2", title: "Next", labels: ["human"] },
]

const q1 = "q-1" as TicketId
const q2 = "q-2" as TicketId
const why = "Error: database is locked"

/** Talks q-1 through from the dashboard, its session giving an answer bd human respond refuses. */
const refusedTalk = () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-talk-refused-")))
  const tools = Effect.runSync(Deferred.make<TalkTools["tools"]>())
  const answer = { answer: "--long-flag" }
  const script = [
    [
      wait,
      init({ mcp_servers: [{ name: serverName, status: "connected", source: "sdk" }] }),
      sessionState("running"),
      ...tool(
        "mcp__tutti__give_answer",
        answer,
        Effect.flatMap(Deferred.await(tools), (found) => {
          const give = found.find((t) => t.name === "give_answer")
          if (give === undefined) return Effect.die("no give_answer")
          return Effect.asVoid(Effect.promise(() => give.handler(answer as never, {})))
        }),
      ),
      result("Decided."),
      sessionState("idle"),
    ],
  ]
  return Effect.runPromise(
    Effect.gen(function* () {
      const news = yield* SubscriptionRef.make<ReadonlyArray<QuestionNews>>([])
      const slot = yield* SubscriptionRef.make<InterviewInputs | null>(null)
      const recording = yield* Recording
      yield* Effect.gen(function* () {
        for (;;) {
          const started = (yield* recording.sentTo(interviewWorker)).find(
            (s) => s._tag === "Started",
          )
          const kind = started?._tag === "Started" ? started.session.kind : undefined
          if (kind?._tag === "Interview") return yield* Deferred.succeed(tools, kind.tools)
          yield* Effect.sleep("5 millis")
        }
      }).pipe(Effect.forkScoped)
      yield* (yield* Backlog).fail("human respond", { stderr: "Error: database is locked" })
      yield* Effect.yieldNow
      yield* talkThrough(
        { question: q1, title: "Which flag name?", next: q2, uuid: "u-1" },
        news,
        slot,
      )
      const issues = yield* (yield* Backlog).issues
      return {
        news: yield* SubscriptionRef.get(news),
        status: issues.find((issue) => issue.id === "q-1")?.status,
        logged: yield* texts,
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        scriptedHost({ [interviewWorker]: script }).pipe(
          Layer.provideMerge(
            Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer(), ClaudeCode.layer),
          ),
          Layer.provideMerge(
            Layer.mergeAll(
              logLayer(),
              eventsLayer(),
              configLayer(appConfig({}, repo)),
              beadsLayer(backlog),
              memoryGit({ dir: repo, files: {} }),
            ),
          ),
        ),
      ),
    ),
  )
}

describe("a talk whose answer bd refuses", () => {
  test("says it isn't answered, and the box opens again at the same question", async () => {
    const value = await refusedTalk()
    expect(value.status).toBe("open")
    expect(value.news).toEqual([
      QuestionNews.NotAnswered({ uuid: "u-1", question: q1, why }),
      QuestionNews.Talked({ uuid: "u-1", question: q1, answered: false, why: null, next: q2 }),
    ])
    expect(value.news.flatMap((item) => newsToast(item) ?? [])).toEqual([
      { text: `couldn't record the answer to q-1: ${why}`, failure: true },
    ])
    expect(value.news.flatMap((item) => returnTo(item) ?? [])).toEqual([{ first: q1 }])
    expect(value.logged).toContain(`couldn't record the dashboard's answer to q-1: ${why}`)
  })

  test("stays on the panel", async () => {
    const { news } = await refusedTalk()
    expect([...answersAfter(new Map([["u-1", "q-1"]]), news)]).toEqual([])
  })
})
