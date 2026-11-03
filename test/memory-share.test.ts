// Each worker's checks get a share of the machine's memory beside their cores (tutti-epza.18): the
// budget from the load readings (src/run/share.ts' budgetOf), divided among the workers allowed,
// the other runs' and the merge check (src/agent/env.ts' memoryShare), at least a floor; kept live
// in .tutti/run/share.json, rewritten as the cap or the readings move it, and named in each
// worker's environment (TUTTI_SHARE_FILE) beside TUTTI_MEMORY_MB.
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
  orchestraMemoryVariable,
  sharedEnv,
  shareFileVariable,
} from "../src/agent/env.ts"
import { noServersNote } from "../src/agent/mcp.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import {
  type Kernel,
  memoryFloor,
  memoryReserve,
  memoryStep,
  newSampler,
  parseDarwin,
  parseProcesses,
  type Reading,
  sample,
} from "../src/run/load.ts"
import type { Log } from "../src/run/log.ts"
import {
  budgetOf,
  changeOf,
  type Division,
  type Kept,
  makeShareKeeper,
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
  test("divides the budget among the workers allowed and the merge check", () => {
    expect(memoryShare(9 * gb, 2)).toBe(3 * 1024)
    expect(memoryShare(8 * gb, 1)).toBe(4 * 1024)
    expect(memoryShare(12 * gb, 2, 1)).toBe(3 * 1024)
  })

  test("counts no more workers than the machine's cap", () => {
    expect(memoryShare(12 * gb, 2, 4, 3)).toBe(3 * 1024)
    expect(memoryShare(12 * gb, 2, 4, 0)).toBe(Math.floor((12 * 1024) / 7))
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
          const checks = (limit > 0 ? Math.min(all, limit) : all) + 1
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
  const vmstat = [
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                                     8176.",
    "Pages wired down:                             351930.",
    "Pages occupied by compressor:                 151496.",
  ].join("\n")

  test("macOS: hw.memsize, and vm_stat's wired pages and the compressor's", () => {
    expect(parseDarwin("1\n{ 1.00 1.00 1.00 }\n10\n17179869184\n", vmstat)?.memory).toEqual({
      total: 17179869184,
      wired: 351930 * 16384,
      compressed: 151496 * 16384,
    })
  })

  test("macOS: not known without hw.memsize, the page size or the counts", () => {
    expect(parseDarwin("1\n{ 1.00 1.00 1.00 }\n10\n", vmstat)?.memory).toBeUndefined()
    expect(parseDarwin("1\n{ 1 1 1 }\n10\n17179869184\n", "Pages wired down: 1.")?.memory).toBe(
      undefined,
    )
    expect(parseDarwin("1\n{ 1 1 1 }\n10\nlots\n", vmstat)?.memory).toBeUndefined()
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
    expect(reading.memory).toEqual({
      checks: (524288 + 262144) * 1024,
      others: (1000 + 50000 + 1048576 + 100000) * 1024,
    })
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
  test("macOS: the memory less wired, compressed, what isn't the checks' and the reserve", () => {
    const budget = budgetOf(
      reading(macKernel({ total: 16 * gb, wired: 5 * gb, compressed: 2 * gb }), {
        checks: 3 * gb,
        others: 4 * gb,
      }),
    )
    expect(budget.bytes).toBe(16 * gb - 5 * gb - 2 * gb - 4 * gb - memoryReserve)
    expect(budget.words).toBe(
      "16.0 GB less 5.0 GB wired, 2.0 GB compressed, 4.0 GB outside the checks and the 2.0 GB reserve",
    )
  })

  test("Linux: the memory available and the checks' own, less the reserve", () => {
    const linux = { ...macKernel({ total: 32 * gb, wired: 0, compressed: 0 }), available: 6 * gb }
    const budget = budgetOf(reading(linux, { checks: 2 * gb, others: 20 * gb }))
    expect(budget.bytes).toBe(6 * gb + 2 * gb - memoryReserve)
    expect(budget.words).toBe("6.0 GB available and 2.0 GB in checks, less the 2.0 GB reserve")
  })

  test("without the readings: half the machine's memory less the reserve", () => {
    expect(budgetOf(null, 16 * gb).bytes).toBe(8 * gb - memoryReserve)
    expect(budgetOf(reading(macKernel()), 16 * gb).bytes).toBe(8 * gb - memoryReserve)
    expect(budgetOf(reading(macKernel(), { checks: 0, others: 0 }), 16 * gb).bytes).toBe(
      8 * gb - memoryReserve,
    )
  })

  test("is never below none, however much else the machine holds", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 256 }),
        fc.integer({ min: 0, max: 256 }),
        fc.integer({ min: 0, max: 256 }),
        fc.integer({ min: 0, max: 256 }),
        fc.integer({ min: 0, max: 256 }),
        (total, wired, compressed, checks, others) => {
          const mac = reading(
            macKernel({ total: total * gb, wired: wired * gb, compressed: compressed * gb }),
            { checks: checks * gb, others: others * gb },
          )
          const budget = budgetOf(mac).bytes
          expect(budget).toBeGreaterThanOrEqual(0)
          expect(budget).toBeLessThanOrEqual(Math.max(total * gb - memoryReserve, 0))
          // What the checks hold is theirs: it never lowers the budget on macOS.
          const more = reading(mac.kernel, { checks: (checks + 1) * gb, others: others * gb })
          expect(budgetOf(more).bytes).toBe(budget)
        },
      ),
    )
  })
})

