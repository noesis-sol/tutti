// The run's end (§ 5 item 6, D19, § 4.3): whether a look of the run, its effects done (the fill, the
// requeues, the recheck, the answers), leaves it busy, done, waiting on you or waiting for the usage
// limit's reset. run.ts's nothingLeft and settle do the look's effects and read what they left into
// a Snapshot; decide reads that, and nothing else.
import { Data } from "effect"
import { type Entry, handBackWaits } from "./ledger.ts"

/** What a look of the run left: read after its effects, in nothingLeft. */
export interface Look {
  /** Nothing was merging as the look began: a merge that ended during it has the run look again. */
  readonly mergedBefore: boolean
  /** The tickets the scheduler runs, after the fill. */
  readonly running: ReadonlySet<string>
  /** The ledger's tickets, after the fill. */
  readonly tickets: ReadonlyMap<string, Pick<Entry, "ticket" | "phase" | "handBack">>
  /** The tickets whose workers went past --ticket-limit: the run doesn't wait for them. */
  readonly overLimit: ReadonlySet<string>
  /** The tickets of the open requests, oldest request first. */
  readonly asking: ReadonlyArray<string>
  /** Whether the run would take a ticket now, given a free slot. */
  readonly canTake: boolean
  /** Whether the merge queue is settled now: nothing merging, queued or resolving. */
  readonly settled: boolean
  /** The triage calls under way. */
  readonly triagePending: number
  /** Whether the run has a dashboard, which shows the end-of-run box. */
  readonly dashboard: boolean
}

/** A look, and what settle reads after it. */
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
  WaitOnYou: { readonly tickets: ReadonlyArray<string> }
  /** Everything else done, the run waits for the usage limit's reset. */
  WaitForReset: Record<never, never>
}>

export const End = Data.taggedEnum<End>()

/**
 * Whether nothing else runs, waits to merge or could start, and which workers wait on you besides:
 * those with an open request, oldest first, those past their ticket limit left out; then, with a
 * dashboard, those a conflict hand-back waits for (§ 4.3).
 */
export const whatsLeft = (look: Look): { done: boolean; waiting: ReadonlyArray<string> } => {
  const asking = new Set(look.asking)
  const aside = new Set<string>()
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
export const endOfRunBox = (look: Look): ReadonlyArray<string> | null => {
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
