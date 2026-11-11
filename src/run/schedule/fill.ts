// The fill (Scheduler.fillTrying): reads bd ready, queues its new candidates (readQueue), holds
// back or releases the tickets waiting, and fills the free slots (fillSlots), each pass of its
// loop in named steps: the queue as it is now (lineUp), what holds each ticket in line back
// (holdsOf), the pick (choose), and the start or the placing of the rest (startOrPlace).
import { Duration, Effect, Ref } from "effect"
import { type BeadsError, beadsWhy, type Issue, type TicketId } from "../../services/Beads.ts"
import { ticketIdProblem } from "../../services/Worktrees.ts"
import { type Again, retrying } from "../again.ts"
import { type Footprint, withChanges } from "../footprint.ts"
import {
  type Beside,
  type Held,
  holds,
  isSolo,
  likelyConflictLine,
  mergeHold,
  overlapHold,
  parentHold,
  pending,
  sharedChanges,
  skippingLine,
  soloLine,
  startsBeside,
  startsBesideLine,
  waitsLine,
  waitsOnLinks,
} from "../holds.ts"
import type { State } from "../ledger.ts"
import { type Line, line } from "../log.ts"
import { type HoldBack, Move, TicketPhase } from "../phase.ts"
import { footprintOf } from "../predict.ts"
import type { Filled } from "../schedule.ts"
import { ready } from "../scope.ts"
import { dispatch, mayStart } from "./dispatch.ts"
import { placeWaiting, setAside, undeferredLine, withIssues } from "./place.ts"
import {
  counts,
  forget,
  type Memo,
  recorded,
  remember,
  said,
  showQueue,
  soloNow,
  warnOnce,
} from "./queue.ts"
import {
  branchesOf,
  branchIn,
  changedIn,
  type FillReads,
  fillReads,
  holding,
  linksOf,
  showOnce,
} from "./reads.ts"
import {
  candidate,
  current,
  deferred,
  mergingIn,
  type Slots,
  setupFailed,
  slotFree,
  waiting,
} from "./slots.ts"
import type { Scheduling } from "./state.ts"

/** How often bd ready is read while tickets run: tickets become ready mid-run. */
export const readyPoll: Duration.Duration = Duration.seconds(30)

/** How many times a poll reads bd ready while it fails, and how long it waits between reads. */
export const readTries = 3
export const readAgainAfter: Duration.Duration = Duration.seconds(3)

/** How a bd read is made again while it fails: readTries in all, readAgainAfter apart. */
export const readAgain: Again = { tries: readTries, after: readAgainAfter }

/**
 * How long bd may fail every read of the queue, or of a ticket whose worker ended, before the run
 * stops with BEADS_FAILED: a shorter outage only delays the fill (queueOutage.ts) or the settle.
 */
export const beadsOutage: Duration.Duration = Duration.minutes(10)

/** How a ticket's read is made again once readAgain has failed: a poll apart, for beadsOutage. */
export const readOutlasting: Again = { tries: Infinity, after: readyPoll, within: beadsOutage }

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

/** What a fill's read of bd ready left in the queue. */
export interface Candidates {
  /** bd ready's list, as the fill read it. */
  readonly found: ReadonlyArray<Issue>
  /** The candidates a queue record counts: those read, with the tickets whose setup failed. */
  readonly ids: ReadonlyArray<TicketId>
  /** The candidates in the queue: those read, but the ones set aside for their IDs. */
  readonly queue: ReadonlyArray<Issue>
  /** The tickets set aside for their IDs. */
  readonly setAside: ReadonlyArray<TicketId>
}

/**
 * Reads bd ready: a candidate is a ticket the run hasn't taken up, or one still waiting, or one set
 * aside that is back in bd ready (undeferred outside the run) while the run doesn't hold; a ticket
 * whose worker waits to be resumed (`carrying`) is none. A ticket waiting in the queue that bd
 * ready no longer lists leaves it, and each new candidate enters the ledger as Queued.
 */
