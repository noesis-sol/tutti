import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import fc from "fast-check"
import { countsUnder, Move, TicketPhase, transition, WaitFor, waitShown } from "../src/run/phase.ts"
import { phaseSaid } from "../src/run/report.ts"

const waiting = (wait: WaitFor) => TicketPhase.Waiting({ for: wait })

describe("what a Waiting ticket waits for", () => {
  test("a blocker named setup or probe is a blocker, not the setup or the probe", () => {
    for (const id of ["setup", "probe", "setup problem"]) {
      const phase = waiting(WaitFor.Blockers({ ids: [id] }))
      expect(countsUnder(phase)).toEqual([])
      expect(phaseSaid(phase)).toBe(`Waiting (back in the queue until ${id} merges)`)
    }
    expect(countsUnder(waiting(WaitFor.Setup()))).toEqual(["setupFailed"])
  })

  test("its worker's blockers, each of them", () => {
    const moved = transition(
      TicketPhase.Working(),
      Move.WaitsForMerge({ blockers: ["tut-b1", "tut-b2"] }),
    )
    expect(Result.isSuccess(moved) && moved.success).toEqual(
      waiting(WaitFor.Blockers({ ids: ["tut-b1", "tut-b2"] })),
    )
  })

  test("the event stream's why: the blockers' IDs, or setup, probe or setup problem", () => {
    expect(waitShown(WaitFor.Blockers({ ids: ["a", "b"] }))).toBe("a, b")
    expect(waitShown(WaitFor.Setup())).toBe("setup")
    expect(waitShown(WaitFor.Probe())).toBe("probe")
    expect(waitShown(WaitFor.SetupProblem())).toBe("setup problem")
  })

  test("the reviewer reads what each waits for", () => {
    expect(phaseSaid(waiting(WaitFor.Setup()))).toBe(
      "Waiting (its worktree's setup failed; back in the queue until a ticket merges or a probe passes)",
    )
    expect(phaseSaid(waiting(WaitFor.Probe()))).toBe(
      "Waiting (back in the queue until the environment probe passes)",
    )
    expect(phaseSaid(waiting(WaitFor.SetupProblem()))).toBe(
      "Waiting (a setup problem stopped its worker; back in the next run)",
    )
  })

  test("any list of blockers is shown as their IDs", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (ids) => {
        expect(waitShown(WaitFor.Blockers({ ids }))).toBe(ids.join(", "))
      }),
    )
  })
})
