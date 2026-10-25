// --overnight's open questions (§ 5 item 2, § 4.11; tutti-kkb.51): a question ticket open when an
// overnight run starts would keep the tickets it blocks waiting all night, as --auto-answer leaves
// a question open before the run, and a maintainer_only one always. Once the pre-flight has cleared
// the run, before the first ticket, the questions in the run's scope are put to the maintainer one
// by one: its options from the metadata (Beads.ts's questionOptions), the recommended one first and
// marked, Other to type your own, and Leave open. In a terminal they are asked in the answer form
// in the command's renderer (src/ui/OpenQuestion.tsx), or as lines in plain output
// (src/ui/plain/forms.ts's openQuestion); without one, nothing is asked. An answer is recorded with
// bd human respond, which closes the question and frees what it blocked; those left open are listed
// with the tickets they keep waiting and how to answer them later. A cancel (Esc, Ctrl+C, the end
// of input) stops the run before it starts, the answers already given kept. orchestra's pre-flight
// puts them in a Claude Code session; this is tutti's own.
import { Console, Effect, Option, Result } from "effect"
import {
  Beads,
  type BeadsError,
  beadsWhy,
  type Issue,
  maintainerOnly,
  questionOptions,
  type TicketId,
} from "../services/Beads.ts"
import type { OpenQuestion, QuestionAt, Reply } from "../ui/questions.ts"
import { sanitize, sanitizeLine } from "../ui/sanitize.ts"
import { exitCodes } from "./holds.ts"
import { Log, line } from "./log.ts"
import { checklistLine, type Say } from "./overnight.ts"
import { joinAnd } from "./processes.ts"
import { descendants } from "./scope.ts"

/** Where a question is put: the form, or the lines. Fails on a cancel. */
export type Put = (
  question: OpenQuestion,
  at: QuestionAt,
) => Effect.Effect<Reply, { readonly _tag: "FormCancelled" }>

/** How putting the questions ended. */
export type Putting =
  /** Every question was answered or left open: the run starts. */
  | { readonly _tag: "Done"; readonly answered: number; readonly left: number }
  /** A question was cancelled: the run doesn't start, the answers given kept, exit 130. */
  | { readonly _tag: "Cancelled"; readonly answered: number }

/** What a run stopped at its questions says on stderr, the answers given kept. */
export const questionsCancelledMessage = (answered: number): string =>
  answered === 0
    ? "tutti: stopped before the run started; no question was answered."
    : `tutti: stopped before the run started; the ${answered === 1 ? "answer" : `${answered} answers`} given ${answered === 1 ? "is" : "are"} kept.`

/** `1 question` or `<n> questions`. */
export const questionCount = (n: number): string => (n === 1 ? "1 question" : `${n} questions`)

/** `ids`' tickets kept waiting on a question, as the checklist says it. */
export const waitingText = (ids: ReadonlyArray<TicketId>): string =>
  ids.length === 0
    ? "no ticket waits on it"
    : `${joinAnd(ids)} ${ids.length === 1 ? "waits" : "wait"} on it`

/** How to answer `id` later, as the checklist says it. */
export const answerLater = (id: TicketId): string => `bd human respond ${id} "<answer>"`

/** A question left open's line of its checklist, without its mark. */
export const leftOpenText = (question: OpenQuestion): string =>
  `${question.id} (${question.title}): ${waitingText(question.waiting)}. Answer it with ${answerLater(question.id)}`

/**
 * The open questions in the run's scope, in bd human list's order: every open issue labelled human
 * or, with --ticket `scope`, one that blocks it or a ticket under it, or is under it itself; each as
 * bd show gives it, with the tickets it keeps waiting.
 */
