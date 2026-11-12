// The scheduler (§ 5 item 5): it reads bd ready within the run's scope (scope.ts), enters each
// candidate in the ledger as Queued, and dispatches the highest-priority Queued ticket to Working
// while a slot is free, handing it to its per-ticket fiber through Start. A slot is taken for as
// long as that fiber runs. Free slots are filled at once (as the run starts, and as a ticket's
// fiber ends) and on the ready poll, every 30 s.
//
// A ready ticket waiting for something besides a slot is HeldBack (holds.ts), and Queued again once
// what held it is gone: a parent until its subtickets are closed and merged, a ticket until its
// blockers and the ticket it was filed from merge, and, with a slot free, one whose footprint
// shares an area or a function with a running ticket's. One sharing only a file with a running
// ticket starts beside it, warned LIKELY_CONFLICT: a rebase conflict is handed back as any is. A solo ticket runs alone: while it runs nothing starts beside it, and
// first in line it waits for the running tickets to finish, holding back those behind it so it
// isn't starved. With every slot taken the tickets wait for a slot anyway, and none is held for an
// overlap or a solo ticket.
//
// A ticket frees its slot as it goes to the merge queue, once its worker has settled, but it holds
// back what it did while it ran until it merges: from ToMerge to Merged, Resolving and Fixing
// included, it is counted among the running tickets for an overlap with its footprint and for a solo
// ticket, running or next. Up to `concurrent` tickets merge, or wait to merge, without a slot, so
// that a slow merge check can't pile finished tickets up without end: beyond that, each takes a slot
// until a merge ends, and a slot free in the meantime waits. A ticket handed back to its worker,
// Resolving or Fixing, takes a slot as a running one does, its worker being at work and running
// checks: the hand-back goes on at once, as the merge queue is never held, and no ticket starts
// until the workers at work are under `concurrent` again.
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
//
// Its operations are in schedule/, each taking the scheduler's state (schedule/state.ts's
// Scheduling): the slots (slots.ts), what it keeps between fills and the queue it shows and
// records (queue.ts), placing and holding (place.ts), starting a ticket in a slot (dispatch.ts),
// and the fill, with what it reads once (fill.ts, reads.ts). `make` assembles them.
import { Effect, FiberSet, type FileSystem, Queue, Ref, type Scope } from "effect"
import type { Log } from "../core/log.ts"
import type { Beads, BeadsError, Issue, TicketId } from "../services/Beads.ts"
import type { EventStream } from "../services/EventStream.ts"
import { Git, type Sha } from "../services/Git.ts"
import { branchFolder, branchOf } from "../services/Worktrees.ts"
import { checkScriptLines } from "./checkScripts.ts"
import type { ClosedBranches } from "./closedBranches.ts"
import { readDeclared } from "./declared.ts"
import type { RunFibers } from "./fibers.ts"
import { type Footprint, worktreeChanges } from "./footprint.ts"
import type { Gate } from "./holds.ts"
import type { Ledger } from "./ledger.ts"
import type { Room } from "./machineGate.ts"
import { type Mentions, readMentions, type Sources } from "./overlap.ts"
import type { RunPlaybook } from "./playbookRun.ts"
import { type RepoFiles, repoFiles } from "./repoFiles.ts"
import type { Solo } from "./runView.ts"
import { carry, recheckSlot } from "./schedule/dispatch.ts"
import { fillTrying } from "./schedule/fill.ts"
import { recordQueue } from "./schedule/queue.ts"
import { LookOpen } from "./schedule/reads.ts"
import { slotsNow } from "./schedule/slots.ts"
import { reached, scheduling } from "./schedule/state.ts"
import { noneVendored, readVendored } from "./vendored.ts"

export { dispatchLine, footprintLine } from "./schedule/dispatch.ts"
export {
  beadsOutage,
  type Picked,
  type PickFrom,
  pick,
  readAgain,
  readAgainAfter,
  readOutlasting,
  readTries,
  readyPoll,
} from "./schedule/fill.ts"
export { badTicketIdLine, badTicketIdNote, undeferredLine } from "./schedule/place.ts"
export { slotsTaken } from "./schedule/slots.ts"
export { progress } from "./schedule/state.ts"

