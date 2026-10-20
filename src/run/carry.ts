// Carry-over (§ 2, § 4.8's The next run and The other carry-over cases, § 5.1's The next run): the
// workers a run leaves, saved in state.json, taken up by the next run, before its first dispatch.
// A ticket is saved with why its session was suspended: as the run ended with it Stopped (sessions.ts,
// run.ts), or waiting on a question, Asked (saveAsked). The next run takes up each, in ID order,
// once it has checked it:
//
// - one whose ticket bd has no trace of, deleted from Beads, is dropped;
// - one whose worktree is gone is dropped, found before anything resumes it (§ 4.8's Resume limits);
// - one whose ticket is closed is merged: in line, ToMerge (§ 5.1's Unmerged), or dropped when its
//   branch is on the base already, merged by hand (unmerged.ts's mergedSince);
// - one deferred meanwhile is shown as deferred, and dropped: undeferred, it comes back through bd
//   ready, its worktree reused;
// - one waiting on a question, or asked as the last run ended, comes back Asked (§ 5.1's StillAsked);
//   once its question is answered, it is resumed and told so (asked.ts), at once when it was
//   answered between runs;
// - any other is resumed, `resume: <session ID>`, Working (§ 5.1's Resumed): told it was interrupted
//   and to carry on, with this run's facts (§ 4.1), as its session starts. Its fiber takes a slot,
//   counting toward no limit (the scheduler's carry), its ticket limit counted afresh, and goes on
//   as a dispatched ticket's does. A session that can't be resumed drops its ticket: WORKER_GONE,
//   left for review (sessions.ts).
//
// One that can't be checked (bd can't show its ticket, the worktree can't be looked for) is kept
// for the next run, as is one outside this run's --ticket scope. A dropped ticket is forgotten in
// state.json.
//
// A run that ends saves the phase each of its other tickets left it in (saveLeft), so a record
// with neither why it was suspended nor a phase is one whose run never reached its end: it crashed
// (kill -9, a power cut), leaving its workers' sessions unsuspended, since a crash can't lose a
// session ID (§ 4.8). Once that run's process is gone, the next run takes up such a ticket as a
// suspended one (`crashed`) when bd has it in progress or closed; one in any other state, back in
// the queue or set aside, is forgotten.
import { Clock, Effect, FileSystem, Result } from "effect"
import { AppConfig } from "../cli/AppConfig.ts"
import { Beads, type BeadsError, type Issue } from "../services/Beads.ts"
import { type PhaseName, Store, type TicketRecord } from "../services/Store.ts"
import { branchOf, nothingEarlier, ticketIdProblem } from "../services/Worktrees.ts"
import { type AnswerOptions, takeAnswers } from "./asked.ts"
import { EventStream } from "./eventstream.ts"
import { Ledger } from "./ledger.ts"
import { detail, type Line, Log, line } from "./log.ts"
import { beadsWhy } from "./merge.ts"
import { Cause } from "./phase.ts"
import { readAgainAfter, readTries } from "./schedule.ts"
import { descendants } from "./scope.ts"
import { resume, workerGone } from "./sessions.ts"
import { openQuestion } from "./settle.ts"
import { runFacts, type StartedWorker } from "./start.ts"
import { mergedSince } from "./unmerged.ts"
import { follow, type WorkEnv, type WorkError, type Worked } from "./work.ts"

/** The metadata key holding the question an asked ticket waited on as the run ended. */
export const questionKey = "asked_question"

/** Why an asked ticket is saved, as state.json has it. */
export const askedWhy = "asked"

/** Why a ticket a crashed run left in state.json is carried over, as its carry-on message says. */
export const crashedWhy = "crashed"

/** Whether the process `pid` is running: one this user may not signal is too. */
export const processRunning = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** What a suspended worker is told as the next run resumes its session. */
export const carryOnText = (id: string, why: string, facts: ReadonlyArray<string> = []): string =>
  [
    `tutti: the last run ended (${why}) while you were working on ${id}, and interrupted you; ` +
      `this run resumes your session. Carry on with ${id} where you left off, as your ` +
      "instructions say.",
    ...facts,
  ].join("\n\n")

export interface CarryOptions extends AnswerOptions {
  /**
   * Runs a resumed worker's fiber, `work`, in a slot, counting toward no limit: the scheduler's
   * carry. With its issue, its footprint, parent and solo label count as a dispatched ticket's do.
   */
  carry(ticket: string, work: Effect.Effect<Worked, WorkError>, issue?: Issue): Effect.Effect<void>
}

/** What became of a saved worker. */
export type Carried =
  | "resumed"
  | "asked"
  | "toMerge"
  | "merged"
  | "deferred"
  | "deleted"
  | "worktreeGone"
  | "workerGone"
  | "kept"

/** Every service carry-over uses. */
export type CarryEnv = WorkEnv | FileSystem.FileSystem

/** `<id>, carried over from the last run, <what>`, as each case's line starts. */
const carriedLine = (id: string, what: Line): Line =>
  detail`${id}, carried over from the last run, ${what}`

