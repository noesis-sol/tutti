// The ticket state machine (§ 5.1): the phases a ticket the run takes up moves through, the causes
// that move it, and the transition table, as data. transition() is the one way to change a ticket's
// phase; refine() changes only a phase's details (the worker's activity, a place in the merge
// queue, a merge's step), never its tag. The run loop drives the machine; the ledger, RunView, the
// log, the event stream and the report read it.
import { Data, Result, Schema } from "effect"
import { type Kind, mergeSteps, phaseNames } from "./events.ts"

/** A variant with no fields. */
type Empty = Record<never, never>

/** What holds a ready ticket back, besides a free slot. */
export const holds = ["overlap", "parent", "merge", "solo"] as const
export type Hold = (typeof holds)[number]

/** A merge's steps, in order. */
export type MergeStep = (typeof mergeSteps)[number]

/**
 * What a Working ticket's row shows: `▶ working`, the worker's activity (`▶ editing`, …), `■ allow?`
 * for a permission request, `■ answer?` for a question it asked, `◷ limit` for a usage limit.
 */
export const activities = [
  "working",
  "editing",
  "reading",
  "testing",
  "subagent",
  "starting",
  "retrying",
  "allow",
  "answer",
  "limit",
] as const
export type Activity = (typeof activities)[number]

/** How a Done ticket finished: merged with its commit, or closed with no change of its own. */
export type Outcome = Data.TaggedEnum<{
  Merged: { readonly commit: string }
  NoChange: Empty
}>

export const Outcome = Data.taggedEnum<Outcome>()

/** A ticket's phase in the run (§ 5.1). Places and attempts count from 1. */
export type TicketPhase = Data.TaggedEnum<{
  /** Ready, waiting for a free slot. */
  Queued: Empty
  /** Ready, but waiting for something other than a slot. */
  HeldBack: { readonly why: Hold }
  /** Picked up, with its worker at it. */
  Working: { readonly activity: Activity }
  /** Its work verified, waiting for its turn in the merge queue; place 1 is next. */
  ToMerge: { readonly place: number }
  /** Its merge under way. */
  Merging: { readonly step: MergeStep }
  /** Its rebase stopped on conflicts, which were handed back to its worker. */
  Resolving: { readonly attempt: number }
  /** Its check failed on the rebased branch, and the failure was handed back to its worker. */
  Fixing: { readonly attempt: number; readonly afterResolution: boolean }
  /** Merged, or closed with no change of its own to merge. The only final phase. */
  Done: { readonly outcome: Outcome }
  /** Waits on a question ticket for you: the question's ID. */
  Asked: { readonly question: string }
  /** Back in the queue until `for` merges, or until the environment probe passes (`probe`). */
  Waiting: { readonly for: string }
  /** Set aside: deferred by its worker or by tutti. */
  Deferred: { readonly why: string }
  /** Left for review: `CHECKS_FAILED`, `DIRTY_WORKTREE`, `REBASE_FAILED`, `OFF_BRANCH`, … */
  Review: { readonly why: string }
  /** Its work is done, but it can't merge until you act: `MERGE_CONFLICT`, `DIRTY_TREE`, … */
  Blocked: { readonly why: string }
  /** It stopped the run (`PAUSED`, `TICKET_LIMIT`), or its worker was at it as the run ended. */
  Stopped: { readonly why: string }
}>

export const TicketPhase = Data.taggedEnum<TicketPhase>()

export type PhaseTag = TicketPhase["_tag"]

const Ordinal = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/** TicketPhase's Schema, for the event stream: the phase as a tagged object. */
export const TicketPhaseSchema = Schema.TaggedUnion({
  Queued: {},
  HeldBack: { why: Schema.Literals(holds) },
  Working: { activity: Schema.Literals(activities) },
  ToMerge: { place: Ordinal },
  Merging: { step: Schema.Literals(mergeSteps) },
  Resolving: { attempt: Ordinal },
  Fixing: { attempt: Ordinal, afterResolution: Schema.Boolean },
  Done: {
    outcome: Schema.TaggedUnion({ Merged: { commit: Schema.String }, NoChange: {} }),
  },
  Asked: { question: Schema.String },
  Waiting: { for: Schema.String },
  Deferred: { why: Schema.String },
  Review: { why: Schema.String },
  Blocked: { why: Schema.String },
  Stopped: { why: Schema.String },
})

// The Schema and the tagged union describe the same values, and the event stream's phase names
// are their tags.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const sameType: Same<typeof TicketPhaseSchema.Type, TicketPhase> = true
const sameTags: Same<(typeof phaseNames)[number], PhaseTag> = true
void sameType
void sameTags

