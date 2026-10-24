// The ticket state machine (§ 5.1): the phases a ticket the run takes up moves through, the moves
// that take it from one to the next, and the transition table, as data. transition() is the one way
// to change a ticket's phase; refine() changes only a phase's details (a place in the merge queue,
// a merge's step), never its tag. What a Working ticket's worker is doing is RunView's, read from
// the worker, not a detail of the phase. The run loop drives the machine; the
// ledger, RunView, the log, the event stream and the report read it.
import { Data, Result, Schema } from "effect"
import type { Mark, Shown, Tone } from "../ui/marks.ts"
import {
  type endingPhases,
  type Kind,
  type mergeSteps,
  phaseNames,
  type phaseSeconds,
  type queuePhases,
  type ticketOutcomes,
} from "./events.ts"

/** A variant with no fields. */
type Empty = Record<never, never>

/** What holds a ready ticket back, besides a free slot. */
export const holdBacks = ["overlap", "parent", "merge", "solo"] as const
export type HoldBack = (typeof holdBacks)[number]

/** A merge's steps, in order. */
export type MergeStep = (typeof mergeSteps)[number]

/** What a Waiting ticket waits for. */
export type WaitFor = Data.TaggedEnum<{
  /** Its blockers to merge: their IDs. Its worker stopped with nothing done, having linked them. */
  Blockers: { readonly ids: ReadonlyArray<string> }
  /** A ticket to merge, or the probe to pass: its worktree's setup failed before its worker started. */
  Setup: Empty
  /** The environment probe to pass: an environment hold reopened it. */
  Probe: Empty
  /** The next run, the setup fixed: a setup problem stopped its worker (SETUP_PROBLEM). */
  SetupProblem: Empty
}>

export const WaitFor = Data.taggedEnum<WaitFor>()

/**
 * What a Waiting ticket waits for, as the event stream's `why` gives it: its blockers' IDs, joined
 * with `, `, or `setup`, `probe` or `setup problem`.
 */
export const waitShown = (wait: WaitFor): string =>
  WaitFor.$match(wait, {
    Blockers: ({ ids }) => ids.join(", "),
    Setup: () => "setup",
    Probe: () => "probe",
    SetupProblem: () => "setup problem",
  })

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
export type Finished = Data.TaggedEnum<{
  Merged: { readonly commit: string }
  NoChange: Empty
}>

export const Finished = Data.taggedEnum<Finished>()

