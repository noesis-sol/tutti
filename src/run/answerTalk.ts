// A question's talk, the run's side (§ 4.11, tutti-i0sz): Talk it through, in the answer form,
// shows the talk's session (agent/answerTalk.ts) in the Interview view, in the command's one
// renderer, as a spec's refinement is shown (interview.ts's inInterviewView), until it ends: its
// answer goes back to the form, which records it as every other (answerQuestion.ts); a talk left,
// or whose session ended, before an answer gives none, and the form puts the question again.
// Leaving before an answer asks `End the talk?`, the question staying open; once give_answer has
// taken one, leaving asks nothing.
import { Effect, SubscriptionRef } from "effect"
import type { AgentHost } from "../agent/AgentHost.ts"
import type { Attention } from "../agent/Attention.ts"
import { startAnswerTalk, TalkEnd } from "../agent/answerTalk.ts"
import { Filing } from "../agent/interviewTools.ts"
import type { Transcripts } from "../agent/Transcripts.ts"
import type { AppConfig } from "../cli/AppConfig.ts"
import type { Beads } from "../services/Beads.ts"
import type { OpenQuestion } from "../ui/questions.ts"
import { type InterviewScreen, inInterviewView } from "./interview.ts"

/** What the Interview view's head names a talk by. */
export const talkName = "Talk"

/** What leaving a talk asks before an answer, and what it says of it. */
export const talkLeaveQuestion = "End the talk?"
export const talkLeaveAbout = "The question stays open."

/** A talk that couldn't start: why, as the form's caller says it. */
export const talkNotStarted = (why: string): TalkEnd =>
  TalkEnd.Ended({ why: `couldn't start: ${why}` })

/**
 * Talks `question` through in the Interview view with `screen`, until the talk ends: the answer
 * give_answer took, or why there is none.
 */
export const talkQuestion = (
  question: OpenQuestion,
  screen: InterviewScreen,
): Effect.Effect<TalkEnd, never, AgentHost | AppConfig | Beads | Attention | Transcripts> =>
  Effect.gen(function* () {
    const started = yield* Effect.result(startAnswerTalk(question.id))
    if (started._tag === "Failure") return talkNotStarted(started.failure.reason)
    const talk = started.success
    const { ended } = yield* inInterviewView(
      {
        description: `${question.id}: ${question.title}`,
        filing: yield* SubscriptionRef.make<Filing>(Filing.None()),
        filed: talk.tools.given,
        name: talkName,
        leaveQuestion: talkLeaveQuestion,
        leaveAbout: talkLeaveAbout,
        send: talk.send,
        leave: talk.leave,
        ended: talk.ended,
      },
      screen,
    )
    return ended
  }).pipe(
    // The talk's scope, which its tools' calls end with.
    Effect.scoped,
  )
