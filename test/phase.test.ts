import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import fc from "fast-check"
import { phaseNames } from "../src/run/events.ts"
import {
  countsUnder,
  Detail,
  Finished,
  hasCard,
  holdBacks,
  InvalidTransition,
  isFinal,
  Move,
  type MoveTag,
  type PhaseTag,
  refine,
  stopsAtEnd,
  TicketPhase,
  transition,
  transitions,
  WaitFor,
} from "../src/run/phase.ts"
import type { TicketId } from "../src/services/Beads.ts"

const {
  Queued,
  HeldBack,
  Working,
  ToMerge,
  Merging,
  Resolving,
  Fixing,
  Done,
  Asked,
  Waiting,
  Deferred,
  Review,
  Blocked,
  Stopped,
} = TicketPhase

const ok = (result: Result.Result<TicketPhase | null, InvalidTransition>): TicketPhase | null => {
  if (Result.isFailure(result)) {
    throw new Error(`expected a phase, got ${result.failure.message}`)
  }
  return result.success
}

const rejected = (
  result: Result.Result<TicketPhase | null, InvalidTransition>,
): InvalidTransition => {
  if (Result.isSuccess(result)) {
    throw new Error(`expected InvalidTransition, got ${result.success?._tag ?? "outside"}`)
  }
  return result.failure
}

