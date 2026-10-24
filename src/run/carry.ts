// Carry-over (§ 2, § 4.8's The next run and The other carry-over cases, § 5.1's The next run): the
// workers a run leaves, saved in state.json, taken up by the next run, before its first dispatch.
// A ticket is saved with why its session was suspended: as the run ended with it Stopped (sessions.ts,
// run.ts), or waiting on a question, Asked (saveAsked). The next run takes up each, in ID order,
// once it has checked it:
//
// - one whose ticket bd has no trace of, deleted from Beads, is dropped;
// - one whose worktree is gone is dropped, found before anything resumes it (§ 4.8's Resume limits);
// - one whose ticket is closed is merged, a rebase its merge left in progress aborted first
//   (abortLeftRebase): in line, ToMerge (§ 5.1's Unmerged), or dropped when its
//   branch is on the base already, merged by hand (unmerged.ts's mergedSince), its worktree and
//   branch removed as after a merge, unless the worktree has uncommitted changes
//   (merge.ts's removeMerged, as handMerged.ts's byHand says);
// - one deferred meanwhile is shown as deferred, and dropped: undeferred, it comes back through bd
//   ready, its worktree reused;
// - one waiting on a question, or asked as the last run ended, comes back Asked (§ 5.1's StillAsked);
//   once its question is answered, it is resumed and told so (asked.ts), at once when it was
//   answered between runs;
// - any other is resumed, `resume: <session ID>`, Working (§ 5.1's Resumed): told it was interrupted
//   and to carry on, with this run's facts (§ 4.1), as its session starts. Its fiber takes a slot,
//   counting toward no limit (the scheduler's carry), its ticket limit counted afresh, and goes on
//   as a dispatched ticket's does. A session that can't be resumed drops its ticket: WORKER_GONE,
//   left for review (sessions.ts). One with no slot for it (every slot taken by those resumed
//   before it, a solo ticket among them, the machine at --machine-workers, a hold) waits, its
//   record left as it was, and is taken up as a slot frees, each look checking it again
//   (carryWaiting); none of these is dispatched afresh meanwhile. A run that ends first leaves it
//   for the next.
//
// One that can't be checked (bd can't show its ticket, the worktree can't be looked for) is kept
// for the next run, as is one outside this run's --ticket scope. A dropped ticket is forgotten in
// state.json.
//
// A run that ends saves the phase each of its other tickets left it in (saveLeft), and forgets a
// deferred one, which comes back through bd ready with a new session; a ticket left for review has
// its phase saved as it is (aside.ts). So a record with neither why it was suspended nor a phase is
// one whose run never reached its end with it: it crashed
// (kill -9, a power cut), leaving its workers' sessions unsuspended, since a crash can't lose a
// session ID (§ 4.8). The next run takes up such a ticket as a suspended one (`crashed`) when bd
// has it in progress or closed; one in any other state, back in the queue or set aside, is
// forgotten. That run is the one state.json named as the Store read it (its previousRun), not the
// state's own stamp, which is this run's once it has written; and it has ended, whatever runs
// under its PID now, as this run holds the run lock (§ 9.2).
import { Clock, Effect, FileSystem, Result } from "effect"
import { AppConfig } from "../cli/AppConfig.ts"
import { Beads, type BeadsError, beadsWhy, type Issue } from "../services/Beads.ts"
import { Git, gitWhy, givenHash, type Sha } from "../services/Git.ts"
import { type PhaseName, Store, type TicketRecord } from "../services/Store.ts"
import { branchOf, nothingEarlier, ticketIdProblem } from "../services/Worktrees.ts"
import { retrying } from "./again.ts"
import { type AnswerOptions, takeAnswers } from "./asked.ts"
import { handedBackOf, uncheckedKey, uncheckedOf } from "./check.ts"
import { byHand, removedText } from "./handMerged.ts"
import { Ledger } from "./ledger.ts"
import { detail, type Line, Log, line } from "./log.ts"
import { removeMerged } from "./merge.ts"
import { Move } from "./phase.ts"
import { info } from "./say.ts"
import { readAgain } from "./schedule.ts"
import { descendants } from "./scope.ts"
import { resume, workerGone } from "./sessions.ts"
import { openQuestion } from "./settle.ts"
import { runFacts, type StartedWorker } from "./start.ts"
import { resumedText } from "./told.ts"
import { mergedSince, namedCommit } from "./unmerged.ts"
import { follow, type WorkEnv } from "./work.ts"

/** The metadata key holding the question an asked ticket waited on as the run ended. */
export const questionKey = "asked_question"

/** Why an asked ticket is saved, as state.json has it. */
export const askedWhy = "asked"

/** Why a ticket a crashed run left in state.json is carried over, as its carry-on message says. */
export const crashedWhy = "crashed"

export type CarryOptions = AnswerOptions

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
  | "waiting"