const readQueue = (sched: Scheduling): Effect.Effect<Candidates, BeadsError> =>
  Effect.gen(function* () {
    const { options } = sched
    const found = yield* ready(sched.beads, options.scope, sched.filter)
    const before = yield* sched.ledger.current
    const kept = yield* sched.carrying
    const listed = found.filter((issue) => !kept.has(issue.id))
    const foundIds = new Set(found.map((issue) => issue.id))
    const { running } = yield* Ref.get(sched.slots)
    const leftReady = new Set((yield* Ref.get(sched.memo)).leftReady)
    for (const entry of before.tickets.values()) {
      if (!deferred(before, entry.ticket)) leftReady.delete(entry.ticket)
      else if (!foundIds.has(entry.ticket) && !running.has(entry.ticket)) {
        leftReady.add(entry.ticket)
      }
    }
    const holdsNow = holds(yield* sched.gate)
    const back = (id: TicketId) => !holdsNow && deferred(before, id) && leftReady.has(id)
    const candidates = listed.filter((issue) => candidate(before, issue.id) || back(issue.id))
    // The queue's counts take in the tickets whose setup failed, held back apart.
    const ids = listed
      .filter(
        (issue) => candidate(before, issue.id) || back(issue.id) || setupFailed(before, issue.id),
      )
      .map((issue) => issue.id)
    yield* remember(sched, (m) => ({ ...m, leftReady, lastIds: ids }))
    yield* dropUnready(sched, before, ids)
    const undeferred = new Set(
      candidates.filter((issue) => back(issue.id)).map((issue) => issue.id),
    )
    const setAsideNow = yield* queueCandidates(sched, before, candidates, undeferred, ids)
    const queue = candidates.filter((issue) => !setAsideNow.includes(issue.id))
    return { found, ids, queue, setAside: setAsideNow }
  })

/**
 * Takes out of the queue each ticket waiting in it that bd ready no longer lists among `ids`
 * (closed, deferred or blocked outside the run); it is queued anew if it is ready again.
 */
const dropUnready = (
  sched: Scheduling,
  before: State,
  ids: ReadonlyArray<TicketId>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const entry of before.tickets.values()) {
      if (waiting(before, entry.ticket) && !ids.includes(entry.ticket)) {
        const solo = yield* soloNow(sched)
        yield* sched.ledger.transition(entry.ticket, Move.Unready(), {
          beside: [{ kind: "queue", ...(yield* recorded(sched, before, ids, solo)) }],
        })
        yield* forget(sched, "waitSaid", entry.ticket)
        yield* forget(sched, "skipSaid", entry.ticket)
      }
    }
  })

/**
 * Enters each new candidate in the ledger as Queued, and one set aside that is back in bd ready
 * (`undeferred`) so again; one with an unusable ID is set aside. The tickets set aside.
 */
const queueCandidates = (
  sched: Scheduling,
  before: State,
  candidates: ReadonlyArray<Issue>,
  undeferred: ReadonlySet<TicketId>,
  ids: ReadonlyArray<TicketId>,
): Effect.Effect<ReadonlyArray<TicketId>> =>
  Effect.gen(function* () {
    const setAsideNow: Array<TicketId> = []
    for (const issue of candidates) {
      const again = undeferred.has(issue.id)
      if (before.tickets.has(issue.id) && !again) continue
      const solo = yield* soloNow(sched)
      const queue = yield* recorded(sched, yield* sched.ledger.current, ids, solo, [
        issue.id,
        TicketPhase.Queued(),
      ])
      yield* sched.ledger.transition(issue.id, again ? Move.Undeferred() : Move.Ready(), {
        title: issue.title,
        issue,
        beside: [{ kind: "queue", ...queue }],
        ...(again ? { lines: [undeferredLine(issue.id)] } : {}),
      })
      yield* remember(sched, (m) => {
        const left = new Set(m.leftReady)
        left.delete(issue.id)
        return { ...m, leftReady: left }
      })
      const why = ticketIdProblem(issue.id)
      if (why !== undefined) {
        yield* setAside(sched, issue, why)
        setAsideNow.push(issue.id)
      }
    }
    return setAsideNow
  })

/**
 * Warns LIKELY_CONFLICT, once, of two running tickets' worktrees changing one file: the second
 * to merge may conflict.
 */
