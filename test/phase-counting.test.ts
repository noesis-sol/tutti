// What is so of each phase (phase.ts phaseFacts): the dashboard's totals, the run's end notice, the
// reviewer's sections, the wind-down line, the ledger, the holds, the schedule, the sessions and the
// tickets table read one table, so that they say the same of a ticket.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Result } from "effect"
import { TestClock } from "effect/testing"
import { endingPhases, phaseNames, queuePhases } from "../src/run/events.ts"
import { holdsWorker, keepsWorker, Ledger } from "../src/run/ledger.ts"
import { finished } from "../src/run/notices.ts"
import {
  activities,
  countsUnder,
  factsOf,
  hasCard,
  Move,
  Outcome,
  type PhaseTag,
  phaseFacts,
  stopsAtEnd,
  TicketPhase,
  WaitFor,
} from "../src/run/phase.ts"
import { emptyStatus, project, rowStatus } from "../src/run/runView.ts"
import { lifetime } from "../src/run/sessions.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"
import { marks } from "../src/ui/marks.ts"

/** A phase of each tag, with details that count as the tag's other phases do but Working's. */
const samples: { readonly [T in PhaseTag]: TicketPhase } = {
  Queued: TicketPhase.Queued(),
  HeldBack: TicketPhase.HeldBack({ why: "overlap" }),
  Working: TicketPhase.Working({ activity: "editing" }),
  ToMerge: TicketPhase.ToMerge({ place: 1 }),
  Merging: TicketPhase.Merging({ step: "check" }),
  Resolving: TicketPhase.Resolving({ attempt: 1 }),
  Fixing: TicketPhase.Fixing({ attempt: 1, afterResolution: false }),
  Done: TicketPhase.Done({ outcome: Outcome.Merged({ commit: "abc1234" }) }),
  Asked: TicketPhase.Asked({ question: "q-1" }),
  Waiting: TicketPhase.Waiting({ for: WaitFor.Blockers({ ids: ["x-1"] }) }),
  Deferred: TicketPhase.Deferred({ why: "BAD_TICKET_ID" }),
  Review: TicketPhase.Review({ why: "CHECKS_FAILED" }),
  Blocked: TicketPhase.Blocked({ why: "MERGE_CONFLICT" }),
  Stopped: TicketPhase.Stopped({ why: "PAUSED" }),
}

const column = <K extends "notice" | "report" | "windDown">(key: K) =>
  Object.fromEntries(phaseNames.map((tag) => [tag, phaseFacts[tag][key]]))

describe("counting", () => {
  test("the end notice counts each phase as the totals of the same name do", () => {
    // Working's needs-you is its worker's, which a run that ended has no more of.
    for (const tag of phaseNames) {
      const totals = countsUnder(samples[tag]).filter(
        (total) => total === "completed" || total === "setAside" || total === "needsYou",
      )
      const notice = phaseFacts[tag].notice
      const expected =
        tag === "Working" ? [] : totals.map((t) => (t === "completed" ? "closed" : t))
      expect(notice === null ? [] : [notice]).toEqual(expected)
    }
  })

  test("the end notice's column", () => {
    expect(column("notice")).toEqual({
      Queued: null,
      HeldBack: null,
      Working: null,
      ToMerge: null,
      Merging: null,
      Resolving: null,
      Fixing: null,
      Done: "closed",
      Asked: "needsYou",
      Waiting: null,
      Deferred: "setAside",
      Review: "setAside",
      Blocked: "needsYou",
      Stopped: null,
    })
  })

  test("the reviewer's sections: Queued and HeldBack in none, as bd ready counts them", () => {
    expect(column("report")).toEqual({
      Queued: null,
      HeldBack: null,
      Working: "inProgress",
      ToMerge: "inProgress",
      Merging: "inProgress",
      Resolving: "inProgress",
      Fixing: "inProgress",
      Done: "closed",
      Asked: "setAside",
      Waiting: "setAside",
      Deferred: "setAside",
      Review: "setAside",
      Blocked: "setAside",
      Stopped: "inProgress",
    })
  })

  test("the wind-down line's marks", () => {
    expect(column("windDown")).toEqual({
      Queued: "faint",
      HeldBack: "faint",
      Working: "windingDown",
      ToMerge: "windingDown",
      Merging: "windingDown",
      Resolving: "windingDown",
      Fixing: "windingDown",
      Done: "done",
      Asked: "needsYou",
      Waiting: "faint",
      Deferred: "needsYou",
      Review: "needsYou",
      Blocked: "needsYou",
      Stopped: "needsYou",
    })
  })
})

/** The phases of each tag whose facts turn on their details, and one of each other tag. */
const variants: ReadonlyArray<TicketPhase> = [
  ...phaseNames.filter((tag) => tag !== "Working").map((tag) => samples[tag]),
  ...activities.map((activity) => TicketPhase.Working({ activity })),
  TicketPhase.Done({ outcome: Outcome.NoChange() }),
  TicketPhase.Waiting({ for: WaitFor.Setup() }),
  TicketPhase.Waiting({ for: WaitFor.Probe() }),
  TicketPhase.Waiting({ for: WaitFor.SetupProblem() }),
  TicketPhase.Review({ why: "OFF_BRANCH" }),
  TicketPhase.Blocked({ why: "DIRTY_TREE" }),
  TicketPhase.Fixing({ attempt: 2, afterResolution: true }),
]

