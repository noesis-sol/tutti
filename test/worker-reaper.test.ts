// A worker's reaper (src/agent/options.ts, § 3.2): a kill -9 of tutti ends its busy workers, and a
// worker that ends normally takes its reaper with it.
import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { reap } from "../src/agent/options.ts"

const host = join(import.meta.dir, "fixtures/reaper/host.ts")

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Whether every one of `pids` has gone within `ms`. */
const goneWithin = async (pids: ReadonlyArray<number>, ms: number): Promise<boolean> => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (!pids.some(alive)) return true
    await Bun.sleep(50)
  }
  return !pids.some(alive)
}

/** Runs the host in `mode` until its worker is busy, and returns the host and the worker's PIDs. */
const startHost = async (mode: "spawn" | "stubborn" | "exit") => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-reaper-"))
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
    throw new Error(`the host didn't start its worker: ${await new Response(proc.stderr).text()}`)
  }
  const pids = readFileSync(join(dir, "pids"), "utf8").trim().split(" ").map(Number)
  return { proc, pids }
}

/** Kills whatever a failed test left of the worker's group. */
const cleanUp = (pids: ReadonlyArray<number>) => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // Gone.
    }
  }
}

describe("a kill -9 of tutti", () => {
  test("ends a busy worker's whole process group", async () => {
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

  test("kills a group that ignores SIGTERM once the grace is over", async () => {
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

  test("a tutti that exits with its worker still busy doesn't wait on the reaper, and ends the worker", async () => {
    const { proc, pids } = await startHost("exit")
    try {
      expect(await proc.exited).toBe(0)
      expect(await goneWithin(pids, 5000)).toBe(true)
    } finally {
      cleanUp(pids)
    }
  }, 15000)
})

describe("reap", () => {
  test("a worker that ends normally takes its reaper with it", async () => {
    const child = spawn("/bin/sh", ["-c", "sleep 0.2"], { stdio: "pipe", detached: true })
    const reaper = reap(child)
    expect(reaper?.pid).toBeDefined()
    const ended = new Promise<string | null>((resolve) =>
      reaper?.once("exit", (_code, signal) => resolve(signal)),
    )
    expect(await ended).toBe("SIGKILL")
    expect(child.exitCode).toBe(0)
  })

  test("doesn't reap a process that has no PID", () => {
    const child = spawn("/nonexistent/claude", [], { stdio: "pipe", detached: true })
    child.on("error", () => {})
    expect(reap(child)).toBeUndefined()
  })
})
