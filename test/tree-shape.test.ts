// The shape of an epic's open tickets (src/plan/shape.ts), as orchestra v0.9.5's: its longest chain
// of blocks links, its hubs, how many tickets its links let run at a time, and the warning of a
// narrow tree a spec's breakdown gives.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import type { Link } from "../src/plan/plan.ts"
import { formatWidth, narrowWarning, shapeLine, shapeOf, widthOf } from "../src/plan/shape.ts"
import type { Issue, TicketId } from "../src/services/Beads.ts"

const issue = (id: string, fields: Partial<Issue> = {}): Issue => ({
  id: id as TicketId,
  title: id,
  description: "",
  design: "",
  acceptance: "",
  notes: "",
  status: "open",
  type: "task",
  assignee: "",
  labels: [],
  dependencies: [],
  metadata: {},
  files: [],
  predictedFiles: [],
  createdAt: "",
  closeReason: "",
  ...fields,
})

/** `blocked` waits for `blocker`. */
const link = (blocker: string, blocked: string): Link => ({
  blocker: blocker as TicketId,
  blocked: blocked as TicketId,
  why: "",
})

const epic = "tutti-e" as TicketId
const ids = (n: number) => Array.from({ length: n }, (_, i) => `tutti-e.${i + 1}`)

describe("shapeOf", () => {
  test("finds the longest chain, first blocker first, and the hubs, the most held first", () => {
    // e.1 holds e.2, e.3, e.4 and e.5; e.2 holds e.6, e.7, e.8; e.6 holds e.9.
    const shape = shapeOf(
      epic,
      ids(9).map((id) => issue(id)),
      [
        link("tutti-e.1", "tutti-e.2"),
        link("tutti-e.1", "tutti-e.3"),
        link("tutti-e.1", "tutti-e.4"),
        link("tutti-e.1", "tutti-e.5"),
        link("tutti-e.2", "tutti-e.6"),
        link("tutti-e.2", "tutti-e.7"),
        link("tutti-e.2", "tutti-e.8"),
        link("tutti-e.6", "tutti-e.9"),
      ],
    )
    expect(shape.tickets).toBe(9)
    expect(shape.chain).toEqual(["tutti-e.1", "tutti-e.2", "tutti-e.6", "tutti-e.9"] as never)
    expect(shape.hubs).toEqual([
      { id: "tutti-e.1" as TicketId, holds: 4 },
      { id: "tutti-e.2" as TicketId, holds: 3 },
    ])
    expect(widthOf(shape)).toBe(2.25)
  })

  test("leaves out epics, closed tickets, links outside them and links given twice", () => {
    const shape = shapeOf(
      epic,
      [
        issue("tutti-e.1"),
        issue("tutti-e.2"),
        issue("tutti-e.3", { status: "closed" }),
        issue("tutti-e.4", { type: "epic" }),
      ],
      [
        link("tutti-e.1", "tutti-e.2"),
        link("tutti-e.1", "tutti-e.2"),
        link("tutti-e.2", "tutti-e.3"),
        link("tutti-e.4", "tutti-e.1"),
        link("other-1", "tutti-e.1"),
        link("tutti-e.2", "tutti-e.2"),
      ],
    )
    expect(shape.tickets).toBe(2)
    expect(shape.chain).toEqual(["tutti-e.1", "tutti-e.2"] as never)
    expect(shape.hubs).toEqual([])
  })

  test("follows a blocks cycle once round rather than loop", () => {
    const shape = shapeOf(
      epic,
      ids(3).map((id) => issue(id)),
      [
        link("tutti-e.1", "tutti-e.2"),
        link("tutti-e.2", "tutti-e.3"),
        link("tutti-e.3", "tutti-e.1"),
      ],
    )
    expect(shape.chain).toEqual(["tutti-e.1", "tutti-e.2", "tutti-e.3"] as never)
  })

  test("of no tickets: no chain, width 0", () => {
    const shape = shapeOf(epic, [issue("tutti-e.1", { status: "closed" })], [])
    expect(shape).toEqual({ epic, tickets: 0, chain: [], hubs: [] })
    expect(widthOf(shape)).toBe(0)
  })

  test("the chain is a path of distinct open tickets along the links, none longer", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 12 }),
        fc.array(fc.tuple(fc.nat(13), fc.nat(13))),
        (n, pairs) => {
          const tickets = ids(n)
          const links = pairs.map(([a, b]) => link(`tutti-e.${a + 1}`, `tutti-e.${b + 1}`))
          const shape = shapeOf(
            epic,
            tickets.map((id) => issue(id)),
            links,
          )
          expect(shape.tickets).toBe(n)
          expect(new Set(shape.chain).size).toBe(shape.chain.length)
          expect(shape.chain.length).toBeLessThanOrEqual(n)
          if (n > 0) expect(shape.chain.length).toBeGreaterThanOrEqual(1)
          const linked = new Set(links.map((l) => `${l.blocker} ${l.blocked}`))
          for (let i = 1; i < shape.chain.length; i++) {
            expect(linked.has(`${shape.chain[i - 1]} ${shape.chain[i]}`)).toBe(true)
          }
          for (const hub of shape.hubs) expect(hub.holds).toBeGreaterThanOrEqual(3)
        },
      ),
    )
  })
})

