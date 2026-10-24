// The run's end with a worker to be resumed that found no slot (§ 5's Scheduling): carried over
// from the last run, or its question answered, it is still to start, so the run doesn't end, nor
// shows the end-of-run box, while the worker in the slot waits on you.
import { describe, expect, test } from "bun:test"
import { TicketPhase } from "../src/run/phase.ts"
import { decide, End, endOfRunBox, type Snapshot } from "../src/run/runEnd.ts"

const look = (over: Partial<Snapshot> = {}): Snapshot => ({
  mergedBefore: true,
  running: new Set(),
  tickets: new Map(),
  overLimit: new Set(),
  asking: [],
  canTake: true,
  resuming: false,
  settled: true,
  triagePending: 0,
  dashboard: true,
  held: false,
  usageHeld: false,
  endAsked: false,
  ...over,
})

/** b works in the one slot, waiting on you; a's question is answered. */
const waitingOnYou = look({
  running: new Set(["b"]),
  tickets: new Map([
    ["a", { ticket: "a", phase: TicketPhase.Asked({ question: "q-1" }), handBack: false }],
    ["b", { ticket: "b", phase: TicketPhase.Working(), handBack: false }],
  ]),
  asking: ["b"],
})

describe("a worker to be resumed with no slot for it", () => {
  test("keeps the run busy beside a worker waiting on you, the box not shown", () => {
    const snapshot = { ...waitingOnYou, resuming: true }
    expect(decide(snapshot)).toEqual(End.Busy())
    expect(decide({ ...snapshot, endAsked: true })).toEqual(End.Busy())
    expect(endOfRunBox(snapshot)).toBeNull()
  })

  test("once none is left to resume, the worker waiting on you is waited for", () => {
    expect(decide(waitingOnYou)).toEqual(End.WaitOnYou({ tickets: ["b"] }))
    expect(endOfRunBox(waitingOnYou)).toEqual(["b"])
  })

  test("keeps a run with nothing else left from ending", () => {
    expect(decide(look({ resuming: true }))).toEqual(End.Busy())
  })
})
