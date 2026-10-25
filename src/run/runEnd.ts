// The run's end (§ 5 item 6, D19, § 4.3): whether a look of the run, its effects done (the fill, the
// requeues, the recheck, the answers), leaves it busy, done, waiting on you or waiting for the usage
// limit's reset. look.ts's loop does the look's effects and reads what they left into a Snapshot;
// decide reads that, and nothing else. limitedOnly reads, for the usage-limit hold, whether nothing
// runs but workers waiting for the limit.
import { Data } from "effect"
import type { TicketId } from "../services/Beads.ts"
import { waitedFor } from "./holdsGate.ts"
import { type Entry, handBackWaits } from "./ledger.ts"
import { isSettled, type QueueState } from "./mergequeue.ts"

/** What a look of the run left: read after its effects, in look.ts's nothingLeft. */
export interface Look {
  /** Nothing was merging as the look began: a merge that ended during it has the run look again. */
  readonly mergedBefore: boolean
  /** The tickets the scheduler runs, after the fill. */
  readonly running: ReadonlySet<TicketId>
  /** The ledger's tickets, after the fill. */
  readonly tickets: ReadonlyMap<TicketId, Pick<Entry, "ticket" | "phase" | "handBack">>
  /** The tickets whose workers went past --ticket-limit: the run doesn't wait for them. */
  readonly overLimit: ReadonlySet<TicketId>
  /** The tickets of the open requests, oldest request first. */
  readonly asking: ReadonlyArray<TicketId>
  /** Whether the run would take a ticket now, given a free slot. */
  readonly canTake: boolean
  /**
   * Whether a worker to be resumed found no slot in the look, carried over from the last run or
   * its question answered: it is still to start, once a slot frees (§ 5's Scheduling). The look
   * tries none while the run holds, which, as for a queued ticket, leaves it for the next run.
   */
  readonly resuming: boolean
  /**
   * Whether a question --auto-answer takes waits for its time (autoAnswer.ts): the run stays for
   * its answer, which the ready poll gives once the time is up, rather than end on it.
   */
  readonly answering: boolean
  /** Whether the merge queue is settled now: nothing merging, queued or resolving. */
  readonly settled: boolean
  /** The triage calls under way. */
  readonly triagePending: number
  /** Whether the run has a dashboard, which shows the end-of-run box. */
  readonly dashboard: boolean
}

/** A look, and what look.ts's untilDone reads after it. */
export interface Snapshot extends Look {
  /** A stop holds the run. */
  readonly held: boolean
  /** The usage-limit hold is on. */
  readonly usageHeld: boolean
  /** The end-of-run box's `q` was pressed since the last look. */
  readonly endAsked: boolean
}

/** What the run does after a look. */
export type End = Data.TaggedEnum<{
  /** Something runs, merges or could start: the run looks again at its next wake. */
  Busy: Record<never, never>
  /** The run ends; `asked` when the end-of-run box's `q` ended it. */
  Done: { readonly asked: boolean }
  /** Everything else done, the run waits for these workers to be answered or handed over (D19). */
  WaitOnYou: { readonly tickets: ReadonlyArray<TicketId> }
  /** Everything else done, the run waits for the usage limit's reset. */
  WaitForReset: Record<never, never>
}>

export const End = Data.taggedEnum<End>()

/**
 * Whether nothing else runs, waits to merge or could start, and which workers wait on you besides:
 * those with an open request, oldest first, those past their ticket limit left out; then, with a
 * dashboard, those a conflict hand-back waits for (§ 4.3).
 */
