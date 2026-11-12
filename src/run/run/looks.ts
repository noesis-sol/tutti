// The looks (run.ts, § 5 items 3 to 7): what a look reads of its Asked tickets, bd's open list
// read once for the answers and the fill both (asked.ts, askedLook.ts), and the fill, the look's
// effects, which read bd and git: the tickets put back in the queue (work.ts), the setups, checks
// and requires taken again, the carried and answered workers taken up (carry.ts, asked.ts), the
// questions --auto-answer takes (autoAnswer.ts), the free slots filled (schedule.ts) unless bd
// can't read the queue (queueOutage.ts), and the critic's next review (critic.ts).
import { Clock, Duration, Effect, type FileSystem, Ref, Result, SubscriptionRef } from "effect"
import { line } from "../../core/log.ts"
import { formatDuration } from "../../project/configFile.ts"
import { beadsWhy, type Issue } from "../../services/Beads.ts"
import type { Notifier } from "../../services/Notifier.ts"
import { awakeSince } from "../../services/Wake.ts"
import { askedQuestions, readAnswers, takeAnswers } from "../asked.ts"
import { type AskedLook, askedLook } from "../askedLook.ts"
import { answeredQuestions, answerQuestions, notifyLeftOpen } from "../autoAnswer.ts"
import { carryWaiting } from "../carry.ts"
import { stopFor, takesBack, takesNew } from "../holds.ts"
import { backoff, failedRead, lasted, type Outage, readDue, sustained } from "../queueOutage.ts"
import { showOn } from "../runView.ts"
import { beadsOutage } from "../schedule.ts"
import { retrySetups } from "../setup.ts"
import { polledOnly, type Wake } from "../wakes.ts"
import { requeueWaiting, type WorkEnv } from "../work.ts"
import type { RunParts } from "./parts.ts"
import type { Started } from "./start.ts"

/** What a look reads of its Asked tickets (askedLook.ts). */
export interface AskedRead {
  /** bd's open list, read where a ticket is Asked; none where none is, or bd can't list. */
  readonly open: ReadonlyArray<Issue> | undefined
  readonly look: AskedLook
}

/** What the loop looks with, and what the looks leave for its end (runEnd.ts). */
export interface Looks {
  /** bd's open list, read once where a ticket is Asked, for the answers and the fill both. */
  readonly lookAtAsked: Effect.Effect<AskedRead>
  /**
   * The look's effects, which read bd and git, in the run's context; `why`, what woke the look
   * (wakes.ts), for the fill, which the ready poll alone has read bd less often (look.ts).
   */
  readonly fill: (
    why: ReadonlySet<Wake>,
  ) => Effect.Effect<void, never, WorkEnv | FileSystem.FileSystem | Notifier>
  /** Whether a question --auto-answer takes waits for its time, as the last fill found. */
  readonly autoAnswering: Ref.Ref<boolean>
  /** bd failing every fill's read of the queue since, if it does (queueOutage.ts). */
  readonly outage: Ref.Ref<Outage | null>
}

