import { describe, expect, test } from "bun:test"
import {
  type Gate,
  holds,
  noMoreWork,
  openGate,
  stopFor,
  takesBack,
  takesNew,
} from "../src/run/holds.ts"

const paused = stopFor("PAUSED", "paused for a reason")

/** Each gate, and what each predicate answers of it. */
const table: ReadonlyArray<{
  readonly name: string
  readonly gate: Gate
  readonly holds: boolean
  readonly takesBack: boolean
  readonly takesNew: boolean
  readonly noMoreWork: string | undefined
}> = [
  {
    name: "nothing holds it",
    gate: openGate,
    holds: false,
    takesBack: true,
    takesNew: true,
    noMoreWork: undefined,
  },
  {
    name: "a stop",
    gate: { ...openGate, stop: paused },
    holds: true,
    takesBack: false,
    takesNew: false,
    noMoreWork: "the run holds (PAUSED: paused for a reason)",
  },
  {
    name: "the usage limit",
    gate: { ...openGate, usageHeld: true },
    holds: true,
    takesBack: false,
    takesNew: false,
    noMoreWork: "the run holds (USAGE_LIMIT)",
  },
  {
    name: "the run's end",
    gate: { ...openGate, ended: true },
    holds: true,
    takesBack: false,
    takesNew: false,
    noMoreWork: undefined,
  },
  {
    name: "a wind-down",
    gate: { ...openGate, windingDown: true },
    holds: false,
    takesBack: false,
    takesNew: false,
    noMoreWork: "the run is winding down",
  },
  {
    name: "--limit reached",
    gate: { ...openGate, limitReached: true },
    holds: false,
    takesBack: true,
    takesNew: false,
    noMoreWork: undefined,
  },
  {
    name: "a stop over the usage limit and a wind-down",
    gate: { ...openGate, stop: paused, usageHeld: true, windingDown: true },
    holds: true,
    takesBack: false,
    takesNew: false,
    noMoreWork: "the run holds (PAUSED: paused for a reason)",
  },
  {
    name: "the usage limit over a wind-down",
    gate: { ...openGate, usageHeld: true, windingDown: true },
    holds: true,
    takesBack: false,
    takesNew: false,
    noMoreWork: "the run holds (USAGE_LIMIT)",
  },
]

describe("the run's gate", () => {
  for (const row of table) {
    test(`${row.name}: holds ${row.holds}, takes back ${row.takesBack}, takes new ${row.takesNew}`, () => {
      expect({
        holds: holds(row.gate),
        takesBack: takesBack(row.gate),
        takesNew: takesNew(row.gate),
        noMoreWork: noMoreWork(row.gate),
      }).toEqual({
        holds: row.holds,
        takesBack: row.takesBack,
        takesNew: row.takesNew,
        noMoreWork: row.noMoreWork,
      })
    })
  }
})
