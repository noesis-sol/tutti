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
// - still in progress after the nudges and the idle grace: Stopped, and the run holds with PAUSED
// - left in any other status: set aside, deferred for review
// - its worker gone and its session not resumed: Review (WORKER_GONE), dropped (sessions.ts)
//
// The session is closed once the ticket no longer needs it (§ 4.8, sessions.ts): kept open while it
// waits to merge, and when it stopped the run (it is suspended as the run ends); closed once asked,
// its worker's turn over, to be resumed when the answer is in.
import { Clock, Effect, Ref, Result, Stream } from "effect"
import { AgentHost } from "../agent/AgentHost.ts"
import { formatDuration } from "../project/configFile.ts"
import { Beads, type BeadsError, type Status } from "../services/Beads.ts"
import type { GitError } from "../services/Git.ts"
import type { Store } from "../services/Store.ts"
import { Worktrees } from "../services/Worktrees.ts"
import { leaveForReview, putAside } from "./aside.ts"
import { type Settling, settlingOf } from "./environment.ts"
import { EventStream } from "./eventstream.ts"
import { Ledger } from "./ledger.ts"
import { detail, type Line, Log, line, Tag, tagged, ticketLine } from "./log.ts"
import { beadsWhy, gitWhy } from "./merge.ts"
import type { MergeQueue } from "./mergequeue.ts"
import { Cause, type TicketPhase } from "./phase.ts"
import { fit, workerGone } from "./sessions.ts"
import { idleGrace, type Settled, type SettleEnv, settle, unmergedBlockers } from "./settle.ts"
import { type StartError, type StartedWorker, type StartTicket, start } from "./start.ts"
import type { Deferral, Triage } from "./triage.ts"

/** A ticket that stopped the run, and the exit code the run ends with for it (§ 5 item 10). */
export interface RunStop {
  readonly why: "PAUSED"
  readonly code: number
  readonly ticket: string
  /** The line the log has for it. */
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
}

/** Its blockers, as the log names them: `a`, or `a, b`. */
const named = (blockers: ReadonlyArray<string>): string => blockers.join(", ")

/** Removes the ticket's worktree and branch: what the line saying so ends with. */
const removeWorktree = (worker: StartedWorker, force: boolean) =>
  Effect.gen(function* () {
    const worktrees = yield* Worktrees
    const { id, path, branch } = worker.worktree
    const removed = yield* Effect.result(worktrees.remove(id, { force }))
    if (Result.isSuccess(removed)) return line`worktree and branch removed`
    const why =
      removed.failure._tag === "BadTicketId" ? removed.failure.why : gitWhy(removed.failure)
    return line`but ${Tag.cleanupFailed} for ${path} / ${branch}: ${why}`
  })

/** Closed with no change of its own: Done{noChange}, its worktree and branch removed. */
const noChange = (ticket: StartTicket, worker: StartedWorker, why: string, own: boolean) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const logs = yield* Log
    // Commits that change nothing keep git from deleting the branch as merged; its reflog has them.
    const left = yield* removeWorktree(worker, own)
    const text = detail`${ticket.id} closed with no change: ${why}, so there is nothing to merge; ${left}`
    yield* ledger.transition(ticket.id, Cause.NoChange(), {
      beside: [
        {
          kind: "closed",
          ticket: ticket.id,
          title: ticket.title,
          detail: "no change to merge",
          text,
        },
      ],
    })
    yield* logs.write(text)
  })

/**
 * Stopped with nothing done, having linked `blockers` that haven't merged: Waiting, back in the
 * queue (reopened, if it was left in progress) until they merge, its empty worktree removed.
 */
const waitsForMerge = (
  ticket: StartTicket,
  worker: StartedWorker,
  blockers: ReadonlyArray<string>,
  status: Status,
) =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const ledger = yield* Ledger
    const logs = yield* Log
    const events = yield* EventStream
    const { id } = ticket
    const list = named(blockers)
    const does = blockers.length === 1 ? "it does" : "they do"
    if (status !== "open") {
      const reopened = yield* Effect.result(beads.update(id, { status: "open" }))
      if (Result.isFailure(reopened)) {
        const text = ticketLine(
          Tag.reopenFailed,
        )`${id} stays ${status}, so it won't be back in the queue as it waits for ${list}: ${beadsWhy(reopened.failure)}; reopen it with: bd update ${id} --status open`
        yield* events.emit({ kind: "warn", ticket: id, text })
        yield* logs.write(text)
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
    yield* ledger.transition(id, Cause.WaitsForMerge({ for: list }), {
      beside: [{ kind: "waits", ticket: id, title: ticket.title, detail: list, text }],
    })
    yield* logs.write(text)
  })

