import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import fc from "fast-check"
import { phaseNames } from "../src/run/events.ts"
import {
  activities,
  Cause,
  type CauseTag,
  countsUnder,
  Detail,
  hasCard,
  holds,
  InvalidTransition,
  isFinal,
  Outcome,
  type PhaseTag,
  refine,
  stopsAtEnd,
  TicketPhase,
  TicketPhaseSchema,
  transition,
  transitions,
} from "../src/run/phase.ts"

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

const ok = (result: Result.Result<TicketPhase, InvalidTransition>): TicketPhase => {
  if (Result.isFailure(result)) {
    throw new Error(`expected a phase, got ${result.failure.message}`)
  }
  return result.success
}

const rejected = (result: Result.Result<TicketPhase, InvalidTransition>): InvalidTransition => {
  if (Result.isSuccess(result)) {
    throw new Error(`expected InvalidTransition, got ${result.success._tag}`)
  }
  return result.failure
}

// § 5.1's transition table, row by row, written out here rather than read from the code: the
// phase a ticket leaves (null: outside the machine), the cause, and the phase it reaches. The
// carry-over entries of "The next run" follow it.
const table: ReadonlyArray<readonly [string, TicketPhase | null, Cause, TicketPhase]> = [
  ["ready in bd ready → Queued", null, Cause.Ready(), Queued()],
  ["Queued → HeldBack", Queued(), Cause.Held({ why: "overlap" }), HeldBack({ why: "overlap" })],
  ["HeldBack → Queued", HeldBack({ why: "solo" }), Cause.Released(), Queued()],
  ["Queued → Working", Queued(), Cause.Dispatched(), Working({ activity: "starting" })],
  [
    "Working → ToMerge",
    Working({ activity: "editing" }),
    Cause.Verified({ place: 2 }),
    ToMerge({ place: 2 }),
  ],
  [
    "Working → Done{noChange}",
    Working({ activity: "working" }),
    Cause.NoChange(),
    Done({ outcome: Outcome.NoChange() }),
  ],
  [
    "Working → Asked",
    Working({ activity: "working" }),
    Cause.FiledQuestion({ question: "tut-q1" }),
    Asked({ question: "tut-q1" }),
  ],
  [
    "Working → Waiting",
    Working({ activity: "working" }),
    Cause.WaitsForMerge({ for: "tut-b1" }),
    Waiting({ for: "tut-b1" }),
  ],
  [
    "Working → Deferred",
    Working({ activity: "working" }),
    Cause.Defer({ why: "BAD_TICKET_ID" }),
    Deferred({ why: "BAD_TICKET_ID" }),
  ],
  [
    "Working → Review",
    Working({ activity: "working" }),
    Cause.Aside({ why: "OFF_BRANCH" }),
    Review({ why: "OFF_BRANCH" }),
  ],
  [
    "Working → Stopped (it stopped the run)",
    Working({ activity: "working" }),
    Cause.StopRun({ why: "PAUSED" }),
    Stopped({ why: "PAUSED" }),
  ],
  [
    "Working → Stopped (the run ended)",
    Working({ activity: "testing" }),
    Cause.RunEnded({ why: "INTERRUPTED" }),
    Stopped({ why: "INTERRUPTED" }),
  ],
  [
    "Asked → Working",
    Asked({ question: "tut-q1" }),
    Cause.Answered(),
    Working({ activity: "starting" }),
  ],
  ["Waiting → Queued", Waiting({ for: "tut-b1" }), Cause.Requeued(), Queued()],
  ["Deferred → Waiting", Deferred({ why: "x" }), Cause.Reopened(), Waiting({ for: "probe" })],
  ["ToMerge → Merging", ToMerge({ place: 1 }), Cause.ItsTurn(), Merging({ step: "rebase" })],
  [
    "ToMerge → Stopped",
    ToMerge({ place: 3 }),
    Cause.RunEnded({ why: "INTERRUPTED" }),
    Stopped({ why: "INTERRUPTED" }),
  ],
  [
    "Merging → Done{merged}",
    Merging({ step: "fast-forward" }),
    Cause.FastForwarded({ commit: "abc123" }),
    Done({ outcome: Outcome.Merged({ commit: "abc123" }) }),
  ],
  [
    "Merging → ToMerge (the run ended before the fast-forward, § 3.4)",
    Merging({ step: "check" }),
    Cause.MergeInterrupted({ place: 1 }),
    ToMerge({ place: 1 }),
  ],
  [
    "Merging → Resolving",
    Merging({ step: "rebase" }),
    Cause.ConflictsHandedBack({ attempt: 1 }),
    Resolving({ attempt: 1 }),
  ],
  [
    "Merging → Fixing",
    Merging({ step: "check" }),
    Cause.CheckHandedBack({ attempt: 1 }),
    Fixing({ attempt: 1, afterResolution: false }),
  ],
  [
    "Merging → Review",
    Merging({ step: "check" }),
    Cause.Aside({ why: "CHECKS_FAILED" }),
    Review({ why: "CHECKS_FAILED" }),
  ],
  [
    "Merging → Blocked",
    Merging({ step: "rebase" }),
    Cause.Block({ why: "MERGE_CONFLICT" }),
    Blocked({ why: "MERGE_CONFLICT" }),
  ],
  [
    "Resolving → ToMerge",
    Resolving({ attempt: 1 }),
    Cause.Verified({ place: 1 }),
    ToMerge({ place: 1 }),
  ],
  [
    "Resolving → Fixing{afterResolution}",
    Resolving({ attempt: 1 }),
    Cause.CheckHandedBack({ attempt: 1 }),
    Fixing({ attempt: 1, afterResolution: true }),
  ],
  [
    "Resolving → Blocked",
    Resolving({ attempt: 2 }),
    Cause.Block({ why: "MERGE_CONFLICT" }),
    Blocked({ why: "MERGE_CONFLICT" }),
  ],
  [
    "Fixing → ToMerge",
    Fixing({ attempt: 1, afterResolution: false }),
    Cause.Verified({ place: 1 }),
    ToMerge({ place: 1 }),
  ],
  [
    "Fixing → Fixing",
    Fixing({ attempt: 1, afterResolution: false }),
    Cause.CheckHandedBack({ attempt: 2 }),
    Fixing({ attempt: 2, afterResolution: false }),
  ],
  [
    "Fixing{afterResolution} → Fixing keeps afterResolution",
    Fixing({ attempt: 1, afterResolution: true }),
    Cause.CheckHandedBack({ attempt: 2 }),
    Fixing({ attempt: 2, afterResolution: true }),
  ],
  [
    "Fixing → Review",
    Fixing({ attempt: 2, afterResolution: false }),
    Cause.Aside({ why: "CHECKS_FAILED" }),
    Review({ why: "CHECKS_FAILED" }),
  ],
  [
    "Fixing{afterResolution} → Blocked",
    Fixing({ attempt: 2, afterResolution: true }),
    Cause.Aside({ why: "CHECKS_FAILED" }),
    Blocked({ why: "CHECKS_FAILED" }),
  ],
  [
    "Resolving → Stopped",
    Resolving({ attempt: 1 }),
    Cause.RunEnded({ why: "INTERRUPTED" }),
    Stopped({ why: "INTERRUPTED" }),
  ],
  [
    "Fixing → Stopped",
    Fixing({ attempt: 1, afterResolution: true }),
    Cause.RunEnded({ why: "INTERRUPTED" }),
    Stopped({ why: "INTERRUPTED" }),
  ],
  [
    "Review{CHECKS_FAILED} → ToMerge",
    Review({ why: "CHECKS_FAILED" }),
    Cause.Recheck({ place: 1 }),
    ToMerge({ place: 1 }),
  ],
  ["carried over: → Working", null, Cause.Resumed(), Working({ activity: "starting" })],
  [
    "carried over: → Asked",
    null,
    Cause.StillAsked({ question: "tut-q1" }),
    Asked({ question: "tut-q1" }),
  ],
  ["carried over: → ToMerge", null, Cause.Unmerged({ place: 1 }), ToMerge({ place: 1 })],
]