/** A ticket's phase in the run (§ 5.1). Places and attempts count from 1. */
export type TicketPhase = Data.TaggedEnum<{
  /** Ready, waiting for a free slot. */
  Queued: Empty
  /** Ready, but waiting for something other than a slot. */
  HeldBack: { readonly why: HoldBack }
  /** Picked up, with its worker at it; what the worker is doing is RunView's (activityOf). */
  Working: Empty
  /** Its work verified, waiting for its turn in the merge queue; place 1 is next. */
  ToMerge: { readonly place: number }
  /** Its merge under way. */
  Merging: { readonly step: MergeStep }
  /** Its rebase stopped on conflicts, which were handed back to its worker. */
  Resolving: { readonly attempt: number }
  /** Its check failed on its branch before it merged, and the failure was handed back. */
  Fixing: { readonly attempt: number; readonly afterResolution: boolean }
  /** Merged, or closed with no change of its own to merge. The only final phase. */
  Done: { readonly outcome: Finished }
  /** Waits on a question ticket for you: the question's ID. */
  Asked: { readonly question: string }
  /** Back in the queue until what it waits for comes: its blockers' merge, a probe, the next run. */
  Waiting: { readonly for: WaitFor }
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

// The event stream's phase names are the phases' tags.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const sameTags: Same<(typeof phaseNames)[number], PhaseTag> = true
void sameTags

/** What moves a ticket from one phase to another: the table's When. */
export type Move = Data.TaggedEnum<{
  /** The ready poll found it. */
  Ready: Empty
  /** bd ready no longer lists it: closed, deferred or blocked outside the run. */
  Unready: Empty
  /** Its footprint overlaps a running ticket's, its subtickets or a blocker aren't merged, or solo. */
  Held: { readonly why: HoldBack }
  /** What held it back is gone. */
  Released: Empty
  /** A slot is free and it is the highest-priority ticket not held back. */
  Dispatched: Empty
  /** Its work is verified (closed, committed, clean and on its branch; or a resolution or fix). */
  Verified: { readonly place: number }
  /** Closed with nothing of its own to merge, or left with nothing once rebased onto the base. */
  NoChange: Empty
  /** Its worker filed a question ticket that blocks it, then settled. */
  FiledQuestion: { readonly question: string }
  /** Its worker stopped with nothing done, having linked a blocker that hasn't merged. */
  WaitsForMerge: { readonly blockers: ReadonlyArray<string> }
  /** The setup failed in its worktree before its worker could start (SETUP_FAILED). */
  SetupFailed: Empty
  /** Its worker's first system/init showed a setup problem, which stopped the run (SETUP_PROBLEM). */
  SetupProblem: Empty
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
  /** Set aside, it left bd ready and is back in it: undeferred outside the run. */
  Undeferred: Empty
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
  /** You handed its steered worker the conflict that waited for it: rebased again, handed back. */
  HandedOver: { readonly place: number }
  /** Set aside or blocked, its branch was merged into the base by hand: `commit` there names it. */
  MergedByHand: { readonly commit: string }
  /** Carried over from an earlier run with its session, which is resumed. */
  Resumed: Empty
  /** Carried over from an earlier run, still waiting on its question. */
  StillAsked: { readonly question: string }
  /** Carried over from an earlier run, closed but not merged (labelled `unmerged`). */
  Unmerged: { readonly place: number }
}>

export const Move = Data.taggedEnum<Move>()

export type MoveTag = Move["_tag"]

type PhaseOf<T extends PhaseTag> = Extract<TicketPhase, { readonly _tag: T }>
type MoveOf<C extends MoveTag> = Extract<Move, { readonly _tag: C }>

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
export interface Transition<F extends From = From, C extends MoveTag = MoveTag, T extends To = To> {
  readonly from: F
  readonly when: C
  readonly to: T
  readonly recorded: Recorded
  /** A condition on the phase it leaves, besides its tag. */
  only?(phase: FromPhase<F>): boolean
  next(phase: FromPhase<F>, move: MoveOf<C>): ToPhase<T>
}

// A row, typed by its phases and move, as a row of the table. The table finds a row by its from,
// when and only before it calls them, so they are only ever given the phase and move they take.
const row = <const F extends From, const C extends MoveTag, const T extends To>(
  transition: Transition<F, C, T>,
): Transition => transition as unknown as Transition

const working = () => TicketPhase.Working()

const aside = { kinds: ["warn"], detail: "aside" } as const
const blocked = { kinds: ["warn"], detail: "blocked" } as const

/**
 * The transition table: § 5.1's, row by row, with its rows for several moves split by move, and
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
    next: () => TicketPhase.Done({ outcome: Finished.NoChange() }),
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
    next: (_, { blockers }) => TicketPhase.Waiting({ for: WaitFor.Blockers({ ids: blockers }) }),
  }),
  row({
    from: "Working",
    when: "SetupFailed",
    to: "Waiting",
    recorded: { kinds: ["warn"], log: "SETUP_FAILED" },
    next: () => TicketPhase.Waiting({ for: WaitFor.Setup() }),
  }),
  row({
    from: "Working",
    when: "SetupProblem",
    to: "Waiting",
    recorded: { kinds: ["stop"], log: "SETUP_PROBLEM" },
    next: () => TicketPhase.Waiting({ for: WaitFor.SetupProblem() }),
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
    next: () => TicketPhase.Waiting({ for: WaitFor.Probe() }),
  }),
  row({
    from: "Deferred",
    when: "Undeferred",
    to: "Queued",
    recorded: { kinds: ["queue"] },
    next: () => TicketPhase.Queued(),
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
    next: (_, { commit }) => TicketPhase.Done({ outcome: Finished.Merged({ commit }) }),
  }),
  row({
    from: "Merging",
    when: "NoChange",
    to: "Done",
    recorded: { kinds: ["closed"], detail: "no change to merge" },
    next: () => TicketPhase.Done({ outcome: Finished.NoChange() }),
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
    when: "NoChange",
    to: "Done",
    recorded: { kinds: ["closed"], detail: "no change to merge" },
    next: () => TicketPhase.Done({ outcome: Finished.NoChange() }),
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
  // § 4.3: a conflict that waited for its steered worker, handed over by you. Back in the merge
  // queue, it is rebased again, and the conflict is handed back with the steered check waived once.
  row({
    from: "Blocked",
    when: "HandedOver",
    to: "ToMerge",
    recorded: { kinds: ["phase"] },
    only: ({ why }) => why === "MERGE_CONFLICT",
    next: (_, { place }) => TicketPhase.ToMerge({ place }),
  }),
  // A ticket set aside or blocked whose branch was merged by hand while the run went on, found as
  // the base moves on (handMerged.ts).
  row({
    from: "Review",
    when: "MergedByHand",
    to: "Done",
    recorded: { kinds: ["closed"], detail: "merged by hand" },
    next: (_, { commit }) => TicketPhase.Done({ outcome: Finished.Merged({ commit }) }),
  }),
  row({
    from: "Blocked",
    when: "MergedByHand",
    to: "Done",
    recorded: { kinds: ["closed"], detail: "merged by hand" },
    next: (_, { commit }) => TicketPhase.Done({ outcome: Finished.Merged({ commit }) }),
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
 * ticket keeps its phase. `to` is the phase the move leads to elsewhere in the table (null:
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

  /** The log's line for it: `PHASE_BUG: <id> <from> → <to> (<move>)`. */
  phaseBug(ticket: string): string {
    return `PHASE_BUG: ${ticket} ${this.message}`
  }
}

