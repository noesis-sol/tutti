// Asked tickets (§ 2 Question, § 5.1 Working → Asked and Asked → Working, § 4.8 Lifetime). A worker
// that files a `human` question ticket blocking its ticket, then settles, moves its ticket to
// Asked{question} (work.ts's conclude: the `asked` record, the ASKED line, `? for you` and Needs
// you), and its session is closed, its turn over by then (sessions.ts's fit). Its fiber ends, so its
// slot is free: the run goes on.
//
// The ready poll calls takeAnswers, one at a time. It reads each Asked ticket in Beads, and once no
// open question blocks it (its question answered: closed), moves it Asked → Working (the `answered`
// record, the ANSWERED line) and resumes its session, keeping its ID, with a client_composed "your
// question is answered" message (the `resumed` record, the RESUMED line). The resumed worker takes
// a slot, counting toward no limit (the scheduler's carry), and its ticket goes on as a dispatched
// one does: settled, read, and moved as its worker leaves it. With no slot for it (every slot
// taken, a solo ticket running, the machine at --machine-workers, a hold), it stays Asked, and a
// later poll brings it back. A session that can't be resumed (its
// worktree or transcript gone, the spawn failing) drops its ticket: WORKER_GONE, left for review,
// its record in state.json forgotten, as sessions.ts's workerGone does. Only bd ready brings it back
// then, so its line says a later run takes it up when it is open, and to reopen it when it is in
// progress, or else to finish it by hand. A ticket bd can't show waits for the next poll.
import { Clock, Effect, Result } from "effect"
import { Beads, type Issue } from "../services/Beads.ts"
import { Store } from "../services/Store.ts"
import { nothingEarlier } from "../services/Worktrees.ts"
import { leaveForReview } from "./aside.ts"
import { Ledger } from "./ledger.ts"
import { line, Tag, ticketLine } from "./log.ts"
import { Move } from "./phase.ts"
import { fit, resume } from "./sessions.ts"
import { openQuestion } from "./settle.ts"
import type { StartedWorker } from "./start.ts"
import { follow, type WorkEnv, type WorkError, type Worked, type WorkOptions } from "./work.ts"

/** What a worker whose question is answered is told as its session is resumed. */
export const answeredText = (id: string, question: string, title: string): string =>
  `tutti: your question ${question} (${title}) is answered. Read the answer with bd show ` +
  `${question}, then carry on with ${id} as your instructions say.`

export interface AnswerOptions extends WorkOptions {
  /**
   * Runs the resumed worker's fiber in a slot, counting toward no limit: the scheduler's carry.
   * Only with a slot for it, `start` resumes the worker, giving its fiber, or undefined for none.
   * With its issue, its footprint, parent and solo label count as a dispatched ticket's do.
   * Whether there was a slot for it.
   */
  carry(
    ticket: string,
    start: Effect.Effect<Effect.Effect<Worked, WorkError> | undefined>,
    issue?: Issue,
  ): Effect.Effect<boolean>
}

/**
 * The question `issue` waited on, `question`, by its title as bd show gives it; the ID alone when
 * its link is gone.
 */
const titleOf = (issue: Issue, question: string): string =>
  issue.dependencies.find((dependency) => dependency.id === question)?.issue?.title ?? question

/**
 * Resumes each Asked ticket whose question is answered (§ 5.1's Asked → Working): its session
 * told so and its fiber carried on in a slot; one with no slot for it stays Asked. The tickets it
 * resumed.
 */
export const takeAnswers = (
  options: AnswerOptions,
): Effect.Effect<ReadonlyArray<string>, never, WorkEnv> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const ledger = yield* Ledger
    const store = yield* Store
    const context = yield* Effect.context<WorkEnv>()
    const back: Array<string> = []
    for (const entry of (yield* ledger.current).tickets.values()) {
      const { phase, ticket: id, title } = entry
      if (phase._tag !== "Asked") continue
      const issue = yield* Effect.result(beads.show(id))
      if (Result.isFailure(issue) || openQuestion(issue.success) !== undefined) continue
      const { question } = phase
      const asked = titleOf(issue.success, question)
      let resumed = false
      const start = Effect.gen(function* () {
        const text = ticketLine(
          Tag.answered,
        )`${question} (${asked}) is answered, so ${id} comes back`
        const moved = yield* ledger.transition(id, Move.Answered(), {
          said: [{ kind: "answered", ticket: id, title, detail: `${question}: ${asked}`, text }],
        })
        if (Result.isFailure(moved)) return undefined
        const saved = yield* store.ticket(id)
        const session = yield* Effect.result(
          resume(
            id,
            "answered",
            answeredText(id, question, asked),
            line`${id}'s question ${question} is answered`,
          ),
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
      yield* options.carry(id, start.pipe(Effect.provideContext(context)), issue.success)
      if (resumed) back.push(id)
    }
    return back
  })