/** What moves a ticket from one phase to another: the table's When. */
export type Cause = Data.TaggedEnum<{
  /** The ready poll found it. */
  Ready: Empty
  /** bd ready no longer lists it: closed, deferred or blocked outside the run. */
  Unready: Empty
  /** Its footprint overlaps a running ticket's, its subtickets or a blocker aren't merged, or solo. */
  Held: { readonly why: Hold }
  /** What held it back is gone. */
  Released: Empty
  /** A slot is free and it is the highest-priority ticket not held back. */
  Dispatched: Empty
  /** Its work is verified (closed, committed, clean and on its branch; or a resolution or fix). */
  Verified: { readonly place: number }
  /** Closed with nothing of its own to merge. */
  NoChange: Empty
  /** Its worker filed a question ticket that blocks it, then settled. */
  FiledQuestion: { readonly question: string }
  /** Its worker stopped with nothing done, having linked a blocker that hasn't merged. */
  WaitsForMerge: { readonly for: string }
  /** Its worker deferred it, or tutti set it aside as it started. */
  Defer: { readonly why: string }
  /** Left for review; after a resolution, blocked instead. */
  Aside: { readonly why: string }
  /** It stopped the run. */
  StopRun: { readonly why: "PAUSED" | "TICKET_LIMIT" }
  /** The run ended with the ticket in it, for `why`. */
  RunEnded: { readonly why: string }
  /** Its question was answered, and its session resumed and told so. */
  Answered: Empty
  /** Its blocker merged, or the environment probe passed. */
  Requeued: Empty
  /** An environment hold reopened it: it failed at once and did nothing. */
  Reopened: Empty
  /** Its turn to merge: every ticket ahead of it has merged or left the queue. */
  ItsTurn: Empty
  /** Rebased, set up, checked and fast-forwarded to `commit`. */
  FastForwarded: { readonly commit: string }
  /** The run ended during its rebase or check: the rebase put back, the check killed (§ 3.4). */
  MergeInterrupted: { readonly place: number }
  /** The rebase stopped on conflicts, handed back to its worker. */
  ConflictsHandedBack: { readonly attempt: number }
  /** The check failed, handed back to its worker. */
  CheckHandedBack: { readonly attempt: number }
  /** It can't merge until you act. */
  Block: { readonly why: string }
  /** Its check failed, the base has moved on since, and it is checked once more. */
  Recheck: { readonly place: number }
  /** Carried over from an earlier run with its session, which is resumed. */
  Resumed: Empty
  /** Carried over from an earlier run, still waiting on its question. */
  StillAsked: { readonly question: string }
  /** Carried over from an earlier run, closed but not merged (labelled `unmerged`). */
  Unmerged: { readonly place: number }
}>

export const Cause = Data.taggedEnum<Cause>()

export type CauseTag = Cause["_tag"]

type PhaseOf<T extends PhaseTag> = Extract<TicketPhase, { readonly _tag: T }>
type CauseOf<C extends CauseTag> = Extract<Cause, { readonly _tag: C }>

/** Where a transition starts: a phase, or null for outside the machine (entering the run). */
export type From = PhaseTag | null
type FromPhase<F extends From> = F extends PhaseTag ? PhaseOf<F> : null

/** Where a transition ends: a phase, or null for outside the machine (leaving the run). */
export type To = PhaseTag | null
type ToPhase<T extends To> = T extends PhaseTag ? PhaseOf<T> : null

/** What a transition writes beside its `phase` record: the table's Recorded as. */
export interface Recorded {
  /** The event stream's records. */
  readonly kinds: ReadonlyArray<Kind>
  /** Their detail, as `warn` with `aside`. */
  readonly detail?: string
  /** The log's line, as `RESOLVING`. */
  readonly log?: string
}

/** A row of the transition table. */
export interface Transition<
  F extends From = From,
  C extends CauseTag = CauseTag,
  T extends To = To,
> {
  readonly from: F
  readonly when: C
  readonly to: T
  readonly recorded: Recorded
  /** A condition on the phase it leaves, besides its tag. */
  only?(phase: FromPhase<F>): boolean
  next(phase: FromPhase<F>, cause: CauseOf<C>): ToPhase<T>
}

// A row, typed by its phases and cause, as a row of the table. The table finds a row by its from,
// when and only before it calls them, so they are only ever given the phase and cause they take.
const row = <const F extends From, const C extends CauseTag, const T extends To>(
  transition: Transition<F, C, T>,
): Transition => transition as unknown as Transition

