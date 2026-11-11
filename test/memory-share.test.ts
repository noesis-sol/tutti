// Each worker's checks get a share of the machine's memory beside their cores (tutti-epza.18): the
// budget from the load readings (src/run/share.ts' budgetOf), divided among the workers allowed,
// the other runs', a part each, and the merge check, mergeWeight parts (src/agent/env.ts'
// memoryShare, tutti-k4if.3), at least a floor; kept live in .tutti/run/share.json, rewritten as the
// cap or the readings move it, and named in each worker's environment (TUTTI_SHARE_FILE) beside
// TUTTI_MEMORY_MB.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer, Ref, Schedule } from "effect"
import fc from "fast-check"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import { ClaudeCode } from "../src/agent/ClaudeCode.ts"
import {
  mebibyte,
  memoryShare,
  memoryVariable,
  memoryVariables,
  mergeWeight,
  orchestraMemoryVariable,
  sharedEnv,
  shareFileVariable,
} from "../src/agent/env.ts"
import { noServersNote } from "../src/agent/mcp.ts"
import { defaultSettings } from "../src/cli/resolveConfig.ts"
import type { Log } from "../src/core/log.ts"
import {
  type Kernel,
  memoryFloor,
  memoryReserve,
  memoryStep,
  newSampler,
  parseDarwin,
  parseLinux,
  parseProcesses,
  type Reading,
  sample,
} from "../src/run/load.ts"
import {
  budgetOf,
  changeOf,
  type Division,
  gigabytes,
  type Kept,
  makeShareKeeper,
  mergeShareFile,
  type Share,
  Shares,
  shareChangeLine,
  shareFile,
  shareFileOf,
  shareLine,
  shareNote,
  shareOf,
  shares,
} from "../src/run/share.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { Captured, layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer, texts } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"
import { testEnv } from "./env.ts"
import { workersIn } from "./workerEnv.ts"

const gb = 1024 ** 3

describe("memoryShare", () => {
  test("divides the budget among the workers allowed, a part each, and the merge check, two", () => {
    expect(mergeWeight).toBe(2)
    expect(memoryShare(12 * gb, 2)).toBe(3 * 1024)
    expect(memoryShare(9 * gb, 1)).toBe(3 * 1024)
    expect(memoryShare(10 * gb, 2, 1)).toBe(2 * 1024)
  })

  test("counts no more workers than the machine's cap", () => {
    expect(memoryShare(10 * gb, 2, 4, 3)).toBe(2 * 1024)
    expect(memoryShare(12 * gb, 2, 4, 0)).toBe(Math.floor((12 * 1024) / 8))
  })

  test("is never under the floor, however short the machine", () => {
    expect(memoryShare(0, 4)).toBe(memoryFloor / mebibyte)
    expect(memoryShare(-5 * gb, 1)).toBe(memoryFloor / mebibyte)
    expect(memoryShare(2 * gb, 8)).toBe(memoryFloor / mebibyte)
  })

  test("never gives the checks more than the budget, while each is above the floor", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 512 * 1024 }),
        fc.integer({ min: 0, max: 16 }),
        fc.integer({ min: 0, max: 32 }),
        fc.integer({ min: 0, max: 32 }),
        (budgetMb, allowed, others, limit) => {
          const budget = budgetMb * mebibyte
          const share = memoryShare(budget, allowed, others, limit)
          const all = Math.max(allowed, 1) + others
          const checks = (limit > 0 ? Math.min(all, limit) : all) + mergeWeight
          expect(Number.isInteger(share)).toBe(true)
          expect(share * mebibyte).toBeGreaterThanOrEqual(memoryFloor)
          if (share * mebibyte > memoryFloor) {
            expect(share * mebibyte * checks).toBeLessThanOrEqual(budget)
          }
        },
      ),
    )
  })

  test("falls, or stays, as more workers share it", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 256 * 1024 }),
        fc.integer({ min: 1, max: 16 }),
        fc.integer({ min: 0, max: 16 }),
        (budgetMb, allowed, others) => {
          const budget = budgetMb * mebibyte
          expect(memoryShare(budget, allowed + 1, others)).toBeLessThanOrEqual(
            memoryShare(budget, allowed, others),
          )
          expect(memoryShare(budget, allowed, others + 1)).toBeLessThanOrEqual(
            memoryShare(budget, allowed, others),
          )
        },
      ),
    )
  })
})