/** The tags whose `fact` is true. */
const where = (fact: (tag: PhaseTag) => boolean): ReadonlyArray<PhaseTag> => phaseNames.filter(fact)

// Each fact against the set or switch it replaced, as that read before the table.
describe("the facts each phase.ts set and switch was", () => {
  test("running: the ledger's and holdsGate's running", () => {
    expect(where((tag) => phaseFacts[tag].running)).toEqual([
      "Working",
      "ToMerge",
      "Merging",
      "Resolving",
      "Fixing",
    ])
  })

  test("card: hasCard", () => {
    expect(where((tag) => phaseFacts[tag].card)).toEqual([
      "Working",
      "ToMerge",
      "Merging",
      "Resolving",
      "Fixing",
    ])
    expect(where((tag) => hasCard(samples[tag]))).toEqual(where((tag) => phaseFacts[tag].card))
  })

  test("atWork: runView's atWork", () => {
    expect(where((tag) => phaseFacts[tag].atWork)).toEqual(["Working", "Resolving", "Fixing"])
  })

  test("busy: holds.ts's busy", () => {
    expect(where((tag) => phaseFacts[tag].busy)).toEqual([
      "Working",
      "Resolving",
      "Fixing",
      "Asked",
    ])
  })

  test("unsettled: holds.ts's unsettled, the busy phases among them", () => {
    expect(where((tag) => phaseFacts[tag].unsettled)).toEqual([
      "Working",
      "ToMerge",
      "Merging",
      "Resolving",
      "Fixing",
      "Asked",
      "Review",
      "Blocked",
      "Stopped",
    ])
    for (const tag of phaseNames) {
      if (phaseFacts[tag].busy) expect(phaseFacts[tag].unsettled).toBe(true)
    }
  })

  test("pastWork: schedule.ts's pastWork", () => {
    expect(where((tag) => phaseFacts[tag].pastWork)).toEqual([
      "ToMerge",
      "Merging",
      "Resolving",
      "Fixing",
    ])
  })

  test("ready: the ledger's rowless and schedule.ts's waiting", () => {
    expect(where((tag) => phaseFacts[tag].ready)).toEqual(["Queued", "HeldBack"])
  })

  test("inQueue: the ledger's inQueue, and the event stream's queue phases", () => {
    expect(where((tag) => phaseFacts[tag].inQueue)).toEqual(["Queued", "HeldBack", "Waiting"])
    expect(where((tag) => phaseFacts[tag].inQueue)).toEqual(
      phaseNames.filter((tag) => (queuePhases as ReadonlyArray<PhaseTag>).includes(tag)),
    )
  })

  test("ends: the ledger's outcomeOf and endsPart, and the event stream's ending phases", () => {
    expect(variants.map((phase) => [phaseLabel(phase), factsOf(phase).ends(phase)])).toEqual(
      variants.map((phase) => [phaseLabel(phase), outcomeBefore(phase)]),
    )
    const ending = where(
      (tag) => !phaseFacts[tag].inQueue && factsOf(samples[tag]).ends(samples[tag]) !== null,
    )
    expect(ending).toEqual(["Done", "Asked", "Deferred", "Review", "Blocked", "Stopped"])
    expect(ending).toEqual(
      phaseNames.filter((tag) => (endingPhases as ReadonlyArray<PhaseTag>).includes(tag)),
    )
  })

  test("over: sessions.ts's over", () => {
    expect(where((tag) => phaseFacts[tag].over)).toEqual(["Done", "Deferred", "Review"])
  })

  test("orchestra: the ledger's countsIn", () => {
    expect(
      Object.fromEntries(
        where((tag) => phaseFacts[tag].orchestra !== null).map((tag) => [
          tag,
          phaseFacts[tag].orchestra,
        ]),
      ),
    ).toEqual({
      Working: "working",
      ToMerge: "waiting",
      Merging: "merging",
      Resolving: "resolving",
      Fixing: "fixing",
    })
  })

  test("session: sessions.ts's lifetime", () => {
    for (const recheck of [false, true]) {
      for (const handBackWaits of [false, true]) {
        for (const phase of variants) {
          expect([
            phaseLabel(phase),
            recheck,
            handBackWaits,
            lifetime(phase, recheck, handBackWaits),
          ]).toEqual([
            phaseLabel(phase),
            recheck,
            handBackWaits,
            lifetimeBefore(phase, recheck, handBackWaits),
          ])
        }
      }
    }
  })

  test("row: runView's rowStatus", () => {
    const glyphs = (phase: TicketPhase): { readonly mark: string; readonly word: string } => {
      const { mark, word } = rowStatus(phase)
      return { mark: marks[mark], word }
    }
    expect(variants.map((phase) => [phaseLabel(phase), glyphs(phase)])).toEqual(
      variants.map((phase) => [phaseLabel(phase), rowBefore(phase)]),
    )
  })

  test("stopsAtEnd: Working, ToMerge, Resolving and Fixing, from the transition table", () => {
    expect(where((tag) => stopsAtEnd(samples[tag]))).toEqual([
      "Working",
      "ToMerge",
      "Resolving",
      "Fixing",
    ])
  })

  test("holdsWorker: a card, or set aside after a failed check", () => {
    for (const phase of variants) {
      const before = hasCard(phase) || (phase._tag === "Review" && phase.why === "CHECKS_FAILED")
      expect([phaseLabel(phase), holdsWorker(phase)]).toEqual([phaseLabel(phase), before])
    }
  })

  test("keepsWorker: holdsWorker, or Blocked on a conflict whose hand-back waits", () => {
    for (const handBack of [false, true]) {
      for (const phase of variants) {
        const waits = handBack && phase._tag === "Blocked" && phase.why === "MERGE_CONFLICT"
        expect([phaseLabel(phase), handBack, keepsWorker({ phase, handBack })]).toEqual([
          phaseLabel(phase),
          handBack,
          holdsWorker(phase) || waits,
        ])
      }
    }
  })

  test("totals give the same array each call, as the dashboard reads them every frame", () => {
    for (const phase of variants) expect(countsUnder(phase)).toBe(countsUnder(phase))
    for (const phase of variants) expect(rowStatus(phase)).toBe(rowStatus(phase))
  })
})