// Every move has a row, so each leads somewhere: the first row's phase for it, or outside.
const leadsTo = (move: MoveTag): To => {
  const found = transitions.find((transition) => transition.when === move)
  return found === undefined ? "Queued" : found.to
}

/** The table's row that `move` takes from `phase` (null: outside the machine), if any. */
export const rowFor = (phase: TicketPhase | null, move: Move): Transition | undefined =>
  transitions.find(
    (transition) =>
      transition.from === (phase?._tag ?? null) &&
      transition.when === move._tag &&
      (transition.only?.(phase) ?? true),
  )

/**
 * The phase `move` moves a ticket in `phase` to, or InvalidTransition when the table doesn't
 * list it. `phase` null is a ticket entering the run; a result of null, one leaving it.
 */
export const transition = (
  phase: TicketPhase | null,
  move: Move,
): Result.Result<TicketPhase | null, InvalidTransition> => {
  const found = rowFor(phase, move)
  if (found === undefined) {
    return Result.fail(
      new InvalidTransition({
        from: phase?._tag ?? null,
        to: leadsTo(move._tag),
        when: move._tag,
      }),
    )
  }
  return Result.succeed(found.next(phase, move))
}

/** A change of a phase's details that leaves its tag as it is. */
export type Detail = Data.TaggedEnum<{
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
  if (phase._tag === "ToMerge" && detail._tag === "Place") {
    return Result.succeed(TicketPhase.ToMerge({ place: detail.place }))
  }
  if (phase._tag === "Merging" && detail._tag === "Step") {
    return Result.succeed(TicketPhase.Merging({ step: detail.step }))
  }
  return Result.fail(new InvalidTransition({ from: phase._tag, to: phase._tag, when: detail._tag }))
}

/** The dashboard's totals (§ 7.2); `heldBack` is In queue's `held back`. */
export type Total =
  | "completed"
  | "setAside"
  | "needsYou"
  | "workers"
  | "inQueue"
  | "heldBack"
  | "setupFailed"

/** What the notice of a run that finished by itself counts a ticket as (§ 7.9). */
export type EndNotice = "closed" | "setAside" | "needsYou"

/** The reviewer's sections of tickets (§ 6.2): closed, set aside, in progress as the run stopped. */
export type ReportSection = "closed" | "setAside" | "inProgress"

/** A ticket's `■` on the wind-down line (§ 5.1). */
export type WindDownMark = "windingDown" | "done" | "needsYou" | "faint"

/** One of orchestra's phases that a ticket's time counts in (§ 10). */
export type PhaseSeconds = (typeof phaseSeconds)[number]

/** How a ticket's part in the run ended, as its `ticket_end` says. */
export type TicketOutcome = (typeof ticketOutcomes)[number]

/** The phases that end a ticket's part in the run, for now or for good. */
export type EndingPhase = (typeof endingPhases)[number]

/** The phases in the queue, that a ticket the run took up may be left in as the run ends. */
export type QueuePhase = (typeof queuePhases)[number]

