// The scheduler's pick (tutti-rvzn.18): a pure function of the tickets free to start, the solo
// ticket running, the tickets busy and whether a slot is free. schedule*.test.ts drive it through
// fills; these are its properties, without layers.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { soloLabel, soloLine } from "../src/run/holds.ts"
import { type PickFrom, pick } from "../src/run/schedule.ts"
import type { Issue } from "../src/services/Beads.ts"

const issue = (id: string, solo: boolean): Issue => ({
  id,
  title: id,
  description: "",
  design: "",
  acceptance: "",
  notes: "",
  status: "open",
  type: "task",
  assignee: "",
  labels: solo ? [soloLabel] : [],
  dependencies: [],
  metadata: {},
  files: [],
  predictedFiles: [],
  createdAt: "",
  closeReason: "",
})

// The free tickets, each solo or not, `t-0` first in line.
const freeTickets = fc
  .array(fc.boolean(), { maxLength: 6 })
  .map((solos) => solos.map((solo, i) => issue(`t-${i}`, solo)))

const pickFrom: fc.Arbitrary<PickFrom> = fc.record({
  free: freeTickets,
  solo: fc.option(fc.constant("solo-1"), { nil: null }),
  busy: fc.nat({ max: 4 }),
  slot: fc.boolean(),
})

describe("pick", () => {
  test("starts nothing while a solo ticket runs, and holds the free ones for it with a slot free", () => {
    fc.assert(
      fc.property(pickFrom, (p) => {
        const picked = pick({ ...p, solo: "solo-1", busy: Math.max(1, p.busy) })
        expect(picked.start).toBeUndefined()
        expect(picked.soloNext).toBeNull()
        expect(picked.soloFirst).toBeNull()
        expect(picked.heldSolo).toEqual(p.slot ? p.free.map((each) => each.id) : [])
        expect(picked.soloLine).toBe(p.slot && p.free.length > 0 ? soloLine("solo-1", false) : "")
      }),
    )
  })

  test("a solo ticket first in line waits for the busy ones, holding the others back", () => {
    fc.assert(
      fc.property(freeTickets, fc.integer({ min: 1, max: 4 }), (rest, busy) => {
        const first = issue("first", true)
        const free = [first, ...rest]
        const picked = pick({ free, solo: null, busy, slot: true })
        expect(picked.start).toBeUndefined()
        expect(picked.soloNext).toBe("first")
        expect(picked.soloFirst).toBe("first")
        expect(picked.soloLine).toBe(soloLine("first", true))
        expect(picked.heldSolo).toEqual(free.map((each) => each.id))
      }),
    )
  })

  test("with no slot free nothing is held for a solo ticket, and none is next", () => {
    fc.assert(
      fc.property(pickFrom, (p) => {
        const picked = pick({ ...p, slot: false })
        expect(picked.heldSolo).toEqual([])
        expect(picked.soloNext).toBeNull()
        expect(picked.soloLine).toBe("")
      }),
    )
  })

  test("a solo ticket first in line with every slot taken is still first, for the rechecks", () => {
    const picked = pick({ free: [issue("first", true)], solo: null, busy: 2, slot: false })
    expect(picked.soloFirst).toBe("first")
    expect(picked.soloNext).toBeNull()
    expect(picked.start).toBeUndefined()
  })

  test("with no solo ticket in the way, the first free ticket is picked", () => {
    fc.assert(
      fc.property(pickFrom, (p) => {
        const free = p.free
        const picked = pick({ ...p, solo: null })
        const first = free[0]
        if (first === undefined) {
          expect(picked.start).toBeUndefined()
        } else if (!first.labels.includes(soloLabel) || p.busy === 0) {
          expect(picked.start).toBe(first)
          expect(picked.heldSolo).toEqual([])
          expect(picked.soloLine).toBe("")
        }
      }),
    )
  })

  test("a solo ticket first in line starts once nothing is busy", () => {
    const first = issue("first", true)
    const picked = pick({ free: [first, issue("t-1", false)], solo: null, busy: 0, slot: true })
    expect(picked.start).toBe(first)
    expect(picked.soloFirst).toBeNull()
    expect(picked.heldSolo).toEqual([])
  })
})
