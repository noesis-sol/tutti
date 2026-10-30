// The per-ticket fiber (§ 5 item 6, § 5.1's transitions from Working): its worker started
// (start.ts), settled and its ticket read (settle.ts), then the outcome, each through the ledger's
// transition():
//
// - closed, a commit naming it, its worktree clean and on its branch: ToMerge, in the merge queue
// - closed with no change of its own to merge: Done{noChange}, its worktree and branch removed
// - closed without a commit naming it while it has changes, with uncommitted changes, or off its
//   branch: Review, `warn` with `aside`
// - a question it filed that blocks it: Asked (asked.ts takes it from there)
// - deferred by its worker: Deferred, and handed to triage (triage.ts) unless its worker reached the
//   usage limit in its attempt; so is a ticket tutti defers for a worker that left it unfinished
// - stopped with nothing done, having linked a blocker that hasn't merged: Waiting (WAITS_FOR_MERGE),
//   its worktree and branch removed; back to Queued once the blocker merges (§ 5 item 9)
// - stopped with nothing done, having linked a blocker that merged after its worktree was cut:
//   Queued at once, its worktree and branch removed, to start again from the base's head
// - still in progress after the nudges and the idle grace: Stopped, and the run holds with PAUSED
// - left in any other status: set aside, deferred for review
// - its worker gone and its session not resumed: Review (WORKER_GONE), dropped (sessions.ts)
// - its worker ended over a setup problem its first system/init showed, or its start found before
//   its first turn (§ 4.1): reopened, Waiting for the next run, and the run holds with
//   SETUP_PROBLEM, exit 2
//
// The session is closed once the ticket no longer needs it (§ 4.8, sessions.ts): kept open while it
// waits to merge, and when it stopped the run (it is suspended as the run ends); closed once asked,
// its worker's turn over, to be resumed when the answer is in.
import { Clock, Deferred, Effect, Ref, Result, Stream } from "effect"
import { AgentHost } from "../agent/AgentHost.ts"
import { formatDuration } from "../project/configFile.ts"
import { Beads, type BeadsError, beadsWhy, type Status, type TicketId } from "../services/Beads.ts"
import { type Git, type GitError, gitWhy, shortHash } from "../services/Git.ts"
import { Store } from "../services/Store.ts"
import { type TicketWorktree, Worktrees } from "../services/Worktrees.ts"
import { dropNothingDone, leaveForReview, nothingLeft, putAside } from "./aside.ts"
import { autoAnswerOf, takenAtOnce } from "./autoAnswer.ts"
import { asking, type ClosedBranches, offBase } from "./closedBranches.ts"
import { type Settling, settlingOf } from "./environment.ts"
import type { EventStream } from "./eventstream.ts"
import { exitCodes, type StopReason, timeLimit } from "./holds.ts"
import { Ledger } from "./ledger.ts"
import { detail, type Line, type Log, line, Tag, tagged, ticketLine } from "./log.ts"
import type { MergeQueue } from "./mergequeue.ts"
import {
  limitStuck,
  type OvernightAside,
  pausedStuck,
  type Stuck,
  setAside as setAsideOvernight,
} from "./overnightAside.ts"
import { Move, type TicketPhase } from "./phase.ts"
import { warn } from "./say.ts"
import { fit, workerGone } from "./sessions.ts"
import {
  idleGrace,
  listChanges,
  Settled,
  type SettleEnv,
  settle,
  unmergedBlockers,
} from "./settle.ts"
import type { SetUps } from "./setup.ts"
import { type StartError, type StartedWorker, type StartTicket, start } from "./start.ts"
import type { Deferral, Triage } from "./triage.ts"

/** A ticket that stopped the run, and the exit code the run ends with for it (§ 5 item 10). */
export interface RunStop {
  readonly why: "PAUSED" | "SETUP_PROBLEM"
  readonly code: number
  readonly ticket: TicketId
  /** The line the run ends with for it, `PAUSED: …`; its HOLD line is the run's to say. */
  readonly line: Line
}

/** The exit code of a worker that stopped the run, as orchestra's ExitStuck. */
export const stuckCode = 3

/**
 * How the ticket's fiber ended: its phase, the stop when it stopped the run, and how its worker
 * settled, as the environment hold counts it (`other` when left out: a resumed worker's).
 */
export interface Worked {
  readonly phase: TicketPhase | undefined
  readonly stop: RunStop | null
  readonly settling?: Settling
}

/** What the per-ticket fiber can fail with, for the run to stop on. */
export type WorkError = StartError | BeadsError | GitError

