// The machine's runs (src/run/machine.ts, orchestra 0.8.5's machine.go): each run registers in a
// folder the machine's tutti and orchestra runs share, says once of each other run that it is going
// (SHARED_MACHINE), and ignores, and removes, a registration whose run is gone. Two runs in these
// tests are two registrations in one folder, as two loops in one process would be.
import { describe, expect, setSystemTime, test } from "bun:test"
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Scope } from "effect"
import {
  elapsedSeconds,
  liveProcesses,
  make,
  type ProcessCheck,
  Processes,
  readRegistration,
  runsDir,
  type Seen,
  startSlack,
  startsKept,
  writeRegistration,
} from "../src/run/machine.ts"

const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "tutti-shared-machine-")))

/** Every process runs, started at a time no one can read: judged by its PID alone. */
const everyoneAlive: ProcessCheck = { alive: () => true, start: () => Effect.succeed(null) }

const runIn = <A, E>(
  effect: Effect.Effect<A, E, Scope.Scope | BunServices.BunServices>,
  processes: ProcessCheck = everyoneAlive,
) =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provideService(Processes, processes),
      Effect.provide(BunServices.layer),
    ),
  )

/** A registration as orchestra writes it, Go's time and all. */
const orchestraFile = (pid: number, started: string, running = 1) =>
  `{"pid":${pid},"repo":"/work/other","concurrent":3,"started":"${started}","running":${running}}`

const texts = (seen: ReadonlyArray<Seen>): ReadonlyArray<string> => seen.map((each) => each.text)

/** What a look found, its lines as plain text. */
const plain = (seen: ReadonlyArray<Seen>) =>
  seen.map((each) => ({ text: each.text as string, shared: each.shared }))

describe("the folder of runs", () => {
  test("is orchestra's: ORCHESTRA_RUNS_DIR, else runs/ in orchestra's cache folder", () => {
    const env =
      (vars: Record<string, string>) =>
      (name: string): string | undefined =>
        vars[name]
    expect(runsDir(env({ HOME: "/Users/me" }), "darwin")).toBe(
      "/Users/me/Library/Caches/orchestra/runs",
    )
    expect(runsDir(env({ HOME: "/home/me" }), "linux")).toBe("/home/me/.cache/orchestra/runs")
    expect(runsDir(env({ HOME: "/home/me", XDG_CACHE_HOME: "/cache" }), "linux")).toBe(
      "/cache/orchestra/runs",
    )
    expect(runsDir(env({ HOME: "/home/me", XDG_CACHE_HOME: "cache" }), "linux")).toBeNull()
    expect(runsDir(env({ HOME: "/home/me", ORCHESTRA_RUNS_DIR: "/runs" }), "darwin")).toBe("/runs")
    expect(runsDir(env({ HOME: "/home/me", ORCHESTRA_RUNS_DIR: "off" }), "darwin")).toBeNull()
    expect(runsDir(env({}), "darwin")).toBeNull()
  })
})

describe("a process's start", () => {
  test("is read from the time ps says it has run", () => {
    expect(elapsedSeconds("00:07")).toBe(7)
    expect(elapsedSeconds("  12:34\n")).toBe(12 * 60 + 34)
    expect(elapsedSeconds("04:39:09")).toBe((4 * 60 + 39) * 60 + 9)
    expect(elapsedSeconds("52-04:39:09")).toBe(((52 * 24 + 4) * 60 + 39) * 60 + 9)
    expect(elapsedSeconds("")).toBeUndefined()
    expect(elapsedSeconds("Wed Oct 21 12:14:07 2026")).toBeUndefined()
  })
})

