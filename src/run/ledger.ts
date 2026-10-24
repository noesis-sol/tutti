// The ledger (§ 3.4, § 5.1): each ticket the run takes up, with its phase, its worker's number and
// its tallies, and the wind-down. It is the one module that writes them. The state is held in a
// SubscriptionRef, which in Effect 4 is a SynchronizedRef (its updates run one at a time, under a
// semaphore) that also publishes each new state, for RunView to project.
//
// Every phase change goes through transition(), which asks the state machine (phase.ts) for the
// next phase; a ticket that leaves the machine leaves the ledger. A change the machine doesn't have
// is a bug: it is logged once as PHASE_BUG, the ticket keeps its phase, and no record is written. A
// valid one writes a `phase` record to the event stream, then the orchestra-era records the caller
// gives beside it (`dispatch`, `closed`, …), all while the state is held, so records come out in
// the order the phases changed. The lines the caller gives are logged with the records, in one
// write (Log's writeWith), so the log has them in the records' order.
import {
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  Ref,
  Result,
  type Stream,
  SubscriptionRef,
} from "effect"
import {
  type Event,
  type endingPhases,
  type Phases,
  type phaseSeconds,
  type queuePhases,
  type TokensByModel,
  tenths,
  type ticketOutcomes,
} from "./events.ts"
import { EventStream } from "./eventstream.ts"
import * as log from "./log.ts"
import { Log, Tag } from "./log.ts"
import {
  type Cause,
  type Detail,
  hasCard,
  InvalidTransition,
  type MergeStep,
  type PhaseTag,
  refine as refinePhase,
  type TicketPhase,
  transition as transitionPhase,
  waitShown,
} from "./phase.ts"
import { nothingSpent, Spending, type Spent } from "./spending.ts"

/**
 * What the ledger counts for each ticket, for triage and the reviewer. Its attention requests,
 * their answers and Claude Code's denials are Attention's to count (Attention.tally).
 */
export const tallyNames = ["messages", "compactions"] as const
export type TallyName = (typeof tallyNames)[number]

/** A ticket's tallies: your messages to its worker, and its worker's compactions. */
export type Tallies = { readonly [K in TallyName]: number }

export const emptyTallies: Tallies = {
  messages: 0,
  compactions: 0,
}

/** A ticket the run took up. Times are epoch milliseconds. */
export interface Entry {
  readonly ticket: string
  /** Its title as Beads gave it: untrusted, sanitised where it enters RunView. */
  readonly title: string
  readonly phase: TicketPhase
  /** When it entered its phase. */
  readonly since: number
  /**
   * Its worker's number, held for as long as its session is open; null without one. It orders the
   * cards and is never shown (§ 7.2).
   */
  readonly worker: number | null
  /**
   * Its place in the tickets table, from the first phase that has a row; null before. It takes the
   * next place again as the ticket leaves Current.
   */
  readonly row: number | null
  /** Checked once more after a failed check (§ 5.1's RECHECK), while it is ToMerge or Merging. */
  readonly rechecking: boolean
  /**
   * You have steered its worker, by a message from its composer or an interrupt, and not released
   * it: tutti sends it nothing automatically (§ 4.3).
   */
  readonly steered: boolean
  /**
   * A conflict hand-back waits for its steered worker (§ 4.3): set as the hand-back is kept, before
   * the ticket is Blocked on it, and cleared as the ticket leaves Blocked. Blocked meanwhile, it keeps
   * its worker's number and its card.
   */
  readonly handBack?: boolean
  /** When you last sent its worker a message; its idle grace for PAUSED counts from then. */
  readonly lastMessage: number | null
  readonly tallies: Tallies
  /** Its time and hand-backs, for the records that end its part in the run (§ 10). */
  readonly account?: Account
}

/** A ticket's time and hand-backs in the run. Times are epoch milliseconds. */
export interface Account {
  /** When the run first took it up (it entered Working, ToMerge, …); null before. */
  readonly took: number | null
  /** How long it spent in each of orchestra's phases it entered (§ 10), in milliseconds. */
  readonly spentIn: { readonly [P in PhaseSeconds]?: number }
  /** Its hand-backs in the run: for conflicts, and for a failing check. */
  readonly handBacks: { readonly resolve: number; readonly fix: number }
  /** Carried over from an earlier run. */
  readonly carried: boolean
}