const warnSharedChanges = (sched: Scheduling, reads: FillReads): Effect.Effect<void> =>
  Effect.gen(function* () {
    const runningNow = (yield* Ref.get(sched.slots)).running
    if (sched.options.footprints === undefined || runningNow.size <= 1) return
    const changed = new Map<TicketId, ReadonlyArray<string>>()
    for (const id of runningNow) changed.set(id, yield* changedIn(sched, reads, id))
    for (const edit of sharedChanges(changed)) {
      const fresh = yield* warnOnce(sched, `${edit.a} ${edit.b} ${edit.file}`)
      if (!fresh) continue
      yield* sched.warn(likelyConflictLine(edit))
    }
  })

/**
 * What holds a waiting ticket back for a parent or a ticket not merged, saying why once. bd ready
 * gives a ticket's links and the fill's lists the issues they link to, so none has a bd show. With
 * nothing of the run's pending, only a closed blocker's branch could hold one back.
 */
const heldFor = (
  sched: Scheduling,
  reads: FillReads,
  issue: Issue,
  state: State,
): Effect.Effect<Held | undefined, BeadsError> =>
  Effect.gen(function* () {
    let held: Held | undefined
    const { left, parents } = yield* holding(sched, reads)
    const subs = parents.get(issue.id)
    if (subs !== undefined) held = parentHold(subs)
    else if (
      waitsOnLinks(issue) &&
      (left.length > 0 || pending(state) || sched.options.closedBranches !== undefined)
    ) {
      const links = yield* linksOf(sched, reads, issue)
      held = mergeHold(state, links, yield* branchesOf(sched, reads, state, links))
    }
    if (yield* said(sched, "waitSaid", issue.id, held?.text ?? "")) {
      yield* sched.logs.write(waitsLine(issue.id, held?.text ?? ""))
    }
    return held
  })

/** What `overlapping` found: the tickets skipped, and the files each other shares with a running one's. */
interface Overlaps {
  readonly skipped: ReadonlyMap<TicketId, Held>
  readonly beside: ReadonlyMap<TicketId, ReadonlyArray<Beside>>
}

const noOverlaps: Overlaps = { skipped: new Map(), beside: new Map() }

/**
 * With a slot free, what shares an area or a function with the footprint of a ticket running or
 * past its work (`past`), saying why once, and the files each other ticket shares with theirs
 * (`beside`), warned as it starts. A solo ticket waits for every one of them anyway, so it is never
 * skipped for one.
 */
const overlapping = (
  sched: Scheduling,
  reads: FillReads,
  issues: ReadonlyArray<Issue>,
  s: Slots,
  past: ReadonlyArray<TicketId>,
): Effect.Effect<Overlaps> =>
  Effect.gen(function* () {
    const skipped = new Map<TicketId, Held>()
    const beside = new Map<TicketId, ReadonlyArray<Beside>>()
    const asked = issues.filter((issue) => !isSolo(issue))
    const { footprints } = sched.options
    const { repo, predicted } = reads
    if (
      footprints === undefined ||
      repo === undefined ||
      s.running.size + past.length === 0 ||
      asked.length === 0
    ) {
      return { skipped, beside }
    }
    const { startBranch } = yield* Ref.get(sched.memo)
    const running = new Map<TicketId, Footprint>()
    for (const [id, issue] of s.issues) {
      const fp = footprintOf(issue, repo, predicted, startBranch.get(id) ?? [])
      running.set(id, withChanges(fp, yield* changedIn(sched, reads, id), repo))
    }
    const mine = new Map<TicketId, Footprint>()
    for (const issue of asked) {
      mine.set(
        issue.id,
        footprintOf(issue, repo, predicted, yield* branchIn(sched, reads, issue.id)),
      )
    }
    const pairs = [...mine.values()].flatMap((fp) =>
      [...running.values()].map((other) => [fp, other] as const),
    )
    const mentions = yield* footprints.mentions(pairs, reads.sources)
    const apart = (file: string) => !repo.shared(file)
    for (const issue of asked) {
      const fp = mine.get(issue.id) as Footprint
      const held = overlapHold(fp, running)
      if (yield* said(sched, "skipSaid", issue.id, held?.text ?? "")) {
        yield* sched.logs.write(skippingLine(issue.id, held?.text ?? ""))
      }
      if (held !== undefined) skipped.set(issue.id, held)
      else beside.set(issue.id, startsBeside(fp, running, mentions, apart))
    }
    return { skipped, beside }
  })

