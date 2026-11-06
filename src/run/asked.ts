// Asked tickets (§ 2 Question, § 5.1 Working → Asked and Asked → Working, § 4.8 Lifetime). A worker
// that files a `human` question ticket blocking its ticket, then settles, moves its ticket to
// Asked{question} (work.ts's conclude: the `asked` record, the ASKED line, `? for you` and Needs
// you), and its session is closed, its turn over by then (sessions.ts's fit). Its fiber ends, so its
// slot is free: the run goes on.
//
// The ready poll calls takeAnswers, one at a time. It reads each Asked ticket in Beads, and once no
// open question blocks it (its question answered: closed), moves it Asked → Working (the `answered`
// record, the ANSWERED line) and resumes its session, keeping its ID, with a client_composed "your
// question is answered" message (the `resumed` record, the RESUMED line), which names the option
// --auto-answer chose when tutti answered it (autoAnswer.ts, which the fill runs first). The resumed worker takes
// a slot, counting toward no limit (the scheduler's carry), and its ticket goes on as a dispatched
// one does: settled, read, and moved as its worker leaves it. A ticket deferred as well as asked about
// is Asked all the same (settle.ts's read), and is put back in progress as it resumes, so that a
// worker stopping again isn't read as deferring it again. With no slot for it (every slot
// taken, a solo ticket running, the machine at --machine-workers, a hold), it stays Asked, and a
// later poll brings it back; until then it no longer needs you, as the look tells RunView (the
// look's noSlot, Status's answered), so its row says `↻ answered`. A look that takes nothing back,
// the run holding or winding down, still reads which are answered (readAnswers). So does the run where
// no look runs, at each wake (run.ts): the environment hold's wait for its probe, and the end's steps,
// the full check among them. There an answer has its row say `↻ answered`, though a run past its last
// look, having decided to end, resumes nothing: its scheduler is interrupted and its closing line
// written, so the next run takes the ticket back. Within a look, answerQuestions and takeAnswers share what they read
// (AskedLook): bd's open list, read once at the look's start where a ticket is Asked, and each
// Asked ticket's bd show. A ticket whose question that list has still open, labelled human, isn't
// shown at all, as it can't come back yet; one answered by hand drops out of the list and is shown
// and resumed at that look. A session that can't be resumed (its
// worktree or transcript gone, the spawn failing) drops its ticket: WORKER_GONE, left for review,
// its record in state.json forgotten, as sessions.ts's workerGone does. Only bd ready brings it back
// then, so its line says a later run takes it up when it is open, and to reopen it when it is in
// progress, or else to finish it by hand. A ticket bd can't show waits for the next poll.
import { Clock, Effect, Result } from "effect"
import { Beads, type BeadsError, HumanLabel, type Issue, type TicketId } from "../services/Beads.ts"
import { Store } from "../services/Store.ts"
import { nothingEarlier } from "../services/Worktrees.ts"
import type { OpenQuestion } from "../ui/questions.ts"
import { leaveForReview } from "./aside.ts"
import { answeredWith } from "./autoAnswer.ts"
import { Ledger, type State } from "./ledger.ts"
import { detail, Log, line, Tag, ticketLine } from "./log.ts"
import { openQuestionOf } from "./overnightQuestions.ts"
import { Move } from "./phase.ts"
import { fit, resume } from "./sessions.ts"
import { openQuestion } from "./settle.ts"
import type { StartedWorker } from "./start.ts"
import { answeredText } from "./told.ts"
import { follow, type WorkEnv, type WorkError, type Worked, type WorkOptions } from "./work.ts"

export interface AnswerOptions extends WorkOptions {
  /**
   * Runs the resumed worker's fiber in a slot, counting toward no limit: the scheduler's carry.
   * Only with a slot for it, `start` resumes the worker, giving its fiber, or undefined for none.
   * With its issue, its footprint, parent and solo label count as a dispatched ticket's do.
   * Whether there was a slot for it.
   */
  carry(
    ticket: TicketId,
    start: Effect.Effect<Effect.Effect<Worked, WorkError> | undefined>,
    issue?: Issue,
  ): Effect.Effect<boolean>
}

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

/**
 * The questions `state`'s Asked tickets wait on, by ID, each as the panel beside the tickets table
 * puts it (openQuestionOf), from bd's open list as the look read it (`open`), with the tickets
 * waiting on it. One the list doesn't have open is left out: its ticket comes back at this look.
 */
export const askedQuestions = (
  state: State,
  open: ReadonlyArray<Issue>,
): ReadonlyMap<string, OpenQuestion> => {
  const waiting = new Map<string, Array<TicketId>>()
  for (const entry of state.tickets.values()) {
    if (entry.phase._tag !== "Asked") continue
    waiting.set(entry.phase.question, [...(waiting.get(entry.phase.question) ?? []), entry.ticket])
  }
  const found = new Map<string, OpenQuestion>()
  for (const issue of open) {
    const tickets = waiting.get(issue.id)
    if (tickets !== undefined && issue.status !== "closed") {
      found.set(issue.id, openQuestionOf(issue, tickets))
    }
  }
  return found
}

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

/**
 * The question `issue` waited on, `question`, by its title as bd show gives it; the ID alone when
 * its link is gone.
 */
const titleOf = (issue: Issue, question: string): string =>
  issue.dependencies.find((dependency) => dependency.id === question)?.issue?.title ?? question

