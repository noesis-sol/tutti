// The preload's warm-up spawn (test/warm-up.ts) waits on its child's 'exit', or, should Bun lose
// that exit (tutti-cje), a second after the child's exit code is set.
import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { type Exiting, waitForExit } from "./warm-up.ts"

/** A child whose exit code is set and whose 'exit' fires only when the test says. */
class FakeChild extends EventEmitter implements Exiting {
  exitCode: number | null = null
  signalCode: string | null = null
}

const timed = async (wait: Promise<void>) => {
  const start = performance.now()
  await wait
  return performance.now() - start
}

describe("waitForExit", () => {
  test("a child that exits ends the wait at once", async () => {
    const child = spawn("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" })
    expect(await timed(waitForExit(child))).toBeLessThan(500)
  })

  test("an 'exit' ends the wait before a poll would see the exit code", async () => {
    const child = new FakeChild()
    setTimeout(() => {
      child.exitCode = 0
      child.emit("exit", 0, null)
    }, 20)
    expect(await timed(waitForExit(child, { poll: 1000 }))).toBeLessThan(500)
  })

  test("a lost exit ends the wait about a second after its exit code is set", async () => {
    const child = new FakeChild()
    setTimeout(() => {
      child.exitCode = 0
    }, 50)
    const took = await timed(waitForExit(child))
    expect(took).toBeGreaterThanOrEqual(1000)
    expect(took).toBeLessThan(2000)
  })

  test("a lost exit by signal ends the wait too", async () => {
    const child = new FakeChild()
    child.signalCode = "SIGKILL"
    const took = await timed(waitForExit(child, { lost: 100, poll: 10 }))
    expect(took).toBeGreaterThanOrEqual(100)
    expect(took).toBeLessThan(1000)
  })

  test("a child that never exits ends the wait at the deadline", async () => {
    const took = await timed(waitForExit(new FakeChild(), { deadline: 200 }))
    expect(took).toBeGreaterThanOrEqual(195)
    expect(took).toBeLessThan(1000)
  })
})