/** The LIKELY_CONFLICT lines of a ticket starting beside running tickets, each said once. */
const warnBeside = (
  sched: Scheduling,
  id: TicketId,
  all: ReadonlyArray<Beside>,
): Effect.Effect<void> =>
  Effect.forEach(all, (each) =>
    Effect.gen(function* () {
      const fresh = yield* warnOnce(sched, `${id} beside ${each.other} ${each.file}`)
      if (fresh) yield* sched.warn(startsBesideLine(id, each), id)
    }),
  )

/** The queue as a pass of the fill's loop finds it: the slots and the ledger now. */
interface LinedUp {
  /** The slots as the pass began. */
  readonly was: Slots
  readonly state: State
  /** The tickets past their work and not merged yet that hold no slot. */
  readonly past: ReadonlyArray<TicketId>
  /** Whether a slot was free as the pass began. */
  readonly slot: boolean
  /** The tickets in line: waiting in the queue, their last fibers ended. */
  readonly inLine: ReadonlyArray<Issue>
}

/** Reads the state: the slots as the ledger has the tickets now, and the tickets in line. */
const lineUp = (sched: Scheduling, queue: ReadonlyArray<Issue>): Effect.Effect<LinedUp> =>
  Effect.gen(function* () {
    const { s: was, state } = yield* current(sched)
    const past = mergingIn(state, was.running)
    const slot = slotFree(was, state, sched.options.concurrent)
    // A ticket back in the queue whose last fiber still holds its slot waits for it to end.
    const inLine = queue.filter((issue) => waiting(state, issue.id) && !was.running.has(issue.id))
    return { was, state, past, slot, inLine }
  })

/** What holds each ticket in line back (`holds`), and those held for nothing (`notHeld`). */
interface Holds {
  readonly holds: Map<TicketId, HoldBack>
  readonly notHeld: ReadonlyArray<Issue>
}

/** Computes the holds: what holds each ticket in line back for a parent or a ticket not merged. */
const holdsOf = (
  sched: Scheduling,
  reads: FillReads,
  lined: LinedUp,
): Effect.Effect<Holds, BeadsError> =>
  Effect.gen(function* () {
    const holds = new Map<TicketId, HoldBack>()
    const notHeld: Array<Issue> = []
    for (const issue of lined.inLine) {
      const held = yield* heldFor(sched, reads, issue, lined.state)
      if (held === undefined) notHeld.push(issue)
      else holds.set(issue.id, held.why)
    }
    return { holds, notHeld }
  })

/** What a pass picked. */
interface Choice {
  /** The slots with the issues of the tickets running or past their work, read with a slot free. */
  readonly s: Slots
  readonly picked: Picked
  /** The tickets skipped for an overlap, and the files each other shares with a running one's. */
  readonly overlaps: Overlaps
  /** What holds each ticket in line back, the overlaps and the solo ticket's holds added. */
  readonly holds: ReadonlyMap<TicketId, HoldBack>
}

/**
 * The pick: with a slot free, the issues of the tickets running or past their work are read and
 * the overlaps found among the tickets held for nothing else; then `pick` chooses, its solo line
 * said when it changed and the memo told the solo ticket next and first.
 */
const choose = (
  sched: Scheduling,
  reads: FillReads,
  lined: LinedUp,
  held: Holds,
): Effect.Effect<Choice> =>
  Effect.gen(function* () {
    const { was, past, slot } = lined
    const holds = new Map(held.holds)
    const s = slot ? yield* withIssues(sched, was, past, (id) => showOnce(sched, reads, id)) : was
    const overlaps = slot ? yield* overlapping(sched, reads, held.notHeld, s, past) : noOverlaps
    for (const [id, each] of overlaps.skipped) holds.set(id, each.why)
    const free = held.notHeld.filter((issue) => !overlaps.skipped.has(issue.id))
    const picked = pick({ free, solo: s.solo, busy: s.running.size + past.length, slot })
    const say = yield* Ref.modify(sched.memo, (m): readonly [Line | "", Memo] => [
      picked.soloLine === m.soloSaid ? "" : picked.soloLine,
      {
        ...m,
        soloNext: picked.soloNext,
        soloFirst: picked.soloFirst,
        soloSaid: picked.soloLine,
      },
    ])
    if (say !== "") yield* sched.logs.write(say)
    for (const id of picked.heldSolo) holds.set(id, "solo")
    return { s, picked, overlaps, holds }
  })