const working = () => TicketPhase.Working({ activity: "starting" })
const aside = { kinds: ["warn"], detail: "aside" } as const
const blocked = { kinds: ["warn"], detail: "blocked" } as const

/**
 * The transition table: § 5.1's, row by row, with its rows for several causes split by cause, and
 * the carry-over of § 5.1's "The next run" as entries from outside. A transition it doesn't list
 * doesn't happen. A ticket waiting in the queue that bd ready no longer lists leaves the machine.
 */
export const transitions: ReadonlyArray<Transition> = [
  row({
    from: null,
    when: "Ready",
    to: "Queued",
    recorded: { kinds: ["queue"] },
    next: () => TicketPhase.Queued(),
  }),
  row({
    from: "Queued",
    when: "Held",
    to: "HeldBack",
    recorded: { kinds: ["queue"], log: "skipping …, … waits: …" },
    next: (_, { why }) => TicketPhase.HeldBack({ why }),
  }),
  row({
    from: "HeldBack",
    when: "Released",
    to: "Queued",
    recorded: { kinds: ["queue"] },
    next: () => TicketPhase.Queued(),
  }),
  row({
    from: "Queued",
    when: "Unready",
    to: null,
    recorded: { kinds: ["queue"] },
    next: () => null,
  }),
  row({
    from: "HeldBack",
    when: "Unready",
    to: null,
    recorded: { kinds: ["queue"] },
    next: () => null,
  }),
  row({
    from: "Queued",
    when: "Dispatched",
    to: "Working",
    recorded: { kinds: ["dispatch"] },
    next: working,
  }),
  row({
    from: "Working",
    when: "Verified",
    to: "ToMerge",
    recorded: { kinds: ["phase"] },
    next: (_, { place }) => TicketPhase.ToMerge({ place }),
  }),
  row({
    from: "Working",
    when: "NoChange",
    to: "Done",
    recorded: { kinds: ["closed"], detail: "no change to merge" },
    next: () => TicketPhase.Done({ outcome: Outcome.NoChange() }),
  }),
  row({
    from: "Working",
    when: "FiledQuestion",
    to: "Asked",
    recorded: { kinds: ["asked"] },
    next: (_, { question }) => TicketPhase.Asked({ question }),
  }),
  row({
    from: "Working",
    when: "WaitsForMerge",
    to: "Waiting",
    recorded: { kinds: ["waits"] },
    next: (_, cause) => TicketPhase.Waiting({ for: cause.for }),
  }),
  row({
    from: "Working",
    when: "Defer",
    to: "Deferred",
    recorded: { kinds: ["deferred"] },
    next: (_, { why }) => TicketPhase.Deferred({ why }),
  }),
  row({
    from: "Working",
    when: "Aside",
    to: "Review",
    recorded: aside,
    next: (_, { why }) => TicketPhase.Review({ why }),
  }),
  row({
    from: "Working",
    when: "StopRun",
    to: "Stopped",
    recorded: { kinds: ["hold", "stop"] },
    next: (_, { why }) => TicketPhase.Stopped({ why }),
  }),
  row({
    from: "Working",
    when: "RunEnded",
    to: "Stopped",
    recorded: { kinds: ["suspended"] },
    next: (_, { why }) => TicketPhase.Stopped({ why }),
  }),
  row({
    from: "Asked",
    when: "Answered",
    to: "Working",
    recorded: { kinds: ["answered", "resumed"] },
    next: working,
  }),
  row({
    from: "Waiting",
    when: "Requeued",
    to: "Queued",
    recorded: { kinds: ["queue"] },
    next: () => TicketPhase.Queued(),
  }),
  row({
    from: "Deferred",
    when: "Reopened",
    to: "Waiting",
    recorded: { kinds: ["reopened"] },
    next: () => TicketPhase.Waiting({ for: "probe" }),
  }),
  row({
    from: "ToMerge",
    when: "ItsTurn",
    to: "Merging",
    recorded: { kinds: ["phase"] },
    next: () => TicketPhase.Merging({ step: "rebase" }),
  }),
  row({
    from: "ToMerge",
    when: "RunEnded",
    to: "Stopped",
    recorded: { kinds: ["suspended"] },
    next: (_, { why }) => TicketPhase.Stopped({ why }),
  }),
  row({
    from: "Merging",
    when: "FastForwarded",
    to: "Done",
    recorded: { kinds: ["closed"] },
    next: (_, { commit }) => TicketPhase.Done({ outcome: Outcome.Merged({ commit }) }),
  }),
  // § 3.4: a quit during the rebase or the check, before the fast-forward, leaves the ticket
  // waiting to merge, and the run's end then stops it as one in the queue.
  row({
    from: "Merging",
    when: "MergeInterrupted",
    to: "ToMerge",
    recorded: { kinds: ["phase"] },
    next: (_, { place }) => TicketPhase.ToMerge({ place }),
  }),
  row({
    from: "Merging",
    when: "ConflictsHandedBack",
    to: "Resolving",
    recorded: { kinds: [], log: "RESOLVING" },
    next: (_, { attempt }) => TicketPhase.Resolving({ attempt }),
  }),
  row({
    from: "Merging",
    when: "CheckHandedBack",
    to: "Fixing",
    recorded: { kinds: [], log: "FIXING" },
    next: (_, { attempt }) => TicketPhase.Fixing({ attempt, afterResolution: false }),
  }),
  row({
    from: "Merging",
    when: "Aside",
    to: "Review",
    recorded: aside,
    next: (_, { why }) => TicketPhase.Review({ why }),
  }),
  row({
    from: "Merging",
    when: "Block",
    to: "Blocked",
    recorded: { kinds: ["warn", "hold"], detail: "blocked" },
    next: (_, { why }) => TicketPhase.Blocked({ why }),
  }),
  row({
    from: "Resolving",
    when: "Verified",
    to: "ToMerge",
    recorded: { kinds: ["phase"] },
    next: (_, { place }) => TicketPhase.ToMerge({ place }),
  }),
  row({
    from: "Resolving",
    when: "CheckHandedBack",
    to: "Fixing",
    recorded: { kinds: [], log: "FIXING" },
    next: (_, { attempt }) => TicketPhase.Fixing({ attempt, afterResolution: true }),
  }),
  row({
    from: "Resolving",
    when: "Block",
    to: "Blocked",
    recorded: blocked,
    next: (_, { why }) => TicketPhase.Blocked({ why }),
  }),
  row({
    from: "Fixing",
    when: "Verified",
    to: "ToMerge",
    recorded: { kinds: ["phase"] },
    next: (_, { place }) => TicketPhase.ToMerge({ place }),
  }),
  row({
    from: "Fixing",
    when: "CheckHandedBack",
    to: "Fixing",
    recorded: { kinds: [], log: "FIXING" },
    next: ({ afterResolution }, { attempt }) => TicketPhase.Fixing({ attempt, afterResolution }),
  }),
  row({
    from: "Fixing",
    when: "Aside",
    to: "Review",
    recorded: aside,
    only: ({ afterResolution }) => !afterResolution,
    next: (_, { why }) => TicketPhase.Review({ why }),
  }),
  row({
    from: "Fixing",
    when: "Aside",
    to: "Blocked",
    recorded: blocked,
    only: ({ afterResolution }) => afterResolution,
    next: (_, { why }) => TicketPhase.Blocked({ why }),
  }),
  row({
    from: "Resolving",
    when: "RunEnded",
    to: "Stopped",
    recorded: { kinds: ["suspended"] },
    next: (_, { why }) => TicketPhase.Stopped({ why }),
  }),
  row({
    from: "Fixing",
    when: "RunEnded",
    to: "Stopped",
    recorded: { kinds: ["suspended"] },
    next: (_, { why }) => TicketPhase.Stopped({ why }),
  }),
  row({
    from: "Review",
    when: "Recheck",
    to: "ToMerge",
    recorded: { kinds: [], log: "RECHECK" },
    only: ({ why }) => why === "CHECKS_FAILED",
    next: (_, { place }) => TicketPhase.ToMerge({ place }),
  }),
  row({
    from: null,
    when: "Resumed",
    to: "Working",
    recorded: { kinds: ["resumed"] },
    next: working,
  }),
  row({
    from: null,
    when: "StillAsked",
    to: "Asked",
    recorded: { kinds: [] },
    next: (_, { question }) => TicketPhase.Asked({ question }),
  }),
  row({
    from: null,
    when: "Unmerged",
    to: "ToMerge",
    recorded: { kinds: [] },
    next: (_, { place }) => TicketPhase.ToMerge({ place }),
  }),
]