/** The account of a ticket entering the run. */
export const newAccount = (): Account => ({
  took: null,
  spentIn: {},
  handBacks: { resolve: 0, fix: 0 },
  carried: false,
})

type PhaseSeconds = (typeof phaseSeconds)[number]

/** The phase of orchestra's that each phase's time counts in (§ 10), for those it counts. */
const countsIn: { readonly [P in PhaseTag]?: PhaseSeconds } = {
  Working: "working",
  ToMerge: "waiting",
  Merging: "merging",
  Resolving: "resolving",
  Fixing: "fixing",
}

type EndingPhase = (typeof endingPhases)[number]

type QueuePhase = (typeof queuePhases)[number]

/** How a ticket's part in the run ended, by the phase it ended in. */
const outcomeOf = (phase: TicketPhase): (typeof ticketOutcomes)[number] | undefined => {
  switch (phase._tag) {
    case "Done":
      return phase.outcome._tag === "Merged" ? "merged" : "no_change"
    case "Deferred":
    case "Review":
      return "set_aside"
    case "Asked":
    case "Blocked":
      return "needs_you"
    case "Stopped":
      return "stopped"
    case "Waiting":
    case "Queued":
    case "HeldBack":
      return "queued"
  }
  return undefined
}

/** The phases that end a ticket's part in the run, for now or for good. */
const endsPart: ReadonlySet<PhaseTag> = new Set<EndingPhase>([
  "Done",
  "Asked",
  "Deferred",
  "Review",
  "Blocked",
  "Stopped",
])

/** The phases in the queue: a ticket the run took up and left in one gets its ticket_end at the end. */
const inQueue: ReadonlySet<PhaseTag> = new Set<QueuePhase>(["Waiting", "Queued", "HeldBack"])

/** The causes that bring a ticket carried over from an earlier run into this one. */
const carriedIn: ReadonlySet<Cause["_tag"]> = new Set(["Resumed", "StillAsked", "Unmerged"])

/**
 * What the record that ends `entry`'s part in the run says of what it spent, `spent` its workers'
 * turns: orchestra's `phases`, `hand_backs`, `carried` and `tokens`, and tutti's `cost_usd`.
 */
export const spentFields = (
  entry: Entry,
  spent: Spent,
): {
  phases?: Phases
  hand_backs: { resolve: number; fix: number }
  carried?: true
  tokens?: TokensByModel
  cost_usd?: number
} => {
  const account = entry.account ?? newAccount()
  const phases: Record<string, number> = {}
  for (const [phase, ms] of Object.entries(account.spentIn)) phases[phase] = tenths(ms)
  return {
    ...(Object.keys(phases).length === 0 ? {} : { phases }),
    hand_backs: { ...account.handBacks },
    ...(account.carried ? { carried: true as const } : {}),
    ...(Object.keys(spent.tokens).length === 0 ? {} : { tokens: spent.tokens }),
    ...(spent.results === 0 ? {} : { cost_usd: spent.costUsd }),
  }
}

/**
 * The `ticket_end` record of `entry`, whose part in the run ended in `phase` at `now`, and the
 * records written beside it given what it spent, those that end its part in the run (`closed`,
 * `deferred`, a `warn` with `aside`).
 */
export const ending = (
  entry: Entry,
  phase: TicketPhase,
  now: number,
  spent: Spent,
  beside: ReadonlyArray<Event>,
): ReadonlyArray<Event> => {
  const outcome = outcomeOf(phase)
  if (outcome === undefined) return beside
  const fields = spentFields(entry, spent)
  const why =
    phase._tag === "Asked"
      ? phase.question
      : phase._tag === "Waiting"
        ? waitShown(phase.for)
        : "why" in phase
          ? (phase.why as string)
          : undefined
  const ends = (event: Event) =>
    event.kind === "closed" ||
    event.kind === "deferred" ||
    (event.kind === "warn" && event.aside === true)
  return [
    ...beside.map((event) =>
      ends(event) && "ticket" in event && event.ticket === entry.ticket
        ? ({ ...event, ...fields } as Event)
        : event,
    ),
    {
      kind: "ticket_end",
      ticket: entry.ticket,
      outcome,
      phase: phase._tag as EndingPhase | QueuePhase,
      ...(why === undefined ? {} : { why }),
      seconds: tenths(now - (entry.account?.took ?? now)),
      turns: spent.turns,
      ...fields,
    } satisfies Event,
  ]
}

