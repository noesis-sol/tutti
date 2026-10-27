// Recording the maintainer's answer to a question ticket (§ 4.11, tutti-kkb.35), however it was
// given: the overnight pre-flight's form (overnightQuestions.ts), the dashboard's Shift+A
// (Box.Questions), or `tutti answer <question> <answer>`. As orchestra's answer talk does, the
// blocked tickets come first: the decision is added to the design of each open ticket the question
// blocks, below what is there, under `Decided (<the question's ID>)`, so that the worker that takes
// a ticket up reads it there; then bd human respond records the answer on the question, which
// closes it and frees what it blocked. A run going on takes a ticket that waited on it back at its
// next look (asked.ts).
import { Effect, Schema } from "effect"
import { Beads, type BeadsError, beadsWhy, HumanLabel, type TicketId } from "../services/Beads.ts"
import { sanitizeLine } from "../ui/sanitize.ts"

/** The question isn't open: answered or closed meanwhile, or not a question at all. */
export class QuestionNotOpen extends Schema.TaggedError<QuestionNotOpen>()("QuestionNotOpen", {
  question: Schema.String,
  /** `closed`, or `not labelled human`. */
  why: Schema.String,
}) {
  override get message(): string {
    return `${this.question} is ${this.why}: it isn't an open question`
  }
}

/** What answering a question did: the question's title, and the tickets whose design took it. */
export interface Recorded {
  readonly title: string
  readonly decided: ReadonlyArray<TicketId>
}

/** The decision's section of a blocked ticket's design: its heading, the question and the answer. */
export const decisionSection = (question: TicketId, title: string, answer: string): string =>
  `Decided (${question}): ${title.trim()}\n${answer.trim()}`

/** `design` with `section` below what is there already. */
export const withDecision = (design: string, section: string): string => {
  const before = design.trimEnd()
  return before === "" ? section : `${before}\n\n${section}`
}

/**
 * Answers the open question `question` with `answer`: the decision added to the design of each
 * open ticket it blocks, then bd human respond, which closes it. A ticket bd can't update fails the
 * whole, the question left open, so that answering again does it all.
 */
export const recordAnswer = (
  question: TicketId,
  answer: string,
): Effect.Effect<Recorded, BeadsError | QuestionNotOpen, Beads> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const shown = yield* beads.show(question, { dependents: true })
    if (!shown.labels.includes(HumanLabel)) {
      return yield* new QuestionNotOpen({ question, why: `not labelled ${HumanLabel}` })
    }
    if (shown.status === "closed") return yield* new QuestionNotOpen({ question, why: "closed" })
    const title = sanitizeLine(shown.title).trim()
    const blocked = [
      ...new Set(
        (shown.dependents ?? [])
          .filter((each) => each.type === "blocks" && each.issue?.status !== "closed")
          .map((each) => each.id),
      ),
    ]
    const section = decisionSection(question, title, answer)
    for (const id of blocked) {
      const ticket = yield* beads.show(id)
      yield* beads.update(id, { design: withDecision(ticket.design, section) })
    }
    yield* beads.respond(question, answer)
    return { title, decided: blocked }
  })

/** Why an answer wasn't recorded, as a line says it. */
export const recordWhy = (error: BeadsError | QuestionNotOpen): string =>
  error._tag === "QuestionNotOpen" ? error.message : beadsWhy(error)
