// What one look reads of bd for its Asked tickets (spec § 5.1's "What a look reads of its Asked
// tickets"): the questions for you bd's open list has open, read once at the look's start, and each
// Asked ticket's issue as bd show gave it this look, shared by the look's answerQuestions
// (autoAnswer.ts) and takeAnswers (asked.ts), neither of which imports the other.
import { Effect } from "effect"
import { Beads, type BeadsError, HumanLabel, type Issue, type TicketId } from "../services/Beads.ts"

/**
 * What one look read of bd for its Asked tickets, shared by answerQuestions and takeAnswers: the
 * questions for you bd's open list has open, read once at the look's start (undefined where the
 * look didn't read it, or bd couldn't), and each Asked ticket's issue as bd show gave it this look.
 * A question answered in the look leaves both: its ticket is shown again.
 */
export interface AskedLook {
  readonly open: Set<string> | undefined
  readonly shown: Map<TicketId, Issue>
  /** The questions this look found answered whose tickets have no slot to come back in. */
  readonly noSlot: Set<string>
  /** Those the look before found so: one whose ticket bd can't show now stays so. */
  readonly known: ReadonlySet<string>
}

/**
 * A look's reads (AskedLook) from bd's open list, `open`, as the look read it at its start, and the
 * questions the look before found answered with no slot, `known`.
 */
export const askedLook = (
  open: ReadonlyArray<Issue> | undefined,
  known: ReadonlySet<string> = new Set(),
): AskedLook => ({
  open:
    open === undefined
      ? undefined
      : new Set(
          open
            .filter((issue) => issue.status !== "closed" && issue.labels.includes(HumanLabel))
            .map((issue) => issue.id),
        ),
  shown: new Map(),
  noSlot: new Set(),
  known,
})

/** Whether the look's open list has `question` still open for you: its ticket can't come back. */
export const stillOpen = (look: AskedLook | undefined, question: string): boolean =>
  look?.open?.has(question) === true

/** `ticket`'s issue as bd show gives it, shown once a look. */
export const shownIn = (
  look: AskedLook | undefined,
  ticket: TicketId,
): Effect.Effect<Issue, BeadsError, Beads> =>
  Effect.gen(function* () {
    const known = look?.shown.get(ticket)
    if (known !== undefined) return known
    const issue = yield* (yield* Beads).show(ticket)
    look?.shown.set(ticket, issue)
    return issue
  })

/** `question`, which `ticket` waited on, answered in the look: both are read afresh. */
export const answeredIn = (
  look: AskedLook | undefined,
  ticket: TicketId,
  question: string,
): void => {
  look?.open?.delete(question)
  look?.shown.delete(ticket)
}