/** The per-ticket fiber's entry: `start` is that fiber, and the ticket holds its slot until it ends. */
export interface Start {
  /** Takes the ticket, now Working in the ledger, from its worktree and session to its outcome. */
  start(issue: Issue): Effect.Effect<void>
}

/**
 * Where tickets work, read for each fill: what keeps tickets sharing a function apart, and warns of
 * those sharing a file (§ 5 Footprints).
 */
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
 * settings' `queue.shared_files`, hold no tickets apart (`RepoFiles.shared`); the vendored paths,
 * .gitattributes' linguist-vendored and the settings' `vendored` globs, are no ticket's
 * (`RepoFiles.vendored`), nor are their files' declarations read. The files the check
 * commands name are check files, and so are those the lines of `scriptedChecks`' scripts name, the
 * merge check's and the full check's (`checkScriptLines`), read with the files.
 */
export const footprintsOf = (options: {
  readonly repo: string
  readonly base: string
  readonly checkCommands: ReadonlyArray<string>
  readonly scriptedChecks?: ReadonlyArray<string>
  readonly sharedFiles?: ReadonlyArray<string>
  readonly vendored?: ReadonlyArray<string>
  readonly worktree: (ticket: TicketId) => Effect.Effect<string>
}): Effect.Effect<Footprints, never, Git | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Git | FileSystem.FileSystem>()
    const git = yield* Git
    const sharedFiles = options.sharedFiles ?? []
    const vendoredGlobs = options.vendored ?? []
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
      const vendored = yield* readVendored(options.repo, files, vendoredGlobs).pipe(
        Effect.provideContext(context),
      )
      const declared = yield* readDeclared(
        options.repo,
        files.filter((f) => !vendored.files.has(f)),
      ).pipe(Effect.provideContext(context))
      const scripts = yield* checkScriptLines(
        options.repo,
        files,
        options.scriptedChecks ?? [],
      ).pipe(Effect.provideContext(context))
      return repoFiles(
        files,
        [...options.checkCommands, ...scripts],
        union,
        sharedFiles,
        declared,
        vendored,
      )
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
        Effect.orElseSucceed(() =>
          repoFiles(undefined, options.checkCommands, [], sharedFiles, undefined, {
            ...noneVendored,
            globs: vendoredGlobs,
          }),
        ),
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
  /** What each ticket dispatched gets of the playbook (playbookRun.ts); none without it. */
  readonly playbook?: Pick<RunPlaybook, "choose">
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
   * The slots taken now, as the scheduler counts them (slotsTaken): the running tickets', the
   * handed-back ones', and one for each ticket waiting to merge or merging beyond `concurrent`. The
   * machine's cap and the pressure cap count these.
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

/** The scheduler over the run's Beads, Ledger (which writes the records), Log and RunFibers. */
export const make = (
  options: Options,
): Effect.Effect<Scheduler, never, Beads | Ledger | Log | EventStream | RunFibers | Scope.Scope> =>
  Effect.gen(function* () {
    const sched = yield* scheduling(options)
    const trying = fillTrying(sched)
    return {
      fillTrying: trying,
      fillWith: (open) => Effect.provideService(trying, LookOpen, open),
      freed: Queue.take(sched.freed),
      carry: (ticket, start, issue) => carry(sched, ticket, start, issue),
      recheckSlot: (ticket, work) => recheckSlot(sched, ticket, work),
      started: Effect.map(Ref.get(sched.slots), (s) => s.started),
      running: Effect.map(Ref.get(sched.slots), (s) => s.running),
      slots: slotsNow(sched),
      interrupt: FiberSet.clear(sched.tickets),
      limitReached: Effect.map(Ref.get(sched.slots), (s) => reached(s.started, options.limit)),
      recordQueue: recordQueue(sched),
    }
  })