// § 5.1's transition table, row by row, written out here rather than read from the code: the
// phase a ticket leaves (null: outside the machine), the move, and the phase it reaches (null:
// outside, leaving the run). The carry-over entries of "The next run" follow it.
const table: ReadonlyArray<readonly [string, TicketPhase | null, Move, TicketPhase | null]> = [
  ["ready in bd ready → Queued", null, Move.Ready(), Queued()],
  ["Queued → HeldBack", Queued(), Move.Held({ why: "overlap" }), HeldBack({ why: "overlap" })],
  ["HeldBack → Queued", HeldBack({ why: "solo" }), Move.Released(), Queued()],
  ["Queued → gone from bd ready", Queued(), Move.Unready(), null],
  ["HeldBack → gone from bd ready", HeldBack({ why: "merge" }), Move.Unready(), null],
  ["Queued → Working", Queued(), Move.Dispatched(), Working()],
  ["Working → ToMerge", Working(), Move.Verified({ place: 2 }), ToMerge({ place: 2 })],
  ["Working → Done{noChange}", Working(), Move.NoChange(), Done({ outcome: Finished.NoChange() })],
  [
    "Working → Asked",
    Working(),
    Move.FiledQuestion({ question: "tut-q1" }),
    Asked({ question: "tut-q1" }),
  ],
  [
    "Working → Waiting",
    Working(),
    Move.WaitsForMerge({ blockers: ["tut-b1" as TicketId] }),
    Waiting({ for: WaitFor.Blockers({ ids: ["tut-b1" as TicketId] }) }),
  ],
  [
    "Working → Queued",
    Working(),
    Move.MergedSinceCut({ blockers: ["tut-b1" as TicketId] }),
    Queued(),
  ],
  ["Working → Waiting{setup}", Working(), Move.SetupFailed(), Waiting({ for: WaitFor.Setup() })],
  [
    "Working → Waiting{setup problem}",
    Working(),
    Move.SetupProblem(),
    Waiting({ for: WaitFor.SetupProblem() }),
  ],
  [
    "Working → Deferred",
    Working(),
    Move.Defer({ why: "BAD_TICKET_ID" }),
    Deferred({ why: "BAD_TICKET_ID" }),
  ],
  ["Working → Review", Working(), Move.Aside({ why: "OFF_BRANCH" }), Review({ why: "OFF_BRANCH" })],
  [
    "Working → Stopped (it stopped the run)",
    Working(),
    Move.StopRun({ why: "PAUSED" }),
    Stopped({ why: "PAUSED" }),
  ],
  [
    "Working → Stopped (the run ended)",
    Working(),
    Move.RunEnded({ why: "INTERRUPTED" }),
    Stopped({ why: "INTERRUPTED" }),
  ],
  ["Asked → Working", Asked({ question: "tut-q1" }), Move.Answered(), Working()],
  [
    "Waiting → Queued",
    Waiting({ for: WaitFor.Blockers({ ids: ["tut-b1" as TicketId] }) }),
    Move.Requeued(),
    Queued(),
  ],
  ["Waiting{setup} → Queued", Waiting({ for: WaitFor.Setup() }), Move.Requeued(), Queued()],
  [
    "Deferred → Waiting",
    Deferred({ why: "x" }),
    Move.Reopened(),
    Waiting({ for: WaitFor.Probe() }),
  ],
  ["Deferred → Queued", Deferred({ why: "x" }), Move.Undeferred(), Queued()],
  ["ToMerge → Merging", ToMerge({ place: 1 }), Move.ItsTurn(), Merging({ step: "rebase" })],
  [
    "ToMerge → Stopped",
    ToMerge({ place: 3 }),
    Move.RunEnded({ why: "INTERRUPTED" }),
    Stopped({ why: "INTERRUPTED" }),
  ],
  [
    "Merging → Done{merged}",
    Merging({ step: "fast-forward" }),
    Move.FastForwarded({ commit: "abc123" }),
    Done({ outcome: Finished.Merged({ commit: "abc123" }) }),
  ],
  [
    "Merging → Done{noChange} (nothing left to merge once rebased)",
    Merging({ step: "rebase" }),
    Move.NoChange(),
    Done({ outcome: Finished.NoChange() }),
  ],
  [
    "Merging → ToMerge (the run ended before the fast-forward, § 3.4)",
    Merging({ step: "check" }),
    Move.MergeInterrupted({ place: 1 }),
    ToMerge({ place: 1 }),
  ],
  [
    "Merging → Resolving",
    Merging({ step: "rebase" }),
    Move.ConflictsHandedBack({ attempt: 1 }),
    Resolving({ attempt: 1 }),
  ],
  [
    "Merging → Fixing",
    Merging({ step: "check" }),
    Move.CheckHandedBack({ attempt: 1 }),
    Fixing({ attempt: 1, afterResolution: false }),
  ],
  [
    "Merging → Review",
    Merging({ step: "check" }),
    Move.Aside({ why: "CHECKS_FAILED" }),
    Review({ why: "CHECKS_FAILED" }),
  ],
  [
    "Merging → Blocked",
    Merging({ step: "rebase" }),
    Move.Block({ why: "MERGE_CONFLICT" }),
    Blocked({ why: "MERGE_CONFLICT" }),
  ],
  [
    "Resolving → ToMerge",
    Resolving({ attempt: 1 }),
    Move.Verified({ place: 1 }),
    ToMerge({ place: 1 }),
  ],
  [
    "Resolving → Done{noChange}",
    Resolving({ attempt: 1 }),
    Move.NoChange(),
    Done({ outcome: Finished.NoChange() }),
  ],
  [
    "Resolving → Fixing{afterResolution}",
    Resolving({ attempt: 1 }),
    Move.CheckHandedBack({ attempt: 1 }),
    Fixing({ attempt: 1, afterResolution: true }),
  ],
  [
    "Resolving → Blocked",
    Resolving({ attempt: 2 }),
    Move.Block({ why: "MERGE_CONFLICT" }),
    Blocked({ why: "MERGE_CONFLICT" }),
  ],
  [
    "Fixing → ToMerge",
    Fixing({ attempt: 1, afterResolution: false }),
    Move.Verified({ place: 1 }),
    ToMerge({ place: 1 }),
  ],
  [
    "Fixing → Fixing",
    Fixing({ attempt: 1, afterResolution: false }),
    Move.CheckHandedBack({ attempt: 2 }),
    Fixing({ attempt: 2, afterResolution: false }),
  ],
  [
    "Fixing{afterResolution} → Fixing keeps afterResolution",
    Fixing({ attempt: 1, afterResolution: true }),
    Move.CheckHandedBack({ attempt: 2 }),
    Fixing({ attempt: 2, afterResolution: true }),
  ],
  [
    "Fixing → Review",
    Fixing({ attempt: 2, afterResolution: false }),
    Move.Aside({ why: "CHECKS_FAILED" }),
    Review({ why: "CHECKS_FAILED" }),
  ],
  [
    "Fixing{afterResolution} → Blocked",
    Fixing({ attempt: 2, afterResolution: true }),
    Move.Aside({ why: "CHECKS_FAILED" }),
    Blocked({ why: "CHECKS_FAILED" }),
  ],
  [
    "Resolving → Stopped",
    Resolving({ attempt: 1 }),
    Move.RunEnded({ why: "INTERRUPTED" }),
    Stopped({ why: "INTERRUPTED" }),
  ],
  [
    "Fixing → Stopped",
    Fixing({ attempt: 1, afterResolution: true }),
    Move.RunEnded({ why: "INTERRUPTED" }),
    Stopped({ why: "INTERRUPTED" }),
  ],
  [
    "Review{CHECKS_FAILED} → ToMerge",
    Review({ why: "CHECKS_FAILED" }),
    Move.Recheck({ place: 1 }),
    ToMerge({ place: 1 }),
  ],
  [
    "Blocked{MERGE_CONFLICT} → ToMerge",
    Blocked({ why: "MERGE_CONFLICT" }),
    Move.HandedOver({ place: 1 }),
    ToMerge({ place: 1 }),
  ],
  [
    "Review → Done, merged by hand",
    Review({ why: "CHECKS_FAILED" }),
    Move.MergedByHand({ commit: "abc" }),
    Done({ outcome: Finished.Merged({ commit: "abc" }) }),
  ],
  [
    "Blocked → Done, merged by hand",
    Blocked({ why: "MERGE_CONFLICT" }),
    Move.MergedByHand({ commit: "abc" }),
    Done({ outcome: Finished.Merged({ commit: "abc" }) }),
  ],
  ["carried over: → Working", null, Move.Resumed(), Working()],
  [
    "carried over: → Asked",
    null,
    Move.StillAsked({ question: "tut-q1" }),
    Asked({ question: "tut-q1" }),
  ],
  ["carried over: → ToMerge", null, Move.Unmerged({ place: 1 }), ToMerge({ place: 1 })],
]

