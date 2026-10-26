// A command's reaper (src/services/exec.ts, § 3.3 "Time limits"): a kill -9 of tutti mid-command
// ends the command's whole process group, and a command that ends, or whose fiber is interrupted,
// takes its reaper with it.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Fiber } from "effect"
import { type Command, exec } from "../src/services/exec.ts"

const host = join(import.meta.dir, "fixtures/reaper/exec-host.ts")

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Whether `check` holds within `ms`. */
const within = async (check: () => boolean, ms: number): Promise<boolean> => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await Bun.sleep(50)
  }
  return check()
}

const goneWithin = (pids: ReadonlyArray<number>, ms: number) => within(() => !pids.some(alive), ms)

/** The PIDs of the reapers watching the group `group`, from ps. */
const reapersOf = (group: number): Array<number> =>
  Bun.spawnSync(["ps", "-ax", "-o", "pid=,command="])
    .stdout.toString()
    .split("\n")
    .filter(
      (line) => line.includes("/bin/sh -c read _;") && line.endsWith(` reaper ${group} 1 tree`),
    )
    .map((line) => Number.parseInt(line.trim(), 10))

/** Waits for a file a command writes, and returns its words as numbers. */
const pidsIn = async (file: string): Promise<Array<number>> => {
  if (!(await within(() => existsSync(file), 5000))) throw new Error(`${file} never appeared`)
  return readFileSync(file, "utf8").trim().split(/\s+/).map(Number)
}

/** Kills whatever a failed test left of the command's group. */
const cleanUp = (pids: ReadonlyArray<number>) => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // Gone.
    }
  }
}

/** Runs the host in `mode` until its command is busy, and returns the host and the command's PIDs. */
const startHost = async (mode: "spawn" | "stubborn") => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-exec-reaper-"))
  const proc = Bun.spawn(["bun", host, mode, dir], { stdout: "pipe", stderr: "pipe" })
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let out = ""
  while (!out.includes("ready")) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  reader.releaseLock()
  if (!out.includes("ready")) {
    throw new Error(`the host didn't start its command: ${await new Response(proc.stderr).text()}`)
  }
  const pids = readFileSync(join(dir, "pids"), "utf8").trim().split(" ").map(Number)
  return { proc, pids }
}

// The command writes its PID, then waits on a sleep: `seconds` long, or until it is killed.
const busy = (file: string, seconds: number): Command => ({
  command: "/bin/sh",
  args: ["-c", `echo $$ > "$1.part" && mv "$1.part" "$1"; sleep ${seconds}`, "command", file],
  timeLimit: "1 minute",
  killGrace: "1 second",
})

describe("a kill -9 of tutti mid-command", () => {
  test("ends the command's whole process group", async () => {
    const { proc, pids } = await startHost("spawn")
    try {
      expect(pids.every(alive)).toBe(true)
      proc.kill("SIGKILL")
      await proc.exited
      expect(await goneWithin(pids, 5000)).toBe(true)
    } finally {
      cleanUp(pids)
    }
  }, 15000)

  test("kills a group that ignores SIGTERM once the command's grace is over", async () => {
    const { proc, pids } = await startHost("stubborn")
    try {
      proc.kill("SIGKILL")
      await proc.exited
      await Bun.sleep(300)
      expect(pids.every(alive)).toBe(true)
      expect(await goneWithin(pids, 5000)).toBe(true)
    } finally {
      cleanUp(pids)
    }
  }, 15000)
})

describe("exec's reaper", () => {
  test("watches a running command, and goes once the command has ended", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "tutti-exec-reaper-")), "pid")
    const running = Effect.runPromise(Effect.provide(exec(busy(file, 0.5)), BunServices.layer))
    const [leader = 0] = await pidsIn(file)
    expect(reapersOf(leader)).toHaveLength(1)
    expect((await running).exitCode).toBe(0)
    expect(await within(() => reapersOf(leader).length === 0, 2000)).toBe(true)
  })

  test("goes with the group when the command's fiber is interrupted", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "tutti-exec-reaper-")), "pid")
    const fiber = Effect.runFork(Effect.provide(exec(busy(file, 30)), BunServices.layer))
    const [leader = 0] = await pidsIn(file)
    try {
      expect(reapersOf(leader)).toHaveLength(1)
      await Effect.runPromise(Fiber.interrupt(fiber))
      expect(alive(leader)).toBe(false)
      expect(await within(() => reapersOf(leader).length === 0, 2000)).toBe(true)
    } finally {
      cleanUp([leader])
    }
  }, 15000)
})
