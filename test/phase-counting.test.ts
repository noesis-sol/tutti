// What each phase counts as (phase.ts counting): the dashboard's totals, the run's end notice, the
// reviewer's sections and the wind-down line read one table, so that they say the same of a ticket.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Result } from "effect"
import { TestClock } from "effect/testing"
import { phaseNames } from "../src/run/events.ts"
import { Ledger } from "../src/run/ledger.ts"
import { finished } from "../src/run/notices.ts"
import {
  Cause,
  counting,
  countsUnder,
  Outcome,
  type PhaseTag,
  TicketPhase,
  WaitFor,
} from "../src/run/phase.ts"
import { emptyStatus, project } from "../src/run/runView.ts"
import { layer as ledgerLayer } from "../src/testing/Ledger.ts"

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
  Object.fromEntries(phaseNames.map((tag) => [tag, counting[tag][key]]))

describe("counting", () => {
  test("the end notice counts each phase as the totals of the same name do", () => {
    // Working's needs-you is its worker's, which a run that ended has no more of.
    for (const tag of phaseNames) {
      const totals = countsUnder(samples[tag]).filter(
        (total) => total === "completed" || total === "setAside" || total === "needsYou",
      )
      const notice = counting[tag].notice
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

describe("a run that ends with a MERGE_CONFLICT", () => {
  test("says the same in the dashboard's totals and the end notice", async () => {
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const ledger = yield* Ledger
        const go = (ticket: string, ...causes: ReadonlyArray<Cause>) =>
          Effect.gen(function* () {
            for (const [i, cause] of causes.entries()) {
              const options = i === 0 ? { title: `Title of ${ticket}` } : {}
              const next = yield* ledger.transition(ticket, cause, options)
              if (Result.isFailure(next)) throw new Error(next.failure.phaseBug(ticket))
            }
          })
        const merging = [
          Cause.Ready(),
          Cause.Dispatched(),
          Cause.Verified({ place: 1 }),
          Cause.ItsTurn(),
        ]
        yield* go("a", ...merging, Cause.FastForwarded({ commit: "abc1234def" }))
        yield* go("b", ...merging, Cause.Block({ why: "MERGE_CONFLICT" }))
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