/**
 * A phase change the table doesn't list: a bug. The run logs it once as `PHASE_BUG`, and the
 * ticket keeps its phase. `to` is the phase the cause leads to elsewhere in the table (null:
 * outside the machine).
 */
export class InvalidTransition extends Schema.TaggedError<InvalidTransition>()(
  "InvalidTransition",
  {
    from: Schema.NullOr(Schema.Literals(phaseNames)),
    to: Schema.NullOr(Schema.Literals(phaseNames)),
    when: Schema.String,
  },
) {
  override get message(): string {
    return `${this.from ?? "outside"} → ${this.to ?? "outside"} (${this.when})`
  }

  /** The log's line for it: `PHASE_BUG: <id> <from> → <to> (<cause>)`. */
  phaseBug(ticket: string): string {
    return `PHASE_BUG: ${ticket} ${this.message}`
  }
}

// Every cause has a row, so each leads somewhere: the first row's phase for it, or outside.
const leadsTo = (cause: CauseTag): To => {
  const found = transitions.find((transition) => transition.when === cause)
  return found === undefined ? "Queued" : found.to
}

/** The table's row that `cause` takes from `phase` (null: outside the machine), if any. */
export const rowFor = (phase: TicketPhase | null, cause: Cause): Transition | undefined =>
  transitions.find(
    (transition) =>
      transition.from === (phase?._tag ?? null) &&
      transition.when === cause._tag &&
      (transition.only?.(phase) ?? true),
  )