/**
 * What a ticket's session is in a phase (§ 4.8): open; closed, keeping its ID; open until the run
 * ends; or suspended as the run ends.
 */
export type Lifetime = "open" | "closed" | "untilRunEnds" | "suspended"

/** What a session's lifetime turns on besides its ticket's phase (§ 4.8). */
export interface SessionKeeps {
  /** A ticket set aside after a failed check may be checked again. */
  readonly recheck: boolean
  /** A ticket blocked on its conflict has its hand-back waiting for its steered worker (§ 4.3). */
  readonly handBackWaits: boolean
}

/**
 * What is so of a ticket in a phase, wherever the run asks: what it counts as, where it is in the
 * run, its session, its row. A phase without an entry, or an entry without a fact, doesn't compile.
 */
export interface Facts<T extends PhaseTag> {
  /**
   * The dashboard's totals it counts under (§ 5.1's Counts under): none, one, or for a Working
   * ticket whose worker waits on you (its `activity`), both Workers and Needs you. The same array
   * each call.
   */
  totals(phase: PhaseOf<T>, activity: Activity): ReadonlyArray<Total>
  /** What the run's end notice counts it as, as the dashboard does, or nothing. */
  readonly notice: EndNotice | null
  /** The reviewer's section it is in, or none. */
  readonly report: ReportSection | null
  /** Its mark on the wind-down line. */
  readonly windDown: WindDownMark
  /** The run is still at it: the HOLD line counts it running, and the wind-down notes it. */
  readonly running: boolean
  /** Its work is under way, which has a card. */
  readonly card: boolean
  /** Its worker is at work, which the worker's state refines: Working, Resolving, Fixing. */
  readonly atWork: boolean
  /** Its worker runs or waits on a question: it hasn't merged, closed or not. */
  readonly busy: boolean
  /** Past its work and not merged yet: it waits to merge, merges, or is handed back. */
  readonly pastWork: boolean
  /** It may be closed and not merged: it holds back its parent and the tickets waiting on it. */
  readonly unsettled: boolean
  /**
   * Ready, waiting for a slot: the run may take it from bd ready again, and it shows no row unless
   * it had one before (§ 5.1).
   */
  readonly ready: boolean
  /** In the queue: a ticket the run took up and left in it gets its `ticket_end` at the end. */
  readonly inQueue: T extends QueuePhase ? true : false
  /** How its part in the run ended, for the phases it may end in, as its `ticket_end` says. */
  ends(phase: PhaseOf<T>): T extends EndingPhase | QueuePhase ? TicketOutcome : null
  /** Its part in the run is over for good: its worker is ended as its session closes (§ 4.8). */
  readonly over: boolean
  /** The phase of orchestra's its time counts in (§ 10), or none. */
  readonly orchestra: PhaseSeconds | null
  /** Its session's lifetime (§ 4.8). */
  session(phase: PhaseOf<T>, keeps: SessionKeeps): Lifetime
  /**
   * Its row's mark, word and tone: `▶ editing` by a Working ticket's worker's `activity`,
   * `◼ to merge`, … The same object each call.
   */
  row(phase: PhaseOf<T>, activity: Activity): Shown
}

// The facts that are the same for every phase of a tag give the same value each call: the
// dashboard reads them for every ticket on every frame.
const always =
  <A>(value: A) =>
  (): A =>
    value

const none: ReadonlyArray<Total> = []
const workers: ReadonlyArray<Total> = ["workers"]
const workersAndYou: ReadonlyArray<Total> = ["workers", "needsYou"]
const setupFailed: ReadonlyArray<Total> = ["setupFailed"]

const shows = (mark: Mark, word: string, tone: Tone, faint = false) =>
  always<Shown>({ mark, word, tone, faint })

const atWork = (word: string, tone: Tone = "picked"): Shown => ({
  mark: "working",
  word,
  tone,
  faint: false,
})

/** A Working ticket's row by its worker's activity (§ 7.11's ticket rows). */
export const activityRows: { readonly [A in Activity]: Shown } = {
  working: atWork("working"),
  editing: atWork("editing"),
  reading: atWork("reading"),
  testing: atWork("testing", "testing"),
  subagent: atWork("subagent"),
  starting: atWork("starting"),
  retrying: atWork("retrying", "deferred"),
  allow: { mark: "waitsForYou", word: "allow?", tone: "stop", faint: false },
  answer: { mark: "waitsForYou", word: "answer?", tone: "stop", faint: false },
  limit: { mark: "queued", word: "limit", tone: "deferred", faint: false },
}

