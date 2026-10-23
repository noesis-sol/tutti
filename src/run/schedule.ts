// The scheduler (§ 5 item 5): it reads bd ready within the run's scope (scope.ts), enters each
// candidate in the ledger as Queued, and dispatches the highest-priority Queued ticket to Working
// while a slot is free, handing it to its per-ticket fiber through Start. A slot is taken for as
// long as that fiber runs. Free slots are filled at once (as the run starts, and as a ticket's
// fiber ends) and on the ready poll, every 30 s.
//
// A ready ticket waiting for something besides a slot is HeldBack (holds.ts), and Queued again once
// what held it is gone: a parent until its subtickets are closed and merged, a ticket until its
// blockers and the ticket it was filed from merge, and, with a slot free, one whose footprint
// overlaps a running ticket's. A solo ticket runs alone: while it runs nothing starts beside it, and
// first in line it waits for the running tickets to finish, holding back those behind it so it
// isn't starved. With every slot taken the tickets wait for a slot anyway, and none is held for an
// overlap or a solo ticket.
//
// A ticket frees its slot as it goes to the merge queue, once its worker has settled, but it holds
// back what it did while it ran until it merges: from ToMerge to Merged, Resolving and Fixing
// included, it is counted among the running tickets for an overlap with its footprint and for a solo
// ticket, running or next. Up to `concurrent` tickets merge, or wait to merge, without a slot, so
// that a slow merge check can't pile finished tickets up without end: beyond that, each takes a slot
// until a merge ends, and a slot free in the meantime waits.
//
// A Queued or HeldBack ticket that bd ready no longer lists, closed, deferred or blocked outside the
// run, leaves the ledger, so the In queue total counts only what may still start.
//
// The ledger's phases keep a ticket from being taken twice: only a ticket the run hasn't taken up,
// or one still Queued or HeldBack, is a candidate. --limit counts the tickets this run starts; a
// resumed or carried-over worker takes a slot (carry) but counts toward nothing, and a ticket put
// back in the queue until its blocker merges counts once, as it starts again: it is dispatched
// again only once its last fiber has ended and freed its slot. A ticket whose ID can't name a
// worktree or a branch is set aside as it is queued (BAD_TICKET_ID), without a worker or a slot.
import {
  Duration,
  Effect,
  FiberSet,
  type FileSystem,
  Queue,
  Ref,
  Result,
  type Scope,
  Semaphore,
} from "effect"
import { Beads, type BeadsError, type Issue } from "../services/Beads.ts"
import { Git } from "../services/Git.ts"
import { branchOf, ticketIdProblem } from "../services/Worktrees.ts"
import type { ClosedBranches } from "./closedBranches.ts"
import type { Event } from "./events.ts"
import { EventStream } from "./eventstream.ts"
import { RunFibers } from "./fibers.ts"
import {
  type Footprint,
  type Mentions,
  type RepoFiles,
  readMentions,
  repoFiles,
  type Sources,
  showFootprint,
  withChanges,
  worktreeChanges,
} from "./footprint.ts"
import {
  asksGit,
  type Held,
  isSolo,
  leftUnmerged,
  likelyConflictLine,
  mergeHold,
  overlapHold,
  parentHold,
  parentsWaiting,
  pending,
  sayOnce,
  sharedChanges,
  skippingLine,
  soloLine,
  unmerged,
  unreadableHold,
  waitsLine,
  waitsOnLinks,
} from "./holds.ts"
import { Ledger, type State } from "./ledger.ts"
import { detail, type Line, Log, line } from "./log.ts"
import { beadsWhy } from "./merge.ts"
import { Cause, type Hold, type PhaseTag, probeWait, setupWait, TicketPhase } from "./phase.ts"
import { footprintOf, type Predictor } from "./predict.ts"
import type { Solo } from "./runView.ts"
import { ready, unclosedIn, unmergedLabel } from "./scope.ts"

/** How often bd ready is read while tickets run: tickets become ready mid-run. */
export const readyPoll: Duration.Duration = Duration.seconds(30)

/** How many times a poll reads bd ready while it fails, and how long it waits between reads. */
export const readTries = 3
export const readAgainAfter: Duration.Duration = Duration.seconds(3)

/** The per-ticket fiber's entry: `start` is that fiber, and the ticket holds its slot until it ends. */
export interface Start {
  /** Takes the ticket, now Working in the ledger, from its worktree and session to its outcome. */
  start(issue: Issue): Effect.Effect<void>
}

/** Where tickets work, read for each fill: what keeps overlapping tickets apart (§ 5 Footprints). */
export interface Footprints {
  /** The repository's files (git ls-files) and the files the check commands name. */
  readonly repo: Effect.Effect<RepoFiles>
  /**
   * The files the running ticket's worktree has changed since it left the base, but those git
   * merges by union; none if unknown.
   */
  changed(ticket: string): Effect.Effect<ReadonlyArray<string>>
  /**
   * The files the ticket's branch changes on top of the base, but those git merges by union: none
   * without a branch, without commits on it, or if unknown. A ticket with some (reopened, carried
   * over) is footprinted from them (`branchFootprint`); without `branch`, none is.
   */
  branch?(ticket: string): Effect.Effect<ReadonlyArray<string>>
  /**
   * Places the functions of the footprints paired in the files comparing them asks about
   * (`askedFiles`), keeping what it reads in `sources`, the fill's, so that each is read once a fill.
   */
  mentions(
    pairs: ReadonlyArray<readonly [Footprint, Footprint]>,
    sources: Sources,
  ): Effect.Effect<Mentions>
}