// The (from, to) pairs § 5.1 lists, by tag; From and To joined as "From>To", "" for outside.
const listed = new Set(table.map(([, from, , to]) => `${from?._tag ?? ""}>${to?._tag ?? ""}`))

// A phase of every tag, with both sides of each condition the table puts on a phase's fields.
const phases: ReadonlyArray<TicketPhase | null> = [
  null,
  Queued(),
  ...holdBacks.map((why) => HeldBack({ why })),
  Working(),
  Working(),
  ToMerge({ place: 1 }),
  Merging({ step: "rebase" }),
  Merging({ step: "fast-forward" }),
  Resolving({ attempt: 1 }),
  Fixing({ attempt: 1, afterResolution: false }),
  Fixing({ attempt: 1, afterResolution: true }),
  Done({ outcome: Finished.Merged({ commit: "abc" }) }),
  Done({ outcome: Finished.NoChange() }),
  Asked({ question: "tut-q1" }),
  Waiting({ for: WaitFor.Blockers({ ids: ["tut-b1" as TicketId] }) }),
  Waiting({ for: WaitFor.Probe() }),
  Waiting({ for: WaitFor.Setup() }),
  Waiting({ for: WaitFor.SetupProblem() }),
  Deferred({ why: "x" }),
  Review({ why: "CHECKS_FAILED" }),
  Review({ why: "DIRTY_WORKTREE" }),
  Blocked({ why: "MERGE_CONFLICT" }),
  Stopped({ why: "PAUSED" }),
]