// The (from, to) pairs § 5.1 lists, by tag; From and To joined as "From>To", "" for outside.
const listed = new Set(table.map(([, from, , to]) => `${from?._tag ?? ""}>${to._tag}`))

// A phase of every tag, with both sides of each condition the table puts on a phase's fields.
const phases: ReadonlyArray<TicketPhase | null> = [
  null,
  Queued(),
  ...holds.map((why) => HeldBack({ why })),
  Working({ activity: "working" }),
  Working({ activity: "allow" }),
  ToMerge({ place: 1 }),
  Merging({ step: "rebase" }),
  Merging({ step: "fast-forward" }),
  Resolving({ attempt: 1 }),
  Fixing({ attempt: 1, afterResolution: false }),
  Fixing({ attempt: 1, afterResolution: true }),
  Done({ outcome: Outcome.Merged({ commit: "abc" }) }),
  Done({ outcome: Outcome.NoChange() }),
  Asked({ question: "tut-q1" }),
  Waiting({ for: "tut-b1" }),
  Waiting({ for: "probe" }),
  Deferred({ why: "x" }),
  Review({ why: "CHECKS_FAILED" }),
  Review({ why: "DIRTY_WORKTREE" }),
  Blocked({ why: "MERGE_CONFLICT" }),
  Stopped({ why: "PAUSED" }),
]