/** The looks, over the run's parts and what the start's steps left. */
export const make = (parts: RunParts, started: Started): Effect.Effect<Looks> =>
  Effect.gen(function* () {
    const { beads, ledger, logs, context, status, holds } = parts.services
    const { stopped } = holds
    const { setUps, gate } = parts.holds
    const { critic, queue, branches } = parts.merge
    const { beforeStart, machine, carrying, scheduler, lookAround } = parts.starting
    const { unslotted, carryOptions, waitingOf } = started
    // Whether a question --auto-answer takes waits for its time, as the last fill found (look.ts).
    const autoAnswering = yield* Ref.make(false)
    // bd failing every fill's read of the queue since, if it does (queueOutage.ts).
    const outage = yield* Ref.make<Outage | null>(null)
    // bd's open list, read here once where a ticket is Asked, for the answers and the fill both: a
    // ticket whose question it has open isn't shown (asked.ts's AskedLook).
    const lookAtAsked = Effect.gen(function* () {
      const asked = [...(yield* ledger.current).tickets.values()].some(
        (entry) => entry.phase._tag === "Asked",
      )
      const listed = asked ? yield* Effect.result(beads.list()) : undefined
      const open = listed !== undefined && Result.isSuccess(listed) ? listed.success : undefined
      // The panel beside the tickets table shows the questions Asked tickets wait on, from the
      // list read for them; with none Asked, none.
      if (!asked) yield* showOn(status, "questions")(new Map())
      else if (open !== undefined) {
        yield* showOn(status, "questions")(askedQuestions(yield* ledger.current, open))
      }
      return { open, look: askedLook(open, (yield* SubscriptionRef.get(status)).answered) }
    })
    // The look's effects, which read bd and git: the tickets put back in the queue, the setups,
    // checks and requires taken again, the carried and answered workers taken up, then the free
    // slots filled.
    const fill = Effect.fn(function* (why: ReadonlySet<Wake>) {
      yield* lookAround
      yield* requeueWaiting(branches)
      // A ticket merged, which may bring what a setup that failed in a ticket's worktree needed.
      yield* retrySetups(setUps)
      // The tickets set aside for a failed check whose base has moved on are checked once more
      // first, each in a slot: each is done but for its merge, and others may wait on it. One left
      // for a hold, a solo ticket or a slot is due again at a later look (recheck.ts).
      yield* queue.recheck
      // The requires list a merge changed, checked before anything starts (requiresChecked), then a
      // spec run's checks gate, once its environment ticket has merged.
      yield* beforeStart
      // The workers carried over that waited for a slot, then the answered tickets, come back
      // before new ones start, each in a slot of its own and counting toward no limit (carry.ts,
      // asked.ts); one with no slot for it waits for a later look. Not while the run holds or
      // winds down, which takes up only what is running: the next run resumes them, though the look
      // still reads which questions are answered.
      yield* Ref.set(unslotted, new Set())
      const gateNow = yield* gate
      if (takesBack(gateNow)) {
        const left = yield* carryWaiting(carryOptions, yield* Ref.get(carrying)).pipe(
          Effect.provideContext(context),
        )
        yield* Ref.set(carrying, waitingOf(left))
      }
      const read = yield* lookAtAsked
      const { look } = read
      let { open } = read
      if (takesBack(gateNow)) {
        // --auto-answer's questions first, so that takeAnswers resumes their tickets at once; one
        // still waiting for its time keeps the run from ending on it.
        const before = (yield* answeredQuestions).length
        yield* Ref.set(autoAnswering, yield* answerQuestions(look))
        // A question answered closed since the list was read: the fill reads it afresh.
        if ((yield* answeredQuestions).length !== before) open = undefined
        yield* takeAnswers(carryOptions, look)
      } else {
        yield* Ref.set(autoAnswering, false)
        // Winding down, it answers none: the questions --auto-answer took at once, which notified
        // nothing, notify now. A hold only puts their answer off.
        if (gateNow.windingDown) yield* notifyLeftOpen
        // A question answered meanwhile needs you no longer, though its ticket comes back later.
        yield* readAnswers(look)
      }
      // Those answered with no slot for them need you no longer: a later look brings them back.
      yield* showOn(status, "answered")(look.noSlot)
      // A fill bd can't read the queue for leaves the slots as they are, and a later look reads it
      // again; bd failing every read for beadsOutage stops the run (queueOutage.ts). One the ready
      // poll alone woke, bd not failing, reads bd for the queue only every busyPoll while every
      // slot is taken (schedule/fill.ts).
      const failing = yield* Ref.get(outage)
      if (takesNew(yield* gate) && readDue(failing, yield* Clock.currentTimeMillis)) {
        const filled = yield* Effect.result(
          scheduler.fillWith(open, failing === null && polledOnly(why)),
        )
        const now = yield* Clock.currentTimeMillis
        if (Result.isSuccess(filled)) {
          yield* Ref.set(outage, null)
          if (failing !== null) {
            const awake = yield* awakeSince(failing.since)
            yield* logs.write(line`read the queue again, after ${lasted(awake)} of bd failing`)
          }
        } else {
          const why = beadsWhy(filled.failure)
          const failed = failedRead(failing, now)
          yield* Ref.set(outage, failed)
          const awake = yield* awakeSince(failed.since)
          if (sustained(awake)) {
            yield* stopped(
              stopFor("BEADS_FAILED", `could not read the queue for ${lasted(awake)}: ${why}`),
            )
          } else {
            const after = backoff(failed.failed)
            const next = Duration.isZero(after) ? "at the next look" : `in ${formatDuration(after)}`
            yield* logs.write(
              line`could not read the queue: ${why}; nothing new starts until it is read, again ${next}, and the run stops if bd fails for ${formatDuration(beadsOutage)}`,
            )
          }
        }
      }
      // For the other runs to count before this one next looks around.
      yield* machine.sayRunning(yield* scheduler.slots)
      // The critic's next review, in a slot the fill left free.
      yield* critic.look
    })
    return { lookAtAsked, fill, autoAnswering, outage }
  })