// A move of every tag: the type makes sure none is missing.
const moveOf: { readonly [C in MoveTag]: Extract<Move, { readonly _tag: C }> } = {
  Ready: Move.Ready(),
  Unready: Move.Unready(),
  Held: Move.Held({ why: "merge" }),
  Released: Move.Released(),
  Dispatched: Move.Dispatched(),
  Verified: Move.Verified({ place: 1 }),
  NoChange: Move.NoChange(),
  FiledQuestion: Move.FiledQuestion({ question: "tut-q1" }),
  WaitsForMerge: Move.WaitsForMerge({ blockers: ["tut-b1" as TicketId] }),
  MergedSinceCut: Move.MergedSinceCut({ blockers: ["tut-b1" as TicketId] }),
  SetupFailed: Move.SetupFailed(),
  SetupProblem: Move.SetupProblem(),
  Defer: Move.Defer({ why: "x" }),
  Aside: Move.Aside({ why: "CHECKS_FAILED" }),
  StopRun: Move.StopRun({ why: "TICKET_LIMIT" }),
  RunEnded: Move.RunEnded({ why: "INTERRUPTED" }),
  Answered: Move.Answered(),
  Requeued: Move.Requeued(),
  Reopened: Move.Reopened(),
  Undeferred: Move.Undeferred(),
  ItsTurn: Move.ItsTurn(),
  FastForwarded: Move.FastForwarded({ commit: "abc" }),
  MergeInterrupted: Move.MergeInterrupted({ place: 1 }),
  ConflictsHandedBack: Move.ConflictsHandedBack({ attempt: 1 }),
  CheckHandedBack: Move.CheckHandedBack({ attempt: 1 }),
  Block: Move.Block({ why: "GIT_FAILED" }),
  Recheck: Move.Recheck({ place: 1 }),
  HandedOver: Move.HandedOver({ place: 1 }),
  MergedByHand: Move.MergedByHand({ commit: "abc" }),
  Resumed: Move.Resumed(),
  StillAsked: Move.StillAsked({ question: "tut-q1" }),
  Unmerged: Move.Unmerged({ place: 1 }),
}
const moves: ReadonlyArray<Move> = Object.values(moveOf)

describe("transition", () => {
  test.each(table)("%s", (_, from, move, to) => {
    expect(ok(transition(from, move))).toEqual(to)
  })

  test("the code's table lists § 5.1's pairs and no others", () => {
    expect(new Set(transitions.map((row) => `${row.from ?? ""}>${row.to ?? ""}`))).toEqual(listed)
  })

  test("every pair the table doesn't list is rejected", () => {
    const taken = new Set<string>()
    for (const from of phases) {
      for (const move of moves) {
        const result = transition(from, move)
        if (Result.isSuccess(result)) {
          taken.add(`${from?._tag ?? ""}>${result.success?._tag ?? ""}`)
        }
      }
    }
    // Of the 15 × 15 pairs of a phase (or outside) and a phase (or outside), the listed ones and
    // no others.
    expect(taken).toEqual(listed)
  })

  test("the conditions on a phase's fields hold", () => {
    expect(
      rejected(transition(Review({ why: "DIRTY_WORKTREE" }), Move.Recheck({ place: 1 }))),
    ).toBeInstanceOf(InvalidTransition)
    expect(
      rejected(transition(Blocked({ why: "DIRTY_TREE" }), Move.HandedOver({ place: 1 }))),
    ).toBeInstanceOf(InvalidTransition)
    expect(
      ok(transition(Fixing({ attempt: 1, afterResolution: true }), Move.Aside({ why: "x" }))),
    ).toEqual(Blocked({ why: "x" }))
    expect(
      rejected(
        transition(Fixing({ attempt: 1, afterResolution: false }), Move.Block({ why: "x" })),
      ),
    ).toBeInstanceOf(InvalidTransition)
  })

  test("an invalid transition names its phases and move, and PHASE_BUG's line", () => {
    const bug = rejected(transition(Queued(), Move.FastForwarded({ commit: "abc" })))
    expect([bug.from, bug.to, bug.when]).toEqual(["Queued", "Done", "FastForwarded"])
    expect(bug.phaseBug("tut-9a1" as TicketId)).toBe(
      "PHASE_BUG: tut-9a1 Queued → Done (FastForwarded)",
    )
    expect(rejected(transition(null, Move.Dispatched())).phaseBug("tut-9a1" as TicketId)).toBe(
      "PHASE_BUG: tut-9a1 outside → Working (Dispatched)",
    )
    expect(rejected(transition(Working(), Move.Unready())).message).toBe(
      "Working → outside (Unready)",
    )
  })

  test("only a ticket waiting in the queue leaves the machine, and only as bd ready drops it", () => {
    const leaving = transitions.filter((row) => row.to === null)
    expect(leaving.map((row) => [row.from, row.when])).toEqual([
      ["Queued", "Unready"],
      ["HeldBack", "Unready"],
    ])
  })

  test("every move leads somewhere in the table", () => {
    expect(new Set<string>(transitions.map((row) => row.when))).toEqual(
      new Set(Object.keys(moveOf)),
    )
  })
})