/** The wind-down (orchestra's drain): when it began, and the tickets running then. */
export interface WindDown {
  readonly since: number
  readonly tickets: ReadonlyArray<string>
}

export interface State {
  /** Every ticket the run took up, in the order it took them up. */
  readonly tickets: ReadonlyMap<string, Entry>
  /** The place the next ticket to get a row takes. */
  readonly rows: number
  /** Set while the run winds down: no new tickets, the running ones finish. */
  readonly windDown: WindDown | null
  /** The PHASE_BUG lines logged so far, each once. */
  readonly bugs: ReadonlyArray<string>
}

export const emptyState: State = { tickets: new Map(), rows: 0, windDown: null, bugs: [] }

/** The phases a ticket shows no row in, unless it had one before (§ 5.1). */
const rowless: ReadonlySet<PhaseTag> = new Set(["Queued", "HeldBack"])

/**
 * Whether a ticket in `phase` keeps its worker's number: while its session is open (§ 4.8), that
 * is, in the phases with a card, and set aside after a failed check that may be checked again.
 */
export const holdsWorker = (phase: TicketPhase): boolean =>
  hasCard(phase) || (phase._tag === "Review" && phase.why === "CHECKS_FAILED")

/** Whether `entry` is Blocked on a conflict whose hand-back waits for its steered worker (§ 4.3). */
export const handBackWaits = (entry: Pick<Entry, "phase" | "handBack">): boolean =>
  entry.handBack === true && entry.phase._tag === "Blocked" && entry.phase.why === Tag.mergeConflict

/**
 * Whether `entry` keeps its worker's number: in a phase that holds one, or Blocked with its
 * hand-back waiting, its session open for it (§ 4.3, § 4.8).
 */
export const keepsWorker = (entry: Pick<Entry, "phase" | "handBack">): boolean =>
  holdsWorker(entry.phase) || handBackWaits(entry)

/** Whether `entry` has a card: a phase with one, or Blocked with its hand-back waiting (§ 4.3). */
export const showsCard = (entry: Pick<Entry, "phase" | "handBack">): boolean =>
  hasCard(entry.phase) || handBackWaits(entry)

/** The lowest number from 1 that no ticket's worker has. */
export const lowestFree = (tickets: ReadonlyMap<string, Entry>): number => {
  const taken = new Set<number>()
  for (const entry of tickets.values()) {
    if (entry.worker !== null) taken.add(entry.worker)
  }
  let n = 1
  while (taken.has(n)) n++
  return n
}

/** The phase's details, as a `phase` record carries them. */
const details = (
  phase: TicketPhase,
): { place?: number; step?: MergeStep; attempt?: number; why?: string } => {
  switch (phase._tag) {
    case "ToMerge":
      return { place: phase.place }
    case "Merging":
      return { step: phase.step }
    case "Resolving":
    case "Fixing":
      return { attempt: phase.attempt }
    case "HeldBack":
    case "Deferred":
    case "Review":
    case "Blocked":
    case "Stopped":
      return { why: phase.why }
  }
  return {}
}

/**
 * The `phase` record for `ticket` moving from `from` (null: entering the run) to `to` (null:
 * leaving it).
 */
export const phaseRecord = (
  ticket: string,
  from: TicketPhase | null,
  to: TicketPhase | null,
  cause: Cause,
): Event => ({
  kind: "phase",
  ticket,
  ...(from === null ? {} : { from: from._tag }),
  ...(to === null ? {} : { to: to._tag, ...details(to) }),
  cause: cause._tag,
})

/** `entry` moved to `phase` by `cause` at `now`: its row and its worker's number follow. */
const moved = (
  state: State,
  entry: Entry,
  phase: TicketPhase,
  cause: Cause,
  now: number,
): State => {
  // A hand-back waits only while the ticket is Blocked on it.
  const handBack = entry.handBack === true && phase._tag === "Blocked"
  // A row whose ticket leaves Current moves to the end, so that the rows are in the order their
  // tickets came to an end, and one leaving Current comes in under the others in the tickets table
  // beside it (§ 7.2).
  const leaves = entry.row !== null && showsCard(entry) && !showsCard({ phase, handBack })
  const row = leaves ? state.rows : (entry.row ?? (rowless.has(phase._tag) ? null : state.rows))
  const worker = keepsWorker({ phase, handBack })
    ? (entry.worker ?? lowestFree(state.tickets))
    : null
  const rechecking =
    cause._tag === "Recheck" ||
    (entry.rechecking && (phase._tag === "ToMerge" || phase._tag === "Merging"))
  const tickets = new Map(state.tickets)
  tickets.set(entry.ticket, {
    ...accounted(entry, phase, cause, now),
    phase,
    since: now,
    row,
    worker,
    rechecking,
    handBack,
  })
  return {
    ...state,
    tickets,
    rows: row !== null && row !== entry.row ? state.rows + 1 : state.rows,
  }
}

