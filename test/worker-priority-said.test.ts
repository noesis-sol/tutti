// lower() says why it couldn't lower a worker's priority, once in tutti's process: the error, the
// pid, the priority before and after; and sets it again where it finds it raised back a moment later
// (lowerRecheck), as on GitHub's macOS runners (tutti-djtt).
import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { Duration } from "effect"
import { type LowerTold, lower, lowerRecheck } from "../src/agent/sessionProcess.ts"

/** An error shaped like Bun's from a priority call that failed. */
const systemError = (syscall: string, code: string, message: string) =>
  Object.assign(new Error(`A system error occurred: ${syscall} returned ${code} (${message})`), {
    code: "ERR_SYSTEM_ERROR",
    info: { code, syscall, message },
  })

/** A process table of one, at `nice`, whose setPriority does `onSet`; what lower() said. */
const fakeAt = (nice: number, onSet: (to: number) => number | Error = (to) => to) => {
  const state = { nice, sets: [] as Array<number>, said: [] as Array<string>, alive: true }
  const told: LowerTold = { said: false }
  const os = {
    getPriority: () => state.nice,
    setPriority: (_pid: number, to: number) => {
      state.sets.push(to)
      const got = onSet(to)
      if (got instanceof Error) throw got
      state.nice = got
    },
  }
  const using = { say: (line: string) => state.said.push(line), alive: () => state.alive, told, os }
  return { state, using }
}

/** Waits past lowerRecheck. */
const pastRecheck = () => Bun.sleep(Duration.toMillis(lowerRecheck) + 50)

describe("lower()", () => {
  test("lowers a priority above nice, reads it back, and says nothing", async () => {
    const { state, using } = fakeAt(-10)
    lower(42, 10, using)
    await pastRecheck()
    expect(state).toMatchObject({ nice: 10, sets: [10], said: [] })
  })

  test("leaves one at nice or lower, unread again and unsaid", async () => {
    const { state, using } = fakeAt(12)
    lower(42, 10, using)
    state.nice = -10
    await pastRecheck()
    expect(state).toMatchObject({ nice: -10, sets: [], said: [] })
  })

  test("a set that fails says the error, the pid, the priority before and after", () => {
    const { state, using } = fakeAt(-10, () =>
      systemError("uv_os_setpriority", "EPERM", "operation not permitted"),
    )
    lower(42, 10, using)
    expect(state.said).toEqual([
      "tutti: couldn't lower Claude Code (pid 42, at nice -10) to nice 10: A system error " +
        "occurred: uv_os_setpriority returned EPERM (operation not permitted); found nice -10 after\n",
    ])
  })

  test("a set that sets nothing says the priority it found after", () => {
    const { state, using } = fakeAt(-10, () => -10)
    lower(42, 10, using)
    expect(state.said).toEqual([
      "tutti: lowered Claude Code (pid 42, at nice -10) to nice 10, but found nice -10 after\n",
    ])
  })

  test("says it once in a process: a second failure is unsaid", () => {
    const { state, using } = fakeAt(-10, () => -10)
    lower(42, 10, using)
    lower(43, 10, using)
    expect(state.said).toHaveLength(1)
    expect(state.sets).toEqual([10, 10])
  })

  test("a priority raised back is set again lowerRecheck later, and said", async () => {
    const { state, using } = fakeAt(-10)
    lower(42, 10, using)
    state.nice = -10
    await pastRecheck()
    expect(state).toMatchObject({ nice: 10, sets: [10, 10] })
    expect(state.said).toEqual([
      `tutti: Claude Code (pid 42), lowered to nice 10, was at nice -10 ${Duration.toMillis(lowerRecheck)} ms later; set again: nice 10\n`,
    ])
  })

  test("one that couldn't be lowered at once is tried again lowerRecheck later", async () => {
    let refuse = true
    const { state, using } = fakeAt(-10, (to) =>
      refuse ? systemError("uv_os_setpriority", "ESRCH", "no such process") : to,
    )
    lower(42, 10, using)
    refuse = false
    await pastRecheck()
    expect(state).toMatchObject({ nice: 10, sets: [10, 10] })
    expect(state.said).toHaveLength(1)
  })

  test("an exited child is left alone at the recheck", async () => {
    const { state, using } = fakeAt(-10)
    lower(42, 10, using)
    state.nice = -10
    state.alive = false
    await pastRecheck()
    expect(state).toMatchObject({ nice: -10, sets: [10], said: [] })
  })

  test("a process that is gone: its priority unread, and why", async () => {
    const child = spawn("/usr/bin/true")
    const pid = child.pid as number
    await new Promise((resolve) => child.once("close", resolve))
    const said: Array<string> = []
    lower(pid, 10, { say: (line) => said.push(line), alive: () => false, told: { said: false } })
    expect(said).toEqual([
      `tutti: couldn't read Claude Code's priority (pid ${pid}) to lower it: A system error ` +
        "occurred: uv_os_getpriority returned ESRCH (no such process)\n",
    ])
  })
})