const text = fc.string({ maxLength: 8 })
const ordinal = fc.integer({ min: 1, max: 9 })

const phaseArb: fc.Arbitrary<TicketPhase> = fc.oneof(
  fc.constant(Queued()),
  fc.constantFrom(...holdBacks).map((why) => HeldBack({ why })),
  fc.constant(Working()),
  ordinal.map((place) => ToMerge({ place })),
  fc
    .constantFrom("rebase", "setup", "check", "fast-forward" as const)
    .map((step) => Merging({ step })),
  ordinal.map((attempt) => Resolving({ attempt })),
  fc.record({ attempt: ordinal, afterResolution: fc.boolean() }).map((fields) => Fixing(fields)),
  fc.oneof(
    text.map((commit) => Done({ outcome: Finished.Merged({ commit }) })),
    fc.constant(Done({ outcome: Finished.NoChange() })),
  ),
  text.map((question) => Asked({ question })),
  fc
    .array(text.map((id) => id as TicketId))
    .map((ids) => Waiting({ for: WaitFor.Blockers({ ids }) })),
  fc
    .constantFrom(WaitFor.Setup(), WaitFor.Probe(), WaitFor.SetupProblem())
    .map((wait) => Waiting({ for: wait })),
  text.map((why) => Deferred({ why })),
  fc.oneof(fc.constant("CHECKS_FAILED"), text).map((why) => Review({ why })),
  text.map((why) => Blocked({ why })),
  text.map((why) => Stopped({ why })),
)

const moveArb: fc.Arbitrary<Move> = fc.oneof(
  fc.constantFrom(
    Move.Ready(),
    Move.Unready(),
    Move.Released(),
    Move.Dispatched(),
    Move.NoChange(),
    Move.Answered(),
    Move.Requeued(),
    Move.Reopened(),
    Move.Undeferred(),
    Move.ItsTurn(),
    Move.Resumed(),
  ),
  fc.constantFrom(...holdBacks).map((why) => Move.Held({ why })),
  ordinal.map((place) => Move.Verified({ place })),
  ordinal.map((place) => Move.Recheck({ place })),
  ordinal.map((place) => Move.HandedOver({ place })),
  ordinal.map((place) => Move.Unmerged({ place })),
  text.map((question) => Move.FiledQuestion({ question })),
  text.map((question) => Move.StillAsked({ question })),
  fc.array(text.map((id) => id as TicketId)).map((blockers) => Move.WaitsForMerge({ blockers })),
  fc.array(text.map((id) => id as TicketId)).map((blockers) => Move.MergedSinceCut({ blockers })),
  text.map((why) => Move.Defer({ why })),
  fc.oneof(fc.constant("CHECKS_FAILED"), text).map((why) => Move.Aside({ why })),
  fc.constantFrom("PAUSED", "TICKET_LIMIT" as const).map((why) => Move.StopRun({ why })),
  text.map((why) => Move.RunEnded({ why })),
  text.map((commit) => Move.FastForwarded({ commit })),
  ordinal.map((attempt) => Move.ConflictsHandedBack({ attempt })),
  ordinal.map((attempt) => Move.CheckHandedBack({ attempt })),
  text.map((why) => Move.Block({ why })),
)