/**
 * The footprints of the checkout at `repo`: its files from git, those git merges by union among
 * them, each running ticket's changes from its worktree (`worktree` gives its folder) against
 * `base`, each ticket's branch's against `base`, and its files' contents. git failing leaves names
 * judged by their look, none merged by union, and a ticket's changes unknown.
 */
export const footprintsOf = (options: {
  readonly repo: string
  readonly base: string
  readonly checkCommands: ReadonlyArray<string>
  readonly worktree: (ticket: string) => Effect.Effect<string>
}): Effect.Effect<Footprints, never, Git | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Git | FileSystem.FileSystem>()
    const git = yield* Git
    // The files but those git merges by union, as dir's .gitattributes say; all when git can't say.
    const withoutUnion = (dir: string, files: ReadonlyArray<string>) =>
      git.mergedByUnion(dir, files).pipe(
        Effect.map((union) => files.filter((f) => !union.includes(f))),
        Effect.orElseSucceed(() => files),
      )
    // The files git lists, read again only once the checkout's commit moves, as a merge moves it:
    // a fill comes on almost every wake. What git failing gives is read again the next time.
    const listed = yield* Ref.make<{ readonly at: string; readonly files: RepoFiles } | undefined>(
      undefined,
    )
    const read = git.trackedFiles(options.repo).pipe(
      Effect.flatMap((files) =>
        git.mergedByUnion(options.repo, files).pipe(
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
          Effect.map((union) => repoFiles(files, options.checkCommands, union)),
        ),
      ),
    )
    return {
      repo: Effect.gen(function* () {
        const at = yield* git.revParse(options.repo, "HEAD").pipe(Effect.orElseSucceed(() => ""))
        const known = yield* Ref.get(listed)
        if (at !== "" && known?.at === at) return known.files
        const files = yield* read
        if (at !== "") yield* Ref.set(listed, { at, files })
        return files
      }).pipe(Effect.orElseSucceed(() => repoFiles(undefined, options.checkCommands))),
      changed: (ticket) =>
        Effect.flatMap(options.worktree(ticket), (path) =>
          Effect.flatMap(worktreeChanges(path, options.base), (files) => withoutUnion(path, files)),
        ).pipe(
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
          Effect.provideContext(context),
        ),
      branch: (ticket) =>
        Effect.gen(function* () {
          const branch = branchOf(ticket)
          if (!(yield* git.branchExists(options.repo, branch))) return []
          const files = yield* git.changedFiles(options.repo, options.base, branch)
          return yield* withoutUnion(options.repo, files)
        }).pipe(
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
          Effect.provideContext(context),
        ),
      mentions: (pairs, sources) =>
        readMentions(options.repo, pairs, sources).pipe(Effect.provideContext(context)),
    }
  })

export interface Options {
  /** How many tickets run at once. */
  readonly concurrent: number
  /** The most tickets this run starts (--limit), or null for no limit. */
  readonly limit: number | null
  /** The ticket the run is scoped to (--ticket), or null for the whole of bd ready. */
  readonly scope: string | null
  /** The queue's `exclude_types`. */
  readonly excludeTypes: ReadonlyArray<string>
  readonly start: Start
  /** Whether the run takes new tickets now (holds say no); the ledger's wind-down says no too. */
  readonly taking?: Effect.Effect<boolean>
  /**
   * Whether the run holds a free slot at --machine-workers (machine.ts), which the queue and
   * dispatch records say with `machine_full`; never without it.
   */
  readonly machineFull?: Effect.Effect<boolean>
  /**
   * The tickets the last run left whose workers wait for a slot to be resumed (carry.ts): none of
   * them is dispatched afresh meanwhile. None without it.
   */
  readonly carrying?: Effect.Effect<ReadonlySet<string>>
  /** Where tickets work, with the queue's `footprint` on; without it, no ticket overlaps another. */
  readonly footprints?: Footprints
  /**
   * Guesses the files of the ready tickets naming nothing, in the background (predict.ts), when
   * footprints are on: its guesses join their footprints as they come in.
   */
  readonly predictor?: Predictor
  /**
   * What git says of closed blockers the run knows nothing of (closed by hand, by another tool,
   * under an earlier tutti): one whose work is only on its branch holds back the tickets it blocks.
   * Without it, such a blocker counts as merged.
   */
  readonly closedBranches?: ClosedBranches
  /** Shows the queue as the dashboard draws it, on each change (§ 7.2). */
  readonly show?: (queue: QueueShown) => Effect.Effect<void>
}

/** What the dashboard draws of the queue: the solo ticket, and the tickets it draws from. */
export interface QueueShown {
  readonly solo: Solo | null
  /** The tickets not closed in the run's scope that it takes, as the last fill read them. */
  readonly unclosed: number | null
}

/** What one fill did. */
export interface Filled {
  /** The tickets it dispatched, in order. */
  readonly dispatched: ReadonlyArray<string>
  /** The tickets it set aside for their IDs. */
  readonly setAside: ReadonlyArray<string>
  /** The candidates left Queued. */
  readonly queued: number
  /** The candidates left HeldBack. */
  readonly heldBack: number
}