const machine = { cores: 10, limit: 0 }
const division = (over: Partial<Division> = {}): Division => ({
  budget: 9 * gb,
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
      from: { cores: 5, memory: 3072 },
      to: { cores: 10, memory: 4608 },
      why: "workers allowed 2 → 1",
    })
    expect(next === null ? "" : shareChangeLine(next.change)).toBe(
      "share: cores 5 → 10, memory 3.0 → 4.5 GB: workers allowed 2 → 1",
    )
  })

  test("follows the other runs' workers and the budget, naming each that moved", () => {
    const next = changeOf(kept(), machine, division({ others: 1, budget: 5 * gb }))
    expect(next?.change.why).toBe("other runs' workers 0 → 1, memory budget 9.0 → 5.0 GB")
    expect(next?.kept.division.others).toBe(1)
  })

  test("doesn't follow a budget that moves less than memoryStep a share", () => {
    const little = changeOf(kept(), machine, division({ budget: 9 * gb + 3 * (memoryStep - 1) }))
    expect(little).toBeNull()
    const enough = changeOf(kept(), machine, division({ budget: 9 * gb + 3 * memoryStep }))
    expect(enough?.change.to.memory).toBe(3072 + memoryStep / mebibyte)
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
      reading(macKernel({ total: 16 * gb, wired: 5 * gb, compressed: 2 * gb }), {
        checks: 0,
        others: 3 * gb,
      }),
    )
    expect(shareNote(budget, machine, { budget: 0, allowed: 2, others: 0 })).toBe(
      "share: memory budget 4.0 GB (16.0 GB less 5.0 GB wired, 2.0 GB compressed, 3.0 GB outside " +
        "the checks and the 2.0 GB reserve), divided among 3 (2 workers allowed and the merge " +
        "check): 1.3 GB a check, 5 cores a worker; kept live in .tutti/run/share.json",
    )
    expect(
      shareNote(budget, { cores: 8, limit: 0 }, { budget: 0, allowed: 1, others: 2 }),
    ).toContain("divided among 4 (1 worker allowed, 2 of other runs and the merge check)")
  })
})

/** The share file in `repo`, as a check script reads it. */
const readShare = (repo: string): { cores: number; memory_mb: number; at: string } =>
  JSON.parse(readFileSync(join(repo, shareFile), "utf8"))

describe("the run's share keeper", () => {
  const mac = (others: number) =>
    reading(macKernel({ total: 16 * gb, wired: 4 * gb, compressed: 1 * gb }), {
      checks: 0,
      others: others * gb,
    })

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

  test("writes the file as it is made, from no reading", async () => {
    await keep(({ repo }) =>
      Effect.gen(function* () {
        expect(readShare(repo)).toMatchObject({
          cores: 5,
          memory_mb: Math.floor((8 * gb - memoryReserve) / 3 / mebibyte),
        })
        expect(yield* (yield* Shares).now).toEqual({
          cores: 5,
          memory: Math.floor((8 * gb - memoryReserve) / 3 / mebibyte),
        })
      }),
    )
  })

  test("takes the first reading's share without a word, then says each change", async () => {
    const records = await keep(({ repo, allowed, keeper }) =>
      Effect.gen(function* () {
        // 16 less 4 wired, 1 compressed, 2 others and the 2 reserve: 7 GB among 3.
        yield* keeper.read(mac(2))
        expect(readShare(repo).memory_mb).toBe(Math.floor((7 * 1024) / 3))
        // The cap falls: 7 GB among 2.
        yield* Ref.set(allowed, 1)
        yield* keeper.read(mac(2))
        expect(readShare(repo)).toMatchObject({ cores: 10, memory_mb: Math.floor((7 * 1024) / 2) })
        expect(yield* (yield* Shares).now).toEqual({ cores: 10, memory: 3584 })
        // The readings move the budget by 3 GB: 4 GB among 2.
        yield* keeper.read(mac(5))
        expect(readShare(repo).memory_mb).toBe(2048)
        // A little more held elsewhere moves nothing.
        yield* keeper.read(mac(5.25))
        expect(readShare(repo).memory_mb).toBe(2048)
        return yield* (yield* Captured).records
      }),
    )
    expect(records.flatMap((record) => (record.kind === "share" ? [record.text] : []))).toEqual([
      "share: cores 5 → 10, memory 2.3 → 3.5 GB: workers allowed 2 → 1",
      "share: memory 3.5 → 2.0 GB: memory budget 7.0 → 4.0 GB",
    ])
    const first = records.find((record) => record.kind === "share")
    expect(first).toMatchObject({ cores: { from: 5, to: 10 }, memory: { from: 2389, to: 3584 } })
  })

  test("follows the cap without a reading, as the load stops being read", async () => {
    await keep(({ repo, allowed, keeper }) =>
      Effect.gen(function* () {
        yield* keeper.read(mac(2))
        yield* Ref.set(allowed, 3)
        yield* keeper.refresh
        expect(readShare(repo)).toMatchObject({ cores: 3, memory_mb: Math.floor((7 * 1024) / 4) })
        expect(yield* texts).toContain(
          "share: cores 5 → 3, memory 2.3 → 1.8 GB: workers allowed 2 → 3",
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
        yield* keeper.read(mac(2))
        yield* keeper.read(mac(6))
        expect((yield* (yield* Shares).now)?.memory).toBe(Math.floor((3 * 1024) / 2))
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
    const { repo, logged } = sessionMemory({ cores: 3, memory: 2560 })
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
