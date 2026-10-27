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
// or one still Queued or HeldBack, is a candidate. A ticket set aside (Deferred) is one again once a
// fill has found it gone from bd ready, its fiber ended, and a later fill finds it back: undeferred
// outside the run, as the notes of a ticket tutti sets aside say to, it is Queued again, and counts
// toward --limit again as it starts. --limit counts the tickets this run starts; a resumed or
// carried-over worker takes a slot (carry) but counts toward nothing, and a ticket put back in the
// queue until its blocker merges counts once, as it starts again: it is dispatched again only once
// its last fiber has ended and freed its slot. A ticket whose ID can't name a worktree or a branch
// is set aside as it is queued (BAD_TICKET_ID), without a worker or a slot.
import {
  Context,
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
import { Beads, type BeadsError, beadsWhy, type Issue, type TicketId } from "../services/Beads.ts"
import { Git, type Sha } from "../services/Git.ts"
import { branchFolder, branchOf, ticketIdProblem } from "../services/Worktrees.ts"
import { type Again, retrying } from "./again.ts"
import type { ClosedBranches } from "./closedBranches.ts"
import { readDeclared } from "./declared.ts"
import { EventStream } from "./eventstream.ts"
import { RunFibers } from "./fibers.ts"
import { type Footprint, showFootprint, withChanges, worktreeChanges } from "./footprint.ts"
import {
  asksGit,
  type Gate,
  type Held,
  holds,
  isSolo,
  leftUnmerged,
  likelyConflictLine,
  mergeHold,
  openGate,
  overlapHold,
  parentHold,
  parentsWaiting,
  pending,
  type Said,
  saying,
  sharedChanges,
  skippingLine,
  soloLine,
  takesBack,
  takesNew,
  unmerged,
  unsaid,
  waitsLine,
  waitsOnLinks,
} from "./holds.ts"
import { Ledger, type State } from "./ledger.ts"
import { detail, type Line, Log, line } from "./log.ts"
import { hasRoom, type Room } from "./machineGate.ts"
import { type Mentions, readMentions, type Sources } from "./overlap.ts"
import { type HoldBack, Move, phaseFacts, TicketPhase } from "./phase.ts"
import { footprintOf, type Predictor } from "./predict.ts"
import { type RepoFiles, repoFiles } from "./repoFiles.ts"
import type { Solo } from "./runView.ts"
import { type Said as SaidRecord, sayer } from "./say.ts"
import { ready, unclosedIn, unmergedLabel } from "./scope.ts"

/** How often bd ready is read while tickets run: tickets become ready mid-run. */
export const readyPoll: Duration.Duration = Duration.seconds(30)

/** How many times a poll reads bd ready while it fails, and how long it waits between reads. */
export const readTries = 3
export const readAgainAfter: Duration.Duration = Duration.seconds(3)

/** How a bd read is made again while it fails: readTries in all, readAgainAfter apart. */
export const readAgain: Again = { tries: readTries, after: readAgainAfter }

/** The per-ticket fiber's entry: `start` is that fiber, and the ticket holds its slot until it ends. */
export interface Start {
  /** Takes the ticket, now Working in the ledger, from its worktree and session to its outcome. */
  start(issue: Issue): Effect.Effect<void>
}

/** Where tickets work, read for each fill: what keeps overlapping tickets apart (§ 5 Footprints). */
export interface Footprints {
  /**
   * The repository's files (git ls-files), the files the check commands name and the names their
   * sources declare.
   */
  readonly repo: Effect.Effect<RepoFiles>
  /**
   * The files the running ticket's worktree has changed since it left the base, but those git
   * merges by union; none if unknown.
   */
  changed(ticket: TicketId): Effect.Effect<ReadonlyArray<string>>
  /**
   * The files the ticket's branch changes on top of the base, but those git merges by union: none
   * without a branch, without commits on it, or if unknown. A ticket with some (reopened, carried
   * over) is footprinted from them (`branchFootprint`); without `branch`, none is. `existing`, the
   * tickets' branches as `branches` read them, says whether its branch is there without asking git.
   */
  branch?(ticket: TicketId, existing?: ReadonlySet<string>): Effect.Effect<ReadonlyArray<string>>
  /**
   * The tickets' branches there are, in one git call, for `branch`; undefined when git can't say,
   * and `branch` asks of each.
   */
  readonly branches?: Effect.Effect<ReadonlySet<string> | undefined>
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
 * `base`, each ticket's branch's against `base`, its files' contents, and the names its source
 * files declare (`readDeclared`). git failing leaves names judged by their look, none merged by
 * union, a ticket's changes unknown and every function declared. `sharedFiles`, the
 * settings' `queue.shared_files`, hold no tickets apart (`RepoFiles.shared`).
 */
export const footprintsOf = (options: {
  readonly repo: string
  readonly base: string
  readonly checkCommands: ReadonlyArray<string>
  readonly sharedFiles?: ReadonlyArray<string>
  readonly worktree: (ticket: TicketId) => Effect.Effect<string>
}): Effect.Effect<Footprints, never, Git | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Git | FileSystem.FileSystem>()
    const git = yield* Git
    const sharedFiles = options.sharedFiles ?? []
    // The files but those git merges by union, as dir's .gitattributes say; all when git can't say.
    const withoutUnion = (dir: string, files: ReadonlyArray<string>) =>
      git.mergedByUnion(dir, files).pipe(
        Effect.map((union) => files.filter((f) => !union.includes(f))),
        Effect.orElseSucceed(() => files),
      )
    // The files git lists and the names their sources declare, read again only once the checkout's
    // commit moves, as a merge moves it: a fill comes on almost every wake. What git failing gives
    // is read again the next time.
    const listed = yield* Ref.make<{ readonly at: Sha; readonly files: RepoFiles } | undefined>(
      undefined,
    )
    const read = Effect.gen(function* () {
      const files = yield* git.trackedFiles(options.repo)
      const union = yield* git
        .mergedByUnion(options.repo, files)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
      const declared = yield* readDeclared(options.repo, files).pipe(Effect.provideContext(context))
      return repoFiles(files, options.checkCommands, union, sharedFiles, declared)
    })
    return {
      repo: Effect.gen(function* () {
        const at = yield* git
          .revParse(options.repo, "HEAD")
          .pipe(Effect.orElseSucceed(() => undefined))
        const known = yield* Ref.get(listed)
        if (at !== undefined && known?.at === at) return known.files
        const files = yield* read
        if (at !== undefined) yield* Ref.set(listed, { at, files })
        return files
      }).pipe(
        Effect.orElseSucceed(() => repoFiles(undefined, options.checkCommands, [], sharedFiles)),
      ),
      changed: (ticket) =>
        Effect.flatMap(options.worktree(ticket), (path) =>
          Effect.flatMap(worktreeChanges(path, options.base), (files) => withoutUnion(path, files)),
        ).pipe(
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
          Effect.provideContext(context),
        ),
      branch: (ticket, existing) =>
        Effect.gen(function* () {
          const branch = branchOf(ticket)
          const there =
            existing === undefined
              ? yield* git.branchExists(options.repo, branch)
              : existing.has(branch)
          if (!there) return []
          const files = yield* git.changedFiles(options.repo, options.base, branch)
          return yield* withoutUnion(options.repo, files)
        }).pipe(
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
          Effect.provideContext(context),
        ),
      branches: git.branches(options.repo, branchFolder).pipe(
        Effect.map((names): ReadonlySet<string> | undefined => new Set(names)),
        Effect.orElseSucceed(() => undefined),
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
  readonly scope: TicketId | null
  /** The queue's `exclude_types`. */
  readonly excludeTypes: ReadonlyArray<string>
  readonly start: Start
  /**
   * Whether the run may take work (holds.ts's Gate), read once for each decision: a ticket starts
   * only as takesNew says, a worker is carried as takesBack says, and a ticket set aside is taken
   * back only while it doesn't hold. Without it, the ledger's wind-down and --limit alone say no.
   */
  readonly gate?: Effect.Effect<Gate>
  /**
   * Run before each start and carry, before the gate is read: the requires check a merge made due
   * (requires.ts), which may stop the run. Nothing without it.
   */
  readonly beforeStart?: Effect.Effect<void>
  /**
   * Whether the machine has room for the ticket about to start (machineGate.ts), asked last, once
   * the gate lets it start, with the slots taken (slotsTaken): the hold at --machine-workers begins,
   * with its line, when it hasn't. The hold's start and end each write a queue record. Room always
   * without it.
   */
  readonly room?: (own: number) => Effect.Effect<Room>
  /**
   * Whether the run holds a free slot at --machine-workers (machine.ts), which the queue and
   * dispatch records say with `machine_full`; never without it.
   */
  readonly machineFull?: Effect.Effect<boolean>
  /**
   * The tickets the last run left whose workers wait for a slot to be resumed (carry.ts): none of
   * them is dispatched afresh meanwhile. None without it.
   */
  readonly carrying?: Effect.Effect<ReadonlySet<TicketId>>
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

/**
 * What the dashboard draws of the queue: the solo ticket, the tickets it draws from, and why each
 * ticket waiting in it is held back, as the log last said it (its Up next panel, § 7.2).
 */
export interface QueueShown {
  readonly solo: Solo | null
  /** The tickets not closed in the run's scope that it takes, as the last fill read them. */
  readonly unclosed: number | null
  /** Why each ticket held back for a parent or a ticket not merged waits, by ticket (waitsLine's). */
  readonly waits: Readonly<Record<string, string>>
  /** Why each ticket held back for an overlap is skipped, by ticket (skippingLine's). */
  readonly skips: Readonly<Record<string, string>>
}

/** The reasons `said` holds, without the empty ones of tickets no longer held. */
const reasons = (said: Said): Readonly<Record<string, string>> =>
  Object.fromEntries([...said].filter(([, why]) => why !== ""))

/** What one fill did. */
export interface Filled {
  /** The tickets it dispatched, in order. */
  readonly dispatched: ReadonlyArray<TicketId>
  /** The tickets it set aside for their IDs. */
  readonly setAside: ReadonlyArray<TicketId>
  /** The candidates left Queued. */
  readonly queued: number
  /** The candidates left HeldBack. */
  readonly heldBack: number
}

export interface Scheduler {
  /**
   * Reads bd ready, queues its new candidates, holds back or releases them, fills the free slots.
   * A read that fails is tried again, up to `readTries` reads in all; then it fails with bd's error.
   */
  readonly fillTrying: Effect.Effect<Filled, BeadsError>
  /**
   * fillTrying with bd's open list read already, `open`, at the look's start (run.ts), which the
   * fill takes rather than read it again.
   */
  fillWith(open: ReadonlyArray<Issue>): Effect.Effect<Filled, BeadsError>
  /** Waits until a ticket's fiber has ended and freed its slot. */
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
    ticket: TicketId,
    start: Effect.Effect<Effect.Effect<void> | undefined>,
    issue?: Issue,
  ): Effect.Effect<boolean>
  /**
   * Runs `work` in a slot for a ticket checked once more (recheck.ts), as a running ticket's,
   * counting toward no limit: only with a slot free, no solo ticket running or first in line at
   * the last pick, and the ticket holding none still. Its issue, read from bd as it takes the
   * slot, has its footprint and solo label count as a dispatched ticket's do. Whether it took one.
   */
  recheckSlot(ticket: TicketId, work: Effect.Effect<void>): Effect.Effect<boolean>
  /** The tickets this run has started: what --limit counts. */
  readonly started: Effect.Effect<number>
  /** The tickets holding a slot now. */
  readonly running: Effect.Effect<ReadonlySet<TicketId>>
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
export const footprintLine = (id: TicketId, fp: Footprint): Line =>
  detail`${id} footprint: ${showFootprint(fp)}`

/** The BAD_TICKET_ID line, as orchestra words it. */
export const badTicketIdLine = (id: TicketId, why: string): Line =>
  detail`BAD_TICKET_ID: ${why}: ${id} -> deferred without starting a worker; rename it (bd rename ${id} <new-id>), then bd undefer <new-id>`

/** The note bd defer appends to a ticket set aside for its ID. */
export const badTicketIdNote = (id: TicketId, why: string): string =>
  `tutti: ${why}, so no worker was started on ${id}: a ticket's ID names its worktree folder and its branch tutti/<id>. Give it a plain ID (bd rename ${id} <new-id>), then bring it back with: bd undefer <new-id>`

/** Whether the ticket waits in the queue: Queued, or HeldBack. */
const waiting = (state: State, id: TicketId): boolean => {
  const tag = state.tickets.get(id)?.phase._tag
  return tag !== undefined && phaseFacts[tag].ready
}

/** Whether the ticket is past its work and not merged yet: it waits to merge, merges, or is fixed. */
const merging = (state: State, id: TicketId): boolean => {
  const tag = state.tickets.get(id)?.phase._tag
  return tag !== undefined && phaseFacts[tag].pastWork
}

/** The tickets past their work and not merged yet that hold no slot: those not `running`. */
const mergingIn = (state: State, running: ReadonlySet<TicketId>): ReadonlyArray<TicketId> =>
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
const setupFailed = (state: State, id: TicketId): boolean => {
  const phase = state.tickets.get(id)?.phase
  return phase?._tag === "Waiting" && phase.for._tag === "Setup"
}

/** bd's open list as the look read it at its start, for the fill it gives it to (fillWith). */
const LookOpen = Context.Reference<ReadonlyArray<Issue> | undefined>("tutti/run/LookOpen", {
  defaultValue: () => undefined,
})

/** Whether the ledger lets the run take `id` from bd ready: not taken up yet, or still waiting. */
const candidate = (state: State, id: TicketId): boolean =>
  !state.tickets.has(id) || waiting(state, id)

/** Whether the ticket is set aside, Deferred. */
const deferred = (state: State, id: TicketId): boolean =>
  state.tickets.get(id)?.phase._tag === "Deferred"

/** `<id>: undeferred; back in the queue`, for a ticket set aside that bd ready lists again. */
export const undeferredLine = (id: TicketId): Line => detail`${id}: undeferred; back in the queue`

/** The solo ticket running, or the one next, as queue and dispatch records give it. */
interface SoloState {
  readonly ticket: TicketId
  readonly next?: true
}

/** The queue's counts among `ids`, as `state` has them with `change` made: a queue record's. */
const counts = (
  state: State,
  ids: ReadonlyArray<TicketId>,
  solo: SoloState | null,
  change?: readonly [string, TicketPhase],
) => {
  let queued = 0
  const by: Partial<Record<HoldBack | "setup", number>> = {}
  for (const id of ids) {
    const phase = change?.[0] === id ? change[1] : state.tickets.get(id)?.phase
    if (phase?._tag === "Queued") queued++
    if (phase?._tag === "HeldBack") by[phase.why] = (by[phase.why] ?? 0) + 1
    // Back in the queue as its setup failed, it is held back until a ticket merges or a probe.
    if (phase?._tag === "Waiting" && phase.for._tag === "Setup") by.setup = (by.setup ?? 0) + 1
  }
  const held = Object.values(by).reduce((sum, n) => sum + n, 0)
  return {
    queued,
    ...(held > 0 ? { held, held_by: by } : {}),
    ...(solo === null ? {} : { solo }),
  }
}

interface Slots {
  readonly running: ReadonlySet<TicketId>
  readonly started: number
  /**
   * The running tickets dispatched, or carried with their issue, and those past their work until
   * they merge: their footprints and labels.
   */
  readonly issues: ReadonlyMap<TicketId, Issue>
  /** The solo ticket running, or past its work until it merges, if any. */
  readonly solo: TicketId | null
}

/** `s` without the issues and solo ticket of the tickets neither running nor past their work. */
const prune = (s: Slots, state: State): Slots => {
  const kept = (id: TicketId) => s.running.has(id) || merging(state, id)
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

/** What a pick chooses from. */
export interface PickFrom {
  /** The tickets in line held back for nothing but a slot or a solo ticket, in the order they start. */
  readonly free: ReadonlyArray<Issue>
  /** The solo ticket running, or past its work until it merges, if any. */
  readonly solo: TicketId | null
  /** The tickets running, and those past their work and not merged yet. */
  readonly busy: number
  /** Whether a slot is free. */
  readonly slot: boolean
}

/** What a pick chose. */
export interface Picked {
  /** The ticket to start, if any. */
  readonly start?: Issue
  /** The solo ticket next, which holds back the others while a slot is free. */
  readonly soloNext: TicketId | null
  /**
   * The solo ticket first in line, even with every slot taken: no recheck takes a slot ahead of it.
   */
  readonly soloFirst: TicketId | null
  /** The solo line saying why nothing starts, or "" for none. */
  readonly soloLine: Line | ""
  /** The tickets held back for a solo ticket: with a slot free and none to start, the free ones. */
  readonly heldSolo: ReadonlyArray<TicketId>
}

/**
 * The pick: the first ticket free, unless a solo ticket runs, or is first in line and waits for the
 * running tickets, and those past their work, to finish. With every slot taken the tickets wait for
 * a slot anyway, and none is held for a solo ticket.
 */
export const pick = (p: PickFrom): Picked => {
  const first = p.free[0]
  let start: Issue | undefined
  let next: TicketId | null = null
  if (first !== undefined && p.solo === null) {
    if (isSolo(first) && p.busy > 0) next = first.id
    else start = first
  }
  const soloNext = p.slot ? next : null
  const why =
    p.slot && start === undefined && p.free.length > 0 && p.solo !== null
      ? soloLine(p.solo, false)
      : soloNext !== null
        ? soloLine(soloNext, true)
        : ""
  return {
    ...(start === undefined ? {} : { start }),
    soloNext,
    soloFirst: next,
    soloLine: why,
    heldSolo: p.slot && start === undefined ? p.free.map((issue) => issue.id) : [],
  }
}

/**
 * What the scheduler keeps between fills, as its fills, the slots it frees and the queue it shows
 * share it: changed in one step each.
 */
interface Memo {
  /** The parents of the tickets the run took up, for those closed and not merged yet. */
  readonly parentOf: ReadonlyMap<TicketId, TicketId | null>
  /** What holds each waiting ticket back, as last said. */
  readonly waitSaid: Said
  /** What each ticket was last skipped for, an overlap. */
  readonly skipSaid: Said
  /** The solo ticket next, which holds back the others while a slot is free. */
  readonly soloNext: TicketId | null
  /**
   * The solo ticket first in line at the last pick, even one made with every slot taken: no
   * recheck takes a slot ahead of it.
   */
  readonly soloFirst: TicketId | null
  /** The solo line last said. */
  readonly soloSaid: string
  /** The LIKELY_CONFLICT lines said, each once. */
  readonly warned: ReadonlySet<string>
  /**
   * What the branch of each ticket dispatched or carried changed on top of the base as it
   * started: one with some is footprinted from them while it runs, as it was when it started.
   */
  readonly startBranch: ReadonlyMap<TicketId, ReadonlyArray<string>>
  /** The tickets the queue draws from, as the last fill read them. */
  readonly unclosed: number | null
  /** The queue last shown. */
  readonly shownLast: string
  /** The candidates the last fill read, which a queue record counts. */
  readonly lastIds: ReadonlyArray<TicketId>
  /**
   * The tickets set aside (Deferred) that a fill found gone from bd ready, their fibers ended: one
   * bd ready lists again was undeferred outside the run, and is queued again while the run doesn't
   * hold. One bd couldn't defer, which bd ready still lists, is kept out of the run. So is one an
   * environment hold reopens itself (Deferred → Waiting), which it does once the run holds.
   */
  readonly leftReady: ReadonlySet<TicketId>
}

const noMemo: Memo = {
  parentOf: new Map(),
  waitSaid: new Map(),
  skipSaid: new Map(),
  soloNext: null,
  soloFirst: null,
  soloSaid: "",
  warned: new Set(),
  startBranch: new Map(),
  unclosed: null,
  shownLast: "",
  lastIds: [],
  leftReady: new Set(),
}

/** The solo ticket running, or else the one next. */
const soloState = (s: Slots, soloNext: TicketId | null): SoloState | null =>
  s.solo !== null ? { ticket: s.solo } : soloNext !== null ? { ticket: soloNext, next: true } : null

/** The scheduler over the run's Beads, Ledger (which writes the records), Log and RunFibers. */
export const make = (
  options: Options,
): Effect.Effect<Scheduler, never, Beads | Ledger | Log | EventStream | RunFibers | Scope.Scope> =>
  Effect.gen(function* () {
    const beads = yield* Beads
    const ledger = yield* Ledger
    const logs = yield* Log
    const events = yield* EventStream
    const { warn } = yield* sayer
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
    const gate =
      options.gate ??
      Effect.map(
        Effect.all([ledger.current, Ref.get(slots)]),
        ([state, s]): Gate => ({
          ...openGate,
          windingDown: state.windDown !== null,
          limitReached: reached(s.started, options.limit),
        }),
      )
    const beforeStart = options.beforeStart ?? Effect.void
    const machineFull = options.machineFull ?? Effect.succeed(false)
    const carrying = options.carrying ?? Effect.succeed(new Set<TicketId>())
    // The queue's counts for a record, `machine_full` with them while the run holds at the cap.
    const recorded = (...args: Parameters<typeof counts>) =>
      Effect.map(machineFull, (full) => ({
        ...counts(...args),
        ...(full ? { machine_full: true as const } : {}),
      }))
    const filter = { excludeTypes: options.excludeTypes }
    // What the scheduler keeps between fills (Memo), each change one step.
    const memo = yield* Ref.make(noMemo)
    const remember = (change: (m: Memo) => Memo) => Ref.update(memo, change)
    const soloNow = Effect.map(Effect.all([Ref.get(slots), Ref.get(memo)]), ([s, m]) =>
      soloState(s, m.soloNext),
    )
    // Records the ticket's reason, waiting or skipped, and says whether it is one to say.
    const said = (which: "waitSaid" | "skipSaid", id: TicketId, why: string) =>
      Ref.modify(memo, (m): readonly [boolean, Memo] => {
        const next = saying(m[which], id, why)
        return [next.say, { ...m, [which]: next.said }]
      })
    const forget = (which: "waitSaid" | "skipSaid", id: TicketId) =>
      remember((m) => ({ ...m, [which]: unsaid(m[which], id) }))
    const slotsTaken = Effect.map(Effect.all([Ref.get(slots), ledger.current]), ([s, state]) =>
      taken(s, state, options.concurrent),
    )
    const recordQueue = Effect.gen(function* () {
      const solo = yield* soloNow
      yield* events.emit({
        kind: "queue",
        ...(yield* recorded(yield* ledger.current, (yield* Ref.get(memo)).lastIds, solo)),
      })
    })
    // Whether the machine has room for the ticket about to start: the queue record says the hold's
    // start and end (`machine_full`).
    const claimRoom = Effect.gen(function* () {
      if (options.room === undefined) return true
      const room = yield* options.room(yield* slotsTaken)
      if (room === "began" || room === "lifted") yield* recordQueue
      return hasRoom(room)
    })

    // Shows the queue when it changed since it was last shown.
    const showQueue = Effect.suspend(() => {
      const show = options.show
      if (show === undefined) return Effect.void
      return Effect.flatMap(Ref.get(slots), (s) =>
        Effect.flatMap(
          Ref.modify(memo, (m): readonly [QueueShown | undefined, Memo] => {
            const solo = soloState(s, m.soloNext)
            const queue: QueueShown = {
              solo: solo === null ? null : { ticket: solo.ticket, running: solo.next !== true },
              unclosed: m.unclosed,
              waits: reasons(m.waitSaid),
              skips: reasons(m.skipSaid),
            }
            const key = JSON.stringify(queue)
            return key === m.shownLast ? [undefined, m] : [queue, { ...m, shownLast: key }]
          }),
          (queue) => (queue === undefined ? Effect.void : show(queue)),
        ),
      )
    })

    // A ticket dispatched (`counted`) that started too early, put back in the queue until its
    // blocker merges (WAITS_FOR_MERGE), counts toward --limit once, as it starts again. Its fiber
    // ends a few steps after it enters Waiting: by then its blocker may have merged, putting it back
    // in the queue, and bd ready may no longer list it, taking it out of the ledger. It isn't
    // dispatched again before its fiber ends, so it is never Working here for a later start.
    const requeued = (state: State, ticket: TicketId) => {
      const phase = state.tickets.get(ticket)?.phase
      if (phase === undefined) return true
      return phase._tag === "Waiting" ? phase.for._tag !== "Probe" : waiting(state, ticket)
    }

    const occupy = (ticket: TicketId, work: Effect.Effect<void>, issue?: Issue, counted = false) =>
      Effect.gen(function* () {
        // Its parent, or that it has none, so that no look shows it for its parent once it closes.
        if (issue !== undefined) {
          const parent = issue.parent ?? null
          yield* remember((m) => ({ ...m, parentOf: new Map(m.parentOf).set(ticket, parent) }))
        }
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
          yield* forget("skipSaid", ticket)
          yield* Ref.update(slots, (s) =>
            prune(
              {
                ...s,
                running: new Set([...s.running].filter((id) => id !== ticket)),
                started: again ? s.started - 1 : s.started,
              },
              state,
            ),
          )
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
        yield* ledger.transition(issue.id, Move.Dispatched())
        yield* ledger.transition(issue.id, Move.Defer({ why: "BAD_TICKET_ID" }), {
          said: [{ kind: "deferred", ticket: issue.id, title: issue.title, detail: why, text }],
        })
        const deferred = yield* beads
          .defer(issue.id, { reason: badTicketIdNote(issue.id, why) })
          .pipe(Effect.result)
        if (Result.isFailure(deferred)) {
          yield* logs.write(detail`${why}: ${issue.id}, and bd could not defer it`)
        }
      })

    const dispatch = (issue: Issue, ids: ReadonlyArray<TicketId>, footprint?: Footprint) =>
      Effect.gen(function* () {
        const s = yield* Ref.updateAndGet(slots, (s) => ({ ...s, started: s.started + 1 }))
        const text = dispatchLine(s.started, options.limit, issue)
        const solo = isSolo(issue)
          ? { ticket: issue.id }
          : soloState(s, (yield* Ref.get(memo)).soloNext)
        const queue = yield* recorded(yield* ledger.current, ids, solo, [
          issue.id,
          TicketPhase.Working(),
        ])
        const record: SaidRecord = {
          kind: "dispatch",
          ticket: issue.id,
          title: issue.title,
          n: s.started,
          ...(options.limit === null ? {} : { limit: options.limit }),
          ...queue,
          text,
        }
        const moved = yield* ledger.transition(issue.id, Move.Dispatched(), {
          said: [record],
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
        const predicted: ReadonlyMap<TicketId, ReadonlyArray<string>> = options.predictor ===
        undefined
          ? new Map()
          : yield* options.predictor.predicted
        const branch = footprints.branch === undefined ? [] : yield* footprints.branch(issue.id)
        yield* remember((m) => ({
          ...m,
          startBranch: new Map(m.startBranch).set(issue.id, branch),
        }))
        yield* logs.write(footprintLine(issue.id, footprintOf(issue, repo, predicted, branch)))
      })

    // The slots as the ledger has the tickets now: those merged since let go of what they held.
    const current = Effect.gen(function* () {
      const state = yield* ledger.current
      const s = yield* Ref.updateAndGet(slots, (s) => prune(s, state))
      return { s, state }
    })

    // A ticket's issue as bd show gives it; null, saying why, when bd couldn't.
    const issueOf = (id: TicketId) =>
      Effect.gen(function* () {
        const read = yield* beads.show(id).pipe(Effect.result)
        if (Result.isSuccess(read)) return read.success
        yield* logs.write(detail`could not read ${id}'s links: ${beadsWhy(read.failure)}`)
        return null
      })

    // `s` with the issue of each ticket running or past its work that took no slot with its issue
    // (carried over closed, handed over again), read from bd once and kept until it merges: its
    // footprint and solo label then count as a dispatched ticket's do.
    const withIssues = (
      s: Slots,
      past: ReadonlyArray<TicketId>,
      read: (id: TicketId) => Effect.Effect<Issue | null> = issueOf,
    ) =>
      Effect.gen(function* () {
        const found = new Map<TicketId, Issue>()
        for (const id of [...s.running, ...past]) {
          if (s.issues.has(id)) continue
          const issue = yield* read(id)
          if (issue !== null) found.set(id, issue)
        }
        if (found.size === 0) return s
        const solo = [...found.values()].find(isSolo)?.id ?? null
        const add = (now: Slots): Slots => ({
          ...now,
          issues: new Map([...now.issues, ...found]),
          solo: now.solo ?? solo,
        })
        yield* Ref.update(slots, add)
        return add(s)
      })

    // `current`, the issues of the tickets running or past their work read as `withIssues` does.
    const known = Effect.gen(function* () {
      const { s, state } = yield* current
      return { s: yield* withIssues(s, mergingIn(state, s.running)), state }
    })

    const mayStart = Effect.gen(function* () {
      const { s, state } = yield* current
      if (!slotFree(s, state, options.concurrent)) return false
      yield* beforeStart
      return takesNew(yield* gate) && (yield* claimRoom)
    })

    // Moves a waiting ticket to the phase `held` says: HeldBack for its reason, or Queued; one held
    // for another reason is released first. Each move writes a queue record.
    const placeWaiting = (id: TicketId, held: HoldBack | undefined, ids: ReadonlyArray<TicketId>) =>
      Effect.gen(function* () {
        const before = yield* ledger.current
        const phase = before.tickets.get(id)?.phase
        if (phase === undefined) return
        if (phase._tag === "HeldBack" ? phase.why === held : held === undefined) return
        if (phase._tag === "HeldBack") {
          const solo = yield* soloNow
          yield* ledger.transition(id, Move.Released(), {
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
        const solo = yield* soloNow
        const to = TicketPhase.HeldBack({ why: held })
        yield* ledger.transition(id, Move.Held({ why: held }), {
          beside: [{ kind: "queue", ...(yield* recorded(now, ids, solo, [id, to])) }],
        })
      })

    const fill = oneFill.withPermit(
      Effect.gen(function* () {
        const found = yield* ready(beads, options.scope, filter)
        const before = yield* ledger.current
        const kept = yield* carrying
        const listed = found.filter((issue) => !kept.has(issue.id))
        const foundIds = new Set(found.map((issue) => issue.id))
        const { running } = yield* Ref.get(slots)
        const leftReady = new Set((yield* Ref.get(memo)).leftReady)
        for (const entry of before.tickets.values()) {
          if (!deferred(before, entry.ticket)) leftReady.delete(entry.ticket)
          else if (!foundIds.has(entry.ticket) && !running.has(entry.ticket)) {
            leftReady.add(entry.ticket)
          }
        }
        const holdsNow = holds(yield* gate)
        const back = (id: TicketId) => !holdsNow && deferred(before, id) && leftReady.has(id)
        const candidates = listed.filter((issue) => candidate(before, issue.id) || back(issue.id))
        // The queue's counts take in the tickets whose setup failed, held back apart.
        const ids = listed
          .filter(
            (issue) =>
              candidate(before, issue.id) || back(issue.id) || setupFailed(before, issue.id),
          )
          .map((issue) => issue.id)
        yield* remember((m) => ({ ...m, leftReady, lastIds: ids }))
        const setAsideNow: Array<TicketId> = []
        // A ticket waiting in the queue that bd ready no longer lists (closed, deferred or blocked
        // outside the run) leaves it; it is queued anew if it is ready again.
        for (const entry of before.tickets.values()) {
          if (waiting(before, entry.ticket) && !ids.includes(entry.ticket)) {
            const solo = yield* soloNow
            yield* ledger.transition(entry.ticket, Move.Unready(), {
              beside: [{ kind: "queue", ...(yield* recorded(before, ids, solo)) }],
            })
            yield* forget("waitSaid", entry.ticket)
            yield* forget("skipSaid", entry.ticket)
          }
        }
        // Each new candidate enters the ledger as Queued, and one set aside that is back in bd
        // ready re-enters it so; one with an unusable ID is set aside.
        for (const issue of candidates) {
          const again = back(issue.id)
          if (before.tickets.has(issue.id) && !again) continue
          const solo = yield* soloNow
          const queue = yield* recorded(yield* ledger.current, ids, solo, [
            issue.id,
            TicketPhase.Queued(),
          ])
          yield* ledger.transition(issue.id, again ? Move.Undeferred() : Move.Ready(), {
            title: issue.title,
            issue,
            beside: [{ kind: "queue", ...queue }],
            ...(again ? { lines: [undeferredLine(issue.id)] } : {}),
          })
          yield* remember((m) => {
            const left = new Set(m.leftReady)
            left.delete(issue.id)
            return { ...m, leftReady: left }
          })
          const why = ticketIdProblem(issue.id)
          if (why !== undefined) {
            yield* setAside(issue, why)
            setAsideNow.push(issue.id)
          }
        }
        const queue = candidates.filter((issue) => !setAsideNow.includes(issue.id))

        const open = (yield* LookOpen) ?? (yield* beads.list())
        const unclosed = unclosedIn(open, options.scope, filter)
        yield* remember((m) => ({ ...m, unclosed }))

        // The tickets left unmerged by an earlier run, and the parents waiting for their subtickets:
        // those of the tickets not closed or left unmerged, and of the run's tickets not merged yet.
        // bd show gives the parent of one the run didn't dispatch. They hold back only a ticket in
        // line, so they are read for the first a fill weighs, and not at all with none.
        let holders:
          | {
              readonly labelled: ReadonlyArray<Issue>
              readonly left: ReadonlyArray<Issue>
              readonly parents: ReadonlySet<TicketId>
            }
          | undefined
        const holding = Effect.gen(function* () {
          if (holders !== undefined) return holders
          const labelled = yield* beads.list({ status: "closed", labels: [unmergedLabel] })
          const left = leftUnmerged(yield* ledger.current, labelled)
          const openIds = new Set(open.map((issue) => issue.id))
          const parentOf = new Map((yield* Ref.get(memo)).parentOf)
          for (const id of unmerged(yield* ledger.current)) {
            if (parentOf.has(id) || openIds.has(id)) continue
            const read = yield* beads.show(id).pipe(Effect.result)
            if (Result.isSuccess(read)) parentOf.set(id, read.success.parent ?? null)
          }
          yield* remember((m) => ({ ...m, parentOf: new Map([...m.parentOf, ...parentOf]) }))
          const parents = parentsWaiting([...open, ...left], yield* ledger.current, parentOf)
          holders = { labelled, left, parents }
          return holders
        })

        // A ticket's issue as bd show gives it, read once a fill; null when bd couldn't.
        const shown = new Map<TicketId, Issue | null>()
        const showOnce = (id: TicketId) =>
          Effect.gen(function* () {
            if (shown.has(id)) return shown.get(id) ?? null
            const issue = yield* issueOf(id)
            shown.set(id, issue)
            return issue
          })
        // A waiting ticket's links with the issues they link to, as bd show gives them, from the lists
        // the fill has read: bd's open list and its closed tickets labelled unmerged. An issue in
        // neither is closed without the label, or one bd hides from both (a tombstone), and reads as
        // closed (closedLink): git says whether its work is on the base (asksGit).
        let linked: ReadonlyMap<TicketId, Issue> | undefined
        const linksOf = (issue: Issue) =>
          Effect.gen(function* () {
            if (linked === undefined) {
              const { labelled } = yield* holding
              linked = new Map([...open, ...labelled].map((each) => [each.id, each]))
            }
            const known = linked
            return {
              ...issue,
              dependencies: issue.dependencies.map((link) => {
                const other = known.get(link.id)
                return other === undefined ? link : { ...link, issue: other }
              }),
            }
          })

        // The repository's files and the running tickets' changes, read once a fill, and the files'
        // contents comparing their footprints asks about.
        const sources: Sources = new Map()
        const footprints = options.footprints
        const repo = footprints === undefined ? undefined : yield* footprints.repo
        const changes = new Map<TicketId, ReadonlyArray<string>>()
        const changedIn = (id: TicketId) =>
          Effect.gen(function* () {
            const known = changes.get(id)
            if (known !== undefined || footprints === undefined || repo === undefined) {
              return known ?? []
            }
            const files = (yield* footprints.changed(id)).map((f) => repo.file(f))
            changes.set(id, files)
            return files
          })
        // What a waiting ticket's branch changes, read once a fill, as are the tickets' branches
        // there are, in one git call for them all.
        const branches = new Map<TicketId, ReadonlyArray<string>>()
        let existing: { readonly names: ReadonlySet<string> | undefined } | undefined
        const branchIn = (id: TicketId) =>
          Effect.gen(function* () {
            const known = branches.get(id)
            if (known !== undefined || footprints?.branch === undefined) return known ?? []
            existing ??= {
              names: footprints.branches === undefined ? undefined : yield* footprints.branches,
            }
            const files = yield* footprints.branch(id, existing.names)
            branches.set(id, files)
            return files
          })
        // The ready tickets naming nothing, nor with commits on their branches, go to the predictor;
        // its guesses so far join footprints.
        const predictor = options.predictor
        if (predictor !== undefined && repo !== undefined) {
          yield* predictor.queue(queue, repo, branchIn)
        }
        const predicted: ReadonlyMap<TicketId, ReadonlyArray<string>> = predictor === undefined
          ? new Map()
          : yield* predictor.predicted

        // Two running tickets' worktrees changing one file: the second to merge may conflict.
        const runningNow = (yield* Ref.get(slots)).running
        if (footprints !== undefined && runningNow.size > 1) {
          const changed = new Map<TicketId, ReadonlyArray<string>>()
          for (const id of runningNow) changed.set(id, yield* changedIn(id))
          for (const edit of sharedChanges(changed)) {
            const key = `${edit.a} ${edit.b} ${edit.file}`
            const fresh = yield* Ref.modify(memo, (m): readonly [boolean, Memo] =>
              m.warned.has(key) ? [false, m] : [true, { ...m, warned: new Set(m.warned).add(key) }],
            )
            if (!fresh) continue
            const text = likelyConflictLine(edit)
            yield* warn(text)
          }
        }

        // Why git finds a closed blocker's work only on its branch, asked once a fill, the base where
        // the fill first found it.
        const closed = options.closedBranches
        let head: { readonly at: string | undefined } | undefined
        const offBase = new Map<TicketId, string | undefined>()
        const branchesOf = (state: State, links: Issue) =>
          Effect.gen(function* () {
            const found = new Map<TicketId, string>()
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
        // ready gives a ticket's links and the fill's lists the issues they link to, so none has a
        // bd show. With nothing of the run's pending, only a closed blocker's branch could hold one
        // back.
        const heldFor = (issue: Issue, state: State) =>
          Effect.gen(function* () {
            let held: Held | undefined
            const { left, parents } = yield* holding
            if (parents.has(issue.id)) held = parentHold
            else if (
              waitsOnLinks(issue) &&
              (left.length > 0 || pending(state) || closed !== undefined)
            ) {
              const links = yield* linksOf(issue)
              held = mergeHold(state, links, yield* branchesOf(state, links))
            }
            if (yield* said("waitSaid", issue.id, held?.text ?? "")) {
              yield* logs.write(waitsLine(issue.id, held?.text ?? ""))
            }
            return held
          })

        // With a slot free, what overlaps the footprint of a ticket running or past its work, saying
        // why once. A solo ticket waits for every one of them anyway, so it is never skipped for one.
        const overlapping = (
          issues: ReadonlyArray<Issue>,
          s: Slots,
          past: ReadonlyArray<TicketId>,
        ) =>
          Effect.gen(function* () {
            const skipped = new Map<TicketId, Held>()
            const asked = issues.filter((issue) => !isSolo(issue))
            if (
              footprints === undefined ||
              repo === undefined ||
              s.running.size + past.length === 0 ||
              asked.length === 0
            ) {
              return skipped
            }
            const { startBranch } = yield* Ref.get(memo)
            const running = new Map<TicketId, Footprint>()
            for (const [id, issue] of s.issues) {
              const fp = footprintOf(issue, repo, predicted, startBranch.get(id) ?? [])
              running.set(id, withChanges(fp, yield* changedIn(id), repo))
            }
            const mine = new Map<TicketId, Footprint>()
            for (const issue of asked) {
              mine.set(issue.id, footprintOf(issue, repo, predicted, yield* branchIn(issue.id)))
            }
            const pairs = [...mine.values()].flatMap((fp) =>
              [...running.values()].map((other) => [fp, other] as const),
            )
            const mentions = yield* footprints.mentions(pairs, sources)
            for (const issue of asked) {
              const held = overlapHold(
                mine.get(issue.id) as Footprint,
                running,
                mentions,
                (file) => !repo.shared(file),
              )
              if (yield* said("skipSaid", issue.id, held?.text ?? "")) {
                yield* logs.write(skippingLine(issue.id, held?.text ?? ""))
              }
              if (held !== undefined) skipped.set(issue.id, held)
            }
            return skipped
          })

        const dispatched: Array<TicketId> = []
        for (;;) {
          const { s: was, state } = yield* current
          const past = mergingIn(state, was.running)
          const slot = slotFree(was, state, options.concurrent)
          // A ticket back in the queue whose last fiber still holds its slot waits for it to end.
          const inLine = queue.filter(
            (issue) => waiting(state, issue.id) && !was.running.has(issue.id),
          )
          const holds = new Map<TicketId, HoldBack>()
          const notHeld: Array<Issue> = []
          for (const issue of inLine) {
            const held = yield* heldFor(issue, state)
            if (held === undefined) notHeld.push(issue)
            else holds.set(issue.id, held.why)
          }
          const s = slot ? yield* withIssues(was, past, showOnce) : was
          const overlaps = slot ? yield* overlapping(notHeld, s, past) : new Map<TicketId, Held>()
          for (const [id, held] of overlaps) holds.set(id, held.why)
          const free = notHeld.filter((issue) => !overlaps.has(issue.id))
          // The pick (`pick`), and its solo line said when it changed.
          const picked = pick({ free, solo: s.solo, busy: s.running.size + past.length, slot })
          const start = picked.start
          const say = yield* Ref.modify(memo, (m): readonly [Line | "", Memo] => [
            picked.soloLine === m.soloSaid ? "" : picked.soloLine,
            {
              ...m,
              soloNext: picked.soloNext,
              soloFirst: picked.soloFirst,
              soloSaid: picked.soloLine,
            },
          ])
          if (say !== "") yield* logs.write(say)
          for (const id of picked.heldSolo) holds.set(id, "solo")
          // The others are placed once the slots are filled, as the last pick leaves them: one
          // dispatched changes what holds the rest, and they aren't released only to be held again.
          if (start === undefined || !(yield* mayStart)) {
            for (const issue of inLine) yield* placeWaiting(issue.id, holds.get(issue.id), ids)
            // A ticket that ended while its footprint was read no longer holds the others back.
            if (overlaps.size > 0 && (yield* Ref.get(slots)).running !== s.running) continue
            break
          }
          yield* placeWaiting(start.id, undefined, ids)
          const branch = yield* branchIn(start.id)
          yield* remember((m) => ({
            ...m,
            startBranch: new Map(m.startBranch).set(start.id, branch),
          }))
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

    // A fill whose read fails is tried again a few seconds later, as readAgain says.
    const fillTrying = retrying(fill, readAgain, {
      tried: (error: BeadsError, tried) =>
        logs.write(
          line`could not read the queue (try ${tried} of ${readTries}), reading it again: ${beadsWhy(error)}`,
        ),
    })

    return {
      fillTrying,
      fillWith: (open) => Effect.provideService(fillTrying, LookOpen, open),
      freed: Queue.take(freed),
      carry: (ticket, start, issue) =>
        oneFill.withPermit(
          Effect.gen(function* () {
            const { s, state } = yield* known
            const others = s.running.size + mergingIn(state, s.running).length
            const free =
              slotFree(s, state, options.concurrent) &&
              s.solo === null &&
              !s.running.has(ticket) &&
              (issue === undefined || !isSolo(issue) || others === 0)
            if (!free) return false
            yield* beforeStart
            if (!takesBack(yield* gate) || !(yield* claimRoom)) return false
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
            const { s, state } = yield* known
            const free =
              slotFree(s, state, options.concurrent) &&
              s.solo === null &&
              (yield* Ref.get(memo)).soloFirst === null &&
              !s.running.has(ticket)
            // Its issue, read as it takes the slot, so that its footprint and solo label hold the
            // others back from the start, as a dispatched ticket's do.
            if (free) yield* occupy(ticket, work, (yield* issueOf(ticket)) ?? undefined)
            return free
          }),
        ),
      started: Effect.map(Ref.get(slots), (s) => s.started),
      running: Effect.map(Ref.get(slots), (s) => s.running),
      slots: slotsTaken,
      interrupt: FiberSet.clear(tickets),
      limitReached: Effect.map(Ref.get(slots), (s) => reached(s.started, options.limit)),
      recordQueue,
    }
  })
