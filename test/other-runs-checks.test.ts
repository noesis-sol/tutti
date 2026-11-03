// The checks' memory budget counts the machine's other runs' checks (tutti-0l05): their memory is
// not available, and their workers are among those the budget is divided by (memoryShare's
// others), so leaving it out cut each run's share twice for them. A run's checks are read from the
// listing as the run reads its own: what is below each of its children, the children not counted.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Effect, Fiber } from "effect"
import fc from "fast-check"
import {
  type Kernel,
  type LoadSource,
  memoryReserve,
  newSampler,
  othersChecks,
  parseProcesses,
  type Reading,
  sample,
  watchLoad,
} from "../src/run/load.ts"
import {
  make,
  OtherWorkers,
  otherWorkers,
  type ProcessCheck,
  Processes,
} from "../src/run/machine.ts"
import { budgetOf } from "../src/run/share.ts"

const gb = 1024 ** 3
const kb = 1024

// tutti (100) with a worker (200) and its check (201); another run (300) with a worker (310), its
// check's shell (311) and test runner (312), a command left in the worker's group (313), and its
// merge check's shell (320) and test runner (321); and a program of no run (500).
const listing = [
  "    1     0     1   1000",
  "  100     1   100  50000",
  "  200   100   200 1048576",
  "  201   200   200 524288",
  "  300     1   300  60000",
  "  310   300   310 1048576",
  "  311   310   310   2000",
  "  312   311   310 786432",
  "  313     1   310 131072",
  "  320   300   320   2000",
  "  321   320   320 262144",
  "  500     1   500 100000",
].join("\n")
const processes = parseProcesses(listing)
if (processes === undefined) throw new Error("listing unread")
const theirs = (2000 + 786432 + 131072 + 262144) * kb

describe("another run's checks", () => {
  test("are what is below its children, the children and the run's process not counted", () => {
    expect(othersChecks(processes, [300], new Set())).toBe(theirs)
    expect(othersChecks(processes, [], new Set())).toBe(0)
    // A run that isn't in the listing holds nothing.
    expect(othersChecks(processes, [999], new Set())).toBe(0)
  })

  test("leave out what the run counts as its own, should one run inside the other", () => {
    expect(othersChecks(processes, [300], new Set([312]))).toBe(theirs - 786432 * kb)
    expect(othersChecks(processes, [300], new Set([300]))).toBe(0)
  })

  test("each process counts once, however many runs it is below", () => {
    expect(othersChecks(processes, [300, 300], new Set())).toBe(theirs)
    fc.assert(
      fc.property(fc.array(fc.constantFrom(100, 300, 500, 999), { maxLength: 6 }), (runs) => {
        const once = othersChecks(processes, [...new Set(runs)], new Set())
        expect(othersChecks(processes, runs, new Set())).toBe(once)
        expect(once).toBeLessThanOrEqual(
          [...processes.values()].reduce((sum, each) => sum + each.memory, 0),
        )
      }),
    )
  })

  test("a reading has them beside the run's own where there are other runs", () => {
    const read = (runs?: ReadonlyArray<number>) =>
      sample({
        sampler: newSampler,
        now: 0,
        processes,
        kernel: undefined,
        roots: new Map([["t-1", 200]]),
        self: 100,
        ...(runs === undefined ? {} : { runs }),
      }).reading.memory
    expect(read()).toEqual({ checks: 524288 * kb })
    expect(read([])).toEqual({ checks: 524288 * kb })
    expect(read([300])).toEqual({ checks: 524288 * kb, others: theirs })
    // This run, registered as another's, counts once.
    expect(read([100, 300])).toEqual({ checks: 524288 * kb, others: theirs })
  })
})

const kernel = (memory: NonNullable<Kernel["memory"]>): Kernel => ({
  pressure: "normal",
  swaps: 0,
  load1: 1,
  cores: 10,
  available: -1,
  memory,
})

const reading = (memory: NonNullable<Kernel["memory"]>, checks: Reading["memory"]): Reading => ({
  at: 0,
  workers: new Map(),
  check: 0,
  ...(checks === undefined ? {} : { memory: checks }),
  kernel: kernel(memory),
  swapping: -1,
  levels: { cpu: "green", pressure: "green", swapping: "green" },
})

