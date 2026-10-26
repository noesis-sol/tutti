// What a spec's breakdown spent (§ 4.14, § 10): its session's cost, turns, time and ID logged as
// it ends, `SPEC: breakdown $1.2500 in 30 turns, 14m2s, session <id>` as orchestra logs it, or
// that its session gave no result; its turns recorded as the workers' are, so the run's end record
// counts them.
import { describe, expect, test } from "bun:test"
import { breakdownWorker } from "../src/agent/breakdown.ts"
import type { ToolAnswer } from "../src/agent/callbacks.ts"
import { exitCodes } from "../src/run/holds.ts"
import { SpecOutcome, spentLine } from "../src/run/specRun.ts"
import { nothingSpent } from "../src/run/spending.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { result, Step, sessionState, tool, wait } from "../src/testing/AgentHost.ts"
import { breakdownInit, type Calls, call, rootInput, scenario, ticket } from "./specScenario.ts"

/** A turn calling the breakdown's tool `name` with `input`, its result giving `fields`. */
const costedTurn = (
  recording: Calls,
  name: string,
  input: Record<string, unknown>,
  answers: Array<ToolAnswer>,
  fields: object,
) => [
  sessionState("running"),
  ...tool(`mcp__tutti__${name}`, input, call(recording, name, input, answers)),
  result("Done.", fields),
  sessionState("idle"),
]

const sessionOf = (sent: Awaited<ReturnType<typeof scenario>>["sent"]): string => {
  const started = sent.find((s) => s._tag === "Started")
  if (started?._tag !== "Started") throw new Error("no breakdown session started")
  return started.session.sessionId
}

describe("the breakdown's spending", () => {
  test("is logged as it ends: its cost, turns, time and session, before what was filed", async () => {
    const answers: Array<ToolAnswer> = []
    const breakdown = {
      root: "test-1",
      issues: [ticket({ key: "list", waits_for: ["test-1.1"], files: ["src/list.ts"] })],
    }
    const ran = await scenario({
      script: (recording) => [
        [
          wait,
          breakdownInit,
          // Each result gives the session's running totals: the second's cost is the whole's.
          ...costedTurn(recording, "file_root", rootInput, answers, {
            total_cost_usd: 0.5,
            num_turns: 10,
          }),
          wait,
          ...costedTurn(recording, "file_breakdown", breakdown, answers, {
            total_cost_usd: 1.25,
            num_turns: 20,
          }),
        ],
      ],
    })
    expect(ran.outcome).toEqual(SpecOutcome.Run({ root: "test-1" as TicketId }))
    const session = sessionOf(ran.sent)
    const at = ran.log.findIndex((text) => text.startsWith("SPEC: breakdown "))
    expect(ran.log[at]).toMatch(
      new RegExp(`^SPEC: breakdown \\$1\\.2500 in 30 turns, \\d+s, session ${session}$`),
    )
    expect(ran.log[at + 1]).toStartWith("SPEC: filed 1 issue from the breakdown's answer")

    // Its turns are recorded as a worker's, and the run's end counts them.
    const turns = ran.records.filter((r) => r.kind === "turn")
    expect(turns.map((r) => (r.kind === "turn" ? [r.ticket, r.cost_usd, r.turns] : []))).toEqual([
      [breakdownWorker, 0.5, 10],
      [breakdownWorker, 0.75, 20],
    ])
    expect(ran.end).toMatchObject({ kind: "end", cost_usd: 1.25 })
  })

  test("a session gone before any result is logged as having given none", async () => {
    const ran = await scenario({
      script: () => [[wait, breakdownInit, Step.Gone({ why: "it crashed" })]],
    })
    expect(ran.outcome).toEqual(SpecOutcome.Stopped({ exitCode: exitCodes.setup }))
    const session = sessionOf(ran.sent)
    const at = ran.log.findIndex((text) => text.startsWith("SPEC: claude session "))
    expect(ran.log[at]).toMatch(
      new RegExp(`^SPEC: claude session ${session} gave no result \\(\\d+s\\)$`),
    )
    expect(ran.log[at + 1]).toMatch(/^SPEC: the breakdown failed: .*it crashed.* \(\d+s\)$/)
    expect(ran.end).not.toHaveProperty("cost_usd")
  })

  test("a turn, singular, and an ID that would break the line", () => {
    const spent = { ...nothingSpent, costUsd: 0.01234, turns: 1, results: 1 }
    expect(spentLine(spent, "4s", "sess-1")).toBe(
      "SPEC: breakdown $0.0123 in 1 turn, 4s, session sess-1",
    )
    expect(spentLine(nothingSpent, "1m02s", "a\nb")).not.toContain("\n")
  })
})
