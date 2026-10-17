// The reviewer's per-ticket tallies (§ 4.5, § 6.2): Attention's requests by kind and their answers,
// the calls a rule allowed for this run allowed, the calls Claude Code denied without asking by
// type, and the ledger's messages and compactions, in one line per ticket.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { emptyTally, type Tally } from "../src/agent/Attention.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import * as log from "../src/run/log.ts"
import { attentionSaid, talliesLine } from "../src/run/report.ts"

const entry: Entry = {
  ticket: "t-1",
  title: "x",
  phase: { _tag: "Working", activity: "working" } as Entry["phase"],
  since: 0,
  worker: 1,
  row: 0,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
}

const tally = (over: Partial<Tally>): Tally => ({ ...emptyTally, ...over })

describe("a ticket's tallies line", () => {
  test("says none when nothing was counted", () => {
    expect(talliesLine(entry, emptyTally, false)).toBe(
      "t-1 (Working): no attention requests, denials or messages; not steered.",
    )
  })

  test("has every request kind, answer, rule allow and denial type", () => {
    const all = tally({
      permissions: 4,
      questions: 1,
      elicitations: 2,
      allowed: 1,
      allowedForRun: 1,
      answered: 2,
      denied: 1,
      declined: 1,
      cancelled: 1,
      allowedByRule: 2,
      deniedBy: { unknown: 1, rule: 1, mode: 1, safetyCheck: 2, classifier: 1, autoDeny: 1 },
    })
    expect(talliesLine({ ...entry, tallies: { messages: 1, compactions: 2 } }, all, true)).toBe(
      "t-1 (Working): 7 attention requests (4 permissions, 1 question, 2 elicitations), " +
        "1 allowed, 1 allowed for this run, 2 answered, 1 denied by you, 1 declined, 1 withdrawn, " +
        "2 calls allowed by a rule you allowed for this run, " +
        "7 calls Claude Code denied without asking (1 by the classifier, 2 by the safety check, " +
        "1 by the permission mode, 1 by a rule, 1 by autoDeny, 1 by Claude Code), " +
        "1 of your messages, compacted twice; steered by you.",
    )
  })

  test("says one of each in the singular", () => {
    expect(
      attentionSaid(tally({ permissions: 1, allowedByRule: 1, deniedBy: { classifier: 1 } })),
    ).toEqual([
      "1 attention request (1 permission)",
      "1 call allowed by a rule you allowed for this run",
      "1 call Claude Code denied without asking (1 by the classifier)",
    ])
  })

  test("counts every denial once, whatever its type is named", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.nat(50)), (deniedBy) => {
        const said = attentionSaid(tally({ deniedBy }))
        const total = Object.values(deniedBy).reduce((sum, n) => sum + n, 0)
        if (total === 0) return said.length === 0
        const line = said[0] ?? ""
        return (
          said.length === 1 &&
          line.startsWith(`${total} call`) &&
          Object.entries(deniedBy).every(
            ([by, n]) => n === 0 || line.includes(`${n} by ${log.denier(by)}`),
          )
        )
      }),
    )
  })
})