// A cause of every tag: the type makes sure none is missing.
const causeOf: { readonly [C in CauseTag]: Extract<Cause, { readonly _tag: C }> } = {
  Ready: Cause.Ready(),
  Held: Cause.Held({ why: "merge" }),
  Released: Cause.Released(),
  Dispatched: Cause.Dispatched(),
  Verified: Cause.Verified({ place: 1 }),
  NoChange: Cause.NoChange(),
  FiledQuestion: Cause.FiledQuestion({ question: "tut-q1" }),
  WaitsForMerge: Cause.WaitsForMerge({ for: "tut-b1" }),
  Defer: Cause.Defer({ why: "x" }),
  Aside: Cause.Aside({ why: "CHECKS_FAILED" }),
  StopRun: Cause.StopRun({ why: "TICKET_LIMIT" }),
  RunEnded: Cause.RunEnded({ why: "INTERRUPTED" }),
  Answered: Cause.Answered(),
  Requeued: Cause.Requeued(),
  Reopened: Cause.Reopened(),
  ItsTurn: Cause.ItsTurn(),
  FastForwarded: Cause.FastForwarded({ commit: "abc" }),
  MergeInterrupted: Cause.MergeInterrupted({ place: 1 }),
  ConflictsHandedBack: Cause.ConflictsHandedBack({ attempt: 1 }),
  CheckHandedBack: Cause.CheckHandedBack({ attempt: 1 }),
  Block: Cause.Block({ why: "GIT_FAILED" }),
  Recheck: Cause.Recheck({ place: 1 }),
  Resumed: Cause.Resumed(),
  StillAsked: Cause.StillAsked({ question: "tut-q1" }),
  Unmerged: Cause.Unmerged({ place: 1 }),
}
const causes: ReadonlyArray<Cause> = Object.values(causeOf)

describe("transition", () => {
  test.each(table)("%s", (_, from, cause, to) => {
    expect(ok(transition(from, cause))).toEqual(to)
  })

  test("the code's table lists § 5.1's pairs and no others", () => {
    expect(new Set(transitions.map((row) => `${row.from ?? ""}>${row.to}`))).toEqual(listed)
  })

  test("every pair the table doesn't list is rejected", () => {
    const taken = new Set<string>()
    for (const from of phases) {
      for (const cause of causes) {
        const result = transition(from, cause)
        if (Result.isSuccess(result)) {
          taken.add(`${from?._tag ?? ""}>${result.success._tag}`)
        }
      }
    }
    // Of the 15 × 14 pairs of a phase (or outside) and a phase, the listed ones and no others.
    expect(taken).toEqual(listed)
  })

  test("the conditions on a phase's fields hold", () => {
    expect(
      rejected(transition(Review({ why: "DIRTY_WORKTREE" }), Cause.Recheck({ place: 1 }))),
    ).toBeInstanceOf(InvalidTransition)
    expect(
      ok(transition(Fixing({ attempt: 1, afterResolution: true }), Cause.Aside({ why: "x" }))),
    ).toEqual(Blocked({ why: "x" }))
    expect(
      rejected(
        transition(Fixing({ attempt: 1, afterResolution: false }), Cause.Block({ why: "x" })),
      ),
    ).toBeInstanceOf(InvalidTransition)
  })

  test("an invalid transition names its phases and cause, and PHASE_BUG's line", () => {
    const bug = rejected(transition(Queued(), Cause.FastForwarded({ commit: "abc" })))
    expect([bug.from, bug.to, bug.when]).toEqual(["Queued", "Done", "FastForwarded"])
    expect(bug.phaseBug("tut-9a1")).toBe("PHASE_BUG: tut-9a1 Queued → Done (FastForwarded)")
    expect(rejected(transition(null, Cause.Dispatched())).phaseBug("tut-9a1")).toBe(
      "PHASE_BUG: tut-9a1 outside → Working (Dispatched)",
    )
  })

  test("every cause leads somewhere in the table", () => {
    expect(new Set<string>(transitions.map((row) => row.when))).toEqual(
      new Set(Object.keys(causeOf)),
    )
  })
})

const text = fc.string({ maxLength: 8 })
const ordinal = fc.integer({ min: 1, max: 9 })