describe("transition, driven by random moves", () => {
  test("no unlisted transition is taken, and Done{merged} is reached only from Merging", () => {
    fc.assert(
      fc.property(
        fc.option(phaseArb, { nil: null }),
        fc.array(moveArb, { maxLength: 40 }),
        (start, steps) => {
          let phase = start
          for (const move of steps) {
            const result = transition(phase, move)
            if (Result.isFailure(result)) {
              // The ticket keeps its phase.
              continue
            }
            const next = result.success
            expect(listed.has(`${phase?._tag ?? ""}>${next?._tag ?? ""}`)).toBe(true)
            if (next?._tag === "Done" && next.outcome._tag === "Merged") {
              expect(phase?._tag).toBe("Merging")
            }
            phase = next
          }
        },
      ),
    )
  })

  test("only Done is final: nothing leaves it", () => {
    fc.assert(
      fc.property(phaseArb, moveArb, (phase, move) => {
        if (isFinal(phase)) {
          expect(Result.isFailure(transition(phase, move))).toBe(true)
        }
      }),
    )
  })
})

describe("refine", () => {
  test("changes a phase's details and keeps its tag", () => {
    expect(ok(refine(ToMerge({ place: 2 }), Detail.Place({ place: 1 })))).toEqual(
      ToMerge({ place: 1 }),
    )
    expect(ok(refine(Merging({ step: "rebase" }), Detail.Step({ step: "check" })))).toEqual(
      Merging({ step: "check" }),
    )
  })

  test("rejects a detail the phase doesn't have", () => {
    const bug = rejected(refine(Resolving({ attempt: 1 }), Detail.Step({ step: "check" })))
    expect(bug.message).toBe("Resolving → Resolving (Step)")
    expect(Result.isFailure(refine(Merging({ step: "rebase" }), Detail.Place({ place: 1 })))).toBe(
      true,
    )
  })
})

describe("what the UI and totals read", () => {
  const sample = (tag: PhaseTag): TicketPhase => {
    const found = phases.find((phase) => phase?._tag === tag)
    if (found === undefined || found === null) {
      throw new Error(`no sample ${tag}`)
    }
    return found
  }

  test("cards are for the phases with work under way", () => {
    expect(phaseNames.filter((tag) => hasCard(sample(tag)))).toEqual([
      "Working",
      "ToMerge",
      "Merging",
      "Resolving",
      "Fixing",
    ])
  })

  test("the totals each phase counts under", () => {
    expect(Object.fromEntries(phaseNames.map((tag) => [tag, countsUnder(sample(tag))]))).toEqual({
      Queued: ["inQueue"],
      HeldBack: ["heldBack"],
      Working: ["workers"],
      ToMerge: [],
      Merging: [],
      Resolving: ["workers"],
      Fixing: ["workers"],
      Done: ["completed"],
      Asked: ["needsYou"],
      Waiting: [],
      Deferred: ["setAside"],
      Review: ["setAside"],
      Blocked: ["needsYou"],
      Stopped: [],
    })
  })

  test("a Working ticket whose worker waits on you counts under Needs you too", () => {
    expect(countsUnder(Working(), "allow")).toEqual(["workers", "needsYou"])
    expect(countsUnder(Working(), "answer")).toEqual(["workers", "needsYou"])
    expect(countsUnder(Working(), "limit")).toEqual(["workers"])
    expect(countsUnder(Working())).toEqual(["workers"])
  })

  test("only Done is final", () => {
    expect(phaseNames.filter((tag) => isFinal(sample(tag)))).toEqual(["Done"])
  })

  test("Working, ToMerge, Resolving and Fixing become Stopped as the run ends", () => {
    expect(phaseNames.filter((tag) => stopsAtEnd(sample(tag)))).toEqual([
      "Working",
      "ToMerge",
      "Resolving",
      "Fixing",
    ])
  })
})