export const whatsLeft = (look: Look): { done: boolean; waiting: ReadonlyArray<TicketId> } => {
  const asking = new Set(look.asking)
  const aside = new Set<TicketId>()
  const busy = [...look.running].filter((ticket) => {
    const entry = look.tickets.get(ticket)
    if (entry === undefined || entry.phase._tag !== "Working") return true
    if (asking.has(ticket) && !look.overLimit.has(ticket)) aside.add(ticket)
    return !look.overLimit.has(ticket) && !asking.has(ticket)
  })
  const waiting = [...asking].filter((ticket) => aside.has(ticket))
  const entries = [...look.tickets.values()]
  // With a worker waiting on you in its slot, a ticket queued for a slot is still to start.
  const queued = entries.some((entry) => entry.phase._tag === "Queued")
  const toStart = waiting.length > 0 && queued && look.canTake
  // A ticket held back for a running one's footprint, when that one ended after the fill read it,
  // is to start too: the next look fills again.
  const overlapped =
    look.running.size === 0 &&
    entries.some((entry) => entry.phase._tag === "HeldBack" && entry.phase.why === "overlap") &&
    look.canTake
  const done =
    !overlapped &&
    !look.resuming &&
    !look.answering &&
    busy.length === 0 &&
    !toStart &&
    look.mergedBefore &&
    look.settled &&
    look.triagePending === 0
  // With a dashboard, a conflict hand-back waiting for its steered worker keeps the run open as a
  // request does, until you hand it over from the worker's view or release it (§ 4.3).
  const conflicts = look.dashboard
    ? entries
        .filter((entry) => handBackWaits(entry) && !waiting.includes(entry.ticket))
        .map((entry) => entry.ticket)
    : []
  return { done, waiting: [...waiting, ...conflicts] }
}

/** The workers the end-of-run box names, with a dashboard and everything else done; null for none. */
export const endOfRunBox = (look: Look): ReadonlyArray<TicketId> | null => {
  const { done, waiting } = whatsLeft(look)
  return done && waiting.length > 0 && look.dashboard ? waiting : null
}

/**
 * What the run does after a look. Done with nothing waiting, it ends, unless the usage-limit hold is
 * on and no stop holds it: then it waits for the reset. With workers waiting on you, a dashboard
 * waits until they are answered, handed over, or the box's `q` ends the run; plain, the run waits
 * only until a stop holds it.
 */
export const decide = (snapshot: Snapshot): End => {
  const { done, waiting } = whatsLeft(snapshot)
  if (!done) return End.Busy()
  if (waiting.length === 0) {
    return snapshot.held || !snapshot.usageHeld ? End.Done({ asked: false }) : End.WaitForReset()
  }
  if (snapshot.dashboard ? snapshot.endAsked : snapshot.held) {
    return End.Done({ asked: snapshot.endAsked })
  }
  return End.WaitOnYou({ tickets: waiting })
}

/** What limitedOnly reads, after a look. */
export interface LimitedOnly {
  /** The tickets whose workers are at the usage limit. */
  readonly limited: ReadonlySet<TicketId>
  /** The tickets whose hand-backs wait for their workers to leave the limit. */
  readonly handBacks: ReadonlySet<TicketId>
  /** The tickets whose workers went past --ticket-limit. */
  readonly overLimit: ReadonlySet<TicketId>
  /** The ledger's tickets. */
  readonly tickets: Iterable<Pick<Entry, "ticket" | "phase">>
  /** The merge queue's state. */
  readonly merges: QueueState
}

/**
 * Whether nothing runs but workers waiting for the usage limit, and no merge is under way or due
 * but the hand-backs waiting for it. A worker at the limit on a hand-back (Resolving, Fixing) waits
 * for it as one on its ticket does, once its hand-back waits for it: kept for the reset, or on its
 * turn that ended on it, not while it is handed over or what it left is checked.
 */
export const limitedOnly = (read: LimitedOnly): boolean => {
  const waits = (entry: Pick<Entry, "ticket" | "phase">) =>
    read.limited.has(entry.ticket) &&
    (entry.phase._tag === "Working" ||
      ((entry.phase._tag === "Resolving" || entry.phase._tag === "Fixing") &&
        read.handBacks.has(entry.ticket)))
  const others = [...read.tickets].some(
    (entry) => waitedFor(entry, read.overLimit) && !waits(entry),
  )
  const { merges } = read
  return (
    !others &&
    isSettled({ ...merges, resolving: merges.resolving.filter((id) => !read.handBacks.has(id)) })
  )
}
