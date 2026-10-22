// A worker's process tree (src/services/processTree.ts, § 3.2): when Claude Code is killed
// outright, by tutti, the SDK or its reaper, the commands it started in groups of their own go too.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk"
import fc from "fast-check"
import { spawnInOwnProcessGroup } from "../src/agent/options.ts"
import {
  descendantGroups,
  killTree,
  type ProcessRow,
  parseProcesses,
} from "../src/services/processTree.ts"
import { testEnv } from "./env.ts"

const claude = join(import.meta.dir, "fixtures/reaper/claude.ts")
const host = join(import.meta.dir, "fixtures/reaper/host.ts")

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

/** Waits for the PIDs claude.ts writes: its own, its detached command's and its child's. */
const pidsIn = async (file: string): Promise<Array<number>> => {
  if (!(await within(() => existsSync(file), 10000))) throw new Error(`${file} never appeared`)
  return readFileSync(file, "utf8").trim().split(/\s+/).map(Number)
}

/** The process group of `pid`, from ps. */
const groupOf = (pid: number): number =>
  Number(
    Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)])
      .stdout.toString()
      .trim(),
  )

/** Kills whatever a failed test left of the processes and their groups. */
const cleanUp = (pids: ReadonlyArray<number>) => {
  for (const pid of pids) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGKILL")
      } catch {
        // Gone.
      }
    }
  }
}

const row = (pid: number, ppid: number, pgid: number): ProcessRow => ({ pid, ppid, pgid })

describe("parseProcesses", () => {
  test("reads ps's pid, ppid and pgid columns, skipping other lines", () => {
    expect(
      parseProcesses("  101     1   101\n 102   101   102\n\nPID PPID PGID\n 7 x 7\n"),
    ).toEqual([row(101, 1, 101), row(102, 101, 102)])
  })
})

describe("descendantGroups", () => {
  // Claude Code 100 leads group 100; 101, a child in its group; 200 and 300, its Bash shells, lead
  // groups of their own, 201 a command in 200's group, 301 in a group of its own under 300.
  const table = [
    row(1, 0, 1),
    row(50, 1, 50),
    row(100, 50, 100),
    row(101, 100, 100),
    row(200, 100, 200),
    row(201, 200, 200),
    row(300, 101, 300),
    row(301, 300, 301),
    row(400, 1, 400),
  ]

  test("finds the groups of every descendant of the group's members", () => {
    expect(descendantGroups(table, 100)).toEqual([200, 300, 301])
  })

  test("spares the groups it is told to, and never the group itself or PID 1's", () => {
    expect(descendantGroups(table, 100, [300])).toEqual([200, 301])
    expect(descendantGroups([...table, row(500, 100, 1), row(501, 100, 0)], 100)).toEqual([
      200, 300, 301,
    ])
  })

  test("finds nothing for a group that has no members", () => {
    expect(descendantGroups(table, 999)).toEqual([])
  })

  test("names only groups of the group's descendants, each once, never the spared", () => {
    const rows = fc.array(
      fc.record({
        pid: fc.integer({ min: 1, max: 40 }),
        ppid: fc.integer({ min: 0, max: 40 }),
        pgid: fc.integer({ min: 0, max: 40 }),
      }),
      { maxLength: 30 },
    )
    fc.assert(
      fc.property(
        rows,
        fc.integer({ min: 2, max: 40 }),
        fc.array(fc.integer({ min: 0, max: 40 })),
        (processes, group, spare) => {
          const found = descendantGroups(processes, group, spare)
          expect(new Set(found).size).toBe(found.length)
          for (const g of found) {
            expect(g).toBeGreaterThan(1)
            expect(g).not.toBe(group)
            expect(spare).not.toContain(g)
            expect(processes.some((p) => p.pgid === g)).toBe(true)
          }
        },
      ),
    )
  })
})

describe("killing a busy Claude Code outright", () => {
  const spawnClaude = (file: string) =>
    spawnInOwnProcessGroup(() => {})({
      command: process.execPath,
      args: [claude, file],
      cwd: "/",
      env: { PATH: testEnv.PATH },
      signal: new AbortController().signal,
    } satisfies SpawnOptions)

  test("the SDK's SIGKILL stops the commands it left in groups of their own", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "tutti-process-tree-")), "pids")
    const child = spawnClaude(file)
    const pids = await pidsIn(file)
    try {
      const [, command] = pids as [number, number, number]
      expect(pids.every(alive)).toBe(true)
      expect(groupOf(command)).toBe(command)
      const exited = new Promise((resolve) => child.once("exit", resolve))
      child.kill("SIGKILL")
      await exited
      expect(await goneWithin(pids, 5000)).toBe(true)
    } finally {
      cleanUp(pids)
    }
  }, 30000)

  test("killTree stops the group and its descendants' groups", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "tutti-process-tree-")), "pids")
    const child = spawnClaude(file)
    const pids = await pidsIn(file)
    try {
      killTree(child.pid)
      expect(await goneWithin(pids, 5000)).toBe(true)
    } finally {
      cleanUp(pids)
    }
  }, 30000)

  test("killTree leaves a PID that is no group alone", () => {
    expect(() => killTree(undefined)).not.toThrow()
    expect(() => killTree(1)).not.toThrow()
    expect(() => killTree(Number.NaN)).not.toThrow()
  })

  test("a kill -9 of tutti: the reaper's SIGKILL stops the commands too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tutti-process-tree-"))
    const proc = Bun.spawn([process.execPath, host, "tree", dir], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const pids = await pidsIn(join(dir, "pids"))
    try {
      expect(pids.every(alive)).toBe(true)
      proc.kill("SIGKILL")
      await proc.exited
      // Claude Code ignores the reaper's SIGTERM, which its detached command never gets; the grace
      // is one second.
      await Bun.sleep(300)
      expect(pids.slice(0, 2).every(alive)).toBe(true)
      expect(await goneWithin(pids, 8000)).toBe(true)
    } finally {
      cleanUp(pids)
    }
  }, 30000)
})