/** Every service the per-ticket fiber uses. */
export type WorkEnv = SettleEnv | Store

export interface WorkOptions {
  /** Where finished tickets land. */
  readonly base: string
  readonly queue: MergeQueue
  /** The run's triage, which each ticket set aside as its worker settles is handed to. */
  readonly triage?: Triage
  /** Takes the TICKET_LIMIT stop of a worker still going --ticket-limit after its dispatch. */
  readonly onTicketLimit?: (stop: StopReason) => Effect.Effect<void>
  /**
   * An overnight run's register (overnightAside.ts): with it, PAUSED, BLOCKED and TICKET_LIMIT set
   * the ticket aside rather than hold the run.
   */
  readonly overnight?: OvernightAside
  /** The run's setups (setup.ts), which the merge queue shares; the settings' setup when absent. */
  readonly setUps?: SetUps
  /**
   * What git says of closed blockers the run knows nothing of: one whose work is only on its
   * branch hasn't merged, for WAITS_FOR_MERGE. Without it, such a blocker counts as merged.
   */
  readonly closedBranches?: ClosedBranches
}

/** Its blockers, as the log names them: `a`, or `a, b`. */
const named = (blockers: ReadonlyArray<TicketId>): string => blockers.join(", ")

/** Removes the ticket's worktree and branch: what the line saying so ends with. */
const removeWorktree = (worker: StartedWorker, force: boolean) =>
  Effect.gen(function* () {
    const worktrees = yield* Worktrees
    const { id, path, branch } = worker.worktree
    const removed = yield* Effect.result(worktrees.remove(id, { force }))
    if (Result.isSuccess(removed)) return line`worktree and branch removed`
    return line`but ${Tag.cleanupFailed} for ${path} / ${branch}: ${gitWhy(removed.failure)}`
  })

/** Closed with no change of its own: Done{noChange}, its worktree and branch removed. */
const noChange = (ticket: StartTicket, worker: StartedWorker, why: string, own: boolean) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    // Commits that change nothing keep git from deleting the branch as merged; its reflog has them.
    const left = yield* removeWorktree(worker, own)
    const text = detail`${ticket.id} closed with no change: ${why}, so there is nothing to merge; ${left}`
    yield* ledger.transition(ticket.id, Move.NoChange(), {
      said: [
        {
          kind: "closed",
          ticket: ticket.id,
          title: ticket.title,
          detail: "no change to merge",
          text,
        },
      ],
    })
    // Done, it has nothing left for a later run: its record in state.json goes.
    yield* Effect.ignore((yield* Store).remove(ticket.id))
  })

/**
 * Stopped with nothing done, having linked `blockers` that haven't merged: Waiting, back in the
 * queue (reopened, if it was left in progress) until they merge, its empty worktree removed.
 */
const waitsForMerge = (
  ticket: StartTicket,
  worker: StartedWorker,
  blockers: ReadonlyArray<TicketId>,
  status: Status,
) =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const ledger = yield* Ledger
    const { id } = ticket
    const list = named(blockers)
    const does = blockers.length === 1 ? "it does" : "they do"
    if (status !== "open") {
      const reopened = yield* Effect.result(beads.update(id, { status: "open" }))
      if (Result.isFailure(reopened)) {
        const text = ticketLine(
          Tag.reopenFailed,
        )`${id} stays ${status}, so it won't be back in the queue as it waits for ${list}: ${beadsWhy(reopened.failure)}; reopen it with: bd update ${id} --status open`
        yield* warn(text, id)
      }
    }
    yield* Effect.ignore(
      beads.update(id, {
        appendNotes: `tutti: started before ${list} merged; back in the queue until ${does}.`,
      }),
    )
    const left = yield* removeWorktree(worker, false)
    const text = ticketLine(
      Tag.waitsForMerge,
    )`${id} waits for ${list} to merge; its worker stopped with nothing done, so it is back in the queue until ${does}; ${left}`
    yield* ledger.transition(id, Move.WaitsForMerge({ blockers }), {
      said: [{ kind: "waits", ticket: id, title: ticket.title, detail: list, text }],
    })
  })

/**
 * Stopped with nothing done, having linked `blockers` that merged after its worktree was cut from
 * `cut`: back in the queue at once (reopened, if it was left in progress), its empty worktree and
 * branch removed, so that it starts again from the base's head.
 */