describe("the variables", () => {
  test("give the memory share in MiB, under orchestra's name too, and the share file", () => {
    expect(memoryVariables(3584, "/repo/.tutti/run/share.json")).toEqual({
      TUTTI_MEMORY_MB: "3584",
      ORCHESTRA_MEMORY_MB: "3584",
      TUTTI_SHARE_FILE: "/repo/.tutti/run/share.json",
    })
    expect(memoryVariables(1024)).toEqual({ TUTTI_MEMORY_MB: "1024", ORCHESTRA_MEMORY_MB: "1024" })
  })

  test("a worker's environment has them beside its cores", () => {
    const env = sharedEnv(
      { PATH: "/usr/bin" },
      { checkTimeout: Duration.minutes(20), cores: 3, memory: 2048, file: "/r/share.json" },
    )
    expect(env).toMatchObject({
      TUTTI_CORES: "3",
      TUTTI_MEMORY_MB: "2048",
      ORCHESTRA_MEMORY_MB: "2048",
      TUTTI_SHARE_FILE: "/r/share.json",
    })
    const without = sharedEnv(
      { PATH: "/usr/bin" },
      { checkTimeout: Duration.minutes(20), cores: 3 },
    )
    expect(without).not.toHaveProperty(memoryVariable)
    expect(without).not.toHaveProperty(shareFileVariable)
  })
})

describe("the machine's memory", () => {
  // vm_stat on the 16 GB Mac under a run (tutti-lt2x), its 16 KB pages.
  const vmstat = [
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                                     3847.",
    "Pages active:                                 220310.",
    "Pages inactive:                               217875.",
    "Pages speculative:                              1063.",
    "Pages throttled:                                   0.",
    "Pages wired down:                             355049.",
    "Pages purgeable:                                1223.",
    "File-backed pages:                            130132.",
    "Anonymous pages:                              309116.",
    "Pages occupied by compressor:                 208995.",
  ].join("\n")

  test("macOS: hw.memsize, and vm_stat's free, inactive, speculative and purgeable pages", () => {
    expect(parseDarwin("1\n{ 1.00 1.00 1.00 }\n10\n17179869184\n", vmstat)?.memory).toEqual({
      total: 17179869184,
      available: (3847 + 217875 + 1063 + 1223) * 16384,
    })
  })

  test("macOS: not known without hw.memsize, the page size or the counts", () => {
    expect(parseDarwin("1\n{ 1.00 1.00 1.00 }\n10\n", vmstat)?.memory).toBeUndefined()
    expect(parseDarwin("1\n{ 1 1 1 }\n10\n17179869184\n", "Pages free: 1.")?.memory).toBe(undefined)
    const noPurgeable = vmstat.replace(/^Pages purgeable:.*$/m, "")
    expect(parseDarwin("1\n{ 1 1 1 }\n10\n17179869184\n", noPurgeable)?.memory).toBeUndefined()
    expect(parseDarwin("1\n{ 1 1 1 }\n10\nlots\n", vmstat)?.memory).toBeUndefined()
  })

  test("Linux: MemTotal, and MemAvailable as what programs could be given", () => {
    const kernel = parseLinux({
      loadavg: "1.00 1.00 1.00 1/100 1",
      pressure: "",
      meminfo: "MemTotal:       16384000 kB\nMemFree:  100 kB\nMemAvailable:    6000000 kB\n",
      vmstat: "",
      cores: 8,
    })
    expect(kernel?.memory).toEqual({ total: 16384000 * 1024, available: 6000000 * 1024 })
    const old = parseLinux({
      loadavg: "1.00 1.00 1.00 1/100 1",
      pressure: "",
      meminfo: "MemTotal:       16384000 kB\n",
      vmstat: "",
      cores: 8,
    })
    expect(old?.memory).toEqual({ total: 16384000 * 1024, available: -1 })
  })

  test("the listing parts the checks' memory from the rest", () => {
    const listing = [
      "    1     0     1   1000", // launchd
      "  100     1   100  50000", // tutti
      "  200   100   200 1048576", // t-1's Claude Code
      "  201   200   200 524288", // its check
      "  400   100   400 262144", // the merge check
      "  500     1   500 100000", // another program
    ].join("\n")
    const { reading } = sample({
      sampler: newSampler,
      now: 0,
      processes: parseProcesses(listing),
      kernel: undefined,
      roots: new Map([["t-1", 200]]),
      self: 100,
    })
    expect(reading.memory).toEqual({ checks: (524288 + 262144) * 1024 })
    const none = sample({
      sampler: newSampler,
      now: 0,
      processes: undefined,
      kernel: undefined,
      roots: new Map(),
      self: 100,
    })
    expect(none.reading.memory).toBeUndefined()
  })
})