/** `question`, whose ticket bd couldn't show: as the look before found it, answered or not. */
const unread = (look: AskedLook | undefined, question: string): void => {
  if (look?.known.has(question) === true) look.noSlot.add(question)
}

/**
 * For a look that takes nothing back, the run holding or winding down: which Asked tickets' questions
 * are answered, by the reads takeAnswers makes, each left Asked for when the run takes back again.
 */
export const readAnswers = (look: AskedLook): Effect.Effect<void, never, Beads | Ledger> =>
  Effect.gen(function* () {
    for (const { phase, ticket } of (yield* (yield* Ledger).current).tickets.values()) {
      if (phase._tag !== "Asked" || stillOpen(look, phase.question)) continue
      const issue = yield* Effect.result(shownIn(look, ticket))
      if (Result.isFailure(issue)) unread(look, phase.question)
      else if (openQuestion(issue.success) === undefined) look.noSlot.add(phase.question)
    }
  })

/** The note on a ticket put back in progress as its question is answered. */
export const askedDeferralNote =
  "tutti: deferred while it waited on a question; back in progress, as the question is answered " +
  "and its worker carries on"

/** `id`, deferred while it was Asked: back in progress as its worker comes back. */
const undeferAnswered = (id: TicketId): Effect.Effect<void, never, Beads | Log> =>
  Effect.gen(function* () {
    yield* (yield* Beads).update(id, { status: "in_progress", appendNotes: askedDeferralNote })
    yield* (yield* Log).write(
      detail`${id}: deferred while it waited on its question; back in progress, as that is answered`,
    )
  }).pipe(Effect.ignore)

/**
 * Resumes each Asked ticket whose question is answered (§ 5.1's Asked → Working): its session
 * told so and its fiber carried on in a slot; one with no slot for it stays Asked. With the look's
 * reads (`look`), one whose question its open list has open isn't shown, and one answerQuestions
 * showed isn't shown again. The tickets it resumed.
 */
export const takeAnswers = (
  options: AnswerOptions,
  look?: AskedLook,
): Effect.Effect<ReadonlyArray<string>, never, WorkEnv> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const store = yield* Store
    const context = yield* Effect.context<WorkEnv>()
    const back: Array<string> = []
    for (const entry of (yield* ledger.current).tickets.values()) {
      const { phase, ticket: id, title } = entry
      if (phase._tag !== "Asked" || stillOpen(look, phase.question)) continue
      const issue = yield* Effect.result(shownIn(look, id))
      const { question } = phase
      if (Result.isFailure(issue)) {
        unread(look, question)
        continue
      }
      if (openQuestion(issue.success) !== undefined) continue
      const asked = titleOf(issue.success, question)
      let resumed = false
      // The option --auto-answer chose, when it answered the question rather than you.
      const auto = yield* answeredWith(question)
      const start = Effect.gen(function* () {
        const by = auto === undefined ? "" : " by --auto-answer"
        const text = ticketLine(
          Tag.answered,
        )`${question} (${asked}) is answered${by}, so ${id} comes back`
        const moved = yield* ledger.transition(id, Move.Answered(), {
          said: [{ kind: "answered", ticket: id, title, detail: `${question}: ${asked}`, text }],
        })
        if (Result.isFailure(moved)) return undefined
        if (issue.success.status === "deferred") yield* undeferAnswered(id)
        const saved = yield* store.ticket(id)
        const session = yield* Effect.result(
          resume({
            ticket: id,
            why: "answered",
            message: answeredText({
              id,
              question,
              title: asked,
              ...(auto === undefined ? {} : { auto }),
            }),
            what: line`${id}'s question ${question} is answered`,
          }),
        )
        if (Result.isFailure(session)) {
          // Its record is forgotten, so only bd ready brings it back: open, a later run starts it
          // afresh; in progress, nothing does until it is reopened.
          const next =
            issue.success.status === "open"
              ? "it is in bd ready, so a later run takes it up again"
              : `reopen it to run it again (bd update ${id} --status open)`
          yield* leaveForReview(id, {
            why: Tag.workerGone,
            detail: "answered, its session not resumed",
            text: ticketLine(
              Tag.workerGone,
            )`${id}'s question ${question} is answered, but its session could not be resumed (${session.failure.reason}); worktree ${saved?.worktree ?? ""} left for review, no longer followed; ${next}, or finish it by hand`,
          })
          yield* fit(id)
          yield* Effect.ignore(store.remove(id))
          return undefined
        }
        const worker: StartedWorker = {
          ticket: id,
          worktree: {
            id,
            branch: saved?.branch ?? "",
            path: saved?.worktree ?? "",
            reused: true,
            fresh: false,
            earlier: nothingEarlier,
          },
          session: saved?.session ?? "",
          message: session.success,
        }
        const ticket = { id, title, metadata: issue.success.metadata }
        // Its ticket limit is counted afresh from its resume, as a carried worker's is: the time
        // it waited on the answer is no time of the worker's.
        const since = yield* Clock.currentTimeMillis
        resumed = true
        return Effect.gen(function* () {
          const followed = yield* follow(ticket, worker, options, since)
          return { phase: (yield* ledger.current).tickets.get(id)?.phase, stop: followed.stop }
        }).pipe(Effect.provideContext(context))
      })
      const slot = yield* options.carry(
        id,
        start.pipe(Effect.provideContext(context)),
        issue.success,
      )
      if (!slot) look?.noSlot.add(question)
      if (resumed) back.push(id)
    }
    return back
  })