describe("the memory budget with other runs", () => {
  test("adds their checks back, and says so", () => {
    const budget = budgetOf(
      reading({ total: 16 * gb, available: 4 * gb }, { checks: 2 * gb, others: 1.5 * gb }),
    )
    expect(budget.bytes).toBe(4 * gb + 2 * gb + 1.5 * gb - memoryReserve)
    expect(budget.words).toBe(
      "4.0 GB available, 2.0 GB in checks and 1.5 GB in other runs' checks, less the 2.0 GB reserve",
    )
    const none = budgetOf(reading({ total: 16 * gb, available: 4 * gb }, { checks: 0, others: 0 }))
    expect(none.words).toBe(
      "4.0 GB available, 0.0 GB in checks and 0.0 GB in other runs' checks, less the 2.0 GB reserve",
    )
  })

  test("a page another run's check takes from the kernel leaves it as it was, up to the machine", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 256 }),
        fc.integer({ min: 0, max: 256 }),
        fc.integer({ min: 0, max: 256 }),
        fc.integer({ min: 0, max: 256 }),
        (total, available, checks, others) => {
          const free = Math.min(available, total)
          const budget = budgetOf(
            reading(
              { total: total * gb, available: free * gb },
              { checks: checks * gb, others: others * gb },
            ),
          ).bytes
          expect(budget).toBeGreaterThanOrEqual(0)
          expect(budget).toBeLessThanOrEqual(Math.max(total * gb - memoryReserve, 0))
          if (free === 0) return
          const taken = budgetOf(
            reading(
              { total: total * gb, available: (free - 1) * gb },
              { checks: checks * gb, others: (others + 1) * gb },
            ),
          ).bytes
          expect(taken).toBe(budget)
        },
      ),
    )
  })
})

const everyoneAlive: ProcessCheck = { alive: () => true, start: () => Effect.succeed(null) }

describe("the other runs' processes", () => {
  test("a look keeps the registered runs' PIDs, and none once their folder is gone", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-other-runs-checks-")))
    const file = (pid: number) =>
      `{"pid":${pid},"repo":"/work/other","concurrent":2,"started":"2026-11-03T09:00:00Z","running":1}`
    writeFileSync(join(dir, "run-300-1.json"), file(300))
    writeFileSync(join(dir, "run-400-1.json"), file(400))
    const runs = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const machine = yield* make({ dir, repo: "/work/tutti", concurrent: 1 })
          const before = yield* machine.runs
          yield* machine.look
          const read = yield* machine.runs
          rmSync(dir, { recursive: true })
          yield* machine.look
          return { before, read, gone: yield* machine.runs }
        }),
      ).pipe(Effect.provideService(Processes, everyoneAlive), Effect.provide(BunServices.layer)),
    )
    expect(runs).toEqual({ before: [], read: [300, 400], gone: [] })
  })

  test("OtherWorkers keeps them beside the workers, for the run's readings", async () => {
    const kept = await Effect.runPromise(
      Effect.gen(function* () {
        const others = yield* OtherWorkers
        const before = { others: yield* others.others, runs: yield* others.runs }
        yield* others.set(3, [300, 400])
        const set = { others: yield* others.others, runs: yield* others.runs }
        yield* others.set(1)
        return { before, set, after: { others: yield* others.others, runs: yield* others.runs } }
      }).pipe(Effect.provide(otherWorkers)),
    )
    expect(kept).toEqual({
      before: { others: 0, runs: [] },
      set: { others: 3, runs: [300, 400] },
      after: { others: 1, runs: [] },
    })
  })

  test("each reading counts the checks of the runs as they are then", async () => {
    const source: LoadSource = {
      processes: Effect.succeed(processes),
      kernel: Effect.succeed(kernel({ total: 16 * gb, available: 4 * gb })),
    }
    const memory = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* Deferred.make<Reading["memory"]>()
        const fiber = yield* Effect.forkChild(
          watchLoad({
            source,
            roots: Effect.succeed(new Map([["t-1", 200]])),
            runs: Effect.succeed([300]),
            self: 100,
            show: (load) => Effect.asVoid(Deferred.succeed(first, load.memory)),
          }),
        )
        const memory = yield* Deferred.await(first)
        yield* Fiber.interrupt(fiber)
        return memory
      }).pipe(Effect.provide(BunServices.layer)),
    )
    expect(memory).toEqual({ checks: 524288 * kb, others: theirs })
  })
})
