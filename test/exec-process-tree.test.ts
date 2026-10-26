// A command's process tree (src/services/exec.ts, src/services/processTree.ts, § 3.3 "Time
// limits"): bun test --parallel runs each test worker in a process group of its own, so exec, and
// the reaper it starts for a command, kill the command's whole tree once SIGTERM hasn't ended it,
// with the tree as it was listed before the SIGTERM: a worker whose coordinator has gone is out of
// the tree by then.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Fiber } from "effect"
import fc from "fast-check"
import { exec } from "../src/services/exec.ts"
import { type ProcessRow, treeGroups } from "../src/services/processTree.ts"
import { slow } from "./gates.ts"

const coordinator = join(import.meta.dir, "fixtures/reaper/coordinator.ts")
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

/** Waits for a file a process writes, and returns its words as numbers. */
const pidsIn = async (file: string, ms = 10000): Promise<Array<number>> => {
  if (!(await within(() => existsSync(file), ms))) throw new Error(`${file} never appeared`)
  return readFileSync(file, "utf8").trim().split(/\s+/).map(Number)
}

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

describe("treeGroups", () => {
  // The check's group 10: its leader 10 and bun test 11; bun test's workers 20 and 30, each the
  // leader of a group of its own; 40, another process.
  const before = [row(10, 1, 10), row(11, 10, 10), row(20, 11, 20), row(30, 11, 30), row(40, 1, 40)]

  test("names the descendants' groups while the tree holds", () => {
    expect(treeGroups(before, before, 10)).toEqual([20, 30])
  })

  test("names the groups of the earlier listing whose coordinator has gone", () => {
    const now = [row(20, 1, 20), row(30, 1, 30), row(40, 1, 40)]
    expect(treeGroups(now, before, 10)).toEqual([20, 30])
  })

  test("leaves out a group of the earlier listing that has gone, or whose ID was reused", () => {
    const now = [row(20, 1, 20), row(31, 1, 30), row(40, 1, 40)]
    expect(treeGroups(now, before, 10)).toEqual([20])
  })

  test("spares the groups it is told to", () => {
    expect(treeGroups(before, before, 10, [30])).toEqual([20])
  })

  test("names only groups of processes there now, each once, never the group, the spared or PID 1's", () => {
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
        rows,
        fc.integer({ min: 2, max: 40 }),
        fc.array(fc.integer({ min: 0, max: 40 }), { maxLength: 3 }),
        (now, earlier, group, spare) => {
          const groups = treeGroups(now, earlier, group, spare)
          expect(new Set(groups).size).toBe(groups.length)
          for (const g of groups) {
            expect(g).not.toBe(group)
            expect(g).toBeGreaterThan(1)
            expect(spare).not.toContain(g)
            expect(now.some((p) => p.pgid === g)).toBe(true)
          }
        },
      ),
    )
  })
})

describe("exec stopping a command", () => {
  test("kills a test worker its coordinator left at the SIGTERM", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "tutti-exec-tree-")), "pids")
    const fiber = Effect.runFork(
      Effect.provide(
        exec({
          command: process.execPath,
          args: [coordinator, file],
          timeLimit: "1 minute",
          killGrace: "1 second",
        }),
        BunServices.layer,
      ),
    )
    const pids = await pidsIn(file)
    try {
      expect(pids.every(alive)).toBe(true)
      await Effect.runPromise(Fiber.interrupt(fiber))
      expect(await goneWithin(pids, 3000)).toBe(true)
    } finally {
      cleanUp(pids)
    }
  }, 15000)
})

describe("a command's reaper, once tutti is gone", () => {
  /** Runs the host in `mode` until its command's processes are up, and returns them. */
  const startHost = async (mode: "claude" | "coordinator") => {
    const dir = mkdtempSync(join(tmpdir(), "tutti-exec-tree-"))
    const proc = Bun.spawn([process.execPath, host, mode, dir], { stdout: "pipe", stderr: "pipe" })
    return { proc, pids: await pidsIn(join(dir, "pids")) }
  }

  test("kills the groups of the command's descendants once the grace is over", async () => {
    // Claude Code ignores the SIGTERM; its detached command, out of its group, never gets it.
    const { proc, pids } = await startHost("claude")
    try {
      expect(pids.every(alive)).toBe(true)
      proc.kill("SIGKILL")
      await proc.exited
      // Its child, in its group, goes at the SIGTERM.
      await Bun.sleep(300)
      expect(pids.slice(0, 2).every(alive)).toBe(true)
      expect(await goneWithin(pids, 8000)).toBe(true)
    } finally {
      cleanUp(pids)
    }
  }, 30000)

  test("kills a test worker its coordinator left at the SIGTERM", async () => {
    const { proc, pids } = await startHost("coordinator")
    try {
      expect(pids.every(alive)).toBe(true)
      proc.kill("SIGKILL")
      await proc.exited
      expect(await goneWithin(pids, 8000)).toBe(true)
    } finally {
      cleanUp(pids)
    }
  }, 30000)
})

describe("a check whose tests run in parallel workers", () => {
  slow.test(
    "stopped by tutti past its grace, leaves no test worker, one spinning in synchronous code",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tutti-exec-tree-"))
      // Each test writes its worker's PID, then one spins and the other waits.
      writeFileSync(
        join(dir, "spin.test.ts"),
        [
          'import { test } from "bun:test"',
          'import { writeFileSync } from "node:fs"',
          'test("spins", () => {',
          `  writeFileSync(\`\${import.meta.dir}/spin.pid\`, String(process.pid))`,
          "  while (true) {}",
          "})",
        ].join("\n"),
      )
      writeFileSync(
        join(dir, "wait.test.ts"),
        [
          'import { test } from "bun:test"',
          'import { writeFileSync } from "node:fs"',
          'test("waits", async () => {',
          `  writeFileSync(\`\${import.meta.dir}/wait.pid\`, String(process.pid))`,
          "  await Bun.sleep(600_000)",
          "})",
        ].join("\n"),
      )
      const fiber = Effect.runFork(
        Effect.provide(
          exec({
            command: "/bin/sh",
            args: [
              "-c",
              'echo $$ > leader.part && mv leader.part leader.pid; exec "$1" test --parallel=2 --timeout=600000',
              "check",
              process.execPath,
            ],
            cwd: dir,
            timeLimit: "5 minutes",
            killGrace: "1 second",
          }),
          BunServices.layer,
        ),
      )
      const [leader = 0] = await pidsIn(join(dir, "leader.pid"), 30000)
      const [spinning = 0] = await pidsIn(join(dir, "spin.pid"), 30000)
      const [waiting = 0] = await pidsIn(join(dir, "wait.pid"), 30000)
      const workers = [spinning, waiting]
      try {
        expect(workers.every(alive)).toBe(true)
        // bun test, the group's leader, can't handle the SIGTERM in its grace, as on a loaded
        // machine: the SIGKILL reaches it first.
        process.kill(leader, "SIGSTOP")
        await Effect.runPromise(Fiber.interrupt(fiber))
        expect(alive(leader)).toBe(false)
        expect(await goneWithin(workers, 3000)).toBe(true)
      } finally {
        cleanUp([leader, ...workers])
      }
    },
    60000,
  )
})