describe("a registration", () => {
  test("reads orchestra's, its time in Go's RFC 3339 with nanoseconds", () => {
    expect(
      readRegistration(orchestraFile(69765, "2026-10-21T12:14:07.939989123+03:00", 2)),
    ).toEqual({
      pid: 69765,
      repo: "/work/other",
      concurrent: 3,
      started: Date.parse("2026-10-21T09:14:07.939Z"),
      running: 2,
      tool: "orchestra",
    })
  })

  test("is written in orchestra's fields, which tutti reads back", () => {
    const reg = {
      pid: 12,
      repo: "/work/tutti",
      concurrent: 2,
      started: Date.parse("2026-10-21T09:14:07.939Z"),
      running: 1,
      tool: "tutti" as const,
    }
    expect(JSON.parse(writeRegistration(reg))).toEqual({
      pid: 12,
      repo: "/work/tutti",
      concurrent: 2,
      started: "2026-10-21T09:14:07.939Z",
      running: 1,
      tool: "tutti",
    })
    expect(readRegistration(writeRegistration(reg))).toEqual(reg)
  })

  test("isn't one without a PID or a start, or not JSON", () => {
    expect(readRegistration("")).toBeUndefined()
    expect(readRegistration("{")).toBeUndefined()
    expect(readRegistration("[]")).toBeUndefined()
    expect(readRegistration(`{"pid":0,"started":"2026-10-21T09:14:07Z"}`)).toBeUndefined()
    expect(readRegistration(`{"pid":7}`)).toBeUndefined()
    expect(readRegistration(`{"pid":7,"started":"yesterday"}`)).toBeUndefined()
    expect(readRegistration(`{"pid":7,"started":"2026-10-21T09:14:07Z"}`)).toMatchObject({
      repo: "",
      concurrent: 0,
      running: 0,
    })
  })
})