/** Still in progress after the nudges and the grace: Stopped, and the run holds with PAUSED. */
const paused = (worker: StartedWorker, gone: string | null) =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const ledger = yield* Ledger
    const logs = yield* Log
    const { id, path } = worker.worktree
    const after =
      gone === null ? line`its worker idle for ${formatDuration(idleGrace)}` : line`${gone}`
    yield* Effect.ignore(
      beads.update(id, {
        appendNotes: `tutti: its worker settled with the ticket still in_progress (worktree ${path}).`,
      }),
    )
    const reason = line`${id} still in_progress, ${after} (worktree ${path}); stopping so it can be answered`
    const text = tagged(Tag.hold)`${line`${Tag.paused}: ${reason}`}`
    yield* ledger.transition(id, Cause.StopRun({ why: "PAUSED" }), {
      beside: [
        { kind: "hold", ticket: id, text },
        { kind: "stop", detail: Tag.paused, ticket: id, text: tagged(Tag.paused)`${reason}` },
      ],
    })
    yield* logs.write(text)
    return { why: "PAUSED", code: stuckCode, ticket: id, line: text } satisfies RunStop
  })

/**
 * Moves the ticket as its worker left it, `settled` saying how; the stop when it stopped the run.
 */
export const conclude = (
  ticket: StartTicket,
  worker: StartedWorker,
  settled: Settled,
  queue: MergeQueue,
): Effect.Effect<RunStop | null, never, SettleEnv> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const logs = yield* Log
    const { id, title } = ticket
    const { path, branch } = worker.worktree
    if (settled._tag === "Paused") return yield* paused(worker, settled.gone)
    if (settled._tag === "Dropped") {
      yield* workerGone(id, path, settled.why)
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
        const text = ticketLine(
          Tag.asked,
        )`${id} waits on your answer to ${q.id} (${q.title}); answer with: bd human respond ${q.id}; worktree ${path} left open`
        yield* ledger.transition(id, Cause.FiledQuestion({ question: q.id }), {
          beside: [{ kind: "asked", ticket: id, title, detail: `${q.id}: ${q.title}`, text }],
        })
        yield* logs.write(text)
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
      case "Uncommitted":
        yield* leaveForReview(id, {
          why: Tag.closedUncommitted,
          detail: "closed with uncommitted changes",
          text: ticketLine(
            Tag.closedUncommitted,
          )`${id} closed (${reading.commit.hash.slice(0, 7)} ${reading.commit.subject}) but ${path} has uncommitted changes to ${reading.files}; worktree left for review`,
        })
        break
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
      case "Deferred": {
        const text = detail`${id} deferred by its worker; worktree ${path} left open`
        yield* ledger.transition(id, Cause.Defer({ why: "by the worker" }), {
          beside: [{ kind: "deferred", ticket: id, title, detail: "by the worker", text }],
        })
        yield* logs.write(text)
        break
      }
      case "InProgress":
      case "Unfinished": {
        const status = reading._tag === "Unfinished" ? reading.status : "in_progress"
        yield* putAside(ticket, {
          note: `tutti: its worker settled with the ticket still '${status}'; deferred for review (worktree ${path}).`,
          reason: `its worker finished without closing it; see worktree ${path}`,
          detail: `still ${status}, noted for review`,
          deferred: detail`${id} still ${status} -> noted and deferred; worktree ${path} left open`,
          failed: `${id} still ${status}, and bd could not defer it`,
          instead: `worktree ${path} left for review`,
        })
        break
      }
    }
    // Its session is closed once the ticket no longer needs it (§ 4.8).
    yield* fit(id)
    return null
  })

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
    const dispatched = yield* Clock.currentTimeMillis
    const started = yield* start(ticket, options.base)
    let stop: RunStop | null = null
    let settling: Settling = "uncounted"
    if (started._tag === "Started") {
      const { worker } = started
      const [settled, limited] = yield* Effect.scoped(
        Effect.gen(function* () {
          const limited = yield* watchLimit(ticket.id)
          return [yield* settle(worker, options.base), yield* Ref.get(limited)] as const
        }),
      )
      stop = yield* conclude(ticket, worker, settled, options.queue)
      if (!limited) yield* toTriage(worker, settled, options.triage)
      settling = yield* settlingOf({
        worker,
        settled,
        started: dispatched,
        limited,
        base: options.base,
      })
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
 * Whether the ticket's worker has been UsageLimited (§ 4.12) since now, watched for the rest of
 * the scope: such a worker never counts toward the environment hold, and isn't triaged.
 */
export const watchLimit = (ticket: string) =>
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
 * Queued; the tickets it put back. A ticket bd can't show waits for the next look.
 */
export const requeueWaiting: Effect.Effect<
  ReadonlyArray<string>,
  never,
  Beads | Ledger | Log
> = Effect.gen(function* () {
  const beads = yield* Beads
  const ledger = yield* Ledger
  const logs = yield* Log
  const back: Array<string> = []
  for (const entry of (yield* ledger.current).tickets.values()) {
    const { phase } = entry
    if (phase._tag !== "Waiting" || phase.for === "probe") continue
    const issue = yield* Effect.result(beads.show(entry.ticket))
    if (Result.isFailure(issue)) continue
    if (unmergedBlockers(issue.success, yield* ledger.current).length > 0) continue
    const queued =
      [...(yield* ledger.current).tickets.values()].filter((each) => each.phase._tag === "Queued")
        .length + 1
    const moved = yield* ledger.transition(entry.ticket, Cause.Requeued(), {
      beside: [{ kind: "queue", queued }],
    })
    if (Result.isFailure(moved)) continue
    yield* logs.write(detail`${entry.ticket}: ${phase.for} merged; back in the queue`)
    back.push(entry.ticket)
  }
  return back
})