/**
 * `entry`'s time in its phase counted, up to `now`, as it moves to `phase` by `cause`: its
 * phases' times, its hand-backs, and for a ticket entering the run, whether it was carried over.
 */
export const accounted = (entry: Entry, phase: TicketPhase, cause: Cause, now: number): Entry => {
  // A ticket entering the run has no account yet: its phase is the one it enters.
  const fresh = entry.account === undefined
  const account = entry.account ?? newAccount()
  const spentIn = { ...account.spentIn }
  const left = countsIn[entry.phase._tag]
  if (left !== undefined && !fresh) {
    spentIn[left] = (spentIn[left] ?? 0) + Math.max(0, now - entry.since)
  }
  const entered = countsIn[phase._tag]
  if (entered !== undefined) spentIn[entered] = spentIn[entered] ?? 0
  // A hand-back counts by its cause, as Fixing hands back to Fixing on a second failed check.
  const handedBack = (tag: Cause["_tag"]) => (cause._tag === tag ? 1 : 0)
  return {
    ...entry,
    account: {
      took: account.took ?? (entered === undefined ? null : now),
      spentIn,
      handBacks: {
        resolve: account.handBacks.resolve + handedBack("ConflictsHandedBack"),
        fix: account.handBacks.fix + handedBack("CheckHandedBack"),
      },
      carried: account.carried || (fresh && carriedIn.has(cause._tag)),
    },
  }
}