export interface Scheduler {
  /** Reads bd ready, queues its new candidates, holds back or releases them, fills the free slots. */
  readonly fill: Effect.Effect<Filled, BeadsError>
  /**
   * Fills, then again on each ready poll and each slot freed, until interrupted. A read that
   * fails is tried again, up to `readTries` reads in all; then it fails with bd's error.
   */
  readonly run: Effect.Effect<never, BeadsError>
  /** Fills once, a read that fails tried again as `run` tries it; then it fails with bd's error. */
  readonly fillTrying: Effect.Effect<Filled, BeadsError>
  /** Waits until a ticket's fiber has ended and freed its slot, for a caller that doesn't use `run`. */
  readonly freed: Effect.Effect<void>
  /**
   * Runs a resumed or carried-over worker in a slot, counting toward no limit: only with a slot
   * free, the run taking tickets (no hold, the machine under --machine-workers) and not winding
   * down, no solo ticket running or past its work, and, for a solo one, no other ticket either.
   * There, `start` readies the worker, giving its `work`, or undefined for none started. With its
   * issue, its footprint, its parent and its solo label count as a dispatched ticket's do, and,
   * with footprints on, its `<id> footprint: …` line is logged as a dispatched ticket's is.
   * Whether there was a slot for it.
   */
  carry(
    ticket: string,
    start: Effect.Effect<Effect.Effect<void> | undefined>,
    issue?: Issue,
  ): Effect.Effect<boolean>
  /**
   * Runs `work` in a slot for a ticket checked once more (recheck.ts), as a running ticket's,
   * counting toward no limit: only with a slot free, no solo ticket running or first in line at
   * the last pick, and the ticket holding none still. Whether it took one.
   */
  recheckSlot(ticket: string, work: Effect.Effect<void>): Effect.Effect<boolean>
  /** The tickets this run has started: what --limit counts. */
  readonly started: Effect.Effect<number>
  /** The tickets holding a slot now. */
  readonly running: Effect.Effect<ReadonlySet<string>>
  /**
   * The slots taken now, as the scheduler counts them (slotsTaken): the running tickets', and one
   * for each ticket past its work beyond `concurrent`. The machine's cap counts these.
   */
  readonly slots: Effect.Effect<number>
  /**
   * Interrupts every ticket's fiber, freeing its slot: for a run that ends while its workers wait,
   * as for the usage limit's reset (§ 4.12).
   */
  readonly interrupt: Effect.Effect<void>
  /** Whether the run has started as many tickets as --limit allows. */
  readonly limitReached: Effect.Effect<boolean>
  /**
   * Writes a queue record of the tickets the last fill read, as they are now: for the machine's
   * hold (`machine_full`), which begins and ends without a ticket changing phase.
   */
  readonly recordQueue: Effect.Effect<void>
}

/** How far the run is through its ticket limit after `n` tickets: `n/limit`, or `n` with none. */
export const progress = (n: number, limit: number | null): string =>
  limit === null ? String(n) : `${n}/${limit}`

/** Whether `n` tickets started reach the run's ticket limit; never with none. */
const reached = (n: number, limit: number | null): boolean => limit !== null && n >= limit

/** `[n/limit] <id> dispatching: <title>`, the dispatch's log line; `dispatching solo` for one. */
export const dispatchLine = (n: number, limit: number | null, issue: Issue): Line =>
  isSolo(issue)
    ? line`[${progress(n, limit)}] ${issue.id} dispatching solo: ${issue.title}`
    : line`[${progress(n, limit)}] ${issue.id} dispatching: ${issue.title}`

/** `<id> footprint: …`, under the dispatch's line with footprints on (§ 5 item 5). */
export const footprintLine = (id: string, fp: Footprint): Line =>
  detail`${id} footprint: ${showFootprint(fp)}`

/** The BAD_TICKET_ID line, as orchestra words it. */
export const badTicketIdLine = (id: string, why: string): Line =>
  detail`BAD_TICKET_ID: ${why}: ${id} -> deferred without starting a worker; rename it (bd rename ${id} <new-id>), then bd undefer <new-id>`

/** The note bd defer appends to a ticket set aside for its ID. */
export const badTicketIdNote = (id: string, why: string): string =>
  `tutti: ${why}, so no worker was started on ${id}: a ticket's ID names its worktree folder and its branch tutti/<id>. Give it a plain ID (bd rename ${id} <new-id>), then bring it back with: bd undefer <new-id>`

/** Whether the ticket waits in the queue: Queued, or HeldBack. */
const waiting = (state: State, id: string): boolean => {
  const tag = state.tickets.get(id)?.phase._tag
  return tag === "Queued" || tag === "HeldBack"
}

/** The phases of a ticket past its work and not merged yet: from ToMerge to Merged. */
const pastWork: ReadonlySet<PhaseTag> = new Set(["ToMerge", "Merging", "Resolving", "Fixing"])

/** Whether the ticket is past its work and not merged yet: it waits to merge, merges, or is fixed. */
const merging = (state: State, id: string): boolean => {
  const tag = state.tickets.get(id)?.phase._tag
  return tag !== undefined && pastWork.has(tag)
}

/** The tickets past their work and not merged yet that hold no slot: those not `running`. */
const mergingIn = (state: State, running: ReadonlySet<string>): ReadonlyArray<string> =>
  [...state.tickets.values()]
    .filter((entry) => merging(state, entry.ticket) && !running.has(entry.ticket))
    .map((entry) => entry.ticket)

/**
 * The slots taken by `running` tickets and `merging` ones past their work without a slot: up to
 * `concurrent` of those take none, and each beyond them one.
 */
export const slotsTaken = (running: number, merging: number, concurrent: number): number =>
  running + Math.max(0, merging - concurrent)