// The phase with its details, to tell the variants apart where a test fails.
const phaseLabel = (phase: TicketPhase): string => JSON.stringify(phase)

// The ledger's outcomeOf before the table.
const outcomeBefore = (phase: TicketPhase): string | null => {
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
  return null
}

// sessions.ts's lifetime before the table.
const lifetimeBefore = (phase: TicketPhase, recheck: boolean, handBackWaits: boolean): string => {
  switch (phase._tag) {
    case "Working":
    case "ToMerge":
    case "Merging":
    case "Resolving":
    case "Fixing":
      return "open"
    case "Review":
      return phase.why === "CHECKS_FAILED" && recheck ? "untilRunEnds" : "closed"
    case "Blocked":
      return phase.why === "MERGE_CONFLICT" && handBackWaits ? "open" : "closed"
    case "Stopped":
      return "suspended"
  }
  return "closed"
}

// runView's rowStatus before the table.
const rowBefore = (phase: TicketPhase): { readonly mark: string; readonly word: string } => {
  switch (phase._tag) {
    case "Queued":
      return { mark: "◷", word: "queued" }
    case "HeldBack":
      return { mark: "◷", word: "held back" }
    case "Working":
      switch (phase.activity) {
        case "allow":
          return { mark: "■", word: "allow?" }
        case "answer":
          return { mark: "■", word: "answer?" }
        case "limit":
          return { mark: "◷", word: "limit" }
      }
      return { mark: "▶", word: phase.activity }
    case "ToMerge":
      return { mark: "◼", word: "to merge" }
    case "Merging":
      return { mark: "◆", word: "merging" }
    case "Resolving":
      return { mark: "⟳", word: "resolving" }
    case "Fixing":
      return { mark: "⟳", word: "fixing" }
    case "Done":
      return { mark: "✓", word: "done" }
    case "Asked":
      return { mark: "?", word: "for you" }
    case "Waiting":
      return { mark: "◷", word: "waiting" }
    case "Deferred":
      return { mark: "↷", word: "deferred" }
    case "Review":
      return { mark: "!", word: "review" }
    case "Blocked":
      return { mark: "■", word: "blocked" }
    case "Stopped":
      return { mark: "■", word: "stopped" }
  }
}

describe("a run that ends with a MERGE_CONFLICT", () => {
  test("says the same in the dashboard's totals and the end notice", async () => {
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        const go = (ticket: string, ...causes: ReadonlyArray<Move>) =>
          Effect.gen(function* () {
            for (const [i, cause] of causes.entries()) {
              const options = i === 0 ? { title: `Title of ${ticket}` } : {}
              const next = yield* ledger.transition(ticket, cause, options)
              if (Result.isFailure(next)) throw new Error(next.failure.phaseBug(ticket))
            }
          })
        const merging = [
          Move.Ready(),
          Move.Dispatched(),
          Move.Verified({ place: 1 }),
          Move.ItsTurn(),
        ]
        yield* go("a", ...merging, Move.FastForwarded({ commit: "abc1234def" }))
        yield* go("b", ...merging, Move.Block({ why: "MERGE_CONFLICT" }))
        return yield* ledger.current
      }).pipe(Effect.provide(ledgerLayer().pipe(Layer.provideMerge(TestClock.layer())))),
    )
    const view = project({
      ledger: state,
      workers: new Map(),
      requests: [],
      status: { ...emptyStatus, branch: "main", concurrency: 3 },
    })
    expect(view.totals.completed).toBe(1)
    expect(view.totals.deferred + view.totals.review).toBe(0)
    expect(view.totals.needsYou).toBe(1)
    const phases = [...state.tickets.values()].map((entry) => entry.phase)
    expect(finished(phases)).toBe("Finished the run · 1 ticket closed · 1 needs you")
  })
})
