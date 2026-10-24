// The stop a quit ends the run with (§ 4.8): quitting.ts's quitStop, for a request to quit and for
// a panic in one of the run's fibers.
import { describe, expect, test } from "bun:test"
import { stopFor } from "../src/run/holds.ts"
import { fromDashboard, quitBy } from "../src/run/quit.ts"
import { Quitting, quitStop } from "../src/run/quitting.ts"

describe("quitStop", () => {
  test("a request to quit ends the run INTERRUPTED (130), its text what the request's says", () => {
    const stop = quitStop(Quitting.Quit({ request: quitBy("SIGTERM") }), ({ how }) => `quit ${how}`)
    expect(stop).toEqual(stopFor("INTERRUPTED", "quit by SIGTERM"))
    expect(stop.code).toBe(130)
    expect(stop.text).toBe("INTERRUPTED: quit by SIGTERM")
  })

  test("the text is given the request itself", () => {
    const seen: Array<string> = []
    quitStop(Quitting.Quit({ request: fromDashboard }), (request) => {
      seen.push(request.how, request.again)
      return "quit"
    })
    expect(seen).toEqual(["from the dashboard", "press Ctrl+C again"])
  })

  test("a panic ends the run with its own PANIC stop, the text not asked for", () => {
    const panic = stopFor("PANIC", "the run's loop: boom")
    const stop = quitStop(Quitting.Panic({ stop: panic }), () => {
      throw new Error("a panic's stop asks for no text")
    })
    expect(stop).toBe(panic)
    expect(stop.code).toBe(4)
  })
})