const mergedSinceCut = (
  ticket: StartTicket,
  worker: StartedWorker,
  blockers: ReadonlyArray<TicketId>,
  cut: string,
  status: Status,
) =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const ledger = yield* Ledger
    const { id } = ticket
    const list = named(blockers)
    if (status !== "open") {
      const reopened = yield* Effect.result(beads.update(id, { status: "open" }))
      if (Result.isFailure(reopened)) {
        const text = ticketLine(
          Tag.reopenFailed,
        )`${id} stays ${status}, so it won't be back in the queue now that ${list} merged: ${beadsWhy(reopened.failure)}; reopen it with: bd update ${id} --status open`
        yield* warn(text, id)
      }
    }
    yield* Effect.ignore(
      beads.update(id, {
        appendNotes: `tutti: its worktree was cut from ${shortHash(cut)}, before ${list} merged; back in the queue to start again from the base's head.`,
      }),
    )
    const left = yield* removeWorktree(worker, false)
    const queued =
      [...(yield* ledger.current).tickets.values()].filter((each) => each.phase._tag === "Queued")
        .length + 1
    yield* ledger.transition(id, Move.MergedSinceCut({ blockers }), {
      beside: [{ kind: "queue", queued }],
      lines: [
        detail`${id} back in the queue: ${list} merged after its worktree was cut from ${shortHash(cut)}; ${left}`,
      ],
    })
  })

/** Still in progress after the nudges and the grace: Stopped, and the run holds with PAUSED. */
const paused = (worker: StartedWorker, gone: string | null) =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const ledger = yield* Ledger
    const { id, path } = worker.worktree
    const after =
      gone === null ? line`its worker idle for ${formatDuration(idleGrace)}` : line`${gone}`
    yield* Effect.ignore(
      beads.update(id, {
        appendNotes: `tutti: its worker settled with the ticket still in_progress (worktree ${path}).`,
      }),
    )
    const reason = line`${id} still in_progress, ${after} (worktree ${path}); stopping so it can be answered`
    const text = tagged(Tag.paused)`${reason}`
    // The run says the HOLD line, with the tickets still running, as it takes the stop.
    yield* ledger.transition(id, Move.StopRun({ why: "PAUSED" }), {
      beside: [{ kind: "stop", detail: Tag.paused, ticket: id, text }],
    })
    return { why: "PAUSED", code: stuckCode, ticket: id, line: text } satisfies RunStop
  })

/**
 * Its worker ended over a setup problem its first system/init showed, or its start found before its
 * first turn (§ 4.1), before it did anything: the ticket is reopened, as no worker took it on, and Waiting for the next run, its
 * worktree kept; the run holds with SETUP_PROBLEM, exit 2, as for a setup problem found at startup.
 */
const setupProblem = (worktree: TicketWorktree, problem: string) =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const ledger = yield* Ledger
    const { id, path } = worktree
    const reopened = yield* Effect.result(
      beads.update(id, {
        status: "open",
        appendNotes: `tutti: reopened; its worker was stopped before it did anything, over a setup problem: ${problem}.`,
      }),
    )
    if (Result.isFailure(reopened)) {
      const text = ticketLine(
        Tag.reopenFailed,
      )`${id}'s worker was stopped over a setup problem, and bd could not reopen it: ${beadsWhy(reopened.failure)}; reopen it with: bd update ${id} --status open`
      yield* warn(text, id)
    }
    const reason = line`${id}'s worker was stopped before it did anything: ${problem}; ${id} is reopened (worktree ${path}); fix the setup, then run again`
    const text = tagged(Tag.setupProblem)`${reason}`
    // The run says the HOLD line, with the tickets still running, as it takes the stop.
    yield* ledger.transition(id, Move.SetupProblem(), {
      beside: [{ kind: "stop", detail: Tag.setupProblem, ticket: id, text }],
    })
    return {
      why: "SETUP_PROBLEM",
      code: exitCodes.setup,
      ticket: id,
      line: text,
    } satisfies RunStop
  })

/**
 * Moves the ticket as its worker left it, `settled` saying how; the stop when it stopped the run.
 * In an overnight run (`overnight`), a ticket Paused or Stuck is set aside instead.
 */
