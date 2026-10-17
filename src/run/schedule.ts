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
// The ledger's phases keep a ticket from being taken twice: only a ticket the run hasn't taken up,
// or one still Queued or HeldBack, is a candidate. --limit counts the tickets this run starts; a
// resumed or carried-over worker takes a slot (carry) but counts toward nothing. A ticket whose ID
// can't name a worktree or a branch is set aside as it is queued (BAD_TICKET_ID), without a worker
// or a slot.
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
import { ticketIdProblem } from "../services/Worktrees.ts"
import type { Event } from "./events.ts"
import { EventStream } from "./eventstream.ts"
import { RunFibers } from "./fibers.ts"
import {
  type Footprint,
  type Mentions,
  type RepoFiles,
  readMentions,
  repoFiles,
  ticketFootprint,
  withChanges,
  worktreeChanges,
} from "./footprint.ts"
import {
  type Held,
  isSolo,
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
} from "./holds.ts"
import { Ledger, type State } from "./ledger.ts"
import { detail, type Line, Log, line } from "./log.ts"
import { Cause, type Hold, TicketPhase } from "./phase.ts"
import { ready } from "./scope.ts"

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
  /** The files the running ticket's worktree has changed since it left the base; none if unknown. */
  changed(ticket: string): Effect.Effect<ReadonlyArray<string>>
  /** Places the footprints' functions in the files they work on. */
  mentions(footprints: ReadonlyArray<Footprint>): Effect.Effect<Mentions>
}

/**
 * The footprints of the checkout at `repo`: its files from git, each running ticket's changes from
 * its worktree (`worktree` gives its folder) against `base`, and its files' contents. git failing
 * leaves names judged by their look, and a ticket's changes unknown.
 */
export const footprintsOf = (options: {
  readonly repo: string
  readonly base: string
  readonly checkCommands: ReadonlyArray<string>
  readonly worktree: (ticket: string) => string
}): Effect.Effect<Footprints, never, Git | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Git | FileSystem.FileSystem>()
    const git = yield* Git
    return {
      repo: git.trackedFiles(options.repo).pipe(
        Effect.map((files) => repoFiles(files, options.checkCommands)),
        Effect.orElseSucceed(() => repoFiles(undefined, options.checkCommands)),
      ),
      changed: (ticket) =>
        worktreeChanges(options.worktree(ticket), options.base).pipe(
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
          Effect.provideContext(context),
        ),
      mentions: (footprints) =>
        readMentions(options.repo, footprints).pipe(Effect.provideContext(context)),
    }
  })

export interface Options {
  /** How many tickets run at once. */
  readonly concurrent: number
  /** The most tickets this run starts (--limit). */
  readonly limit: number
  /** The ticket the run is scoped to (--ticket), or null for the whole of bd ready. */
  readonly scope: string | null
  /** The queue's `exclude_types`. */
  readonly excludeTypes: ReadonlyArray<string>
  readonly start: Start
  /** Whether the run takes new tickets now (holds say no); the ledger's wind-down says no too. */
  readonly taking?: Effect.Effect<boolean>
  /** Where tickets work, with the queue's `footprint` on; without it, no ticket overlaps another. */
  readonly footprints?: Footprints
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
  /**
   * Runs a resumed or carried-over worker's `work` in a slot, counting toward no limit. With its
   * issue, its footprint, its parent and its solo label count as a dispatched ticket's do.
   */
  carry(ticket: string, work: Effect.Effect<void>, issue?: Issue): Effect.Effect<void>
  /** The tickets this run has started: what --limit counts. */
  readonly started: Effect.Effect<number>
  /** The tickets holding a slot now. */
  readonly running: Effect.Effect<ReadonlySet<string>>
  /** Whether the run has started as many tickets as --limit allows. */
  readonly limitReached: Effect.Effect<boolean>
}