/**
 * What is so of each phase: the dashboard's totals, the run's end notice, the reviewer's sections,
 * the wind-down line, the ledger, the holds, the schedule, the sessions and the tickets table all
 * read this table, so that they say the same of a ticket.
 */
export const phaseFacts: { readonly [T in PhaseTag]: Facts<T> } = {
  // Ready but not taken up: the reviewer counts these from bd ready, not in a section.
  Queued: {
    totals: always(["inQueue"]),
    notice: null,
    report: null,
    windDown: "faint",
    running: false,
    card: false,
    atWork: false,
    busy: false,
    pastWork: false,
    unsettled: false,
    ready: true,
    inQueue: true,
    ends: always("queued"),
    over: false,
    orchestra: null,
    session: always("closed"),
    row: shows("queued", "queued", "dim", true),
  },
  HeldBack: {
    totals: always(["heldBack"]),
    notice: null,
    report: null,
    windDown: "faint",
    running: false,
    card: false,
    atWork: false,
    busy: false,
    pastWork: false,
    unsettled: false,
    ready: true,
    inQueue: true,
    ends: always("queued"),
    over: false,
    orchestra: null,
    session: always("closed"),
    row: shows("queued", "held back", "dim", true),
  },
  Working: {
    totals: (_, activity) =>
      activity === "allow" || activity === "answer" ? workersAndYou : workers,
    notice: null,
    report: "inProgress",
    windDown: "windingDown",
    running: true,
    card: true,
    atWork: true,
    busy: true,
    pastWork: false,
    unsettled: true,
    ready: false,
    inQueue: false,
    ends: always(null),
    over: false,
    orchestra: "working",
    session: always("open"),
    row: (_, activity) => activityRows[activity],
  },
  // ToMerge and Merging count nowhere until they reach Done.
  ToMerge: {
    totals: always(none),
    notice: null,
    report: "inProgress",
    windDown: "windingDown",
    running: true,
    card: true,
    atWork: false,
    busy: false,
    pastWork: true,
    unsettled: true,
    ready: false,
    inQueue: false,
    ends: always(null),
    over: false,
    orchestra: "waiting",
    session: always("open"),
    row: shows("toMerge", "to merge", "toMerge"),
  },
  Merging: {
    totals: always(none),
    notice: null,
    report: "inProgress",
    windDown: "windingDown",
    running: true,
    card: true,
    atWork: false,
    busy: false,
    pastWork: true,
    unsettled: true,
    ready: false,
    inQueue: false,
    ends: always(null),
    over: false,
    orchestra: "merging",
    session: always("open"),
    row: shows("merging", "merging", "merging"),
  },
  Resolving: {
    totals: always(workers),
    notice: null,
    report: "inProgress",
    windDown: "windingDown",
    running: true,
    card: true,
    atWork: true,
    busy: true,
    pastWork: true,
    unsettled: true,
    ready: false,
    inQueue: false,
    ends: always(null),
    over: false,
    orchestra: "resolving",
    session: always("open"),
    row: shows("reworking", "resolving", "deferred"),
  },
  Fixing: {
    totals: always(workers),
    notice: null,
    report: "inProgress",
    windDown: "windingDown",
    running: true,
    card: true,
    atWork: true,
    busy: true,
    pastWork: true,
    unsettled: true,
    ready: false,
    inQueue: false,
    ends: always(null),
    over: false,
    orchestra: "fixing",
    session: always("open"),
    row: shows("reworking", "fixing", "deferred"),
  },
  Done: {
    totals: always(["completed"]),
    notice: "closed",
    report: "closed",
    windDown: "done",
    running: false,
    card: false,
    atWork: false,
    busy: false,
    pastWork: false,
    unsettled: false,
    ready: false,
    inQueue: false,
    ends: (phase) => (phase.outcome._tag === "Merged" ? "merged" : "no_change"),
    over: true,
    orchestra: null,
    session: always("closed"),
    row: shows("done", "done", "closed", true),
  },
  // Its worker settled before it filed the question: its session is closed until the answer.
  Asked: {
    totals: always(["needsYou"]),
    notice: "needsYou",
    report: "setAside",
    windDown: "needsYou",
    running: false,
    card: false,
    atWork: false,
    busy: true,
    pastWork: false,
    unsettled: true,
    ready: false,
    inQueue: false,
    ends: always("needs_you"),
    over: false,
    orchestra: null,
    session: always("closed"),
    row: shows("asked", "for you", "stop"),
  },
  Waiting: {
    // Only one whose setup failed counts, apart in In queue, as it waits for a merge or a probe.
    totals: (phase) => (phase.for._tag === "Setup" ? setupFailed : none),
    notice: null,
    report: "setAside",
    windDown: "faint",
    running: false,
    card: false,
    atWork: false,
    busy: false,
    pastWork: false,
    unsettled: false,
    ready: false,
    inQueue: true,
    ends: always("queued"),
    over: false,
    orchestra: null,
    session: always("closed"),
    row: shows("queued", "waiting", "dim", true),
  },
  Deferred: {
    totals: always(["setAside"]),
    notice: "setAside",
    report: "setAside",
    windDown: "needsYou",
    running: false,
    card: false,
    atWork: false,
    busy: false,
    pastWork: false,
    unsettled: false,
    ready: false,
    inQueue: false,
    ends: always("set_aside"),
    over: true,
    orchestra: null,
    session: always("closed"),
    row: shows("setAside", "deferred", "deferred", true),
  },
  Review: {
    totals: always(["setAside"]),
    notice: "setAside",
    report: "setAside",
    windDown: "needsYou",
    running: false,
    card: false,
    atWork: false,
    busy: false,
    pastWork: false,
    unsettled: true,
    ready: false,
    inQueue: false,
    ends: always("set_aside"),
    over: true,
    orchestra: null,
    // A recheck may hand it a conflict.
    session: (phase, { recheck }) =>
      phase.why === "CHECKS_FAILED" && recheck ? "untilRunEnds" : "closed",
    row: shows("review", "review", "deferred", true),
  },
  Blocked: {
    totals: always(["needsYou"]),
    notice: "needsYou",
    report: "setAside",
    windDown: "needsYou",
    running: false,
    card: false,
    atWork: false,
    busy: false,
    pastWork: false,
    unsettled: true,
    ready: false,
    inQueue: false,
    ends: always("needs_you"),
    over: false,
    orchestra: null,
    // You may message, interrupt or release its steered worker while its hand-back waits (§ 4.3).
    session: (phase, { handBackWaits }) =>
      phase.why === "MERGE_CONFLICT" && handBackWaits ? "open" : "closed",
    row: shows("waitsForYou", "blocked", "stop"),
  },
  // The run's end suspends its session.
  Stopped: {
    totals: always(none),
    notice: null,
    report: "inProgress",
    windDown: "needsYou",
    running: false,
    card: false,
    atWork: false,
    busy: false,
    pastWork: false,
    unsettled: true,
    ready: false,
    inQueue: false,
    ends: always("stopped"),
    over: false,
    orchestra: null,
    session: always("suspended"),
    row: shows("stopped", "stopped", "stop"),
  },
}