/** What a pass of the fill's loop did: picked again, filled the slots, or started a ticket. */
type Step = "again" | "done" | { readonly started: TicketId }

/**
 * Starts the pick, or places the tickets in line: the others are placed once the slots are filled,
 * as the last pick leaves them, as one dispatched changes what holds the rest, and they aren't
 * released only to be held again.
 */
const startOrPlace = (
  sched: Scheduling,
  reads: FillReads,
  lined: LinedUp,
  choice: Choice,
  ids: ReadonlyArray<TicketId>,
): Effect.Effect<Step> =>
  Effect.gen(function* () {
    const { slot, inLine } = lined
    const { s, picked, overlaps, holds } = choice
    const start = picked.start
    // A slot that freed while the holds were read (a fiber ended) doesn't start the pick: with
    // no slot free as the loop began, it was made without the overlap check and the issues of
    // the tickets running, so the loop picks again with them.
    if (start !== undefined && !slot) {
      const now = yield* current(sched)
      if (slotFree(now.s, now.state, sched.options.concurrent)) return "again"
    }
    if (start === undefined || !slot || !(yield* mayStart(sched))) {
      for (const issue of inLine) yield* placeWaiting(sched, issue.id, holds.get(issue.id), ids)
      // A ticket that ended while its footprint was read no longer holds the others back.
      if (overlaps.skipped.size > 0 && (yield* Ref.get(sched.slots)).running !== s.running) {
        return "again"
      }
      return "done"
    }
    yield* placeWaiting(sched, start.id, undefined, ids)
    const branch = yield* branchIn(sched, reads, start.id)
    yield* remember(sched, (m) => ({
      ...m,
      startBranch: new Map(m.startBranch).set(start.id, branch),
    }))
    const { repo, predicted } = reads
    const footprint = repo === undefined ? undefined : footprintOf(start, repo, predicted, branch)
    if (!(yield* dispatch(sched, start, ids, footprint))) return "done"
    yield* warnBeside(sched, start.id, overlaps.beside.get(start.id) ?? [])
    return { started: start.id }
  })

/** Fills the free slots from `queue`, a ticket a pass, until none starts; the tickets dispatched. */
const fillSlots = (
  sched: Scheduling,
  reads: FillReads,
  queue: ReadonlyArray<Issue>,
  ids: ReadonlyArray<TicketId>,
): Effect.Effect<ReadonlyArray<TicketId>, BeadsError> =>
  Effect.gen(function* () {
    const dispatched: Array<TicketId> = []
    for (;;) {
      const lined = yield* lineUp(sched, queue)
      const held = yield* holdsOf(sched, reads, lined)
      const choice = yield* choose(sched, reads, lined, held)
      const step = yield* startOrPlace(sched, reads, lined, choice, ids)
      if (step === "done") break
      if (step !== "again") dispatched.push(step.started)
    }
    return dispatched
  })

/** One fill: reads bd ready, queues its new candidates, holds back or releases them, fills the slots. */
export const fill = (sched: Scheduling): Effect.Effect<Filled, BeadsError> =>
  sched.oneFill.withPermit(
    Effect.gen(function* () {
      const { found, ids, queue, setAside } = yield* readQueue(sched)
      const reads = yield* fillReads(sched, found, queue)
      yield* warnSharedChanges(sched, reads)
      const dispatched = yield* fillSlots(sched, reads, queue, ids)
      yield* showQueue(sched)
      const after = counts(yield* sched.ledger.current, ids, null)
      return {
        dispatched,
        setAside,
        queued: after.queued,
        heldBack: (after.held ?? 0) - (after.held_by?.setup ?? 0),
      }
    }),
  )

/** A fill whose read fails is tried again a few seconds later, as readAgain says. */
export const fillTrying = (sched: Scheduling): Effect.Effect<Filled, BeadsError> =>
  retrying(fill(sched), readAgain, {
    tried: (error: BeadsError, tried) =>
      sched.logs.write(
        line`could not read the queue (try ${tried} of ${readTries}), reading it again: ${beadsWhy(error)}`,
      ),
  })