export const conclude = (
  ticket: StartTicket,
  worker: StartedWorker,
  settled: Settled,
  queue: MergeQueue,
  overnight?: OvernightAside,
): Effect.Effect<RunStop | null, never, SettleEnv> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const { id, title } = ticket
    const { path, branch } = worker.worktree
    if (overnight !== undefined && (settled._tag === "Paused" || settled._tag === "Stuck")) {
      const stuck =
        settled._tag === "Stuck"
          ? settled.stuck
          : pausedStuck(settled.left, formatDuration(idleGrace))
      yield* setAsideOvernight(ticket, worker, stuck, overnight)
      yield* fit(id)
      return null
    }
    // Only an overnight run's fiber is Stuck; otherwise its ticket holds the run, as Paused.
    if (settled._tag === "Paused" || settled._tag === "Stuck") {
      return yield* paused(worker, settled._tag === "Paused" ? settled.gone : null)
    }
    if (settled._tag === "Setup") return yield* setupProblem(worker.worktree, settled.problem)
    if (settled._tag === "Dropped") {
      yield* workerGone({ ticket: id, worktree: path, why: settled.why })
      yield* fit(id)
      return null
    }
    const { reading } = settled
    switch (reading._tag) {
      case "Finished":
        // Its session stays open while it waits to merge: a conflict may be handed back to it.
        yield* queue.offer({ id, title, branch, worktree: path })
        return null
      case "Asked": {
        const q = reading.question
        // With --auto-answer, why it leaves the question to you, if it does, and whether it
        // answers it at once, which doesn't notify (autoAnswer.ts).
        const { leaves, atOnce } = yield* autoAnswerOf(q.id)
        const text = ticketLine(
          Tag.asked,
        )`${id} waits on your answer to ${q.id} (${q.title}); answer with: bd human respond ${q.id}; worktree ${path} left open${leaves}`
        const detail = `${q.id}: ${q.title}`
        const auto = atOnce ? { auto_answering: true as const } : {}
        // Noted first, so that a look answering it meanwhile finds it: one the run winds down or
        // ends with notifies then (autoAnswer.ts's notifyLeftOpen).
        if (atOnce) yield* takenAtOnce(id, q.id, q.title)
        yield* ledger.transition(id, Move.FiledQuestion({ question: q.id }), {
          said: [{ kind: "asked", ticket: id, title, detail, ...auto, text }],
        })
        break
      }
      case "NoChange":
        yield* noChange(ticket, worker, reading.why, reading.own)
        break
      case "NoCommit":
        yield* leaveForReview(id, {
          why: Tag.closedWithoutCommit,
          detail: "closed without a commit",
          text: ticketLine(
            Tag.closedWithoutCommit,
          )`no commit on ${branch} names ${id}; worktree ${path} left for review`,
        })
        break
      case "Uncommitted": {
        const { shown, more } = listChanges(reading.files)
        const andMore = more === 0 ? "" : ` and ${more} more`
        yield* leaveForReview(id, {
          why: Tag.closedUncommitted,
          detail: "closed with uncommitted changes",
          text: ticketLine(
            Tag.closedUncommitted,
          )`${id} closed (${shortHash(reading.commit.hash)} ${reading.commit.subject}) but ${path} has uncommitted changes: ${shown}${andMore}; worktree left for review (commit or remove them)`,
        })
        break
      }
      case "OffBranch":
        yield* leaveForReview(id, {
          why: Tag.offBranch,
          detail: `worktree not on ${branch}`,
          text: ticketLine(
            Tag.offBranch,
          )`${id} closed, but its worktree ${path} has ${reading.on}, not ${branch}; worktree left for review`,
        })
        break
      case "WaitsForMerge":
        yield* waitsForMerge(ticket, worker, reading.blockers, reading.status)
        break
      case "MergedSinceCut":
        yield* mergedSinceCut(ticket, worker, reading.blockers, reading.cut, reading.status)
        break
      case "Deferred": {
        const left = reading.nothingDone ? nothingLeft : line`worktree ${path} left open`
        const text = detail`${id} deferred by its worker; ${left}`
        yield* ledger.transition(id, Move.Defer({ why: "by the worker" }), {
          said: [{ kind: "deferred", ticket: id, title, detail: "by the worker", text }],
        })
        break
      }
      case "InProgress":
      case "Unfinished": {
        const status = reading._tag === "Unfinished" ? reading.status : "in_progress"
        const failed = `${id} still ${status}, and bd could not defer it`
        const detailed = `still ${status}, noted for review`
        yield* putAside(
          ticket,
          reading.nothingDone
            ? {
                note: `tutti: its worker settled with the ticket still '${status}' and nothing done (no commits, no changes); deferred for review, its worktree and branch removed.`,
                reason: "its worker finished without closing it, and with nothing done",
                detail: detailed,
                deferred: detail`${id} still ${status} -> noted and deferred; ${nothingLeft}`,
                failed,
                instead: nothingLeft,
              }
            : {
                note: `tutti: its worker settled with the ticket still '${status}'; deferred for review (worktree ${path}).`,
                reason: `its worker finished without closing it; see worktree ${path}`,
                detail: detailed,
                deferred: detail`${id} still ${status} -> noted and deferred; worktree ${path} left open`,
                failed,
                instead: `worktree ${path} left for review`,
              },
        )
        break
      }
    }
    // Its session is closed once the ticket no longer needs it (§ 4.8).
    yield* fit(id)
    return null
  })

