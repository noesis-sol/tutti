// What holds the run is one value (holds.ts's RunHolds): its stops, BLOCKED among them once per
// ticket, the tickets past --ticket-limit, the machine's hold and the usage limit's view;
// `· stopping`, the banners and the usage line are what it shows.
import { describe, expect, test } from "bun:test"
import * as fc from "fast-check"
import {
  blockedStop,
  blockedTickets,
  changeStops,
  extendFirst,
  liftBlocked,
  noHolds,
  pastTicketLimit,
  putFirst,
  type RunHolds,
  raiseStop,
  shownHolds,
  showUsage,
  stopFor,
  stopsLine,
  ticketLimitStop,
  withMachineHold,
} from "../src/run/holds.ts"
import type { UsageView } from "../src/run/usageLimit.ts"

const usageHeld: UsageView = {
  usage: { utilization: 1, resetsAt: 1_000 },
  hold: { word: "USAGE_LIMIT", resetsAt: 1_000 },
  notice: "usage limit (five-hour) · resets 14:05",
}

const usageFree: UsageView = {
  usage: { utilization: 0.4, resetsAt: 1_000 },
  hold: null,
  notice: null,
}

const words = (holds: RunHolds) => shownHolds(holds).holds.map((each) => each.word)

describe("RunHolds", () => {
  test("nothing holds a fresh run", () => {
    expect(shownHolds(noHolds)).toEqual({ stopping: false, holds: [], usage: null, notice: null })
    expect(blockedTickets(noHolds).size).toBe(0)
  })

  test("BLOCKED is a stop, shown as one banner however many tickets it holds", () => {
    const held = raiseStop(
      raiseStop(noHolds, blockedStop("a", "a question")),
      blockedStop("b", "x"),
    )
    expect([...blockedTickets(held)]).toEqual(["a", "b"])
    expect(shownHolds(held).stopping).toBe(true)
    expect(words(held)).toEqual(["BLOCKED"])
  })

  test("lifting one ticket's BLOCKED is one call, and keeps the stops beside it", () => {
    const paused = stopFor("PAUSED", "t-3 paused")
    const held = [blockedStop("a", "q"), paused, blockedStop("b", "q")].reduce(raiseStop, noHolds)
    const lifted = liftBlocked(held, "a")
    expect([...blockedTickets(lifted)]).toEqual(["b"])
    expect(lifted.stops[0]).toBe(paused)
    expect(words(lifted)).toEqual(["BLOCKED"])
    const none = liftBlocked(lifted, "b")
    expect(blockedTickets(none).size).toBe(0)
    expect(words(none)).toEqual([])
    expect(shownHolds(none).stopping).toBe(true)
  })

  test("a worker past its ticket limit raises its stop and counts over the limit", () => {
    const stop = ticketLimitStop({ id: "t-1", limit: "2h", worktree: "/w/t-1" })
    const over = pastTicketLimit(noHolds, "t-1", stop)
    expect([...over.overLimit]).toEqual(["t-1"])
    expect(over.stops[0]).toBe(stop)
    expect(shownHolds(over).stopping).toBe(true)
    expect(words(over)).toEqual([])
  })

  test("the machine's hold and the usage limit's show as banners, without stopping the run", () => {
    const held = showUsage(withMachineHold(noHolds, true), usageHeld)
    expect(shownHolds(held)).toEqual({
      stopping: false,
      holds: [
        { word: "USAGE_LIMIT", resetsAt: 1_000 },
        { word: "MACHINE", resetsAt: null },
      ],
      usage: usageHeld.usage,
      notice: usageHeld.notice,
    })
    const blocked = raiseStop(held, blockedStop("a", "q"))
    expect(words(blocked)).toEqual(["BLOCKED", "USAGE_LIMIT", "MACHINE"])
    const free = showUsage(withMachineHold(blocked, false), usageFree)
    expect(shownHolds(free)).toEqual({
      stopping: true,
      holds: [{ word: "BLOCKED", resetsAt: null }],
      usage: usageFree.usage,
      notice: null,
    })
  })

  test("a change that changes nothing gives the same holds", () => {
    expect(withMachineHold(noHolds, false)).toBe(noHolds)
    expect(changeStops(noHolds, (stops) => extendFirst(stops, ["t-1 never handed back"]))).toBe(
      noHolds,
    )
  })

  test("quitting's stop goes first, and the run's end adds to its line", () => {
    const blocked = raiseStop(noHolds, blockedStop("a", "q"))
    const quit = stopFor("INTERRUPTED", "quit")
    const ended = changeStops(
      changeStops(blocked, (stops) => putFirst(stops, quit)),
      (stops) => extendFirst(stops, ["t-1 never handed back", "t-2 too"]),
    )
    expect(ended.stops[0]?.why).toBe("INTERRUPTED")
    expect<string>(stopsLine(ended.stops)).toBe(
      "INTERRUPTED: quit; t-1 never handed back; t-2 too; also BLOCKED >4min: a needs you: q",
    )
    expect([...blockedTickets(ended)]).toEqual(["a"])
  })

  // The holds, after any run of changes as run.ts makes them, against a model of what each keeps.
  test("BLOCKED is recorded once per ticket, and the banners follow the holds", () => {
    const tickets = fc.constantFrom("a", "b", "c")
    const change = fc.oneof(
      fc.record({ kind: fc.constant("trip" as const), ticket: tickets }),
      fc.record({ kind: fc.constant("lift" as const), ticket: tickets }),
      fc.record({ kind: fc.constant("limit" as const), ticket: tickets }),
      fc.record({ kind: fc.constant("machine" as const), full: fc.boolean() }),
      fc.record({ kind: fc.constant("usage" as const), held: fc.boolean() }),
      fc.record({ kind: fc.constant("paused" as const) }),
    )
    fc.assert(
      fc.property(fc.array(change, { maxLength: 30 }), (changes) => {
        let holds = noHolds
        const blocked = new Set<string>()
        const over = new Set<string>()
        let others = 0
        let machine = false
        let usage = false
        for (const each of changes) {
          switch (each.kind) {
            case "trip":
              // As blockedAt trips only a ticket not held yet.
              if (blockedTickets(holds).has(each.ticket)) break
              holds = raiseStop(holds, blockedStop(each.ticket, "q"))
              blocked.add(each.ticket)
              break
            case "lift":
              holds = liftBlocked(holds, each.ticket)
              blocked.delete(each.ticket)
              break
            case "limit":
              holds = pastTicketLimit(
                holds,
                each.ticket,
                ticketLimitStop({ id: each.ticket, limit: "2h", worktree: "/w" }),
              )
              over.add(each.ticket)
              others++
              break
            case "machine":
              holds = withMachineHold(holds, each.full)
              machine = each.full
              break
            case "usage":
              holds = showUsage(holds, each.held ? usageHeld : usageFree)
              usage = each.held
              break
            case "paused":
              holds = raiseStop(holds, stopFor("PAUSED", "paused"))
              others++
          }
        }
        const blocks = holds.stops
          .filter((stop) => stop.why === "BLOCKED")
          .map((stop) => stop.ticket)
        expect(blocks.length).toBe(new Set(blocks).size)
        expect(new Set(blocks)).toEqual(blocked)
        expect(blockedTickets(holds)).toEqual(blocked)
        expect(holds.stops.length).toBe(blocked.size + others)
        expect(holds.overLimit).toEqual(over)
        const shown = shownHolds(holds)
        expect(shown.stopping).toBe(holds.stops.length > 0)
        expect(shown.holds.map((hold) => hold.word)).toEqual([
          ...(blocked.size > 0 ? ["BLOCKED"] : []),
          ...(usage ? ["USAGE_LIMIT"] : []),
          ...(machine ? ["MACHINE"] : []),
        ])
        expect(shown.notice).toBe(usage ? usageHeld.notice : null)
      }),
    )
  })
})