export const openQuestions = (
  scope: TicketId | null,
): Effect.Effect<ReadonlyArray<OpenQuestion>, BeadsError, Beads> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const listed = (yield* beads.questions()).filter((question) => question.status === "open")
    if (listed.length === 0) return []
    const inScope =
      scope === null
        ? null
        : new Set<TicketId>([scope, ...(yield* descendants(beads, scope)).map((each) => each.id)])
    const found: Array<OpenQuestion> = []
    for (const each of listed) {
      const shown = yield* Effect.result(beads.show(each.id, { dependents: true }))
      if (Result.isFailure(shown)) {
        // A question deleted meanwhile is none.
        if (shown.failure._tag === "BeadsFailed" && shown.failure.noSuchIssue) continue
        return yield* Effect.fail(shown.failure)
      }
      const question = shown.success
      const blocked = (question.dependents ?? [])
        .filter((dependent) => dependent.type === "blocks" && dependent.issue?.status !== "closed")
        .map((dependent) => dependent.id)
      const waiting = inScope === null ? blocked : blocked.filter((id) => inScope.has(id))
      if (inScope !== null && !inScope.has(question.id) && waiting.length === 0) continue
      found.push(openQuestionOf(question, waiting))
    }
    return found
  })

/** `question` as it is put, keeping `waiting` waiting. */
export const openQuestionOf = (
  question: Issue,
  waiting: ReadonlyArray<TicketId>,
): OpenQuestion => ({
  id: question.id,
  title: sanitizeLine(question.title).trim(),
  description: sanitize(question.description).trim(),
  options: questionOptions(question.metadata),
  maintainerOnly: maintainerOnly(question.metadata),
  waiting: [...new Set(waiting)],
})

/**
 * Puts `questions` one by one with `put` (none: without a terminal, nothing is asked), records each
 * answer with bd human respond and logs it, then says how many were answered and lists those left
 * open, with the tickets they keep waiting and how to answer them later. A cancel stops there, the
 * answers given kept. An answer bd couldn't record leaves its question open, saying why.
 */
export const putQuestions = (options: {
  readonly questions: ReadonlyArray<OpenQuestion>
  readonly put: Option.Option<Put>
  readonly say: Pick<Say, "print" | "say" | "warn" | "theme">
}): Effect.Effect<Putting, never, Beads | Log> =>
  Effect.gen(function* () {
    const { questions, say } = options
    const beads = yield* Beads
    const logs = yield* Log
    const left: Array<OpenQuestion> = []
    let answered = 0
    const counted = Effect.suspend(() =>
      answered === 0 ? Effect.void : say.say(`Answered ${questionCount(answered)}`),
    )
    for (const [index, question] of questions.entries()) {
      if (Option.isNone(options.put)) {
        left.push(question)
        continue
      }
      const reply = yield* Effect.result(
        options.put.value(question, { index, of: questions.length }),
      )
      if (Result.isFailure(reply)) {
        yield* logs.write(
          line`overnight pre-flight: the questions were cancelled, ${questionCount(answered)} answered: the run doesn't start`,
        )
        yield* counted
        return { _tag: "Cancelled", answered } as const
      }
      if (reply.success._tag === "LeaveOpen") {
        left.push(question)
        continue
      }
      const answer = reply.success.answer
      const recorded = yield* Effect.result(beads.respond(question.id, answer))
      if (Result.isFailure(recorded)) {
        const text = `overnight pre-flight: couldn't record the answer to ${question.id} (${question.title}): ${beadsWhy(recorded.failure)}`
        yield* say.warn(text)
        yield* logs.write(line`${text}`)
        left.push(question)
        continue
      }
      answered++
      yield* logs.write(
        line`overnight pre-flight: answered ${question.id} (${question.title}): ${answer}`,
      )
    }
    yield* counted
    if (left.length > 0) {
      yield* say.say(`Overnight pre-flight: ${questionCount(left.length)} left open`)
      yield* say.print(
        left
          .map((question) =>
            checklistLine({ verdict: "warned", text: leftOpenText(question) }, say.theme),
          )
          .join("\n"),
      )
      yield* logs.write(
        ...left.map(
          (question) =>
            line`overnight pre-flight: left open: ${question.id} (${question.title}): ${waitingText(question.waiting)}`,
        ),
      )
    }
    return { _tag: "Done", answered, left: left.length } as const
  })

/** Ends a run stopped at its questions: questionsCancelledMessage on stderr, and exit 130. */
export const stoppedAtQuestions = (answered: number): Effect.Effect<number> =>
  Effect.as(Console.error(questionsCancelledMessage(answered)), exitCodes.interrupted)
