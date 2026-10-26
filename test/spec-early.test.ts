// A spec run starts on its environment ticket while the breakdown files the rest (§ 4.14,
// orchestra-qd9e.1): once file_root has filed the root epic and that ticket, specRun hands the run
// Early, the breakdown going on in the run's scope, its banner saying what it has filed; the run
// doesn't end while it files, and its end, or its failure, comes as `rest`. Without an environment
// ticket the run waits for the breakdown's end, as before.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, SubscriptionRef } from "effect"
import type { ToolAnswer } from "../src/agent/callbacks.ts"
import { exitCodes, noHolds, shownHolds, withFiling } from "../src/run/holds.ts"
import { decide, End, type Snapshot } from "../src/run/runEnd.ts"
import { SpecOutcome } from "../src/run/specRun.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { result, run, sessionState, tool, wait } from "../src/testing/AgentHost.ts"
import { breakdownInit, call, rootInput, scenario, ticket } from "./specScenario.ts"

/** The breakdown's banner while it files the rest, and once it is over. */
interface Seen {
  during: string | null
  after: string | null
}

/** What Early hands the run: the banner before and after the rest is filed, and how it ended. */
const following = (go: Deferred.Deferred<void>, seen: Seen) => (outcome: SpecOutcome) =>
  Effect.gen(function* () {
    if (outcome._tag !== "Early") return outcome
    seen.during = yield* SubscriptionRef.get(outcome.filing)
    yield* Deferred.succeed(go, undefined)
    const rest = yield* outcome.rest
    seen.after = yield* SubscriptionRef.get(outcome.filing)
    return rest
  })

describe("the early start", () => {
  test("the run starts on the environment ticket while the breakdown files the rest", async () => {
    const go = Effect.runSync(Deferred.make<void>())
    const seen: Seen = { during: null, after: null }
    const answers: Array<ToolAnswer> = []
    const rest = {
      root: "test-1",
      issues: [ticket({ key: "list", waits_for: ["test-1.1"] })],
    }
    const ran = await scenario({
      script: (recording) => [
        [
          wait,
          breakdownInit,
          sessionState("running"),
          ...tool(
            "mcp__tutti__file_root",
            rootInput,
            call(recording, "file_root", rootInput, answers),
          ),
          // The rest is filed only once the run has started on the environment ticket.
          run(Deferred.await(go)),
          ...tool(
            "mcp__tutti__file_breakdown",
            rest,
            call(recording, "file_breakdown", rest, answers),
          ),
          result("Done."),
          sessionState("idle"),
        ],
      ],
      early: following(go, seen),
    })
    expect(ran.outcome._tag).toBe("Early")
    if (ran.outcome._tag !== "Early") return
    expect(ran.outcome.root).toBe("test-1" as TicketId)
    expect(ran.outcome.environment).toBe("test-1.1" as TicketId)
    expect(seen.during).toBe("breaking the spec down: 1 epic, 1 ticket filed")
    expect(ran.early).toEqual(SpecOutcome.Run({ root: "test-1" as TicketId }))
    expect(seen.after).toBeNull()
    expect(ran.log).toContain(
      "SPEC: the run starts on test-1.1, the environment ticket, while the breakdown files the rest of test-1",
    )
    expect(ran.log).toContain("SPEC: broken down into test-1 (1 epic, 2 tickets)")
    expect(Bun.stripANSI(ran.out)).toContain(
      "◆ Starting on test-1.1, the environment ticket, while the breakdown files the rest",
    )
    expect(ran.issues.find((i) => i.id === "test-1")?.metadata.spec_sha256).toBeDefined()
  })

  test("a breakdown that fails after the run started ends as Stopped, which stops the run", async () => {
    const go = Effect.runSync(Deferred.make<void>())
    const seen: Seen = { during: null, after: null }
    const answers: Array<ToolAnswer> = []
    const ran = await scenario({
      script: (recording) => [
        [
          wait,
          breakdownInit,
          sessionState("running"),
          ...tool(
            "mcp__tutti__file_root",
            rootInput,
            call(recording, "file_root", rootInput, answers),
          ),
          run(Deferred.await(go)),
          result("No more."),
          sessionState("idle"),
          wait,
          sessionState("running"),
          result("Still no more."),
          sessionState("idle"),
        ],
      ],
      early: following(go, seen),
    })
    expect(ran.outcome._tag).toBe("Early")
    expect(ran.early).toEqual(SpecOutcome.Stopped({ exitCode: exitCodes.setup }))
    expect(seen.after).toBeNull()
    expect(ran.errors[0]).toBe(
      "tutti couldn't break the spec down: its turn ended without handing the tree to file_breakdown",
    )
  })

  test("without an environment ticket the run waits for the breakdown's end", async () => {
    const answers: Array<ToolAnswer> = []
    const plain = { ...rootInput, environment: undefined }
    const rest = { root: "test-1", issues: [ticket({ key: "list" })] }
    const ran = await scenario({
      script: (recording) => [
        [
          wait,
          breakdownInit,
          sessionState("running"),
          ...tool("mcp__tutti__file_root", plain, call(recording, "file_root", plain, answers)),
          ...tool(
            "mcp__tutti__file_breakdown",
            rest,
            call(recording, "file_breakdown", rest, answers),
          ),
          result("Done."),
          sessionState("idle"),
        ],
      ],
      early: (outcome) => Effect.succeed(outcome),
    })
    expect(ran.outcome).toEqual(SpecOutcome.Run({ root: "test-1" as TicketId }))
  })
})

describe("the run while the breakdown files", () => {
  const idle: Snapshot = {
    mergedBefore: true,
    running: new Set(),
    tickets: new Map(),
    overLimit: new Set(),
    asking: [],
    canTake: true,
    resuming: false,
    answering: false,
    settled: true,
    triagePending: 0,
    dashboard: true,
    held: false,
    usageHeld: false,
    endAsked: false,
  }

  test("doesn't end with nothing left, but waits for the rest", () => {
    expect(decide(idle)).toEqual(End.Done({ asked: false }))
    expect(decide({ ...idle, filing: true })).toEqual(End.Busy())
  })

  test("shows what the breakdown has filed as a banner, gone once it is over", () => {
    const filing = withFiling(noHolds, "breaking the spec down: 1 epic, 1 ticket filed")
    expect(shownHolds(filing).holds).toEqual([
      { word: "breaking the spec down: 1 epic, 1 ticket filed", resetsAt: null },
    ])
    expect(shownHolds(withFiling(filing, null)).holds).toEqual([])
    expect(withFiling(noHolds, null)).toBe(noHolds)
  })
})