const newEntry = (ticket: string, title: string, phase: TicketPhase): Entry => ({
  ticket,
  title,
  phase,
  since: 0,
  worker: null,
  row: null,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

/** The phases a refinement belongs to, for a PHASE_BUG about a ticket the run hasn't taken up. */
const refines: Record<Detail["_tag"], PhaseTag> = {
  Activity: "Working",
  Place: "ToMerge",
  Step: "Merging",
}

// What a change returns (a transition's null: the ticket left the machine), and the state it leaves.
type Changed<P> = readonly [Result.Result<P, InvalidTransition>, State]

const changed = <P>(result: Result.Result<P, InvalidTransition>, state: State): Changed<P> => [
  result,
  state,
]

/** The phases a ticket still running when the wind-down begins is in. */
const running: ReadonlySet<PhaseTag> = new Set([
  "Working",
  "ToMerge",
  "Merging",
  "Resolving",
  "Fixing",
])

export class Ledger extends Context.Service<
  Ledger,
  {
    /**
     * Moves `ticket` by `cause`, as the state machine says, and writes its `phase` record, then
     * `beside` (the orchestra-era records its row names), with `lines` logged in the same write.
     * `title` sets its title, as a ticket entering the run needs; a ticket leaving it (null) leaves
     * the ledger. An invalid change logs PHASE_BUG once, writes nothing, and leaves the ticket as it
     * was.
     */
    transition(
      ticket: string,
      cause: Cause,
      options?: {
        readonly title?: string
        readonly beside?: ReadonlyArray<Event>
        readonly lines?: ReadonlyArray<log.Line>
      },
    ): Effect.Effect<Result.Result<TicketPhase | null, InvalidTransition>>
    /** Changes a detail of `ticket`'s phase (its activity, place or step), not the phase. */
    refine(
      ticket: string,
      detail: Detail,
    ): Effect.Effect<Result.Result<TicketPhase, InvalidTransition>>
    /**
     * Marks `ticket`'s worker steered by you, by a message (its time noted for the idle grace) or an
     * interrupt; a ticket not in the run has no worker to steer.
     */
    steer(ticket: string, by: "message" | "interrupt"): Effect.Effect<void>
    /** Releases `ticket`'s worker: it is no longer steered. */
    release(ticket: string): Effect.Effect<void>
    /**
     * Notes that a conflict hand-back waits for `ticket`'s steered worker (§ 4.3), as it is kept:
     * Blocked on it, the ticket keeps its worker's number and its card until it leaves Blocked.
     */
    handBackWaits(ticket: string): Effect.Effect<void>
    /**
     * Claims `ticket`'s one resume of a session that ended unexpectedly (Gone) in this run (§ 4.8):
     * true the first time, false after.
     */
    claimGoneResume(ticket: string): Effect.Effect<boolean>
    /** Whether `ticket`'s one resume of a Gone session in this run is claimed already. */
    goneResumed(ticket: string): Effect.Effect<boolean>
    /** Adds `by` (1 by default) to one of `ticket`'s tallies; a ticket not in the run has none. */
    count(ticket: string, tally: TallyName, by?: number): Effect.Effect<void>
    /**
     * Writes the ticket_end of each ticket the run took up that is back in the queue as it ends
     * (Waiting, Queued, HeldBack): no RunEnded moves it, and its workers spent what they spent.
     */
    readonly endQueued: Effect.Effect<void>
    /** Begins the wind-down, noting the tickets running now; nothing when it has begun. */
    readonly windDown: Effect.Effect<void>
    /** Ends the wind-down: the run takes tickets again. */
    readonly windUp: Effect.Effect<void>
    readonly current: Effect.Effect<State>
    /** The state now, then each new one. */
    readonly changes: Stream.Stream<State>
  }
>()("tutti/run/Ledger") {
  static readonly layer: Layer.Layer<Ledger, never, Log | EventStream> = Layer.effect(
    Ledger,
    Effect.suspend(() => make),
  )
}

/** The ledger over the run's Log and EventStream, empty. */
export const make: Effect.Effect<Ledger["Service"], never, Log | EventStream> = Effect.gen(
  function* () {
    const logs = yield* Log
    const events = yield* EventStream
    const spending = yield* Effect.serviceOption(Spending)
    const ref = yield* SubscriptionRef.make(emptyState)
    // The tickets whose Gone session was resumed in this run.
    const goneResumed = yield* Ref.make<ReadonlySet<string>>(new Set())

    // Logs `error` about `ticket` as PHASE_BUG, unless the same line was logged before.
    const bug = (state: State, ticket: string, error: InvalidTransition) => {
      const text = log.phaseBug({
        id: ticket,
        from: error.from ?? "outside",
        to: error.to ?? "outside",
        cause: error.when,
      })
      if (state.bugs.includes(text)) return Effect.succeed(state)
      return Effect.as(logs.write(text), { ...state, bugs: [...state.bugs, text] })
    }

    const transition: Ledger["Service"]["transition"] = (ticket, cause, options = {}) =>
      SubscriptionRef.modifyEffect(ref, (state) =>
        Effect.gen(function* () {
          const entry = state.tickets.get(ticket)
          const from = entry?.phase ?? null
          const next = transitionPhase(from, cause)
          if (Result.isFailure(next)) {
            return changed(next, yield* bug(state, ticket, next.failure))
          }
          const now = yield* Clock.currentTimeMillis
          // A ticket whose part in the run ends gets its ticket_end, and what it spent on the
          // records that end it.
          const ends =
            entry !== undefined &&
            next.success !== null &&
            next.success._tag !== entry.phase._tag &&
            endsPart.has(next.success._tag)
          const beside =
            ends && entry !== undefined && next.success !== null
              ? ending(
                  accounted(entry, next.success, cause, now),
                  next.success,
                  now,
                  Option.isSome(spending) ? yield* spending.value.ofTicket(ticket) : nothingSpent,
                  options.beside ?? [],
                )
              : (options.beside ?? [])
          const records = Effect.forEach(
            [phaseRecord(ticket, from, next.success, cause), ...beside],
            (event) => events.emit(event),
            { discard: true },
          )
          yield* options.lines === undefined ? records : logs.writeWith(options.lines, records)
          if (next.success === null) {
            const tickets = new Map(state.tickets)
            tickets.delete(ticket)
            return changed(next, { ...state, tickets })
          }
          const base = entry ?? newEntry(ticket, options.title ?? "", next.success)
          const titled = options.title === undefined ? base : { ...base, title: options.title }
          return changed(next, moved(state, titled, next.success, cause, now))
        }),
      )

    const refine: Ledger["Service"]["refine"] = (ticket, detail) =>
      SubscriptionRef.modifyEffect(ref, (state) =>
        Effect.gen(function* () {
          const entry = state.tickets.get(ticket)
          const next =
            entry === undefined
              ? Result.fail(
                  new InvalidTransition({
                    from: null,
                    to: refines[detail._tag],
                    when: detail._tag,
                  }),
                )
              : refinePhase(entry.phase, detail)
          if (Result.isFailure(next)) {
            return changed(next, yield* bug(state, ticket, next.failure))
          }
          const tickets = new Map(state.tickets)
          tickets.set(ticket, { ...(entry as Entry), phase: next.success })
          return changed(next, { ...state, tickets })
        }),
      )

    const count: Ledger["Service"]["count"] = (ticket, tally, by = 1) =>
      SubscriptionRef.update(ref, (state) => {
        const entry = state.tickets.get(ticket)
        if (entry === undefined) return state
        const tickets = new Map(state.tickets)
        tickets.set(ticket, {
          ...entry,
          tallies: { ...entry.tallies, [tally]: entry.tallies[tally] + by },
        })
        return { ...state, tickets }
      })

    // `ticket`'s entry changed by `change`; a ticket not in the run is left out.
    const updateEntry = (ticket: string, change: (entry: Entry, now: number) => Entry) =>
      SubscriptionRef.updateEffect(ref, (state) =>
        Effect.map(Clock.currentTimeMillis, (now) => {
          const entry = state.tickets.get(ticket)
          if (entry === undefined) return state
          const tickets = new Map(state.tickets)
          tickets.set(ticket, change(entry, now))
          return { ...state, tickets }
        }),
      )

    const steer: Ledger["Service"]["steer"] = (ticket, by) =>
      updateEntry(ticket, (entry, now) => ({
        ...entry,
        steered: true,
        lastMessage: by === "message" ? now : entry.lastMessage,
      }))

    const release: Ledger["Service"]["release"] = (ticket) =>
      updateEntry(ticket, (entry) => ({ ...entry, steered: false }))

    const handBackWaitsFor: Ledger["Service"]["handBackWaits"] = (ticket) =>
      SubscriptionRef.update(ref, (state) => {
        const entry = state.tickets.get(ticket)
        if (entry === undefined) return state
        const marked = { ...entry, handBack: true }
        const worker = keepsWorker(marked)
          ? (entry.worker ?? lowestFree(state.tickets))
          : entry.worker
        const tickets = new Map(state.tickets)
        tickets.set(ticket, { ...marked, worker })
        return { ...state, tickets }
      })

    const claimGoneResume: Ledger["Service"]["claimGoneResume"] = (ticket) =>
      Ref.modify(goneResumed, (resumed) =>
        resumed.has(ticket) ? [false, resumed] : [true, new Set([...resumed, ticket])],
      )

    const goneResumedOf: Ledger["Service"]["goneResumed"] = (ticket) =>
      Effect.map(Ref.get(goneResumed), (resumed) => resumed.has(ticket))

    const endQueued = SubscriptionRef.modifyEffect(ref, (state) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        for (const entry of state.tickets.values()) {
          if (!inQueue.has(entry.phase._tag) || entry.account?.took == null) continue
          const spent = Option.isSome(spending)
            ? yield* spending.value.ofTicket(entry.ticket)
            : nothingSpent
          yield* Effect.forEach(ending(entry, entry.phase, now, spent, []), events.emit, {
            discard: true,
          })
        }
        return [undefined, state] as const
      }),
    )

    const windDown = SubscriptionRef.updateEffect(ref, (state) =>
      state.windDown !== null
        ? Effect.succeed(state)
        : Effect.map(Clock.currentTimeMillis, (since) => ({
            ...state,
            windDown: {
              since,
              tickets: [...state.tickets.values()]
                .filter((entry) => running.has(entry.phase._tag))
                .map((entry) => entry.ticket),
            },
          })),
    )

    const windUp = SubscriptionRef.update(ref, (state) =>
      state.windDown === null ? state : { ...state, windDown: null },
    )

    return Ledger.of({
      transition,
      refine,
      steer,
      release,
      handBackWaits: handBackWaitsFor,
      claimGoneResume,
      goneResumed: goneResumedOf,
      count,
      endQueued,
      windDown,
      windUp,
      current: SubscriptionRef.get(ref),
      changes: SubscriptionRef.changes(ref),
    })
  },
)