const phaseArb: fc.Arbitrary<TicketPhase> = fc.oneof(
  fc.constant(Queued()),
  fc.constantFrom(...holds).map((why) => HeldBack({ why })),
  fc.constantFrom(...activities).map((activity) => Working({ activity })),
  ordinal.map((place) => ToMerge({ place })),
  fc
    .constantFrom("rebase", "setup", "check", "fast-forward" as const)
    .map((step) => Merging({ step })),
  ordinal.map((attempt) => Resolving({ attempt })),
  fc.record({ attempt: ordinal, afterResolution: fc.boolean() }).map((fields) => Fixing(fields)),
  fc.oneof(
    text.map((commit) => Done({ outcome: Outcome.Merged({ commit }) })),
    fc.constant(Done({ outcome: Outcome.NoChange() })),
  ),
  text.map((question) => Asked({ question })),
  text.map((blocker) => Waiting({ for: blocker })),
  text.map((why) => Deferred({ why })),
  fc.oneof(fc.constant("CHECKS_FAILED"), text).map((why) => Review({ why })),
  text.map((why) => Blocked({ why })),
  text.map((why) => Stopped({ why })),
)

const causeArb: fc.Arbitrary<Cause> = fc.oneof(
  fc.constantFrom(
    Cause.Ready(),
    Cause.Released(),
    Cause.Dispatched(),
    Cause.NoChange(),
    Cause.Answered(),
    Cause.Requeued(),
    Cause.Reopened(),
    Cause.ItsTurn(),
    Cause.Resumed(),
  ),
  fc.constantFrom(...holds).map((why) => Cause.Held({ why })),
  ordinal.map((place) => Cause.Verified({ place })),
  ordinal.map((place) => Cause.Recheck({ place })),
  ordinal.map((place) => Cause.Unmerged({ place })),
  text.map((question) => Cause.FiledQuestion({ question })),
  text.map((question) => Cause.StillAsked({ question })),
  text.map((blocker) => Cause.WaitsForMerge({ for: blocker })),
  text.map((why) => Cause.Defer({ why })),
  fc.oneof(fc.constant("CHECKS_FAILED"), text).map((why) => Cause.Aside({ why })),
  fc.constantFrom("PAUSED", "TICKET_LIMIT" as const).map((why) => Cause.StopRun({ why })),
  text.map((why) => Cause.RunEnded({ why })),
  text.map((commit) => Cause.FastForwarded({ commit })),
  ordinal.map((attempt) => Cause.ConflictsHandedBack({ attempt })),
  ordinal.map((attempt) => Cause.CheckHandedBack({ attempt })),
  text.map((why) => Cause.Block({ why })),
)

describe("transition, driven by random causes", () => {
  test("no unlisted transition is taken, and Done{merged} is reached only from Merging", () => {
    fc.assert(
      fc.property(
        fc.option(phaseArb, { nil: null }),
        fc.array(causeArb, { maxLength: 40 }),
        (start, steps) => {
          let phase = start
          for (const cause of steps) {
            const result = transition(phase, cause)
            if (Result.isFailure(result)) {
              // The ticket keeps its phase.
              continue
            }
            const next = result.success
            expect(listed.has(`${phase?._tag ?? ""}>${next._tag}`)).toBe(true)
            if (next._tag === "Done" && next.outcome._tag === "Merged") {
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
      fc.property(phaseArb, causeArb, (phase, cause) => {
        if (isFinal(phase)) {
          expect(Result.isFailure(transition(phase, cause))).toBe(true)
        }
      }),
    )
  })
})

describe("refine", () => {
  test("changes a phase's details and keeps its tag", () => {
    expect(
      ok(refine(Working({ activity: "starting" }), Detail.Activity({ activity: "allow" }))),
    ).toEqual(Working({ activity: "allow" }))
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
    expect(countsUnder(Working({ activity: "allow" }))).toEqual(["workers", "needsYou"])
    expect(countsUnder(Working({ activity: "answer" }))).toEqual(["workers", "needsYou"])
    expect(countsUnder(Working({ activity: "limit" }))).toEqual(["workers"])
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

describe("TicketPhaseSchema", () => {
  test("its tags are the event stream's phase names", () => {
    expect(Object.keys(TicketPhaseSchema.cases).sort()).toEqual([...phaseNames].sort())
  })

  test("round-trips every phase", () => {
    fc.assert(
      fc.property(phaseArb, (phase) => {
        const encoded = Schema.encodeSync(TicketPhaseSchema)(phase)
        expect(
          Schema.decodeUnknownSync(TicketPhaseSchema)(JSON.parse(JSON.stringify(encoded))),
        ).toEqual({ ...phase })
      }),
    )
  })

  test("rejects a place or attempt below 1, and an unknown hold", () => {
    const decode = Schema.decodeUnknownResult(TicketPhaseSchema)
    expect(Result.isFailure(decode({ _tag: "ToMerge", place: 0 }))).toBe(true)
    expect(Result.isFailure(decode({ _tag: "Resolving", attempt: 0 }))).toBe(true)
    expect(Result.isFailure(decode({ _tag: "HeldBack", why: "slot" }))).toBe(true)
    expect(Result.isSuccess(decode({ _tag: "HeldBack", why: "solo" }))).toBe(true)
  })
})
