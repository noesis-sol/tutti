// Talk it through on a question bd closed after the box read it (tutti-ofhl, § 4.11): no session
// starts and no view is shown; the news says AlreadyAnswered, then Talked with the next question, so
// the one toast is the plain `<question> is already answered`, the box goes on, and the question
// leaves the panel. An issue that isn't a question at all is still a failure, and the box stays at it.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, SubscriptionRef } from "effect"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import { interviewWorker } from "../src/agent/inView.ts"
import type { InterviewInputs } from "../src/run/interview.ts"
import { QuestionNews, talkThrough } from "../src/run/questionNews.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Recording, layer as scriptedHost } from "../src/testing/AgentHost.ts"
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
  { id: "tut-1", title: "Waits", status: "closed", blockedBy: ["q-2"] },
  { id: "q-2", title: "Answered", labels: ["human"], status: "closed" },
  { id: "q-3", title: "Next", labels: ["human"] },
  { id: "tut-9", title: "Not a question" },
]

const q2 = "q-2" as TicketId
const q3 = "q-3" as TicketId

/** Talks `question` through from the dashboard: what came of it, with no session scripted. */
const talkOn = (question: string, next: TicketId | null) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tutti-talk-closed-")))
  return Effect.runPromise(
    Effect.gen(function* () {
      const news = yield* SubscriptionRef.make<ReadonlyArray<QuestionNews>>([])
      const slot = yield* SubscriptionRef.make<InterviewInputs | null>(null)
      yield* talkThrough(
        { question: question as TicketId, title: "T", next, uuid: "u-1" },
        news,
        slot,
      )
      const recording = yield* Recording
      const issues = yield* (yield* Backlog).issues
      return {
        news: yield* SubscriptionRef.get(news),
        slot: yield* SubscriptionRef.get(slot),
        sent: yield* recording.sentTo(interviewWorker),
        logged: yield* texts,
        design: issues.find((issue) => issue.id === "tut-1")?.design,
      }
    }).pipe(
      Effect.provide(
        scriptedHost({}).pipe(
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

describe("a talk on a question bd has closed", () => {
  test("starts no session, shows no view and records nothing", async () => {
    const value = await talkOn("q-2", q3)
    expect(value.sent).toEqual([])
    expect(value.slot).toBeNull()
    expect(value.design ?? "").not.toContain("Decided")
    expect(value.logged).toContain("no talk about q-2 on the dashboard, it is already answered")
  })

  test("says it is already answered, then goes on to the next question", async () => {
    const { news } = await talkOn("q-2", q3)
    expect(news).toEqual([
      QuestionNews.AlreadyAnswered({ uuid: "u-1", question: q2 }),
      QuestionNews.Talked({ uuid: "u-1", question: q2, answered: true, why: null, next: q3 }),
    ])
    expect(news.flatMap((item) => newsToast(item) ?? [])).toEqual([
      { text: "q-2 is already answered", failure: false },
    ])
    expect(news.flatMap((item) => returnTo(item) ?? [])).toEqual([{ first: q3 }])
  })

  test("as the last question, the box stays closed", async () => {
    const { news } = await talkOn("q-2", null)
    expect(news.flatMap((item) => returnTo(item) ?? [])).toEqual([])
  })

  test("leaves the panel, however it was answered", async () => {
    const { news } = await talkOn("q-2", q3)
    expect([...answersAfter(new Map(), news)]).toEqual([["u-1", "q-2"]])
  })
})

describe("a talk on what isn't a question", () => {
  test("is still a failure, and the box stays at it", async () => {
    const { news } = await talkOn("tut-9", q3)
    expect(news.flatMap((item) => newsToast(item) ?? [])).toEqual([
      {
        text: "the talk about tut-9 ended without an answer: couldn't start: tut-9 couldn't be read: tut-9 isn't an open question",
        failure: true,
      },
    ])
    expect(news.flatMap((item) => returnTo(item) ?? [])).toEqual([{ first: "tut-9" as TicketId }])
  })
})