/** What became of a ticket's worker: how it settled, and the stop when it stopped the run. */
export interface Followed {
  readonly settled: Settled
  /** Whether it reached the usage limit (§ 4.12) on the way. */
  readonly limited: boolean
  readonly stop: RunStop | null
}

/**
 * Follows the ticket's worker, started or resumed, to its outcome: TICKET_LIMIT counted from
 * `since` while it goes on, settled, its ticket moved as it left it, and handed to triage when set
 * aside, unless it reached the usage limit.
 */
export const follow = (
  ticket: StartTicket,
  worker: StartedWorker,
  options: WorkOptions,
  since: number,
): Effect.Effect<Followed, BeadsError | GitError, WorkEnv> =>
  Effect.gen(function* () {
    const { overnight } = options
    // In an overnight run, BLOCKED and TICKET_LIMIT set the ticket aside: whichever comes first ends
    // the wait for its worker to settle. Registered until its ticket is set aside, so that BLOCKED
    // finds its fiber until its requests are denied.
    const stuck = yield* Deferred.make<Stuck>()
    if (overnight !== undefined) yield* overnight.follow(ticket.id, stuck)
    const [settled, limited] = yield* Effect.scoped(
      Effect.gen(function* () {
        const limited = yield* watchLimit(ticket.id)
        // TICKET_LIMIT or LONG_RUNNING while it goes on (holds.ts); the worker isn't interrupted,
        // but in an overnight run.
        yield* timeLimit(
          ticket.id,
          worker.worktree.path,
          since,
          overnight === undefined
            ? (options.onTicketLimit ?? (() => Effect.void))
            : (_, limit) => Deferred.succeed(stuck, limitStuck(limit)),
          overnight === undefined,
        ).pipe(Effect.forkScoped({ startImmediately: true }))
        const settled = yield* Effect.raceFirst(
          settle(worker, options.base, options.closedBranches),
          Effect.map(Deferred.await(stuck), (stuck) => Settled.Stuck({ stuck })),
        )
        return [settled, yield* Ref.get(limited)] as const
      }),
    )
    const stop = yield* conclude(ticket, worker, settled, options.queue, overnight)
    yield* leaveAside(worker, settled, limited, options.triage)
    return { settled, limited, stop }
  }).pipe(Effect.scoped)

/**
 * The per-ticket fiber, for a ticket dispatched and Working: its worker started on `base`, settled,
 * and its ticket moved as it left it. Fails on what the run stops for: git making its worktree,
 * state.json, or Beads and git failing to say what the worker left.
 */
export const work = (
  ticket: StartTicket,
  options: WorkOptions,
): Effect.Effect<Worked, WorkError, WorkEnv> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const started = yield* start(ticket, options.base, options.setUps)
    let stop: RunStop | null = null
    // A setup that failed before its worker could start, and a session that didn't start, count
    // toward the environment hold as a worker failing at once does.
    let settling: Settling =
      started._tag === "SetupFailed"
        ? "setup"
        : started._tag === "SetAside" && started.session
          ? "start"
          : "uncounted"
    // Stopped over a setup problem as its session started, it stops the run (§ 4.1).
    if (started._tag === "SetupProblem")
      stop = yield* setupProblem(started.worktree, started.problem)
    if (started._tag === "Started") {
      const { worker } = started
      // Its clocks, the hold's window and its time limit, start with its worker, once the setup
      // before it is done: a setup that takes minutes is no time of the worker's.
      const dispatched = yield* Clock.currentTimeMillis
      const followed = yield* follow(ticket, worker, options, dispatched)
      const { settled, limited } = followed
      stop = followed.stop
      settling = yield* settlingOf({ settled, started: dispatched, limited })
    }
    return { phase: (yield* ledger.current).tickets.get(ticket.id)?.phase, stop, settling }
  })

/**
 * What triage is told of a ticket set aside as its worker settled, as conclude set it aside:
 * deferred by its worker, or by tutti for a worker that left it unfinished; undefined otherwise.
 */
