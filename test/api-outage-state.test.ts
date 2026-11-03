// A turn failing as Claude's API is unavailable (§ 4.2, WorkerState's apiOutage): ApiUnavailable,
// never settled, for a 5xx or 529 result, an assistant message saying `overloaded` or
// `server_error`, or a result with no status after retries of no response; Failed for the turn's
// own errors (a 4xx, no status without retries, an interrupt). Then the hold's backoff and gate.
import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Duration } from "effect"
import fc from "fast-check"
import { read } from "../src/agent/reading.ts"
import {
  apiOutage,
  initial,
  settled,
  step,
  type Worker,
  WorkerEvent,
  WorkerState,
  waitsForHold,
} from "../src/agent/WorkerState.ts"
import { probeAfter, probeEveryMost } from "../src/run/apiOutage.ts"
import { holds, noHolds, openGate, shownHolds, takesNew, withApiHold } from "../src/run/holds.ts"
import { activityOf, stateStatus } from "../src/run/runView.ts"

const sdk = (message: object): WorkerEvent =>
  WorkerEvent.Message({ session: "s", reading: read(message as unknown as SDKMessage) })
const init = sdk({ type: "system", subtype: "init", permissionMode: "auto", session_id: "s" })
const idle = sdk({ type: "system", subtype: "session_state_changed", state: "idle" })
const failed = (status: number | null, text = `API Error: ${status}`) =>
  sdk({
    type: "result",
    subtype: "success",
    is_error: true,
    result: text,
    api_error_status: status,
    num_turns: 1,
  })
const clean = sdk({ type: "result", subtype: "success", is_error: false, result: "DONE" })
const interrupted = sdk({
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  errors: [],
  num_turns: 1,
})
const retry = (status: number | null) =>
  sdk({
    type: "system",
    subtype: "api_retry",
    attempt: 1,
    max_retries: 10,
    retry_delay_ms: 500,
    error_status: status,
    error: "unknown",
  })
const assistant = (error: string) =>
  sdk({ type: "assistant", message: { content: [] }, parent_tool_use_id: null, error })

/** The worker after `events`, the nth at time n. */
const fold = (events: ReadonlyArray<WorkerEvent>, worker: Worker = initial()): Worker =>
  events.reduce((w, event, n) => step(w, event, n), worker)
const stateAfter = (...events: ReadonlyArray<WorkerEvent>): WorkerState => fold(events).state