/** Every service carry-over uses. */
export type CarryEnv = WorkEnv | FileSystem.FileSystem

/** `<id>, carried over from the last run, <what>`, as each case's line starts. */
const carriedLine = (id: string, what: Line): Line =>
  detail`${id}, carried over from the last run, ${what}`

/** The ticket, read again as readAgain says while bd fails; not again when bd has no such ticket. */
const showTrying = (beads: Beads["Service"], id: string): Effect.Effect<Issue, BeadsError> =>
  retrying(beads.show(id), readAgain, {
    while: (error) => !(error._tag === "BeadsFailed" && error.noSuchIssue),
  })

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
 * crash left. A deferred ticket's is forgotten instead: undeferred, it starts a new session.
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
        if (phase === undefined || !left(record)) continue
        if (phase === "Deferred") delete tickets[id]
        else tickets[id] = { ...record, phase }
      }
      return { ...state, tickets }
    }),
  )
})

/** Whether a crashed run left the record: neither why it was suspended nor its phase, a session. */
const leftByCrash = (record: TicketRecord): boolean =>
  record.suspended === undefined && record.phase === undefined && record.session !== undefined

/**
 * The records of the workers the last run left in state.json: suspended, or left by a crash, when
 * state.json named the run that wrote it as the Store read it.
 */
const toCarry = Effect.gen(function* () {
  const store = yield* Store
  const crashed = store.previousRun !== undefined
  return Object.entries((yield* store.state).tickets).filter(
    ([, record]) => record.suspended !== undefined || (crashed && leftByCrash(record)),
  )
})

/** The tickets whose workers the last run left in state.json, for this one to carry on with. */
export const carriedTickets: Effect.Effect<ReadonlySet<string>, never, Store> = Effect.map(
  toCarry,
  (saved) => new Set(saved.map(([id]) => id)),
)

/** The question the saved ticket waited on, if state.json has one. */
const savedQuestion = (record: TicketRecord): string | undefined => {
  const question = Object.hasOwn(record.metadata, questionKey)
    ? record.metadata[questionKey]
    : undefined
  return typeof question === "string" && question !== "" ? question : undefined
}

/**
 * The commit a worker's resolution of its handed-back conflicts had got to in `worktree`, mid-rebase,
 * which git keeps once the rebase is aborted: its `HEAD`, unless that is where the branch was before
 * the rebase or on the base, the commit it was rebased onto. Undefined for none, or when git can't
 * say.
 */
const resolutionAt = (
  worktree: string,
  before: Sha | undefined,
  at: { readonly repo: string; readonly base: string },
) =>
  Effect.gen(function* () {
    const git = yield* Git
    const head = yield* Effect.result(git.revParse(worktree, "HEAD"))
    if (Result.isFailure(head) || head.success === before) return undefined
    const fork = yield* Effect.result(git.mergeBase(at.repo, at.base, head.success))
    return Result.isSuccess(fork) && fork.success !== head.success ? head.success : undefined
  })

/**
 * Aborts the rebase of the ticket's branch a merge left in progress in its worktree, its run ended
 * while git rebased it: one its rebased-and-unchecked mark (check.ts) shows tutti began. The branch
 * is back as its worker left it, for this run's merge to rebase again, rather than set aside
 * OFF_BRANCH mid-rebase. One whose conflicts were handed back to its worker is aborted too, its
 * resolution unfinished: the ticket is closed, so its worker isn't resumed, and the merge hands the
 * conflicts back afresh, as the usage-limit end does for a hand-back never sent (§ 4.12); the
 * commit its resolution had got to is named, which git keeps. git that can't say or can't abort it
 * leaves it as it is, saying so of an abort that failed.
 */
const abortLeftRebase = (
  id: string,
  record: TicketRecord,
  worktree: string,
  branch: string,
  at: { readonly repo: string; readonly base: string },
) =>
  Effect.gen(function* () {
    const mark = Object.hasOwn(record.metadata, uncheckedKey)
      ? record.metadata[uncheckedKey]
      : undefined
    const unchecked = uncheckedOf(mark)
    if (unchecked === undefined) return undefined
    const git = yield* Git
    const rebasing = yield* Effect.result(git.rebaseInProgress(worktree))
    if (Result.isFailure(rebasing) || !rebasing.success) return undefined
    const handed = handedBackOf(mark)
    const attempt = handed ? yield* resolutionAt(worktree, unchecked.head, at) : undefined
    const aborted = yield* Effect.result(git.abortRebase(worktree))
    if (Result.isFailure(aborted)) {
      return handed
        ? line`was left mid-rebase as the last run ended, its worker resolving its conflicts, and git could not abort it: ${gitWhy(aborted.failure)}`
        : line`was left mid-rebase as the last run ended, and git could not abort it: ${gitWhy(aborted.failure)}`
    }
    if (!handed) {
      return line`was left mid-rebase as the last run ended: the rebase is aborted, ${branch} back as its worker left it`
    }
    const kept =
      attempt === undefined
        ? line``
        : line`; its resolution had got to ${givenHash(attempt)}, which git keeps`
    return line`was left mid-rebase as the last run ended, its worker resolving its conflicts: the rebase is aborted, ${branch} back as its worker left it, for its merge to hand the conflicts back afresh${kept}`
  })

