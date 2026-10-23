// processAlive, the one way tutti, its exec and its test runner ask whether a process (or a
// process group) is there: only ESRCH says it has gone.

import { describe, expect, test } from "bun:test"
import { processAlive } from "../src/services/processTree.ts"

describe("processAlive", () => {
  test("this process is there", () => {
    expect(processAlive(process.pid)).toBe(true)
  })

  test("a process that has exited and been reaped isn't", () => {
    const child = Bun.spawnSync(["true"])
    expect(child.exitCode).toBe(0)
    expect(processAlive(child.pid)).toBe(false)
  })

  test("one this user may not signal is: PID 1 is another user's", () => {
    if (process.getuid?.() === 0) return
    expect(processAlive(1)).toBe(true)
  })

  test("a group with no process left isn't", () => {
    const child = Bun.spawnSync(["true"])
    expect(processAlive(-child.pid)).toBe(false)
  })
})