/** Whether the ticket is back in the queue as its worktree's setup failed, Waiting{setup}. */
const setupFailed = (state: State, id: string): boolean => {
  const phase = state.tickets.get(id)?.phase
  return phase?._tag === "Waiting" && phase.for === setupWait
}

/** Whether the ledger lets the run take `id` from bd ready: not taken up yet, or still waiting. */
const candidate = (state: State, id: string): boolean =>
  !state.tickets.has(id) || waiting(state, id)

/** The solo ticket running, or the one next, as queue and dispatch records give it. */
interface SoloState {
  readonly ticket: string
  readonly next?: true
}

/** The queue's counts among `ids`, as `state` has them with `change` made: a queue record's. */
const counts = (
  state: State,
  ids: ReadonlyArray<string>,
  solo: SoloState | null,
  change?: readonly [string, TicketPhase],
) => {
  let queued = 0
  const by: Partial<Record<Hold | "setup", number>> = {}
  for (const id of ids) {
    const phase = change?.[0] === id ? change[1] : state.tickets.get(id)?.phase
    if (phase?._tag === "Queued") queued++
    if (phase?._tag === "HeldBack") by[phase.why] = (by[phase.why] ?? 0) + 1
    // Back in the queue as its setup failed, it is held back until a ticket merges or a probe.
    if (phase?._tag === "Waiting" && phase.for === setupWait) by.setup = (by.setup ?? 0) + 1
  }
  const held = Object.values(by).reduce((sum, n) => sum + n, 0)
  return {
    queued,
    ...(held > 0 ? { held, held_by: by } : {}),
    ...(solo === null ? {} : { solo }),
  }
}

interface Slots {
  readonly running: ReadonlySet<string>
  readonly started: number
  /**
   * The running tickets dispatched, or carried with their issue, and those past their work until
   * they merge: their footprints and labels.
   */
  readonly issues: ReadonlyMap<string, Issue>
  /** The solo ticket running, or past its work until it merges, if any. */
  readonly solo: string | null
}

/** `s` without the issues and solo ticket of the tickets neither running nor past their work. */
const prune = (s: Slots, state: State): Slots => {
  const kept = (id: string) => s.running.has(id) || merging(state, id)
  if ([...s.issues.keys()].every(kept) && (s.solo === null || kept(s.solo))) return s
  return {
    ...s,
    issues: new Map([...s.issues].filter(([id]) => kept(id))),
    solo: s.solo !== null && kept(s.solo) ? s.solo : null,
  }
}

/** The slots taken, the running tickets and those past their work as `state` has them. */
const taken = (s: Slots, state: State, concurrent: number): number =>
  slotsTaken(s.running.size, mergingIn(state, s.running).length, concurrent)

/** Whether a slot is free, the running tickets and those past their work as `state` has them. */
const slotFree = (s: Slots, state: State, concurrent: number): boolean =>
  taken(s, state, concurrent) < concurrent