/**
 * Takes up the workers the last run left in state.json, as the run starts (see above): what
 * became of each, by ticket.
 */
export const carryOver = (
  options: CarryOptions,
): Effect.Effect<ReadonlyMap<string, Carried>, never, CarryEnv> => takeUp(options, undefined)

/**
 * Takes up the workers of `waiting`, those carryOver left waiting for a slot, checking each again
 * as at the start: what became of each still saved, by ticket, `waiting` for one with no slot yet.
 */
export const carryWaiting = (
  options: CarryOptions,
  waiting: ReadonlySet<string>,
): Effect.Effect<ReadonlyMap<string, Carried>, never, CarryEnv> =>
  waiting.size === 0 ? Effect.succeed(new Map()) : takeUp(options, waiting)

/** Takes up the saved workers, or those of `only` alone: carryOver's and carryWaiting's. */
const takeUp = (
  options: CarryOptions,
  only: ReadonlySet<string> | undefined,
): Effect.Effect<ReadonlyMap<string, Carried>, never, CarryEnv> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const beads = yield* Beads
    const store = yield* Store
    const ledger = yield* Ledger
    const logs = yield* Log
    const fs = yield* FileSystem.FileSystem
    const context = yield* Effect.context<WorkEnv>()
    const { base } = options
    const carried = new Map<string, Carried>()
    const saved = [...(yield* toCarry)]
      .filter(([id]) => only === undefined || only.has(id))
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
        yield* info(text, id)
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
        const undone = yield* abortLeftRebase(id, record, worktree, branch, {
          repo: config.repo,
          base,
        })
        if (undone !== undefined) yield* logs.write(carriedLine(id, undone))
        const found = yield* mergedSince(issue, { repo: config.repo, base })
        if (found.merged !== undefined) {
          const commit = found.merged
          const ticket = { id, branch, worktree }
          const removed = yield* removeMerged(ticket, { repo: config.repo, base }, byHand)
          yield* dropped(
            id,
            "merged",
            carriedLine(
              id,
              line`is dropped: ${branch} is on ${base} already (${namedCommit(commit)})${removedText(ticket, removed)}`,
            ),
          )
          continue
        }
        const moved = yield* options.queue.offer(
          { id, title: issue.title, branch, worktree },
          (place) => Move.Unmerged({ place }),
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
        const moved = yield* ledger.transition(id, Move.StillAsked({ question: q }), {
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

      // Resumed, Working: told it was interrupted, with this run's facts, as its session starts,
      // once there is a slot for it.
      const start = Effect.gen(function* () {
        const moved = yield* ledger.transition(id, Move.Resumed(), { title: issue.title, issue })
        if (Result.isFailure(moved)) return undefined
        const facts = runFacts({
          id,
          ticketLimit: config.settings.workers.ticket_limit,
          scope: config.ticket,
        })
        const resumed = yield* Effect.result(
          resume({
            ticket: id,
            why: "suspended",
            message: resumedText(id, why, facts),
            what:
              record.suspended === undefined
                ? line`${id} was in progress as the last run crashed`
                : line`${id} was suspended as the last run ended (${why})`,
          }),
        )
        if (Result.isFailure(resumed)) {
          carried.set(id, "workerGone")
          yield* workerGone({ ticket: id, worktree, why: resumed.failure.reason })
          return undefined
        }
        carried.set(id, "resumed")
        const since = yield* Clock.currentTimeMillis
        const worker: StartedWorker = {
          ticket: id,
          worktree: {
            id,
            branch,
            path: worktree,
            reused: true,
            fresh: false,
            earlier: nothingEarlier,
          },
          session: record.session ?? "",
          message: resumed.success,
        }
        const ticket = { id, title: issue.title, metadata: issue.metadata }
        return Effect.gen(function* () {
          const followed = yield* follow(ticket, worker, options, since)
          return { phase: (yield* ledger.current).tickets.get(id)?.phase, stop: followed.stop }
        }).pipe(Effect.provideContext(context))
      })
      if (yield* options.carry(id, start.pipe(Effect.provideContext(context)), issue)) continue
      // Said once, as the run starts: a later look finds it waiting still.
      if (only === undefined) {
        yield* said(id, "waiting", carriedLine(id, line`waits for a free slot to be resumed`))
      } else carried.set(id, "waiting")
    }

    // An asked ticket whose question was answered between runs is resumed now, and told so; each
    // look after the start takes up those answered since.
    if (only === undefined) yield* takeAnswers(options)
    return carried
  })