/** The facts of `phase`'s tag, for those that turn on its details. */
export const factsOf = (phase: TicketPhase): Facts<PhaseTag> =>
  phaseFacts[phase._tag] as Facts<PhaseTag>

/**
 * The totals a ticket in `phase` counts under, from the table; `activity` is a Working ticket's
 * worker's, `starting` while nothing says.
 */
export const countsUnder = (
  phase: TicketPhase,
  activity: Activity = "starting",
): ReadonlyArray<Total> => factsOf(phase).totals(phase, activity)

/** The phases with work under way, which have a card. */
export const hasCard = (phase: TicketPhase): boolean => phaseFacts[phase._tag].card

/** Whether `phase` is final: only Done is. */
export const isFinal = (phase: TicketPhase): boolean => phase._tag === "Done"

// The phases the table moves to Stopped as the run ends.
const stopping: ReadonlySet<From> = new Set(
  transitions.filter((transition) => transition.when === "RunEnded").map(({ from }) => from),
)

/**
 * Whether a ticket in `phase` becomes Stopped as the run ends: Working, ToMerge, Resolving and
 * Fixing. A merge under way finishes its step first, and the other phases leave the run as they are.
 */
export const stopsAtEnd = (phase: TicketPhase): boolean => stopping.has(phase._tag)
