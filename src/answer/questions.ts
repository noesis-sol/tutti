// `tutti answer` for the questions workers filed (§ 4.11, § 8.1, tutti-kkb.35), as for the run's
// attention requests: its listing gives, after the requests, every open question in the project
// (an open issue labelled human), with the tickets it keeps waiting and its options from the
// metadata, the recommended one first and marked, numbered; `tutti answer <question> <answer>`
// answers one, by an option's number or label or in your own words, recorded as answerQuestion.ts
// does: the decision in each blocked ticket's design, then bd human respond, which closes the
// question. It needs no run: a run going on takes the ticket that waited back at its next look.
// --json lists the requests alone, as it did. A project without Beads has no questions.
import { Effect, Schema } from "effect"
import { recordAnswer, recordWhy } from "../run/answerQuestion.ts"
import { openQuestionOf, openQuestions, waitingText } from "../run/overnightQuestions.ts"
import { Beads, type BeadsError, beadsWhy, type TicketId } from "../services/Beads.ts"
import { choicesOf, type OpenQuestion } from "../ui/questions.ts"
import { sanitizeLine } from "../ui/sanitize.ts"

/** What to give a question as its answer, as the listing and the errors say it. */
export const questionAnswerWords = "an option's number or label, or your own answer in quotes"

/**
 * How to answer `question` with `tutti answer`: after `--`, so that a label that starts with `-`,
 * as a flag's name does, is taken as the answer, not as a flag of the command.
 */
export const answerQuestionWith = (question: TicketId): string =>
  `tutti answer ${question} -- <${questionAnswerWords}>`

/** There is neither an open request nor a question with that ID. */
export class NoSuchQuestion extends Schema.TaggedError<NoSuchQuestion>()("NoSuchQuestion", {
  question: Schema.String,
}) {
  override get message(): string {
    return `there is no open request or question ${this.question}; tutti answer lists them`
  }
}

/** The answer to the question couldn't be recorded. */
export class QuestionNotAnswered extends Schema.TaggedError<QuestionNotAnswered>()(
  "QuestionNotAnswered",
  { question: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `the answer to ${this.question} wasn't recorded: ${this.reason}`
  }
}

/**
 * What `given` answers `question` with: the option it numbers (from 1, as the listing numbers
 * them) or names (its label, whatever the case), as its label; otherwise the text itself, trimmed.
 */
export const chosenAnswer = (question: OpenQuestion, given: string): string => {
  const text = given.trim()
  const options = question.options ?? []
  if (/^[1-9]$/.test(text)) {
    const numbered = options[Number(text) - 1]
    if (numbered !== undefined) return numbered.label
  }
  const named = options.find((option) => option.label.toLowerCase() === text.toLowerCase())
  return named?.label ?? text
}

/** The open questions for people: each with what waits on it, its options, and how to answer it. */
export const showQuestions = (questions: ReadonlyArray<OpenQuestion>): string =>
  questions
    .map((question) => {
      const lines = [`${question.id}  ${question.title}  (${waitingText(question.waiting)})`]
      if (question.maintainerOnly) lines.push("    only the maintainer answers it")
      const options = choicesOf(question).flatMap((choice) =>
        choice._tag === "Option" ? [choice] : [],
      )
      for (const [i, option] of options.entries()) {
        const about = option.description === "" ? "" : ` - ${option.description}`
        lines.push(`    ${i + 1}. ${option.label}${about}`)
      }
      lines.push(`    answer with: ${sanitizeLine(answerQuestionWith(question.id))}`)
      return lines.join("\n")
    })
    .join("\n\n")

/** The listing's section of open questions: none where none is open. */
export const questionsSection = (questions: ReadonlyArray<OpenQuestion>): string =>
  questions.length === 0 ? "" : `\n\nOpen questions:\n${showQuestions(questions)}`

/** Every open question in the project, as the listing gives them. */
export const listQuestions: Effect.Effect<
  ReadonlyArray<OpenQuestion>,
  BeadsError,
  Beads
> = openQuestions(null)

/** What answering a question did, as the command prints it. */
export const answeredLine = (
  question: TicketId,
  title: string,
  answer: string,
  decided: ReadonlyArray<TicketId>,
): string =>
  sanitizeLine(
    `Answered ${question} (${title}): ${answer}.${decided.length === 0 ? "" : ` The decision is in the design of ${decided.join(", ")}.`}`,
  )

/**
 * Answers the open question `id` with `given` (chosenAnswer), recorded as answerQuestion.ts does:
 * the line to print.
 */
export const answerQuestion = (
  id: string,
  given: string,
): Effect.Effect<string, NoSuchQuestion | QuestionNotAnswered, Beads> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const shown = yield* beads
      .show(id as TicketId, { dependents: true })
      .pipe(
        Effect.mapError((error): NoSuchQuestion | QuestionNotAnswered =>
          error._tag === "BeadsFailed" && error.noSuchIssue
            ? new NoSuchQuestion({ question: id })
            : new QuestionNotAnswered({ question: id, reason: beadsWhy(error) }),
        ),
      )
    const question = openQuestionOf(shown, [])
    const answer = chosenAnswer(question, given)
    if (answer === "") {
      return yield* new QuestionNotAnswered({
        question: id,
        reason: `the answer is empty: give ${questionAnswerWords}`,
      })
    }
    const recorded = yield* recordAnswer(question.id, answer).pipe(
      Effect.mapError(
        (error) => new QuestionNotAnswered({ question: id, reason: recordWhy(error) }),
      ),
    )
    return answeredLine(question.id, recorded.title, answer, recorded.decided)
  })