/**
 * The phase `cause` moves a ticket in `phase` to, or InvalidTransition when the table doesn't
 * list it. `phase` null is a ticket entering the run; a result of null, one leaving it.
 */
export const transition = (
  phase: TicketPhase | null,
  cause: Cause,
): Result.Result<TicketPhase | null, InvalidTransition> => {
  const found = rowFor(phase, cause)
  if (found === undefined) {
    return Result.fail(
      new InvalidTransition({
        from: phase?._tag ?? null,
        to: leadsTo(cause._tag),
        when: cause._tag,
      }),
    )
  }
  return Result.succeed(found.next(phase, cause))
}

/** A change of a phase's details that leaves its tag as it is. */
export type Detail = Data.TaggedEnum<{
  /** A Working ticket's worker is doing something else. */
  Activity: { readonly activity: Activity }
  /** A ToMerge ticket moved up the merge queue. */
  Place: { readonly place: number }
  /** A Merging ticket's merge went on to its next step. */
  Step: { readonly step: MergeStep }
}>

export const Detail = Data.taggedEnum<Detail>()

/** `phase` with `detail` changed: InvalidTransition when it isn't a detail of that phase. */
export const refine = (
  phase: TicketPhase,
  detail: Detail,
): Result.Result<TicketPhase, InvalidTransition> => {
  if (phase._tag === "Working" && detail._tag === "Activity") {
    return Result.succeed(TicketPhase.Working({ activity: detail.activity }))
  }
  if (phase._tag === "ToMerge" && detail._tag === "Place") {
    return Result.succeed(TicketPhase.ToMerge({ place: detail.place }))
  }
  if (phase._tag === "Merging" && detail._tag === "Step") {
    return Result.succeed(TicketPhase.Merging({ step: detail.step }))
  }
  return Result.fail(new InvalidTransition({ from: phase._tag, to: phase._tag, when: detail._tag }))
}

/** The phases with work under way, which have a card. */
export const hasCard = (phase: TicketPhase): boolean =>
  phase._tag === "Working" ||
  phase._tag === "Resolving" ||
  phase._tag === "Fixing" ||
  phase._tag === "ToMerge" ||
  phase._tag === "Merging"

/** The dashboard's totals (§ 7.2); `heldBack` is In queue's `held back`. */
export type Total = "completed" | "setAside" | "needsYou" | "workers" | "inQueue" | "heldBack"

/**
 * The totals a ticket in `phase` counts under: none, one, or for a Working ticket whose worker
 * waits on you, both Workers and Needs you.
 */
export const countsUnder = (phase: TicketPhase): ReadonlyArray<Total> => {
  switch (phase._tag) {
    case "Queued":
      return ["inQueue"]
    case "HeldBack":
      return ["heldBack"]
    case "Working":
      return phase.activity === "allow" || phase.activity === "answer"
        ? ["workers", "needsYou"]
        : ["workers"]
    case "Resolving":
    case "Fixing":
      return ["workers"]
    case "Done":
      return ["completed"]
    case "Asked":
    case "Blocked":
      return ["needsYou"]
    case "Deferred":
    case "Review":
      return ["setAside"]
  }
  // ToMerge and Merging until they reach Done; Waiting and Stopped nowhere.
  return []
}

/** Whether `phase` is final: only Done is. */
export const isFinal = (phase: TicketPhase): boolean => phase._tag === "Done"

/**
 * Whether a ticket in `phase` becomes Stopped as the run ends: Working, ToMerge, Resolving and
 * Fixing. A merge under way finishes its step first, and the other phases leave the run as they are.
 */
export const stopsAtEnd = (phase: TicketPhase): boolean =>
  transitions.some((transition) => transition.when === "RunEnded" && transition.from === phase._tag)