const macKernel = (memory?: Kernel["memory"]): Kernel => ({
  pressure: "normal",
  swaps: 0,
  load1: 1,
  cores: 10,
  available: -1,
  ...(memory === undefined ? {} : { memory }),
})

const reading = (kernel: Kernel, memory?: Reading["memory"]): Reading => ({
  at: 0,
  workers: new Map(),
  check: 0,
  ...(memory === undefined ? {} : { memory }),
  kernel,
  swapping: -1,
  levels: { cpu: "green", pressure: "green", swapping: "green" },
})

describe("the memory budget", () => {
  test("the memory available and the checks' own, less the reserve", () => {
    const budget = budgetOf(
      reading(macKernel({ total: 16 * gb, available: 4 * gb }), { checks: 3 * gb }),
    )
    expect(budget.bytes).toBe(4 * gb + 3 * gb - memoryReserve)
    expect(budget.words).toBe("4.0 GB available and 3.0 GB in checks, less the 2.0 GB reserve")
  })

  test("macOS under a run: no longer nothing, as shared pages count once (tutti-lt2x)", () => {
    // The vm_stat above, the run's checks holding 2.2 GB: wired 5.4 GB, the compressor 3.2 GB and
    // 7.3 GB of resident memory outside the checks left nothing of the 16 GB.
    const kernel = parseDarwin(
      "1\n{ 1.00 1.00 1.00 }\n10\n17179869184\n",
      [
        "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
        "Pages free:                                     3847.",
        "Pages inactive:                               217875.",
        "Pages speculative:                              1063.",
        "Pages wired down:                             355049.",
        "Pages purgeable:                                1223.",
        "Pages occupied by compressor:                 208995.",
      ].join("\n"),
    )
    if (kernel === undefined) throw new Error("vm_stat unread")
    const budget = budgetOf(reading(kernel, { checks: 2.2 * gb }))
    expect(gigabytes(budget.bytes)).toBe("3.6")
    expect(budget.words).toBe("3.4 GB available and 2.2 GB in checks, less the 2.0 GB reserve")
  })

  test("Linux: MemAvailable, as the kernel's memory says it", () => {
    const linux = { ...macKernel({ total: 32 * gb, available: 6 * gb }), available: 6 * gb }
    const budget = budgetOf(reading(linux, { checks: 2 * gb }))
    expect(budget.bytes).toBe(6 * gb + 2 * gb - memoryReserve)
    expect(budget.words).toBe("6.0 GB available and 2.0 GB in checks, less the 2.0 GB reserve")
  })

  test("without the readings: half the machine's memory less the reserve", () => {
    expect(budgetOf(null, 16 * gb).bytes).toBe(8 * gb - memoryReserve)
    expect(budgetOf(reading(macKernel()), 16 * gb).bytes).toBe(8 * gb - memoryReserve)
    expect(budgetOf(reading(macKernel(), { checks: 0 }), 16 * gb).bytes).toBe(
      8 * gb - memoryReserve,
    )
    const unread = macKernel({ total: 16 * gb, available: -1 })
    expect(budgetOf(reading(unread, { checks: gb }), 16 * gb).words).toStartWith("half of 16.0 GB")
  })

  test("is never below none nor past the machine, and what the checks hold is theirs", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 256 }),
        fc.integer({ min: 0, max: 256 }),
        fc.integer({ min: 0, max: 256 }),
        (total, available, checks) => {
          const kernel = macKernel({
            total: total * gb,
            available: Math.min(available, total) * gb,
          })
          const budget = budgetOf(reading(kernel, { checks: checks * gb })).bytes
          expect(budget).toBeGreaterThanOrEqual(0)
          expect(budget).toBeLessThanOrEqual(Math.max(total * gb - memoryReserve, 0))
          // A check that takes a page the kernel had spare leaves the budget as it was.
          if (available === 0) return
          const taken = macKernel({
            total: total * gb,
            available: (Math.min(available, total) - 1) * gb,
          })
          expect(budgetOf(reading(taken, { checks: (checks + 1) * gb })).bytes).toBe(budget)
        },
      ),
    )
  })
})

