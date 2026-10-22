import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { Tag } from "../src/run/log.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { decide, End, endOfRunBox, type Look, type Snapshot, whatsLeft } from "../src/run/runEnd.ts"

type Ticket = Look["tickets"] extends ReadonlyMap<string, infer V> ? V : never

const ids = ["a", "b", "c", "d", "e"]

const phases: ReadonlyArray<TicketPhase> = [
  TicketPhase.Queued(),
  TicketPhase.HeldBack({ why: "overlap" }),
  TicketPhase.HeldBack({ why: "solo" }),
  TicketPhase.Working({ activity: "working" }),
  TicketPhase.Working({ activity: "answer" }),
  TicketPhase.ToMerge({ place: 1 }),
  TicketPhase.Resolving({ attempt: 1 }),
  TicketPhase.Done({ outcome: { _tag: "NoChange" } }),
  TicketPhase.Blocked({ why: Tag.mergeConflict }),
  TicketPhase.Blocked({ why: "a reason" }),
]

const arbTicket = (ticket: string): fc.Arbitrary<Ticket> =>
  fc.record({ phase: fc.constantFrom(...phases), handBack: fc.boolean() }).map((each) => ({
    ticket,
    ...each,
  }))

const arbSnapshot: fc.Arbitrary<Snapshot> = fc
  .record({
    known: fc.subarray(ids),
    running: fc.subarray(ids),
    overLimit: fc.subarray(ids),
    asking: fc.array(fc.constantFrom(...ids), { maxLength: 6 }),
    mergedBefore: fc.boolean(),
    canTake: fc.boolean(),
    settled: fc.boolean(),
    triagePending: fc.nat(2),
    dashboard: fc.boolean(),
    held: fc.boolean(),
    usageHeld: fc.boolean(),
    endAsked: fc.boolean(),
  })
  .chain(({ known, running, overLimit, ...rest }) =>
    fc.tuple(...known.map(arbTicket)).map((tickets) => ({
      ...rest,
      tickets: new Map(tickets.map((each) => [each.ticket, each])),
      running: new Set(running),
      overLimit: new Set(overLimit),
    })),
  )

const look = (over: Partial<Snapshot> = {}): Snapshot => ({
  mergedBefore: true,
  running: new Set(),
  tickets: new Map(),
  overLimit: new Set(),
  asking: [],
  canTake: true,
  settled: true,
  triagePending: 0,
  dashboard: true,
  held: false,
  usageHeld: false,
  endAsked: false,
  ...over,
})

const tickets = (...entries: ReadonlyArray<[string, TicketPhase, boolean?]>) =>
  new Map(
    entries.map(([ticket, phase, handBack]) => [
      ticket,
      { ticket, phase, handBack: handBack ?? false },
    ]),
  )

const working = TicketPhase.Working({ activity: "answer" })

