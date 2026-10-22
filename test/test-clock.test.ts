// The UI tests' renderer clock (test/render.ts's TestClock): OpenTUI's ManualClock kept in step with
// real time, which a test leaps ahead to fire its timers without waiting for them (§ 13).
import { describe, expect, test } from "bun:test"
import { TestClock } from "./render.ts"

describe("the test clock", () => {
  test("fires a timer in real time, with no leap", async () => {
    const clock = new TestClock()
    const fired = await new Promise<number>((resolve) => {
      clock.setTimeout(() => resolve(clock.now()), 5)
    })
    expect(fired).toBeGreaterThanOrEqual(5)
  })

  test("a leap fires at once, in order, the timers due by then and those they set", () => {
    const clock = new TestClock()
    const fired: Array<string> = []
    clock.setTimeout(() => {
      fired.push("parser")
      clock.setTimeout(() => fired.push("hold"), 30)
    }, 20)
    clock.setTimeout(() => fired.push("later"), 1000)
    clock.leap(50)
    expect(fired).toEqual(["parser", "hold"])
    expect(clock.now()).toBeGreaterThanOrEqual(50)
    clock.leap(1000)
    expect(fired).toEqual(["parser", "hold", "later"])
  })

  test("a cleared timer doesn't fire, leapt over or in real time", async () => {
    const clock = new TestClock()
    const fired: Array<string> = []
    clock.clearTimeout(clock.setTimeout(() => fired.push("leapt"), 10))
    clock.clearTimeout(clock.setTimeout(() => fired.push("real"), 5))
    clock.leap(20)
    await new Promise<void>((resolve) => clock.setTimeout(resolve, 10))
    expect(fired).toEqual([])
  })

  test("an interval keeps firing in real time until cleared", async () => {
    const clock = new TestClock()
    let ticks = 0
    let thrice: () => void = () => {}
    const ticked = new Promise<void>((resolve) => {
      thrice = resolve
    })
    const handle = clock.setInterval(() => {
      ticks += 1
      if (ticks >= 3) thrice()
    }, 2)
    await ticked
    clock.clearInterval(handle)
    const cleared = ticks
    await new Promise<void>((resolve) => clock.setTimeout(resolve, 10))
    expect(ticks).toBe(cleared)
    expect(clock.pendingTimerCount).toBe(0)
  })
})