/** `[n/limit] <id> dispatching: <title>`, the dispatch's log line; `dispatching solo` for one. */
export const dispatchLine = (n: number, limit: number, issue: Issue): Line =>
  isSolo(issue)
    ? line`[${n}/${limit}] ${issue.id} dispatching solo: ${issue.title}`
    : line`[${n}/${limit}] ${issue.id} dispatching: ${issue.title}`

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
  const by: Partial<Record<Hold, number>> = {}
  for (const id of ids) {
    const phase = change?.[0] === id ? change[1] : state.tickets.get(id)?.phase
    if (phase?._tag === "Queued") queued++
    if (phase?._tag === "HeldBack") by[phase.why] = (by[phase.why] ?? 0) + 1
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
  /** The running tickets dispatched, or carried with their issue: their footprints and labels. */
  readonly issues: ReadonlyMap<string, Issue>
  /** The solo ticket running, if any. */
  readonly solo: string | null
}

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
    const filter = { excludeTypes: options.excludeTypes }
    // The parents of the tickets the run took up, for those closed and not merged yet.
    const parentOf = new Map<string, string>()
    const waitSaid = sayOnce()
    const skipSaid = sayOnce()
    // The solo ticket next, which holds back the others while a slot is free, and its line last said.
    let soloNext: string | null = null
    let soloSaid = ""
    // The LIKELY_CONFLICT lines said, each once.
    const warned = new Set<string>()

    const soloState = (s: Slots): SoloState | null =>
      s.solo !== null
        ? { ticket: s.solo }
        : soloNext !== null
          ? { ticket: soloNext, next: true }
          : null

    const occupy = (ticket: string, work: Effect.Effect<void>, issue?: Issue) =>
      Effect.gen(function* () {
        if (issue?.parent !== undefined) parentOf.set(ticket, issue.parent)
        yield* Ref.update(slots, (s) => ({
          ...s,
          running: new Set([...s.running, ticket]),
          issues: issue === undefined ? s.issues : new Map([...s.issues, [ticket, issue]]),
          solo: issue !== undefined && isSolo(issue) ? ticket : s.solo,
        }))
        const release = Effect.andThen(
          Ref.update(slots, (s) => {
            skipSaid.forget(ticket)
            return {
              ...s,
              running: new Set([...s.running].filter((id) => id !== ticket)),
              issues: new Map([...s.issues].filter(([id]) => id !== ticket)),
              solo: s.solo === ticket ? null : s.solo,
            }
          }),
          Queue.offer(freed, undefined),
        )
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
        })
        yield* logs.write(text)
        const deferred = yield* beads
          .defer(issue.id, { reason: badTicketIdNote(issue.id, why) })
          .pipe(Effect.result)
        if (Result.isFailure(deferred)) {
          yield* logs.write(detail`${why}: ${issue.id}, and bd could not defer it`)
        }
      })

    const dispatch = (issue: Issue, ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const s = yield* Ref.updateAndGet(slots, (s) => ({ ...s, started: s.started + 1 }))
        const text = dispatchLine(s.started, options.limit, issue)
        const solo = isSolo(issue) ? { ticket: issue.id } : soloState(s)
        const queue = counts(yield* ledger.current, ids, solo, [
          issue.id,
          TicketPhase.Working({ activity: "starting" }),
        ])
        const record: Event = {
          kind: "dispatch",
          ticket: issue.id,
          title: issue.title,
          n: s.started,
          limit: options.limit,
          ...queue,
          text,
        }
        const moved = yield* ledger.transition(issue.id, Cause.Dispatched(), { beside: [record] })
        if (Result.isFailure(moved)) {
          // A PHASE_BUG, which the ledger logged: nothing starts, and nothing is counted.
          yield* Ref.update(slots, (s) => ({ ...s, started: s.started - 1 }))
          return false
        }
        yield* logs.write(text)
        yield* occupy(issue.id, options.start.start(issue), issue)
        return true
      })

    const mayStart = Effect.gen(function* () {
      const s = yield* Ref.get(slots)
      const state = yield* ledger.current
      return (
        s.running.size < options.concurrent &&
        s.started < options.limit &&
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
            beside: [{ kind: "queue", ...counts(before, ids, solo, [id, TicketPhase.Queued()]) }],
          })
        }
        if (held === undefined) return
        const now = yield* ledger.current
        const solo = soloState(yield* Ref.get(slots))
        const to = TicketPhase.HeldBack({ why: held })
        yield* ledger.transition(id, Cause.Held({ why: held }), {
          beside: [{ kind: "queue", ...counts(now, ids, solo, [id, to]) }],
        })
      })

    const fill = oneFill.withPermit(
      Effect.gen(function* () {
        const found = yield* ready(beads, options.scope, filter)
        const before = yield* ledger.current
        const candidates = found.filter((issue) => candidate(before, issue.id))
        const ids = candidates.map((issue) => issue.id)
        const setAsideNow: Array<string> = []
        // A ticket held back that bd ready no longer lists has nothing to wait for in the queue.
        for (const entry of before.tickets.values()) {
          if (entry.phase._tag === "HeldBack" && !ids.includes(entry.ticket)) {
            yield* settle(entry.ticket, undefined, ids)
          }
        }
        // Each new candidate enters the ledger as Queued; one with an unusable ID is set aside.
        for (const issue of candidates) {
          if (before.tickets.has(issue.id)) continue
          const solo = soloState(yield* Ref.get(slots))
          const queue = counts(yield* ledger.current, ids, solo, [issue.id, TicketPhase.Queued()])
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

        // The parents waiting for their subtickets: those of the tickets not closed, and of the
        // run's tickets not merged yet. bd show gives the parent of one the run didn't dispatch.
        const open = yield* beads.list()
        const openIds = new Set(open.map((issue) => issue.id))
        for (const id of unmerged(yield* ledger.current)) {
          if (parentOf.has(id) || openIds.has(id)) continue
          const read = yield* beads.show(id).pipe(Effect.result)
          if (Result.isSuccess(read)) parentOf.set(id, read.success.parent ?? "")
        }
        const parents = parentsWaiting(open, yield* ledger.current, parentOf)

        // A ticket's links, as bd show gives them, read once a fill; null when bd couldn't.
        const shown = new Map<string, Issue | null>()
        const linksOf = (id: string) =>
          Effect.gen(function* () {
            if (shown.has(id)) return shown.get(id) ?? null
            const read = yield* beads.show(id).pipe(Effect.result)
            if (Result.isFailure(read)) {
              yield* logs.write(
                detail`could not read ${id}'s links: ${read.failure.message || read.failure._tag}`,
              )
            }
            const issue = Result.isSuccess(read) ? read.success : null
            shown.set(id, issue)
            return issue
          })

        // The repository's files and the running tickets' changes, read once a fill.
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
            yield* events.emit({ kind: "warn", text })
            yield* logs.write(text)
          }
        }

        // What holds a waiting ticket back for a parent or a ticket not merged, saying why once.
        const heldFor = (issue: Issue, state: State) =>
          Effect.gen(function* () {
            let held: Held | undefined
            if (parents.has(issue.id)) held = parentHold
            else if (pending(state)) {
              const links = yield* linksOf(issue.id)
              held = links === null ? unreadableHold : mergeHold(state, links)
            }
            if (waitSaid.changed(issue.id, held?.text ?? "")) {
              yield* logs.write(waitsLine(issue.id, held?.text ?? ""))
            }
            return held
          })

        // With a slot free, what overlaps a running ticket's footprint, saying why once. A solo
        // ticket waits for every running ticket anyway, so it is never skipped for one.
        const overlapping = (issues: ReadonlyArray<Issue>, s: Slots) =>
          Effect.gen(function* () {
            const skipped = new Map<string, Held>()
            if (footprints === undefined || repo === undefined || s.running.size === 0) {
              return skipped
            }
            const running = new Map<string, Footprint>()
            for (const [id, issue] of s.issues) {
              running.set(id, withChanges(ticketFootprint(issue, repo), yield* changedIn(id), repo))
            }
            const asked = issues.filter((issue) => !isSolo(issue))
            const mine = new Map(asked.map((issue) => [issue.id, ticketFootprint(issue, repo)]))
            const mentions = yield* footprints.mentions([...mine.values(), ...running.values()])
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
          const state = yield* ledger.current
          const s = yield* Ref.get(slots)
          const slot = s.running.size < options.concurrent
          const inLine = queue.filter((issue) => waiting(state, issue.id))
          const holds = new Map<string, Hold>()
          const notHeld: Array<Issue> = []
          for (const issue of inLine) {
            const held = yield* heldFor(issue, state)
            if (held === undefined) notHeld.push(issue)
            else holds.set(issue.id, held.why)
          }
          const overlaps = slot ? yield* overlapping(notHeld, s) : new Map<string, Held>()
          for (const [id, held] of overlaps) holds.set(id, held.why)
          const free = notHeld.filter((issue) => !overlaps.has(issue.id))
          // The pick: the first ticket free, unless a solo ticket runs, or is first in line and
          // waits for the running tickets to finish.
          const first = free[0]
          let start: Issue | undefined
          let next: string | null = null
          if (first !== undefined && s.solo === null) {
            if (isSolo(first) && s.running.size > 0) next = first.id
            else start = first
          }
          soloNext = slot ? next : null
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
            break
          }
          yield* settle(start.id, undefined, ids)
          if (!(yield* dispatch(start, ids))) break
          dispatched.push(start.id)
        }
        const after = counts(yield* ledger.current, ids, null)
        return {
          dispatched,
          setAside: setAsideNow,
          queued: after.queued,
          heldBack: after.held ?? 0,
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
                  line`could not read the queue (try ${tries} of ${readTries}), reading it again: ${error.message || error._tag}`,
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
      carry: occupy,
      started: Effect.map(Ref.get(slots), (s) => s.started),
      running: Effect.map(Ref.get(slots), (s) => s.running),
      limitReached: Effect.map(Ref.get(slots), (s) => s.started >= options.limit),
    }
  })