/** The ticket, read up to `readTries` times while bd fails; not again when bd has no such ticket. */
const showTrying = (
  beads: Beads["Service"],
  id: string,
  tries = 1,
): Effect.Effect<Issue, BeadsError> =>
  Effect.catch(beads.show(id), (error) =>
    tries >= readTries || (error._tag === "BeadsFailed" && error.noSuchIssue)
      ? Effect.fail(error)
      : Effect.andThen(Effect.sleep(readAgainAfter), showTrying(beads, id, tries + 1)),
  )

/**
 * Saves each Asked ticket for the next run as the run ends: why (`asked`), its phase and its
 * question. The tickets it saved.
 */
export const saveAsked: Effect.Effect<ReadonlyArray<string>, never, Ledger | Store> = Effect.gen(
  function* () {
    const store = yield* Store
    const saved: Array<string> = []
    for (const entry of (yield* (yield* Ledger).current).tickets.values()) {
      if (entry.phase._tag !== "Asked") continue
      yield* Effect.ignore(store.setMetadata(entry.ticket, questionKey, entry.phase.question))
      yield* Effect.ignore(store.suspend(entry.ticket, askedWhy, "Asked"))
      saved.push(entry.ticket)
    }
    return saved
  },
)

/**
 * Saves the phase each ticket of the run left it in as the run ends, after saveAsked and the
 * suspended: each record in state.json with neither, so the next run doesn't take it for one a
 * crash left.
 */
export const saveLeft: Effect.Effect<void, never, Ledger | Store> = Effect.gen(function* () {
  const store = yield* Store
  const phases = new Map<string, PhaseName>()
  for (const entry of (yield* (yield* Ledger).current).tickets.values()) {
    phases.set(entry.ticket, entry.phase._tag)
  }
  const left = (record: TicketRecord) =>
    record.suspended === undefined && record.phase === undefined
  const leaving = Object.entries((yield* store.state).tickets).filter(
    ([id, record]) => phases.has(id) && left(record),
  )
  if (leaving.length === 0) return
  yield* Effect.ignore(
    store.update((state) => {
      const tickets = { ...state.tickets }
      for (const [id, record] of Object.entries(tickets)) {
        const phase = phases.get(id)
        if (phase !== undefined && left(record)) tickets[id] = { ...record, phase }
      }
      return { ...state, tickets }
    }),
  )
})

/** Whether a crashed run left the record: neither why it was suspended nor its phase, a session. */
const leftByCrash = (record: TicketRecord): boolean =>
  record.suspended === undefined && record.phase === undefined && record.session !== undefined

/** The question the saved ticket waited on, if state.json has one. */
const savedQuestion = (record: TicketRecord): string | undefined => {
  const question = Object.hasOwn(record.metadata, questionKey)
    ? record.metadata[questionKey]
    : undefined
  return typeof question === "string" && question !== "" ? question : undefined
}

/**
 * Takes up the workers the last run left in state.json, as the run starts (see above): what
 * became of each, by ticket.
 */