describe("two runs sharing a folder", () => {
  test("each says once that the other is going, and that it has ended", async () => {
    const dir = folder()
    const said = await runIn(
      Effect.gen(function* () {
        const a = yield* make({ dir, repo: "/work/a", concurrent: 2 })
        const bScope = yield* Scope.make()
        const b = yield* make({ dir, repo: "/work/b", concurrent: 1 }).pipe(
          Effect.provideService(Scope.Scope, bScope),
        )
        const first = { a: texts(yield* a.look), b: texts(yield* b.look) }
        const again = { a: texts(yield* a.look), b: texts(yield* b.look) }
        yield* b.running(3)
        yield* a.look
        const counted = yield* a.others
        yield* Scope.close(bScope, Exit.void)
        const ended = yield* a.look
        return { first, again, counted, ended, left: yield* a.others }
      }),
    )
    expect(said.first).toEqual({
      a: [
        "SHARED_MACHINE: another tutti run is going in /work/b with 1 worker; their checks slow each other down",
      ],
      b: [
        "SHARED_MACHINE: another tutti run is going in /work/a with 2 workers; their checks slow each other down",
      ],
    })
    expect(said.again).toEqual({ a: [], b: [] })
    expect(said.counted).toBe(3)
    expect(plain(said.ended)).toEqual([
      { text: "  the other tutti run in /work/b has ended", shared: 0 },
    ])
    expect(said.left).toBe(0)
    // Both removed their files as they ended.
    expect(readdirSync(dir)).toEqual([])
  })

  test("sees orchestra's run, and orchestra reads tutti's file", async () => {
    const dir = folder()
    writeFileSync(join(dir, "run-4242-1.json"), orchestraFile(4242, "2026-10-21T12:14:07.9+03:00"))
    const { seen, mine } = await runIn(
      Effect.gen(function* () {
        const machine = yield* make({ dir, repo: "/work/tutti", concurrent: 2 })
        yield* machine.running(2)
        const mine = readdirSync(dir).filter((name) => name !== "run-4242-1.json")
        return {
          seen: yield* machine.look,
          mine: mine.map((name) => JSON.parse(readFileSync(join(dir, name), "utf8"))),
        }
      }),
    )
    expect(plain(seen)).toEqual([
      {
        text: "SHARED_MACHINE: another orchestra run is going in /work/other with 3 workers; their checks slow each other down",
        shared: 1,
      },
    ])
    expect(mine).toEqual([
      expect.objectContaining({ pid: process.pid, repo: "/work/tutti", concurrent: 2, running: 2 }),
    ])
  })

  test("ignores and removes a registration whose PID is gone or taken again since", async () => {
    const dir = folder()
    const started = "2026-10-21T09:00:00Z"
    writeFileSync(join(dir, "run-11-1.json"), orchestraFile(11, started, 4)) // its PID is gone
    writeFileSync(join(dir, "run-12-1.json"), orchestraFile(12, started, 4)) // taken again
    writeFileSync(join(dir, "run-13-1.json"), orchestraFile(13, started, 1)) // still going
    writeFileSync(join(dir, "run-14-1.json"), "{") // one being written, or not a run's
    const processes: ProcessCheck = {
      alive: (pid) => pid !== 11,
      start: (pid) =>
        Effect.succeed(
          pid === 12 ? Date.parse(started) + startSlack + 1000 : Date.parse(started) + startSlack,
        ),
    }
    const { seen, others } = await runIn(
      Effect.gen(function* () {
        const machine = yield* make({ dir, repo: "/work/tutti", concurrent: 1 })
        return { seen: texts(yield* machine.look), others: yield* machine.others }
      }),
      processes,
    )
    expect(seen).toEqual([
      "SHARED_MACHINE: another orchestra run is going in /work/other with 3 workers; their checks slow each other down",
    ])
    expect(others).toBe(1)
    expect(readdirSync(dir).toSorted()).toEqual(["run-13-1.json", "run-14-1.json"])
  })

  test("finds out a PID taken by another process while the run watches it, within a minute", async () => {
    const dir = folder()
    const started = Date.parse("2026-10-21T09:00:00Z")
    writeFileSync(join(dir, "run-21-1.json"), orchestraFile(21, "2026-10-21T09:00:00Z", 2))
    // PID 21 is the registered run's until its third read, then a process started since.
    let reads = 0
    const processes: ProcessCheck = {
      alive: () => true,
      start: () => Effect.succeed(++reads < 3 ? started : started + 3_600_000),
    }
    const counted = await runIn(
      Effect.gen(function* () {
        const machine = yield* make({ dir, repo: "/work/tutti", concurrent: 1 })
        const counts: Array<number> = []
        try {
          yield* machine.look
          counts.push(yield* machine.others)
          setSystemTime(new Date(Date.now() + startsKept + 1000))
          yield* machine.look
          counts.push(yield* machine.others)
          // Read again within the minute: still the cached start.
          yield* machine.look
          counts.push(yield* machine.others)
          setSystemTime(new Date(Date.now() + startsKept + 1000))
          const ended = texts(yield* machine.look)
          counts.push(yield* machine.others)
          return { counts, ended, reads }
        } finally {
          setSystemTime()
        }
      }),
      processes,
    )
    expect(counted).toEqual({
      counts: [2, 2, 2, 0],
      ended: ["  the other orchestra run in /work/other has ended"],
      reads: 3,
    })
    expect(readdirSync(dir)).toEqual([])
  })

  test("the live check keeps a running process and drops one that started after its run", async () => {
    // This process runs: registered now, it is going; registered in 2001, its PID was taken since.
    const dir = folder()
    const now = new Date().toISOString()
    writeFileSync(join(dir, "run-now.json"), orchestraFile(process.pid, now))
    writeFileSync(join(dir, "run-old.json"), orchestraFile(process.pid, "2001-01-01T00:00:00Z"))
    const seen = await runIn(
      Effect.gen(function* () {
        const machine = yield* make({ dir, repo: "/work/tutti", concurrent: 1 })
        return yield* machine.look
      }),
      liveProcesses,
    )
    expect(seen.map((each) => each.shared)).toEqual([1])
    expect(existsSync(join(dir, "run-old.json"))).toBe(false)
    expect(existsSync(join(dir, "run-now.json"))).toBe(true)
  }, 15_000)

  test("a folder that can't be read holds no run, and one removed is made again", async () => {
    const parent = folder()
    const dir = join(parent, "runs")
    const { before, after } = await runIn(
      Effect.gen(function* () {
        const machine = yield* make({ dir, repo: "/work/tutti", concurrent: 1 })
        const before = readdirSync(dir).length
        rmSync(dir, { recursive: true })
        expect(yield* machine.look).toEqual([])
        expect(yield* machine.others).toBe(0)
        yield* machine.running(1)
        return { before, after: readdirSync(dir).length }
      }),
    )
    expect(before).toBe(1)
    expect(after).toBe(1)
  })

  test("registers nowhere without a folder", async () => {
    const seen = await runIn(
      Effect.gen(function* () {
        const machine = yield* make({ dir: null, repo: "/work/tutti", concurrent: 1 })
        yield* machine.running(2)
        return { seen: yield* machine.look, others: yield* machine.others }
      }),
    )
    expect(seen).toEqual({ seen: [], others: 0 })
  })
})