describe("shapeLine", () => {
  test("names the chain without the project's prefix, the width and the hubs", () => {
    const shape = shapeOf(
      epic,
      ids(7).map((id) => issue(id)),
      [
        link("tutti-e.1", "tutti-e.3"),
        link("tutti-e.1", "tutti-e.4"),
        link("tutti-e.1", "tutti-e.5"),
        link("tutti-e.1", "tutti-e.6"),
      ],
    )
    expect(shapeLine(shape)).toBe(
      "tutti-e: 7 tickets, longest chain 2 (e.1 > e.3), at most 3.5 at a time; tutti-e.1 holds 4",
    )
  })

  test("says 1 ticket, and no hubs where there are none", () => {
    expect(shapeLine(shapeOf(epic, [issue("tutti-e.1")], []))).toBe(
      "tutti-e: 1 ticket, longest chain 1 (e.1), at most 1 at a time",
    )
  })

  test("gives the width to one decimal, without a trailing .0", () => {
    expect([formatWidth(7), formatWidth(3.5), formatWidth(10 / 3), formatWidth(2.96)]).toEqual([
      "7",
      "3.5",
      "3.3",
      "3",
    ])
  })
})

describe("narrowWarning", () => {
  const chain = (n: number) =>
    shapeOf(
      epic,
      ids(n).map((id) => issue(id)),
      ids(n)
        .slice(1)
        .map((id, i) => link(`tutti-e.${i + 1}`, id)),
    )

  test("warns of a chain over three, naming it", () => {
    expect(narrowWarning(chain(4), 1)).toBe(
      "a narrow ticket tree, its longest chain over 3: tutti-e: 4 tickets, longest chain 4 (e.1 > e.2 > e.3 > e.4), at most 1 at a time. A ticket needs a blocks link only to one whose code it builds on, so that the rest run side by side",
    )
  })

  test("warns of fewer tickets at a time than the run's concurrency, or its tickets if fewer", () => {
    expect(narrowWarning(chain(3), 2)).toStartWith(
      "a narrow ticket tree, fewer than the run's 2 tickets at a time: tutti-e: 3 tickets, longest chain 3",
    )
    expect(narrowWarning(chain(5), 4)).toStartWith(
      "a narrow ticket tree, its longest chain over 3 and fewer than the run's 4 tickets at a time:",
    )
    // Two tickets side by side under a run of four run as wide as they can.
    expect(narrowWarning(chain(1), 4)).toBeNull()
    expect(narrowWarning(shapeOf(epic, [issue("tutti-e.1"), issue("tutti-e.2")], []), 4)).toBeNull()
  })

  test("gives none for a wide tree, a short chain at concurrency 1, or no tickets", () => {
    // Eight tickets, a chain of 2: four at a time.
    const wide = shapeOf(
      epic,
      ids(8).map((id) => issue(id)),
      [link("tutti-e.1", "tutti-e.2"), link("tutti-e.3", "tutti-e.4")],
    )
    expect(narrowWarning(wide, 4)).toBeNull()
    expect(narrowWarning(chain(3), 1)).toBeNull()
    expect(narrowWarning(shapeOf(epic, [], []), 4)).toBeNull()
  })
})
