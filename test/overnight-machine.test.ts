// What --overnight's pre-flight reads of the machine from files and the kernel (tutti-kkb.46): the
// other runs registered in the machine's folder of runs, those gone left out (src/run/machine.ts's
// otherRuns), and the free disk where the worktrees will go (src/run/processes.ts's freeDisk).
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit } from "effect"
import { otherRuns, Processes, type Registration, writeRegistration } from "../src/run/machine.ts"
import { freeDisk } from "../src/run/processes.ts"

const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-overnight-machine-")))

const registration = (pid: number, started: number): Registration => ({
  pid,
  repo: `/work/repo-${pid}`,
  concurrent: 2,
  started,
  running: 1,
  tool: "tutti",
})

describe("the other runs on the machine", () => {
  test("are those registered whose process is there, first started first", async () => {
    const dir = folder()
    const now = Date.now()
    writeFileSync(join(dir, "run-20-1.json"), writeRegistration(registration(20, now - 1000)))
    writeFileSync(join(dir, "run-10-1.json"), writeRegistration(registration(10, now - 5000)))
    // Gone, and a PID another process took since the run started.
    writeFileSync(join(dir, "run-30-1.json"), writeRegistration(registration(30, now)))
    writeFileSync(join(dir, "run-40-1.json"), writeRegistration(registration(40, now - 60_000)))
    // Not a run's, this process's own, and one being written.
    writeFileSync(join(dir, "notes.txt"), "hello")
    writeFileSync(join(dir, "run-own.json"), writeRegistration(registration(process.pid, now)))
    writeFileSync(join(dir, "run-50-1.json.tmp"), writeRegistration(registration(50, now)))
    const runs = await Effect.runPromise(
      otherRuns(dir).pipe(
        Effect.provideService(Processes, {
          alive: (pid) => pid !== 30,
          start: (pid) => Effect.succeed(pid === 40 ? now : null),
        }),
        Effect.provide(BunServices.layer),
      ),
    )
    expect(runs.map((run) => run.pid)).toEqual([10, 20])
  })

  test("are none without a folder of runs", async () => {
    const none = await Effect.runPromise(otherRuns(null).pipe(Effect.provide(BunServices.layer)))
    expect(none).toEqual([])
    const missing = await Effect.runPromise(
      otherRuns(join(folder(), "nowhere")).pipe(Effect.provide(BunServices.layer)),
    )
    expect(missing).toEqual([])
  })
})

describe("the free disk", () => {
  test("is read where the worktrees will go, from the nearest folder that is there", async () => {
    const dir = folder()
    const read = await Effect.runPromise(freeDisk(join(dir, "repo-tutti", "deeper")))
    expect(read.where).toBe(dir)
    expect(read.free).toBeGreaterThan(0)
  })

  test("says why where it can't be read", async () => {
    const exit = await Effect.runPromiseExit(freeDisk("\0bad"))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
