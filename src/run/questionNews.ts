// Answering questions on the dashboard during a run (§ 7.2, tutti-kkb.35): Shift+A's box offers
// ReadQuestions, and the run reads the open questions in its scope as the overnight pre-flight does
// (overnightQuestions.ts's openQuestions); each answer the box gives it offers AnswerQuestion, and
// the run records it (answerQuestion.ts). Both are bd's, so each runs in a fiber of its own, the
// screen's other commands not waiting on bd, and puts what came of it in the screen's question
// news under the uuid the box drew: the box shows the questions read, and the toasts say how each
// answer went (QuestionsBox.tsx). The log has a line for each answer, recorded or not.
//
// Talk it through in the box offers TalkQuestion (tutti-i0sz): the run talks the question through
// in a session shown in place of the screen (answerTalk.ts's talkQuestion, in the screen's talk
// slot), records the answer it gives as AnswerQuestion does, and then says it is over in the news
// (Talked), with the question the box goes on from: the next once answered, else the same.
import { Data, Effect, Result, SubscriptionRef } from "effect"
import type { AgentHost } from "../agent/AgentHost.ts"
import type { Attention } from "../agent/Attention.ts"
import { TalkEnd } from "../agent/answerTalk.ts"
import type { Transcripts } from "../agent/Transcripts.ts"
import type { AppConfig } from "../cli/AppConfig.ts"
import { type Beads, beadsWhy, type TicketId } from "../services/Beads.ts"
import type { OpenQuestion } from "../ui/questions.ts"
import { recordAnswer, recordWhy } from "./answerQuestion.ts"
import { inSlot, talkQuestion } from "./answerTalk.ts"
import type { InterviewInputs } from "./interview.ts"
import { Log, line } from "./log.ts"
import { openQuestions } from "./overnightQuestions.ts"

/** What came of a ReadQuestions or an AnswerQuestion, by the uuid the box drew. */
export type QuestionNews = Data.TaggedEnum<{
  /** The open questions in the run's scope, in bd human list's order. */
  Read: { readonly uuid: string; readonly questions: ReadonlyArray<OpenQuestion> }
  NotRead: { readonly uuid: string; readonly why: string }
  /** The answer recorded: the question closed, the decision in the designs of `decided`. */
  Answered: {
    readonly uuid: string
    readonly question: TicketId
    readonly title: string
    readonly decided: ReadonlyArray<TicketId>
  }
  NotAnswered: { readonly uuid: string; readonly question: TicketId; readonly why: string }
  /**
   * A talk is over, its answer recorded if it gave one (Answered or NotAnswered came first): `why`
   * it gave none, or null; `next`, the question the box goes on from.
   */
  Talked: {
    readonly uuid: string
    readonly question: TicketId
    readonly answered: boolean
    readonly why: string | null
    readonly next: TicketId | null
  }
}>

export const QuestionNews = Data.taggedEnum<QuestionNews>()

/** The most news the screen keeps: the box and the toasts wait only on the latest. */
export const newsKept = 16

/** `news` with `item` added, the oldest dropped past `newsKept`. */
const added = (
  news: SubscriptionRef.SubscriptionRef<ReadonlyArray<QuestionNews>>,
  item: QuestionNews,
) => SubscriptionRef.update(news, (all) => [...all, item].slice(-newsKept))

/** Reads the open questions in `scope` (null: every one) into `news` under `uuid`. Never fails. */
export const readQuestions = (
  uuid: string,
  scope: TicketId | null,
  news: SubscriptionRef.SubscriptionRef<ReadonlyArray<QuestionNews>>,
): Effect.Effect<void, never, Beads> =>
  Effect.gen(function* () {
    const read = yield* Effect.result(openQuestions(scope))
    yield* added(
      news,
      Result.isSuccess(read)
        ? QuestionNews.Read({ uuid, questions: read.success })
        : QuestionNews.NotRead({ uuid, why: beadsWhy(read.failure) }),
    )
  })

/** Records `answer` to `question` (answerQuestion.ts), and how it went in `news` under `uuid`. */
export const answerQuestion = (
  request: { readonly question: TicketId; readonly answer: string; readonly uuid: string },
  news: SubscriptionRef.SubscriptionRef<ReadonlyArray<QuestionNews>>,
): Effect.Effect<void, never, Beads | Log> =>
  Effect.gen(function* () {
    const logs = yield* Log
    const { question, answer, uuid } = request
    const recorded = yield* Effect.result(recordAnswer(question, answer))
    if (Result.isFailure(recorded)) {
      const why = recordWhy(recorded.failure)
      yield* logs.write(line`couldn't record the dashboard's answer to ${question}: ${why}`)
      return yield* added(news, QuestionNews.NotAnswered({ uuid, question, why }))
    }
    const { title, decided } = recorded.success
    yield* logs.write(line`answered ${question} (${title}) on the dashboard: ${answer}`)
    yield* added(news, QuestionNews.Answered({ uuid, question, title, decided }))
  })

/** Why a talk didn't start while another is shown. */
export const talkingAlready = "another talk is going on"

/**
 * Talks `request.question` through, shown in `slot` (the screen's talk slot), records the answer it
 * gives as answerQuestion does, then puts Talked in `news` under `request.uuid`. Never fails.
 */
export const talkThrough = (
  request: {
    readonly question: TicketId
    readonly title: string
    readonly next: TicketId | null
    readonly uuid: string
  },
  news: SubscriptionRef.SubscriptionRef<ReadonlyArray<QuestionNews>>,
  slot: SubscriptionRef.SubscriptionRef<InterviewInputs | null>,
): Effect.Effect<void, never, AgentHost | AppConfig | Attention | Beads | Log | Transcripts> =>
  Effect.gen(function* () {
    const logs = yield* Log
    const { question, uuid, next } = request
    const ended =
      (yield* SubscriptionRef.get(slot)) === null
        ? yield* talkQuestion({ id: question, title: request.title }, inSlot(slot))
        : TalkEnd.Ended({ why: talkingAlready })
    if (ended._tag === "Answered") {
      yield* answerQuestion({ question, answer: ended.answer, uuid }, news)
      return yield* added(
        news,
        QuestionNews.Talked({ uuid, question, answered: true, why: null, next }),
      )
    }
    yield* logs.write(
      line`the talk about ${question} on the dashboard ended without an answer: ${ended.why}`,
    )
    yield* added(
      news,
      QuestionNews.Talked({ uuid, question, answered: false, why: ended.why, next }),
    )
  })