export const carryOver = (
  options: CarryOptions,
): Effect.Effect<ReadonlyMap<string, Carried>, never, CarryEnv> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const beads = yield* Beads
    const store = yield* Store
    const ledger = yield* Ledger
    const logs = yield* Log
    const events = yield* EventStream
    const fs = yield* FileSystem.FileSystem
    const context = yield* Effect.context<WorkEnv>()
    const { base } = options
    const carried = new Map<string, Carried>()
    const state = yield* store.state
    // A run whose process is gone, and that didn't save its tickets as it ended, crashed.
    const last = state.run
    const crashed = last !== undefined && !(yield* Effect.sync(() => processRunning(last.pid)))
    const saved = Object.entries(state.tickets)
      .filter(([, record]) => record.suspended !== undefined || (crashed && leftByCrash(record)))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    if (saved.length === 0) return carried

    // A scoped run takes up its ticket and its descendants; bd failing to list them, its ticket.
    const root = config.ticket
    const inScope = new Set<string>(root === null ? [] : [root])
    if (root !== null) {
      const subs = yield* Effect.result(descendants(beads, root))
      if (Result.isSuccess(subs)) for (const sub of subs.success) inScope.add(sub.id)
      else {
        yield* logs.write(
          detail`could not list ${root}'s subtickets, to carry over the workers left on them: ${beadsWhy(subs.failure)}`,
        )
      }
    }

    const said = (id: string, what: Carried, text: Line) =>
      Effect.gen(function* () {
        carried.set(id, what)
        yield* logs.write(text)
        yield* events.emit({ kind: "info", ticket: id, text })
      })
    const dropped = (id: string, what: Carried, text: Line) =>
      Effect.andThen(said(id, what, text), Effect.ignore(store.remove(id)))
    // Taken up into the run, its record is no longer suspended: the run's end saves it again.
    const taken = (id: string, what: Carried, text: Line) =>
      Effect.andThen(
        said(id, what, text),
        Effect.ignore(store.updateTicket(id, ({ suspended: _, phase: __, ...record }) => record)),
      )

    for (const [id, record] of saved) {
      const why = record.suspended ?? crashedWhy
      const idProblem = ticketIdProblem(id)
      if (idProblem !== undefined) {
        yield* dropped(id, "deleted", carriedLine(id, line`is dropped: ${idProblem}`))
        continue
      }
      if (root !== null && !inScope.has(id)) {
        yield* said(
          id,
          "kept",
          carriedLine(id, line`is kept for a later run: it is outside this run's scope`),
        )
        continue
      }
      const shown = yield* Effect.result(showTrying(beads, id))
      if (Result.isFailure(shown)) {
        const error = shown.failure
        if (error._tag === "BeadsFailed" && error.noSuchIssue) {
          yield* dropped(id, "deleted", carriedLine(id, line`is dropped: bd has no such ticket`))
        } else {
          yield* said(
            id,
            "kept",
            carriedLine(id, line`is kept for the next run: bd can't show it: ${beadsWhy(error)}`),
          )
        }
        continue
      }
      const issue = shown.success
      // Left by a crash, a ticket bd has back in the queue or set aside has no worker to take up.
      if (
        record.suspended === undefined &&
        issue.status !== "in_progress" &&
        issue.status !== "closed"
      ) {
        yield* Effect.ignore(store.remove(id))
        continue
      }
      const worktree = record.worktree ?? ""
      const there =
        worktree === ""
          ? false
          : yield* fs.exists(worktree).pipe(Effect.orElseSucceed(() => undefined))
      if (there === undefined) {
        yield* said(
          id,
          "kept",
          carriedLine(
            id,
            line`is kept for the next run: its worktree ${worktree} can't be looked for`,
          ),
        )
        continue
      }
      if (!there) {
        yield* dropped(
          id,
          "worktreeGone",
          carriedLine(id, line`is dropped: its worktree ${worktree} is gone`),
        )
        continue
      }
      const branch = record.branch ?? branchOf(id)

      if (issue.status === "closed") {
        const found = yield* mergedSince(issue, { repo: config.repo, base })
        if (found.merged !== undefined) {
          const commit = found.merged
          yield* dropped(
            id,
            "merged",
            carriedLine(
              id,
              line`is dropped: ${branch} is on ${base} already (${commit.hash.slice(0, 7)} ${commit.subject})`,
            ),
          )
          continue
        }
        const moved = yield* options.queue.offer(
          { id, title: issue.title, branch, worktree },
          (place) => Cause.Unmerged({ place }),
        )
        if (Result.isFailure(moved)) continue
        yield* taken(id, "toMerge", carriedLine(id, line`is closed, so it waits to merge`))
        continue
      }

      if (issue.status === "deferred") {
        yield* dropped(
          id,
          "deferred",
          carriedLine(
            id,
            line`is deferred since, so it isn't resumed; worktree ${worktree} left as it is`,
          ),
        )
        continue
      }

      const asked = openQuestion(issue)
      const question = asked?.id ?? (record.phase === "Asked" ? savedQuestion(record) : undefined)
      if (question !== undefined || record.phase === ("Asked" satisfies PhaseName)) {
        const q = question ?? ""
        const moved = yield* ledger.transition(id, Cause.StillAsked({ question: q }), {
          title: issue.title,
        })
        if (Result.isFailure(moved)) continue
        yield* taken(
          id,
          "asked",
          carriedLine(
            id,
            asked === undefined
              ? line`waited on ${q}, which is answered since`
              : line`still waits on your answer to ${asked.id} (${asked.title}); answer with: bd human respond ${asked.id}`,
          ),
        )
        continue
      }

      // Resumed, Working: told it was interrupted, with this run's facts, as its session starts.
      const moved = yield* ledger.transition(id, Cause.Resumed(), { title: issue.title })
      if (Result.isFailure(moved)) continue
      const facts = runFacts({
        id,
        ticketLimit: config.settings.workers.ticket_limit,
        scope: config.ticket,
      })
      const resumed = yield* Effect.result(
        resume(
          id,
          "suspended",
          carryOnText(id, why, facts),
          record.suspended === undefined
            ? line`${id} was in progress as the last run crashed`
            : line`${id} was suspended as the last run ended (${why})`,
        ),
      )
      if (Result.isFailure(resumed)) {
        carried.set(id, "workerGone")
        yield* workerGone(id, worktree, resumed.failure.reason)
        continue
      }
      carried.set(id, "resumed")
      const since = yield* Clock.currentTimeMillis
      const worker: StartedWorker = {
        ticket: id,
        worktree: { id, branch, path: worktree, reused: true, earlier: nothingEarlier },
        session: record.session ?? "",
        message: resumed.success,
      }
      const ticket = { id, title: issue.title, metadata: issue.metadata }
      yield* options.carry(
        id,
        Effect.gen(function* () {
          const followed = yield* follow(ticket, worker, options, since)
          return { phase: (yield* ledger.current).tickets.get(id)?.phase, stop: followed.stop }
        }).pipe(Effect.provideContext(context)),
        issue,
      )
    }

    // An asked ticket whose question was answered between runs is resumed now, and told so.
    yield* takeAnswers(options)
    return carried
  })