const machine = { cores: 10, limit: 0 }
const division = (over: Partial<Division> = {}): Division => ({
  budget: 12 * gb,
  allowed: 2,
  others: 0,
  ...over,
})
const kept = (over: Partial<Division> = {}): Kept => ({
  share: shareOf(machine, division(over)),
  division: division(over),
})

describe("a change of the share", () => {
  test("follows the workers allowed, saying so", () => {
    const next = changeOf(kept(), machine, division({ allowed: 1 }))
    expect(next?.change).toEqual({
      from: { cores: 5, memory: 3072, merge: { cores: 10, memory: 6144 } },
      to: { cores: 10, memory: 4096, merge: { cores: 10, memory: 8192 } },
      why: "workers allowed 2 → 1",
    })
    expect(next === null ? "" : shareChangeLine(next.change)).toBe(
      "share: cores 5 → 10, memory 3.0 → 4.0 GB; merge check memory 6.0 → 8.0 GB: workers allowed 2 → 1",
    )
  })

  test("follows the other runs' workers and the budget, naming each that moved", () => {
    const next = changeOf(kept(), machine, division({ others: 1, budget: 5 * gb }))
    expect(next?.change.why).toBe("other runs' workers 0 → 1, memory budget 12.0 → 5.0 GB")
    expect(next?.kept.division.others).toBe(1)
  })

  test("doesn't follow a budget that moves less than memoryStep a share", () => {
    const little = changeOf(kept(), machine, division({ budget: 12 * gb + 4 * (memoryStep - 1) }))
    expect(little).toBeNull()
    const enough = changeOf(kept(), machine, division({ budget: 12 * gb + 4 * memoryStep }))
    expect(enough?.change.to.memory).toBe(3072 + memoryStep / mebibyte)
    expect(enough?.change.to.merge.memory).toBe(2 * (3072 + memoryStep / mebibyte))
  })

  test("is none where nothing moves", () => {
    expect(changeOf(kept(), machine, division())).toBeNull()
    // At the floor, a falling budget changes nothing.
    const floor = kept({ budget: 0 })
    expect(changeOf(floor, machine, division({ budget: 0, allowed: 2 }))).toBeNull()
  })

  test("whatever the readings, a change is to the share they give", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 64 * 1024 }),
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 0, max: 8 }),
        (budgetMb, allowed, others) => {
          const now = division({ budget: budgetMb * mebibyte, allowed, others })
          const next = changeOf(kept(), machine, now)
          if (next !== null) expect(next.kept.share).toEqual(shareOf(machine, now))
          if (allowed !== 2 || others !== 0) {
            const share = shareOf(machine, now)
            const same = share.cores === 5 && share.memory === 3072
            expect(next === null).toBe(same)
          }
        },
      ),
    )
  })
})

describe("the share file", () => {
  test("is a JSON line of the cores, the memory in MiB and when", () => {
    const line = shareLine({ cores: 3, memory: 3584 }, Date.parse("2026-11-03T09:12:40Z"))
    expect(line).toBe('{"cores":3,"memory_mb":3584,"at":"2026-11-03T09:12:40.000Z"}\n')
    expect(line.trim().split("\n")).toHaveLength(1)
    expect(shareFileOf("/repo")).toBe("/repo/.tutti/run/share.json")
  })
})

describe("the START block's note", () => {
  test("says the budget, what it is made of and how it is divided", () => {
    const budget = budgetOf(
      reading(macKernel({ total: 16 * gb, available: 5 * gb }), { checks: gb }),
    )
    expect(shareNote(budget, machine, { budget: 0, allowed: 2, others: 0 })).toBe(
      "share: memory budget 4.0 GB (5.0 GB available and 1.0 GB in checks, less the 2.0 GB " +
        "reserve), divided into 4 parts (2 workers allowed, a part each, and the merge check, 2 " +
        "parts): 1.0 GB and 5 cores a worker's checks, 2.0 GB and 10 cores the merge check's; " +
        "kept live in .tutti/run/share.json and .tutti/run/merge-share.json",
    )
    expect(
      shareNote(budget, { cores: 8, limit: 0 }, { budget: 0, allowed: 1, others: 2 }),
    ).toContain(
      "divided into 5 parts (1 worker allowed, 2 of other runs, a part each, and the merge check, 2 parts)",
    )
  })
})

