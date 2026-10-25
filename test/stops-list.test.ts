// The run's stops as one list in the order raised (holds.ts): the first decides the exit code and
// leads the closing line, a stop put first goes before them, and a change that changes nothing
// leaves the holds as they were, so that the dashboard isn't drawn again for it.

import { describe, expect, test } from "bun:test"
import * as fc from "fast-check"
import {
  addStop,
  changeStops,
  exitCodeOf,
  extendFirst,
  firstStop,
  liftBlocked,
  noHolds,
  noStops,
  putFirst,
  raiseStop,
  type StopReason,
  type Stops,
  stopFor,
  stopsLine,
  swapStop,
} from "../src/run/holds.ts"
import type { TicketId } from "../src/services/Beads.ts"

const paused = stopFor("PAUSED", "the worker paused", { ticket: "t-1" as TicketId })
const dirty = stopFor("DIRTY_TREE", "uncommitted changes in /repo")
const quit = stopFor("INTERRUPTED", "you quit")

describe("the stops as a list", () => {
  test("the first raised decides the exit code and leads the line", () => {
    const stops = addStop(addStop(noStops, dirty), paused)
    expect(firstStop(stops)).toBe(dirty)
    expect(exitCodeOf(stops)).toBe(5)
    expect(String(stopsLine(stops))).toBe(
      "DIRTY_TREE: uncommitted changes in /repo; also PAUSED: the worker paused",
    )
    expect(firstStop(noStops)).toBeNull()
    expect(exitCodeOf(noStops)).toBe(0)
  })

  test("a stop put first goes before those raised, which keep their order", () => {
    expect(putFirst(addStop(addStop(noStops, dirty), paused), quit)).toEqual([quit, dirty, paused])
    expect(putFirst(noStops, quit)).toEqual([quit])
  })

  test("the first's line takes the parts added to it; none, or no stop, leaves it", () => {
    const stops = addStop(addStop(noStops, dirty), paused)
    const [first, second] = extendFirst(stops, ["t-2 never handed back"])
    expect(String(first?.text)).toBe(
      "DIRTY_TREE: uncommitted changes in /repo; t-2 never handed back",
    )
    expect(second).toBe(paused)
    expect(extendFirst(stops, [])).toBe(stops)
    expect(extendFirst(noStops, ["a part"])).toBe(noStops)
  })

  test("a swap of a stop not among them, or a lift of none, changes nothing", () => {
    const holds = raiseStop(noHolds, dirty)
    expect(changeStops(holds, (stops) => swapStop(stops, paused, null))).toBe(holds)
    expect(liftBlocked(holds, "t-1" as TicketId)).toBe(holds)
  })

  test("a swap keeps the others in their places, whatever stops are raised", () => {
    const stop = fc.constantFrom<StopReason>(paused, dirty, quit)
    fc.assert(
      fc.property(fc.array(stop, { maxLength: 6 }), (raised) => {
        const stops: Stops = raised.reduce(addStop, noStops)
        const swapped = swapStop(stops, dirty, quit)
        expect(swapped).toHaveLength(stops.length)
        expect(swapped).toEqual(stops.map((each) => (each === dirty ? quit : each)))
        const lifted = swapStop(stops, dirty, null)
        expect(lifted).toEqual(stops.filter((each) => each !== dirty))
      }),
    )
  })
})