export const deferralOf = (worker: StartedWorker, settled: Settled): Deferral | undefined => {
  if (settled._tag !== "Read") return undefined
  const { reading, state } = settled
  const left = (status: Status) =>
    `the worker settled with the ticket still '${status}', so tutti deferred it`
  const how =
    reading._tag === "Deferred"
      ? "the worker deferred it"
      : reading._tag === "InProgress"
        ? left("in_progress")
        : reading._tag === "Unfinished"
          ? left(reading.status)
          : undefined
  if (how === undefined) return undefined
  return {
    ticket: worker.ticket,
    how,
    worktree: worker.worktree.path,
    ...(state._tag === "Failed" ? { failed: state.error } : {}),
  }
}

/**
 * Hands the ticket to `triage` when conclude set it aside (§ 5 item 13). The caller leaves out a
 * ticket whose worker was UsageLimited in its attempt (§ 4.12).
 */
export const toTriage = (
  worker: StartedWorker,
  settled: Settled,
  triage: Triage | undefined,
): Effect.Effect<void, never, Ledger> =>
  Effect.gen(function* () {
    const deferral = deferralOf(worker, settled)
    if (triage === undefined || deferral === undefined) return
    const phase = (yield* (yield* Ledger).current).tickets.get(worker.ticket)?.phase
    if (phase?._tag === "Deferred") yield* triage.deferred(deferral)
  })

/**
 * Once conclude has set the ticket aside: hands it to `triage`, unless its worker reached the usage
 * limit in its attempt (`limited`), then removes its worktree and branch when its worker left
 * nothing done (aside.ts).
 */
export const leaveAside = (
  worker: StartedWorker,
  settled: Settled,
  limited: boolean,
  triage: Triage | undefined,
): Effect.Effect<void, never, EventStream | Ledger | Log | Worktrees> =>
  Effect.gen(function* () {
    if (!limited) yield* toTriage(worker, settled, triage)
    // Only the readings conclude sets aside say whether their worker did anything.
    if (settled._tag !== "Read" || !("nothingDone" in settled.reading)) return
    if (settled.reading.nothingDone) yield* dropNothingDone(worker.worktree)
  })

/**
 * Whether the ticket's worker has been UsageLimited (§ 4.12) since now, watched for the rest of
 * the scope: such a worker never counts toward the environment hold, and isn't triaged.
 */
export const watchLimit = (ticket: TicketId) =>
  Effect.gen(function* () {
    const host = yield* AgentHost
    const limited = yield* Ref.make(false)
    yield* host.state(ticket).pipe(
      Stream.takeUntil((state) => state._tag === "UsageLimited"),
      Stream.runForEach((state) =>
        state._tag === "UsageLimited" ? Ref.set(limited, true) : Effect.void,
      ),
      Effect.ignore,
      Effect.forkScoped({ startImmediately: true }),
    )
    return limited
  })

/**
 * Puts each Waiting ticket whose blockers have all merged back in the queue (§ 5 item 9), Waiting →
 * Queued; the tickets it put back. `closed`, the run's, says which closed blockers the run knows
 * nothing of haven't merged. A ticket bd can't show waits for the next look.
 */
export const requeueWaiting = (
  closed?: ClosedBranches,
): Effect.Effect<ReadonlyArray<string>, never, Beads | Git | Ledger | Log> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const ledger = yield* Ledger
    const ask = closed === undefined ? undefined : asking(closed)
    const back: Array<string> = []
    for (const entry of (yield* ledger.current).tickets.values()) {
      const { phase } = entry
      if (phase._tag !== "Waiting" || phase.for._tag !== "Blockers") continue
      const issue = yield* Effect.result(beads.show(entry.ticket))
      if (Result.isFailure(issue)) continue
      const state = yield* ledger.current
      const branches = yield* offBase(ask, state, issue.success.dependencies, ["blocks"])
      if (unmergedBlockers(issue.success, state, branches).length > 0) continue
      const queued =
        [...(yield* ledger.current).tickets.values()].filter((each) => each.phase._tag === "Queued")
          .length + 1
      const moved = yield* ledger.transition(entry.ticket, Move.Requeued(), {
        beside: [{ kind: "queue", queued }],
        lines: [detail`${entry.ticket}: ${named(phase.for.ids)} merged; back in the queue`],
      })
      if (Result.isFailure(moved)) continue
      back.push(entry.ticket)
    }
    return back
  })