/** The scheduler over the run's Beads, Ledger (which writes the records), Log and RunFibers. */
export const make = (
  options: Options,
): Effect.Effect<Scheduler, never, Beads | Ledger | Log | EventStream | RunFibers | Scope.Scope> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const ledger = yield* Ledger
    const logs = yield* Log
    const events = yield* EventStream
    const tickets = yield* (yield* RunFibers).make<void, never>("tickets")
    const slots = yield* Ref.make<Slots>({
      running: new Set(),
      started: 0,
      issues: new Map(),
      solo: null,
    })
    // A ticket's fiber that ends wakes the poll, so its slot is filled at once.
    const freed = yield* Queue.sliding<void>(1)
    const oneFill = yield* Semaphore.make(1)
    const taking = options.taking ?? Effect.succeed(true)
    const machineFull = options.machineFull ?? Effect.succeed(false)
    const carrying = options.carrying ?? Effect.succeed(new Set<string>())
    // The queue's counts for a record, `machine_full` with them while the run holds at the cap.
    const recorded = (...args: Parameters<typeof counts>) =>
      Effect.map(machineFull, (full) => ({
        ...counts(...args),
        ...(full ? { machine_full: true as const } : {}),
      }))
    const filter = { excludeTypes: options.excludeTypes }
    // The parents of the tickets the run took up, for those closed and not merged yet.
    const parentOf = new Map<string, string>()
    const waitSaid = sayOnce()
    const skipSaid = sayOnce()
    // The solo ticket next, which holds back the others while a slot is free, and its line last said.
    let soloNext: string | null = null
    // The solo ticket first in line at the last pick, even one made with every slot taken: no
    // recheck takes a slot ahead of it.
    let soloFirst: string | null = null
    let soloSaid = ""
    // The LIKELY_CONFLICT lines said, each once.
    const warned = new Set<string>()
    // What the branch of each ticket dispatched or carried changed on top of the base as it
    // started: one with some is footprinted from them while it runs, as it was when it started.
    const startBranch = new Map<string, ReadonlyArray<string>>()
    // The tickets the queue draws from, as the last fill read them, and the queue last shown.
    let unclosed: number | null = null
    let shownLast = ""
    // The candidates the last fill read, which a queue record counts.
    let lastIds: ReadonlyArray<string> = []

    const soloState = (s: Slots): SoloState | null =>
      s.solo !== null
        ? { ticket: s.solo }
        : soloNext !== null
          ? { ticket: soloNext, next: true }
          : null

    // Shows the queue when it changed since it was last shown.
    const showQueue = Effect.suspend(() => {
      const show = options.show
      if (show === undefined) return Effect.void
      return Effect.flatMap(Ref.get(slots), (s) => {
        const solo = soloState(s)
        const queue: QueueShown = {
          solo: solo === null ? null : { ticket: solo.ticket, running: solo.next !== true },
          unclosed,
        }
        const key = JSON.stringify(queue)
        if (key === shownLast) return Effect.void
        shownLast = key
        return show(queue)
      })
    })

    // A ticket dispatched (`counted`) that started too early, put back in the queue until its
    // blocker merges (WAITS_FOR_MERGE), counts toward --limit once, as it starts again. Its fiber
    // ends a few steps after it enters Waiting: by then its blocker may have merged, putting it back
    // in the queue, and bd ready may no longer list it, taking it out of the ledger. It isn't
    // dispatched again before its fiber ends, so it is never Working here for a later start.
    const requeued = (state: State, ticket: string) => {
      const phase = state.tickets.get(ticket)?.phase
      if (phase === undefined) return true
      return phase._tag === "Waiting" ? phase.for !== probeWait : waiting(state, ticket)
    }

    const occupy = (ticket: string, work: Effect.Effect<void>, issue?: Issue, counted = false) =>
      Effect.gen(function* () {
        if (issue?.parent !== undefined) parentOf.set(ticket, issue.parent)
        yield* Ref.update(slots, (s) => ({
          ...s,
          running: new Set([...s.running, ticket]),
          issues: issue === undefined ? s.issues : new Map([...s.issues, [ticket, issue]]),
          solo: issue !== undefined && isSolo(issue) ? ticket : s.solo,
        }))
        yield* showQueue
        // A ticket gone to the merge queue keeps its issue and solo label until it merges.
        const release = Effect.gen(function* () {
          const state = yield* ledger.current
          const again = counted && requeued(state, ticket)
          yield* Ref.update(slots, (s) => {
            skipSaid.forget(ticket)
            return prune(
              {
                ...s,
                running: new Set([...s.running].filter((id) => id !== ticket)),
                started: again ? s.started - 1 : s.started,
              },
              state,
            )
          })
          yield* showQueue
          yield* Queue.offer(freed, undefined)
        })
        yield* FiberSet.run(tickets, Effect.ensuring(work, release))
      })

    // A ticket whose ID can't be run moves through Working to Deferred at once: no worker starts,
    // so it has no dispatch record and counts toward no limit.
    const setAside = (issue: Issue, why: string) =>
      Effect.gen(function* () {
        const text = badTicketIdLine(issue.id, why)
        yield* ledger.transition(issue.id, Cause.Dispatched())
        yield* ledger.transition(issue.id, Cause.Defer({ why: "BAD_TICKET_ID" }), {
          beside: [{ kind: "deferred", ticket: issue.id, title: issue.title, detail: why, text }],
          lines: [text],
        })
        const deferred = yield* beads
          .defer(issue.id, { reason: badTicketIdNote(issue.id, why) })
          .pipe(Effect.result)
        if (Result.isFailure(deferred)) {
          yield* logs.write(detail`${why}: ${issue.id}, and bd could not defer it`)
        }
      })

    const dispatch = (issue: Issue, ids: ReadonlyArray<string>, footprint?: Footprint) =>
      Effect.gen(function* () {
        const s = yield* Ref.updateAndGet(slots, (s) => ({ ...s, started: s.started + 1 }))
        const text = dispatchLine(s.started, options.limit, issue)
        const solo = isSolo(issue) ? { ticket: issue.id } : soloState(s)
        const queue = yield* recorded(yield* ledger.current, ids, solo, [
          issue.id,
          TicketPhase.Working({ activity: "starting" }),
        ])
        const record: Event = {
          kind: "dispatch",
          ticket: issue.id,
          title: issue.title,
          n: s.started,
          ...(options.limit === null ? {} : { limit: options.limit }),
          ...queue,
          text,
        }
        const moved = yield* ledger.transition(issue.id, Cause.Dispatched(), {
          beside: [record],
          lines: [text],
        })
        if (Result.isFailure(moved)) {
          // A PHASE_BUG, which the ledger logged: nothing starts, and nothing is counted.
          yield* Ref.update(slots, (s) => ({ ...s, started: s.started - 1 }))
          return false
        }
        if (footprint !== undefined) yield* logs.write(footprintLine(issue.id, footprint))
        yield* occupy(issue.id, options.start.start(issue), issue, true)
        return true
      })

    // A resumed or carried-over ticket's footprint, logged as a dispatched ticket's is, as
    // orchestra's startFootprint does for a ticket it adopts or resumes.
    const carriedFootprint = (issue: Issue | undefined) =>
      Effect.gen(function* () {
        const footprints = options.footprints
        if (issue === undefined || footprints === undefined) return
        const repo = yield* footprints.repo
        const predicted: ReadonlyMap<string, ReadonlyArray<string>> = options.predictor ===
        undefined
          ? new Map()
          : yield* options.predictor.predicted
        const branch = footprints.branch === undefined ? [] : yield* footprints.branch(issue.id)
        startBranch.set(issue.id, branch)
        yield* logs.write(footprintLine(issue.id, footprintOf(issue, repo, predicted, branch)))
      })

    // The slots as the ledger has the tickets now: those merged since let go of what they held.
    const current = Effect.gen(function* () {
      const state = yield* ledger.current
      const s = yield* Ref.updateAndGet(slots, (s) => prune(s, state))
      return { s, state }
    })

    const mayStart = Effect.gen(function* () {
      const { s, state } = yield* current
      return (
        slotFree(s, state, options.concurrent) &&
        !reached(s.started, options.limit) &&
        state.windDown === null &&
        (yield* taking)
      )
    })

    // Moves a waiting ticket to the phase `held` says: HeldBack for its reason, or Queued; one held
    // for another reason is released first. Each move writes a queue record.
    const settle = (id: string, held: Hold | undefined, ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const before = yield* ledger.current
        const phase = before.tickets.get(id)?.phase
        if (phase === undefined) return
        if (phase._tag === "HeldBack" ? phase.why === held : held === undefined) return
        if (phase._tag === "HeldBack") {
          const solo = soloState(yield* Ref.get(slots))
          yield* ledger.transition(id, Cause.Released(), {
            beside: [
              {
                kind: "queue",
                ...(yield* recorded(before, ids, solo, [id, TicketPhase.Queued()])),
              },
            ],
          })
        }
        if (held === undefined) return
        const now = yield* ledger.current
        const solo = soloState(yield* Ref.get(slots))
        const to = TicketPhase.HeldBack({ why: held })
        yield* ledger.transition(id, Cause.Held({ why: held }), {
          beside: [{ kind: "queue", ...(yield* recorded(now, ids, solo, [id, to])) }],
        })
      })

    const fill = oneFill.withPermit(
      Effect.gen(function* () {
        const found = yield* ready(beads, options.scope, filter)
        const before = yield* ledger.current
        const kept = yield* carrying
        const listed = found.filter((issue) => !kept.has(issue.id))
        const candidates = listed.filter((issue) => candidate(before, issue.id))
        // The queue's counts take in the tickets whose setup failed, held back apart.
        const ids = listed
          .filter((issue) => candidate(before, issue.id) || setupFailed(before, issue.id))
          .map((issue) => issue.id)
        lastIds = ids
        const setAsideNow: Array<string> = []
        // A ticket waiting in the queue that bd ready no longer lists (closed, deferred or blocked
        // outside the run) leaves it; it is queued anew if it is ready again.
        for (const entry of before.tickets.values()) {
          if (waiting(before, entry.ticket) && !ids.includes(entry.ticket)) {
            const solo = soloState(yield* Ref.get(slots))
            yield* ledger.transition(entry.ticket, Cause.Unready(), {
              beside: [{ kind: "queue", ...(yield* recorded(before, ids, solo)) }],
            })
            waitSaid.forget(entry.ticket)
            skipSaid.forget(entry.ticket)
          }
        }
        // Each new candidate enters the ledger as Queued; one with an unusable ID is set aside.
        for (const issue of candidates) {
          if (before.tickets.has(issue.id)) continue
          const solo = soloState(yield* Ref.get(slots))
          const queue = yield* recorded(yield* ledger.current, ids, solo, [
            issue.id,
            TicketPhase.Queued(),
          ])
          yield* ledger.transition(issue.id, Cause.Ready(), {
            title: issue.title,
            beside: [{ kind: "queue", ...queue }],
          })
          const why = ticketIdProblem(issue.id)
          if (why !== undefined) {
            yield* setAside(issue, why)
            setAsideNow.push(issue.id)
          }
        }
        const queue = candidates.filter((issue) => !setAsideNow.includes(issue.id))

        // The parents waiting for their subtickets: those of the tickets not closed or left
        // unmerged by an earlier run, and of the run's tickets not merged yet. bd show gives the
        // parent of one the run didn't dispatch.
        const open = yield* beads.list()
        unclosed = unclosedIn(open, options.scope, filter)
        const left = leftUnmerged(
          yield* ledger.current,
          yield* beads.list({ status: "closed", labels: [unmergedLabel] }),
        )
        const openIds = new Set(open.map((issue) => issue.id))
        for (const id of unmerged(yield* ledger.current)) {
          if (parentOf.has(id) || openIds.has(id)) continue
          const read = yield* beads.show(id).pipe(Effect.result)
          if (Result.isSuccess(read)) parentOf.set(id, read.success.parent ?? "")
        }
        const parents = parentsWaiting([...open, ...left], yield* ledger.current, parentOf)

        // A ticket's links, as bd show gives them, read once a fill; null when bd couldn't.
        const shown = new Map<string, Issue | null>()
        const linksOf = (id: string) =>
          Effect.gen(function* () {
            if (shown.has(id)) return shown.get(id) ?? null
            const read = yield* beads.show(id).pipe(Effect.result)
            if (Result.isFailure(read)) {
              yield* logs.write(detail`could not read ${id}'s links: ${beadsWhy(read.failure)}`)
            }
            const issue = Result.isSuccess(read) ? read.success : null
            shown.set(id, issue)
            return issue
          })

        // The repository's files and the running tickets' changes, read once a fill, and the files'
        // contents comparing their footprints asks about.
        const sources: Sources = new Map()
        const footprints = options.footprints
        const repo = footprints === undefined ? undefined : yield* footprints.repo
        const changes = new Map<string, ReadonlyArray<string>>()
        const changedIn = (id: string) =>
          Effect.gen(function* () {
            const known = changes.get(id)
            if (known !== undefined || footprints === undefined || repo === undefined) {
              return known ?? []
            }
            const files = (yield* footprints.changed(id)).map((f) => repo.file(f))
            changes.set(id, files)
            return files
          })
        // What a waiting ticket's branch changes, read once a fill.
        const branches = new Map<string, ReadonlyArray<string>>()
        const branchIn = (id: string) =>
          Effect.gen(function* () {
            const known = branches.get(id)
            if (known !== undefined || footprints?.branch === undefined) return known ?? []
            const files = yield* footprints.branch(id)
            branches.set(id, files)
            return files
          })
        // The ready tickets naming nothing, nor with commits on their branches, go to the predictor;
        // its guesses so far join footprints.
        const predictor = options.predictor
        if (predictor !== undefined && repo !== undefined) {
          yield* predictor.queue(queue, repo, branchIn)
        }
        const predicted: ReadonlyMap<string, ReadonlyArray<string>> = predictor === undefined
          ? new Map()
          : yield* predictor.predicted

        // Two running tickets' worktrees changing one file: the second to merge may conflict.
        const runningNow = (yield* Ref.get(slots)).running
        if (footprints !== undefined && runningNow.size > 1) {
          const changed = new Map<string, ReadonlyArray<string>>()
          for (const id of runningNow) changed.set(id, yield* changedIn(id))
          for (const edit of sharedChanges(changed)) {
            const key = `${edit.a} ${edit.b} ${edit.file}`
            if (warned.has(key)) continue
            warned.add(key)
            const text = likelyConflictLine(edit)
            yield* logs.writeWith([text], events.emit({ kind: "warn", text }))
          }
        }

        // Why git finds a closed blocker's work only on its branch, asked once a fill, the base where
        // the fill first found it.
        const closed = options.closedBranches
        let head: { readonly at: string | undefined } | undefined
        const offBase = new Map<string, string | undefined>()
        const branchesOf = (state: State, links: Issue) =>
          Effect.gen(function* () {
            const found = new Map<string, string>()
            if (closed === undefined) return found
            for (const link of links.dependencies) {
              if (link.type !== "blocks" && link.type !== "discovered-from") continue
              if (!asksGit(state, link)) continue
              if (!offBase.has(link.id)) {
                head ??= { at: yield* closed.head }
                offBase.set(link.id, yield* closed.why(link.id, head.at))
              }
              const why = offBase.get(link.id)
              if (why !== undefined) found.set(link.id, why)
            }
            return found
          })

        // What holds a waiting ticket back for a parent or a ticket not merged, saying why once. bd
        // ready gives a ticket's links, so one linking to none it waits on has no bd show. With
        // nothing of the run's pending, only a closed blocker's branch could hold one back: a ticket
        // whose links bd can't show then goes ahead, as orchestra's does.
        const heldFor = (issue: Issue, state: State) =>
          Effect.gen(function* () {
            let held: Held | undefined
            const waits = waitsOnLinks(issue)
            if (parents.has(issue.id)) held = parentHold
            else if (waits && (left.length > 0 || pending(state))) {
              const links = yield* linksOf(issue.id)
              held =
                links === null
                  ? unreadableHold
                  : mergeHold(state, links, yield* branchesOf(state, links))
            } else if (waits && closed !== undefined) {
              const links = yield* linksOf(issue.id)
              if (links !== null) held = mergeHold(state, links, yield* branchesOf(state, links))
            }
            if (waitSaid.changed(issue.id, held?.text ?? "")) {
              yield* logs.write(waitsLine(issue.id, held?.text ?? ""))
            }
            return held
          })

        // With a slot free, what overlaps the footprint of a ticket running or past its work, saying
        // why once. A solo ticket waits for every one of them anyway, so it is never skipped for one.
        // One running or past its work that took no slot with its issue (carried over closed, checked
        // once more, handed over again) has its issue read from bd once, kept until it merges.
        const overlapping = (issues: ReadonlyArray<Issue>, s: Slots, past: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            const skipped = new Map<string, Held>()
            const asked = issues.filter((issue) => !isSolo(issue))
            if (
              footprints === undefined ||
              repo === undefined ||
              s.running.size + past.length === 0 ||
              asked.length === 0
            ) {
              return skipped
            }
            const read = new Map<string, Issue>()
            for (const id of [...s.running, ...past]) {
              if (s.issues.has(id)) continue
              const issue = yield* linksOf(id)
              if (issue !== null) read.set(id, issue)
            }
            if (read.size > 0) {
              yield* Ref.update(slots, (now) => ({
                ...now,
                issues: new Map([...now.issues, ...read]),
              }))
            }
            const running = new Map<string, Footprint>()
            for (const [id, issue] of [...s.issues, ...read]) {
              const fp = footprintOf(issue, repo, predicted, startBranch.get(id) ?? [])
              running.set(id, withChanges(fp, yield* changedIn(id), repo))
            }
            const mine = new Map<string, Footprint>()
            for (const issue of asked) {
              mine.set(issue.id, footprintOf(issue, repo, predicted, yield* branchIn(issue.id)))
            }
            const pairs = [...mine.values()].flatMap((fp) =>
              [...running.values()].map((other) => [fp, other] as const),
            )
            const mentions = yield* footprints.mentions(pairs, sources)
            for (const issue of asked) {
              const held = overlapHold(mine.get(issue.id) as Footprint, running, mentions)
              if (skipSaid.changed(issue.id, held?.text ?? "")) {
                yield* logs.write(skippingLine(issue.id, held?.text ?? ""))
              }
              if (held !== undefined) skipped.set(issue.id, held)
            }
            return skipped
          })

        const dispatched: Array<string> = []
        for (;;) {
          const { s, state } = yield* current
          const past = mergingIn(state, s.running)
          const slot = slotFree(s, state, options.concurrent)
          // A ticket back in the queue whose last fiber still holds its slot waits for it to end.
          const inLine = queue.filter(
            (issue) => waiting(state, issue.id) && !s.running.has(issue.id),
          )
          const holds = new Map<string, Hold>()
          const notHeld: Array<Issue> = []
          for (const issue of inLine) {
            const held = yield* heldFor(issue, state)
            if (held === undefined) notHeld.push(issue)
            else holds.set(issue.id, held.why)
          }
          const overlaps = slot ? yield* overlapping(notHeld, s, past) : new Map<string, Held>()
          for (const [id, held] of overlaps) holds.set(id, held.why)
          const free = notHeld.filter((issue) => !overlaps.has(issue.id))
          // The pick: the first ticket free, unless a solo ticket runs, or is first in line and
          // waits for the running tickets, and those past their work, to finish.
          const first = free[0]
          let start: Issue | undefined
          let next: string | null = null
          if (first !== undefined && s.solo === null) {
            if (isSolo(first) && s.running.size + past.length > 0) next = first.id
            else start = first
          }
          soloNext = slot ? next : null
          soloFirst = next
          const soloWhy =
            slot && start === undefined && free.length > 0 && s.solo !== null
              ? soloLine(s.solo, false)
              : soloNext !== null
                ? soloLine(soloNext, true)
                : ""
          if (soloWhy !== soloSaid) {
            soloSaid = soloWhy
            if (soloWhy !== "") yield* logs.write(soloWhy)
          }
          // With a slot free and none to start, only a solo ticket keeps the free ones waiting.
          if (slot && start === undefined) for (const issue of free) holds.set(issue.id, "solo")
          // The others settle once the slots are filled, as the last pick leaves them: one
          // dispatched changes what holds the rest, and they aren't released only to be held again.
          if (start === undefined || !(yield* mayStart)) {
            for (const issue of inLine) yield* settle(issue.id, holds.get(issue.id), ids)
            // A ticket that ended while its footprint was read no longer holds the others back.
            if (overlaps.size > 0 && (yield* Ref.get(slots)).running !== s.running) continue
            break
          }
          yield* settle(start.id, undefined, ids)
          const branch = yield* branchIn(start.id)
          startBranch.set(start.id, branch)
          const footprint =
            repo === undefined ? undefined : footprintOf(start, repo, predicted, branch)
          if (!(yield* dispatch(start, ids, footprint))) break
          dispatched.push(start.id)
        }
        yield* showQueue
        const after = counts(yield* ledger.current, ids, null)
        return {
          dispatched,
          setAside: setAsideNow,
          queued: after.queued,
          heldBack: (after.held ?? 0) - (after.held_by?.setup ?? 0),
        }
      }),
    )

    // A fill whose read fails is tried again a few seconds later, up to readTries reads.
    const fillTries = (tries: number): Effect.Effect<Filled, BeadsError> =>
      fill.pipe(
        Effect.catch((error) =>
          tries >= readTries
            ? Effect.fail(error)
            : Effect.gen(function* () {
                yield* logs.write(
                  line`could not read the queue (try ${tries} of ${readTries}), reading it again: ${beadsWhy(error)}`,
                )
                yield* Effect.sleep(readAgainAfter)
                return yield* fillTries(tries + 1)
              }),
        ),
      )

    const run = Effect.forever(
      Effect.andThen(
        fillTries(1),
        Effect.race(Queue.take(freed), Effect.asVoid(Effect.sleep(readyPoll))),
      ),
    )

    return {
      fill,
      run,
      fillTrying: fillTries(1),
      freed: Queue.take(freed),
      carry: (ticket, start, issue) =>
        oneFill.withPermit(
          Effect.gen(function* () {
            const { s, state } = yield* current
            const others = s.running.size + mergingIn(state, s.running).length
            const room =
              slotFree(s, state, options.concurrent) &&
              state.windDown === null &&
              s.solo === null &&
              !s.running.has(ticket) &&
              (issue === undefined || !isSolo(issue) || others === 0) &&
              (yield* taking)
            if (!room) return false
            const work = yield* start
            if (work !== undefined) {
              yield* Effect.andThen(carriedFootprint(issue), occupy(ticket, work, issue))
            }
            return true
          }),
        ),
      recheckSlot: (ticket, work) =>
        oneFill.withPermit(
          Effect.gen(function* () {
            const { s, state } = yield* current
            const free =
              slotFree(s, state, options.concurrent) &&
              s.solo === null &&
              soloFirst === null &&
              !s.running.has(ticket)
            if (free) yield* occupy(ticket, work)
            return free
          }),
        ),
      started: Effect.map(Ref.get(slots), (s) => s.started),
      running: Effect.map(Ref.get(slots), (s) => s.running),
      slots: Effect.map(Effect.all([Ref.get(slots), ledger.current]), ([s, state]) =>
        taken(s, state, options.concurrent),
      ),
      interrupt: FiberSet.clear(tickets),
      limitReached: Effect.map(Ref.get(slots), (s) => reached(s.started, options.limit)),
      recordQueue: Effect.gen(function* () {
        const solo = soloState(yield* Ref.get(slots))
        yield* events.emit({
          kind: "queue",
          ...(yield* recorded(yield* ledger.current, lastIds, solo)),
        })
      }),
    }
  })