/** The share file in `repo`, a worker's or `file`, as a check script reads it. */
const readShare = (
  repo: string,
  file = shareFile,
): { cores: number; memory_mb: number; at: string } =>
  JSON.parse(readFileSync(join(repo, file), "utf8"))

describe("the run's share keeper", () => {
  const mac = (available: number) =>
    reading(macKernel({ total: 16 * gb, available: available * gb }), { checks: 0 })

  const keep = <A>(
    body: (options: {
      readonly repo: string
      readonly allowed: Ref.Ref<number>
      readonly keeper: Effect.Success<ReturnType<typeof makeShareKeeper>>
    }) => Effect.Effect<A, never, Captured | Log>,
  ) => {
    const repo = mkdtempSync(join(tmpdir(), "tutti-memory-share-"))
    return Effect.runPromise(
      Effect.gen(function* () {
        const allowed = yield* Ref.make(2)
        const keeper = yield* makeShareKeeper({
          repo,
          machine,
          allowed: Ref.get(allowed),
          others: Effect.succeed(0),
          total: 16 * gb,
        })
        return yield* body({ repo, allowed, keeper })
      }).pipe(Effect.provide(Layer.mergeAll(logLayer(), eventsLayer(), shares))),
    )
  }

  test("writes the files as it is made, from no reading", async () => {
    await keep(({ repo }) =>
      Effect.gen(function* () {
        const memory = Math.floor((8 * gb - memoryReserve) / 4 / mebibyte)
        expect(readShare(repo)).toMatchObject({ cores: 5, memory_mb: memory })
        expect(readShare(repo, mergeShareFile)).toMatchObject({ cores: 10, memory_mb: 2 * memory })
        expect(yield* (yield* Shares).now).toEqual({
          cores: 5,
          memory,
          merge: { cores: 10, memory: 2 * memory },
        })
      }),
    )
  })

  test("takes the first reading's share without a word, then says each change", async () => {
    const records = await keep(({ repo, allowed, keeper }) =>
      Effect.gen(function* () {
        // 10 GB available less the 2 reserve: 8 GB in 4 parts.
        yield* keeper.read(mac(10))
        expect(readShare(repo).memory_mb).toBe(2048)
        expect(readShare(repo, mergeShareFile).memory_mb).toBe(4096)
        // The cap falls: 8 GB in 3 parts.
        yield* Ref.set(allowed, 1)
        yield* keeper.read(mac(10))
        expect(readShare(repo)).toMatchObject({ cores: 10, memory_mb: Math.floor((8 * 1024) / 3) })
        expect(yield* (yield* Shares).now).toEqual({
          cores: 10,
          memory: 2730,
          merge: { cores: 10, memory: 5460 },
        })
        // The readings move the budget by 3 GB: 5 GB in 3 parts.
        yield* keeper.read(mac(7))
        expect(readShare(repo).memory_mb).toBe(Math.floor((5 * 1024) / 3))
        expect(readShare(repo, mergeShareFile).memory_mb).toBe(2 * 1706)
        // A little more held elsewhere moves nothing.
        yield* keeper.read(mac(6.75))
        expect(readShare(repo).memory_mb).toBe(1706)
        return yield* (yield* Captured).records
      }),
    )
    expect(records.flatMap((record) => (record.kind === "share" ? [record.text] : []))).toEqual([
      "share: cores 5 → 10, memory 2.0 → 2.7 GB; merge check memory 4.0 → 5.3 GB: workers allowed 2 → 1",
      "share: memory 2.7 → 1.7 GB; merge check memory 5.3 → 3.3 GB: memory budget 8.0 → 5.0 GB",
    ])
    const first = records.find((record) => record.kind === "share")
    expect(first).toMatchObject({ cores: { from: 5, to: 10 }, memory: { from: 2048, to: 2730 } })
  })

  test("follows the cap without a reading, as the load stops being read", async () => {
    await keep(({ repo, allowed, keeper }) =>
      Effect.gen(function* () {
        yield* keeper.read(mac(10))
        yield* Ref.set(allowed, 3)
        yield* keeper.refresh
        expect(readShare(repo)).toMatchObject({ cores: 3, memory_mb: Math.floor((8 * 1024) / 5) })
        expect(readShare(repo, mergeShareFile)).toMatchObject({ cores: 6, memory_mb: 2 * 1638 })
        expect(yield* texts).toContain(
          "share: cores 5 → 3, memory 2.0 → 1.6 GB; merge check cores 10 → 6, memory 4.0 → 3.2 GB: workers allowed 2 → 3",
        )
      }),
    )
  })

  test("says once that the file can't be written, and keeps the share", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tutti-memory-share-"))
    await Bun.write(join(repo, ".tutti"), "not a folder")
    const said = await Effect.runPromise(
      Effect.gen(function* () {
        const keeper = yield* makeShareKeeper({
          repo,
          machine,
          allowed: Effect.succeed(1),
          others: Effect.succeed(0),
          total: 16 * gb,
        })
        yield* keeper.read(mac(9))
        yield* keeper.read(mac(5))
        expect((yield* (yield* Shares).now)?.memory).toBe(1024)
        return yield* texts
      }).pipe(Effect.provide(Layer.mergeAll(logLayer(), eventsLayer(), shares))),
    )
    expect(said.filter((text) => text.startsWith("SHARE_UNWRITTEN: "))).toHaveLength(1)
  })
})

