// A Working ticket's activity is RunView's (runView.ts activityOf), worked out from its worker's
// state and open requests as the view is projected; the ledger's phase doesn't carry it.

import { describe, expect, test } from "bun:test"
import { WorkerState } from "../src/agent/WorkerState.ts"
import { emptyTallies, type State } from "../src/run/ledger.ts"
import { activities, TicketPhase } from "../src/run/phase.ts"
import { activityOf, emptyStatus, project } from "../src/run/runView.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { questionOf, stateFor } from "./activity.ts"

const ledgerOf = (phase: TicketPhase): State => ({
  tickets: new Map([
    [
      "t" as TicketId,
      {
        ticket: "t" as TicketId,
        title: "Title of t",
        phase,
        since: 0,
        worker: 1,
        row: 0,
        rechecking: false,
        steered: false,
        lastMessage: null,
        tallies: emptyTallies,
      },
    ],
  ]),
  rows: 1,
  windDown: null,
  bugs: [],
})

describe("activityOf", () => {
  test("reads each activity from the worker's state, or a question it asked", () => {
    for (const activity of activities) {
      const requests = activity === "answer" ? [questionOf("t" as TicketId)] : []
      expect(activityOf(stateFor(activity), requests)).toBe(activity)
    }
  })

  test("an open request comes before the state", () => {
    const editing = WorkerState.Working({ doing: "editing" })
    expect(activityOf(editing, [questionOf("t" as TicketId)])).toBe("answer")
    expect(activityOf(editing, [{ ...questionOf("t" as TicketId), kind: permission }])).toBe(
      "allow",
    )
  })

  test("is starting while neither says, and after the turn", () => {
    expect(activityOf(undefined, [])).toBe("starting")
    expect(activityOf(WorkerState.Idle({ at: 0 }), [])).toBe("starting")
    expect(activityOf(WorkerState.Gone({ why: "exited" }), [])).toBe("starting")
  })
})

const permission = {
  _tag: "Permission",
  tool: "Bash",
  input: {},
  suggestions: [],
  summary: "make",
} as const

describe("a Working ticket in RunView", () => {
  test("its row, card and totals follow its worker, its phase the ledger's own", () => {
    const phase = TicketPhase.Working()
    const view = project({
      ledger: ledgerOf(phase),
      workers: new Map([["t", WorkerState.NeedsYou({ requests: 1 })]]),
      requests: [],
      status: { ...emptyStatus, concurrency: 1 },
    })
    expect(view.rows[0]?.word).toBe("allow?")
    expect(view.cards[0]?.phase).toBe(phase)
    expect(view.cards[0]?.tone).toBe("stop")
    expect([view.totals.workers, view.totals.needsYou]).toEqual([1, 1])
  })

  test("with no worker's state yet, it is starting, its card's status faint", () => {
    const view = project({
      ledger: ledgerOf(TicketPhase.Working()),
      workers: new Map(),
      requests: [],
      status: { ...emptyStatus, concurrency: 1 },
    })
    expect(view.rows[0]?.word).toBe("starting")
    expect([view.cards[0]?.status, view.cards[0]?.tone]).toEqual(["starting", "dim"])
    expect([view.totals.workers, view.totals.needsYou]).toEqual([1, 0])
  })
})