describe("ApiUnavailable", () => {
  test("a 529 after the retries: ApiUnavailable, not settled, from when it came", () => {
    const state = stateAfter(init, retry(529), retry(529), failed(529, "Overloaded"), idle)
    expect(state).toEqual(WorkerState.ApiUnavailable({ at: 3, error: "Overloaded", status: 529 }))
    expect(settled(state)).toBe(false)
    expect(waitsForHold(state)).toBe(true)
  })

  test("a 500 or a 503 is one too, with or without retries before it", () => {
    expect(stateAfter(init, failed(500), idle)._tag).toBe("ApiUnavailable")
    expect(stateAfter(init, retry(503), failed(503), idle)._tag).toBe("ApiUnavailable")
  })

  test("no status after retries of no response is a connection error: ApiUnavailable", () => {
    const state = stateAfter(init, retry(null), failed(null, "Connection error."), idle)
    expect(state).toEqual(
      WorkerState.ApiUnavailable({ at: 2, error: "Connection error.", status: null }),
    )
  })

  test("no status with an assistant message saying overloaded or server_error", () => {
    expect(stateAfter(init, assistant("overloaded"), failed(null), idle)._tag).toBe(
      "ApiUnavailable",
    )
    expect(stateAfter(init, assistant("server_error"), failed(null), idle)._tag).toBe(
      "ApiUnavailable",
    )
  })

  test("it is so before idle and with a send outstanding: it waits, not works", () => {
    expect(stateAfter(init, failed(529))._tag).toBe("ApiUnavailable")
    const told = WorkerEvent.Sent({ session: "s", uuid: "u-1" })
    expect(stateAfter(init, failed(529), idle, told)._tag).toBe("ApiUnavailable")
  })

  test("its time is kept while it waits, and its next turn ending clean is Idle", () => {
    const waiting = fold([init, failed(529), idle, idle])
    expect(waiting.state).toMatchObject({ _tag: "ApiUnavailable", at: 1 })
    expect(fold([init, clean, idle], waiting).state._tag).toBe("Idle")
  })

  test("the turn's own errors are Failed: a 4xx, no status without retries, an interrupt", () => {
    expect(stateAfter(init, failed(400), idle)._tag).toBe("Failed")
    expect(stateAfter(init, retry(529), failed(400), idle)._tag).toBe("Failed")
    expect(stateAfter(init, failed(null, "billing"), idle)._tag).toBe("Failed")
    expect(stateAfter(init, retry(529), interrupted, idle)._tag).toBe("Failed")
    // Retries of a 4xx and no status after them: not the API's.
    expect(stateAfter(init, retry(408), failed(null), idle)._tag).toBe("Failed")
  })

  test("a retry's status goes with its turn: the next turn's error is read afresh", () => {
    const first = fold([init, retry(null), clean, idle])
    expect(fold([init, failed(null), idle], first).state._tag).toBe("Failed")
  })

  test("the usage limit and the login refused come first", () => {
    expect(stateAfter(init, retry(529), failed(429), idle)._tag).toBe("UsageLimited")
    const refused = stateAfter(
      init,
      retry(null),
      assistant("authentication_failed"),
      failed(null),
      idle,
    )
    expect(refused._tag).toBe("LoginRefused")
  })

  test("its card says so, with its status, and its row is retrying", () => {
    const state = WorkerState.ApiUnavailable({ at: 0, error: "Overloaded", status: 529 })
    expect(stateStatus(state, [], "retrying")).toBe("API unavailable (529)")
    const none = WorkerState.ApiUnavailable({ at: 0, error: "Connection error.", status: null })
    expect(stateStatus(none, [], "retrying")).toBe("API unavailable")
    expect(activityOf(state, [])).toBe("retrying")
  })
})

describe("apiOutage", () => {
  const anyTurn = fc.record({
    status: fc.option(fc.integer({ min: 100, max: 599 }), { nil: null }),
    retried: fc.option(fc.option(fc.integer({ min: 100, max: 599 }), { nil: null }), {
      nil: undefined,
    }),
    serverError: fc.boolean(),
    interrupted: fc.boolean(),
  })

  test("an interrupt is never an outage", () => {
    fc.assert(fc.property(anyTurn, (turn) => !apiOutage({ ...turn, interrupted: true })))
  })

  test("a result's status decides when it has one: a 5xx is an outage, any other status not", () => {
    fc.assert(
      fc.property(anyTurn, fc.integer({ min: 100, max: 599 }), (turn, status) => {
        const outage = apiOutage({ ...turn, status, interrupted: false })
        return outage === status >= 500
      }),
    )
  })
})

describe("the hold's probes and gate", () => {
  test("the wait before each probe doubles from a minute, up to probeEveryMost", () => {
    const waits = [0, 1, 2, 3, 4, 5, 40].map((n) => Duration.toMinutes(probeAfter(n)))
    expect(waits).toEqual([1, 2, 4, 8, 15, 15, 15])
    expect(Duration.toMinutes(probeEveryMost)).toBe(15)
  })

  test("it holds the run, takes no new tickets and shows its banner", () => {
    expect(holds({ ...openGate, apiHeld: true })).toBe(true)
    expect(takesNew({ ...openGate, apiHeld: true })).toBe(false)
    expect(takesNew({ ...openGate, apiHeld: false })).toBe(true)
    const shown = shownHolds(withApiHold(noHolds, true))
    expect(shown.holds).toEqual([{ word: "API_UNAVAILABLE", resetsAt: null }])
    expect(shown.stopping).toBe(false)
    expect(shownHolds(withApiHold(withApiHold(noHolds, true), false)).holds).toEqual([])
  })
})