/** The fake's log: the environment variables it was asked for, as each session started. */
const loggedEnv = (file: string): ReadonlyArray<Record<string, string | null>> =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line))
        .flatMap((entry) => (entry.env === undefined ? [] : [entry.env]))
    : []

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

const memoryNames = [memoryVariable, orchestraMemoryVariable, shareFileVariable] as const

/** The memory variables a worker's session starts with, the run keeping `kept` (none: null). */
const sessionMemory = (kept: Share | null) => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-memory-share-"))
  const log = join(dir, "fake.jsonl")
  const config = appConfig({ claude: fake, settings: { ...defaultSettings, concurrent: 2 } }, dir)
  const env: Record<string, string | undefined> = {
    ...testEnv,
    FAKE_CLAUDE_SCENARIO: JSON.stringify({ log, env: memoryNames }),
  }
  const host = liveLayer({
    prompt: { text: "Work on TICKET_ID.", file: null },
    servers: { servers: [], note: noServersNote },
    account: { billing: { _tag: "Subscription", keyUnused: false } },
    cores: 10,
  })
  const run = Effect.gen(function* () {
    if (kept !== null) yield* (yield* Shares).set(kept)
    const agents = yield* AgentHost
    yield* agents.start("t-1" as TicketId, {
      sessionId: "11111111-1111-4111-8111-111111111111",
      cwd: dir,
    })
    return yield* Effect.sync(() => loggedEnv(log)).pipe(
      Effect.repeat({
        until: (found) => found.length > 0,
        schedule: Schedule.spaced(Duration.millis(20)),
      }),
      Effect.timeoutOrElse({
        duration: Duration.seconds(10),
        orElse: () => Effect.die("the fake never logged its environment"),
      }),
    )
  })
  return {
    repo: config.repo,
    logged: Effect.runPromise(
      Effect.scoped(
        run.pipe(
          Effect.provide(
            host.pipe(
              Layer.provideMerge(
                Layer.mergeAll(
                  attentionLayer(waitForTest),
                  transcriptsLayer(),
                  ClaudeCode.layer.pipe(Layer.provide(workersIn(env))),
                ),
              ),
              Layer.provideMerge(
                Layer.mergeAll(logLayer(), eventsLayer(), configLayer(config), BunServices.layer),
              ),
              Layer.provideMerge(shares),
            ),
          ),
        ),
      ),
    ),
  }
}

describe("a worker's session", () => {
  test("names the share file, with the share the run keeps", async () => {
    const { repo, logged } = sessionMemory({
      cores: 3,
      memory: 2560,
      merge: { cores: 6, memory: 5120 },
    })
    expect(await logged).toEqual([
      {
        TUTTI_MEMORY_MB: "2560",
        ORCHESTRA_MEMORY_MB: "2560",
        TUTTI_SHARE_FILE: shareFileOf(repo),
      },
    ])
  }, 30_000)

  test("names none where the run keeps no share, its memory worked out from the machine's", async () => {
    const [env] = await sessionMemory(null).logged
    expect(env?.TUTTI_SHARE_FILE ?? null).toBeNull()
    expect(Number(env?.TUTTI_MEMORY_MB)).toBeGreaterThanOrEqual(memoryFloor / mebibyte)
  }, 30_000)
})