describe("decide", () => {
  test("a busy look is never an end", () => {
    fc.assert(
      fc.property(arbSnapshot, (snapshot) => {
        const end = decide(snapshot)
        const running = [...snapshot.running].some((ticket) => {
          const entry = snapshot.tickets.get(ticket)
          return entry === undefined || entry.phase._tag !== "Working"
        })
        if (running || !snapshot.mergedBefore || !snapshot.settled || snapshot.triagePending > 0) {
          expect(end._tag).toBe("Busy")
        }
      }),
    )
  })

  test("the workers it waits on ask or wait for a hand-back, each once", () => {
    fc.assert(
      fc.property(arbSnapshot, (snapshot) => {
        const end = decide(snapshot)
        if (end._tag !== "WaitOnYou") return
        expect(end.tickets.length).toBeGreaterThan(0)
        expect(new Set(end.tickets).size).toBe(end.tickets.length)
        for (const ticket of end.tickets) {
          const entry = snapshot.tickets.get(ticket)
          const asks = snapshot.asking.includes(ticket) && snapshot.running.has(ticket)
          const handBack =
            snapshot.dashboard &&
            entry?.handBack === true &&
            entry.phase._tag === "Blocked" &&
            entry.phase.why === Tag.mergeConflict
          expect(asks || handBack).toBe(true)
          expect(asks && snapshot.overLimit.has(ticket)).toBe(false)
        }
      }),
    )
  })

  test("waiting for the reset needs the usage-limit hold on and no stop", () => {
    fc.assert(
      fc.property(arbSnapshot, (snapshot) => {
        if (decide(snapshot)._tag === "WaitForReset") {
          expect(snapshot.usageHeld && !snapshot.held).toBe(true)
          expect(decide({ ...snapshot, held: true })).toEqual(End.Done({ asked: false }))
          expect(decide({ ...snapshot, usageHeld: false })).toEqual(End.Done({ asked: false }))
        }
      }),
    )
  })

  test("a dashboard ends on the box's q; plain, on a stop", () => {
    fc.assert(
      fc.property(arbSnapshot, (snapshot) => {
        const waits = decide({ ...snapshot, held: false, endAsked: false })
        if (waits._tag !== "WaitOnYou") return
        const ends = snapshot.dashboard ? { endAsked: true } : { held: true }
        expect(decide({ ...snapshot, held: false, endAsked: false, ...ends })).toEqual(
          End.Done({ asked: snapshot.dashboard }),
        )
      }),
    )
  })

  test("the box names the workers waited on, whenever the run is otherwise done", () => {
    fc.assert(
      fc.property(arbSnapshot, (snapshot) => {
        const end = decide(snapshot)
        const box = endOfRunBox(snapshot)
        if (end._tag === "WaitOnYou" && snapshot.dashboard) expect(box).toEqual(end.tickets)
        if (end._tag === "Busy" || end._tag === "WaitForReset") expect(box).toBeNull()
        if (!snapshot.dashboard) expect(box).toBeNull()
      }),
    )
  })

  test("the box's q is taken only with workers to wait on", () => {
    fc.assert(
      fc.property(arbSnapshot, (snapshot) => {
        const end = decide(snapshot)
        if (end._tag === "Done" && end.asked) {
          expect(whatsLeft(snapshot).waiting.length).toBeGreaterThan(0)
        }
      }),
    )
  })

  test("nothing left ends the run", () => {
    expect(decide(look())).toEqual(End.Done({ asked: false }))
  })

  test("a worker waiting on you holds a queued ticket still to start, but not at the cap", () => {
    const snapshot = look({
      running: new Set(["a"]),
      tickets: tickets(["a", working], ["b", TicketPhase.Queued()]),
      asking: ["a"],
    })
    expect(decide(snapshot)).toEqual(End.Busy())
    expect(decide({ ...snapshot, canTake: false })).toEqual(End.WaitOnYou({ tickets: ["a"] }))
  })

  test("a solo ticket held behind a waiting worker doesn't keep the run busy", () => {
    const snapshot = look({
      running: new Set(["a"]),
      tickets: tickets(["a", working], ["b", TicketPhase.HeldBack({ why: "solo" })]),
      asking: ["a"],
    })
    expect(decide(snapshot)).toEqual(End.WaitOnYou({ tickets: ["a"] }))
  })

  test("a ticket held back for an ended one's footprint is to start", () => {
    const snapshot = look({ tickets: tickets(["b", TicketPhase.HeldBack({ why: "overlap" })]) })
    expect(decide(snapshot)).toEqual(End.Busy())
    expect(decide({ ...snapshot, canTake: false })).toEqual(End.Done({ asked: false }))
  })

  test("a worker past its ticket limit is neither waited for nor waited on", () => {
    const snapshot = look({
      running: new Set(["a"]),
      tickets: tickets(["a", working]),
      asking: ["a"],
      overLimit: new Set(["a"]),
    })
    expect(decide(snapshot)).toEqual(End.Done({ asked: false }))
  })

  test("a conflict hand-back waits on you with a dashboard only", () => {
    const snapshot = look({
      tickets: tickets(["c", TicketPhase.Blocked({ why: Tag.mergeConflict }), true]),
    })
    expect(decide(snapshot)).toEqual(End.WaitOnYou({ tickets: ["c"] }))
    expect(decide({ ...snapshot, dashboard: false })).toEqual(End.Done({ asked: false }))
  })

  test("requests come oldest first, hand-backs after", () => {
    const snapshot = look({
      running: new Set(["a", "b"]),
      tickets: tickets(
        ["c", TicketPhase.Blocked({ why: Tag.mergeConflict }), true],
        ["a", working],
        ["b", working],
      ),
      asking: ["b", "a", "b"],
    })
    expect(decide(snapshot)).toEqual(End.WaitOnYou({ tickets: ["b", "a", "c"] }))
  })

  test("a merge under way as the look began has it look again", () => {
    expect(decide(look({ mergedBefore: false }))).toEqual(End.Busy())
  })

  test("with the usage-limit hold on, the run waits for the reset", () => {
    expect(decide(look({ usageHeld: true }))).toEqual(End.WaitForReset())
    expect(decide(look({ usageHeld: true, held: true }))).toEqual(End.Done({ asked: false }))
  })
})
