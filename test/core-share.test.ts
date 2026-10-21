// Each worker gets its share of the machine's cores for its checks (tutti-kkb.24): the cores
// divided among the run's workers, in TUTTI_CORES and ORCHESTRA_CORES and as -p in GOFLAGS, and
// the rules' note on checks says so. tutti's own test runner keeps bun's threads to it.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer, Schedule } from "effect"
import fc from "fast-check"
import { coreShareOf, coreThreadVariables, jscThreadVariables } from "../scripts/test.ts"
import { AgentHost } from "../src/agent/AgentHost.ts"
import { layer as liveLayer } from "../src/agent/AgentHostLive.ts"
import {
  coreShare,
  coresVariable,
  coreVariables,
  orchestraCoresVariable,
  probeEnv,
  setsParallel,
  workerEnv,
} from "../src/agent/env.ts"
import { noServersNote } from "../src/agent/mcp.ts"
import { defaultSettings } from "../src/cli/AppConfig.ts"
import { checkNote, coresNote } from "../src/project/prompt.ts"
import { appConfig, layer as configLayer } from "../src/testing/AppConfig.ts"
import { layer as attentionLayer, waitForTest } from "../src/testing/Attention.ts"
import { layer as eventsLayer } from "../src/testing/EventStream.ts"
import { layer as logLayer } from "../src/testing/Log.ts"
import { layer as transcriptsLayer } from "../src/testing/Transcripts.ts"

// The live host's test starts the fake Claude Code as a process: up to a second on an idle machine.
setDefaultTimeout(30_000)

const fake = resolve(import.meta.dir, "fixtures/fake-claude/claude.ts")

const shareVariables = [coresVariable, orchestraCoresVariable, "GOFLAGS"] as const

describe("coreShare", () => {
  test("gives one worker all the cores", () => {
    expect(coreShare(10, 1)).toBe(10)
  })

  test("divides the cores among several workers, rounding down", () => {
    expect(coreShare(10, 2)).toBe(5)
    expect(coreShare(10, 3)).toBe(3)
    expect(coreShare(10, 4)).toBe(2)
    expect(coreShare(16, 16)).toBe(1)
  })

  test("gives each worker at least one", () => {
    expect(coreShare(4, 8)).toBe(1)
    expect(coreShare(1, 16)).toBe(1)
    expect(coreShare(0, 1)).toBe(1)
  })

  test("counts the workers of the machine's other runs, up to the machine's cap", () => {
    expect(coreShare(10, 2, 3)).toBe(2)
    expect(coreShare(10, 2, 3, 4)).toBe(2)
    expect(coreShare(12, 2, 4, 3)).toBe(4)
    expect(coreShare(10, 2, 3, 0)).toBe(2)
  })

  test("takes a run of no workers as one", () => {
    expect(coreShare(8, 0)).toBe(8)
  })

  test("never gives the workers more cores than the machine has, while each has one", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 256 }),
        fc.integer({ min: 1, max: 16 }),
        fc.integer({ min: 0, max: 64 }),
        (cores, concurrent, others) => {
          const share = coreShare(cores, concurrent, others)
          const workers = concurrent + others
          expect(share).toBeGreaterThanOrEqual(1)
          if (cores >= workers) expect(share * workers).toBeLessThanOrEqual(cores)
          expect((share + 1) * workers).toBeGreaterThan(cores)
        },
      ),
    )
  })
})

describe("coreVariables", () => {
  test("sets TUTTI_CORES, ORCHESTRA_CORES and Go's -p", () => {
    expect(coreVariables(3)).toEqual({ TUTTI_CORES: "3", ORCHESTRA_CORES: "3", GOFLAGS: "-p=3" })
  })

  test("puts -p after the GOFLAGS the environment has", () => {
    expect(coreVariables(2, "  -mod=mod   -race ").GOFLAGS).toBe("-mod=mod -race -p=2")
  })

  test("keeps a -p the environment's GOFLAGS sets", () => {
    for (const goflags of ["-p=4", "-mod=mod --p=4", "-p"]) {
      const result = coreVariables(2, goflags)
      expect(result).not.toHaveProperty("GOFLAGS")
      expect(result.TUTTI_CORES).toBe("2")
    }
  })

  test("setsParallel finds -p only as a flag of its own", () => {
    expect(setsParallel(["-p=8"])).toBe(true)
    expect(setsParallel(["--p=8"])).toBe(true)
    expect(setsParallel(["-pgo=auto", "-parallel=2", "p=4", "-mod=mod"])).toBe(false)
  })
})

describe("workerEnv", () => {
  test("lays the share over the environment's own, after its GOFLAGS", () => {
    const result = workerEnv({
      env: { PATH: "/usr/bin", TUTTI_CORES: "16", ORCHESTRA_CORES: "16", GOFLAGS: "-mod=mod" },
      subscription: true,
      billing: "subscription",
      cores: 4,
    })
    expect(result).toMatchObject({
      PATH: "/usr/bin",
      TUTTI_CORES: "4",
      ORCHESTRA_CORES: "4",
      GOFLAGS: "-mod=mod -p=4",
    })
  })

  test("leaves the environment's alone without a share", () => {
    const result = workerEnv({
      env: { PATH: "/usr/bin", GOFLAGS: "-mod=mod" },
      subscription: true,
      billing: "subscription",
    })
    expect(result.GOFLAGS).toBe("-mod=mod")
    expect(result).not.toHaveProperty(coresVariable)
  })

  test("the probe's environment has no share", () => {
    const result = probeEnv({ env: { PATH: "/usr/bin" } })
    for (const name of shareVariables) expect(result).not.toHaveProperty(name)
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

/** The share variables a worker's session starts with, in a run of `concurrent` on `cores`. */
const sessionShare = (concurrent: number, cores: number) => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-core-share-"))
  const log = join(dir, "fake.jsonl")
  const config = appConfig({ claude: fake, settings: { ...defaultSettings, concurrent } }, dir)
  const env: Record<string, string | undefined> = {
    ...process.env,
    FAKE_CLAUDE_SCENARIO: JSON.stringify({ log, env: shareVariables }),
  }
  delete env.GOFLAGS
  const host = liveLayer({
    prompt: { text: "Work on TICKET_ID.", file: null },
    servers: { servers: [], note: noServersNote },
    account: { billing: { _tag: "Subscription", keyUnused: false }, subscription: true },
    env,
    cores,
  })
  return Effect.runPromise(
    Effect.gen(function* () {
      const agents = yield* AgentHost
      yield* agents.start("t-1", { sessionId: "11111111-1111-4111-8111-111111111111", cwd: dir })
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
    }).pipe(
      Effect.provide(
        host.pipe(
          Layer.provideMerge(Layer.mergeAll(attentionLayer(waitForTest), transcriptsLayer())),
          Layer.provideMerge(
            Layer.mergeAll(logLayer(), eventsLayer(), configLayer(config), BunServices.layer),
          ),
        ),
      ),
    ),
  )
}

describe("a worker's session", () => {
  test("gets all the cores in a run of one worker", async () => {
    expect(await sessionShare(1, 10)).toEqual([
      { TUTTI_CORES: "10", ORCHESTRA_CORES: "10", GOFLAGS: "-p=10" },
    ])
  })

  test("gets its share of the cores in a run of several workers", async () => {
    expect(await sessionShare(4, 10)).toEqual([
      { TUTTI_CORES: "2", ORCHESTRA_CORES: "2", GOFLAGS: "-p=2" },
    ])
  })
})

describe("the check note", () => {
  test("tells the worker its share of the cores is in its environment", () => {
    expect(coresNote).toContain(
      "Other workers' checks run on this machine beside yours: TUTTI_CORES in your environment " +
        "(and ORCHESTRA_CORES, for scripts written for orchestra) is your share of its cores",
    )
    expect(coresNote).toContain("GOFLAGS has Go's commands keep to it already (-p).")
    expect(checkNote("scripts/check-fast.sh")).toEndWith(`exit status. ${coresNote}\n`)
    expect(checkNote(null)).toContain(coresNote)
  })
})

describe("the test runner", () => {
  test("reads the share from TUTTI_CORES, or orchestra's ORCHESTRA_CORES", () => {
    expect(coreShareOf({ TUTTI_CORES: "3", ORCHESTRA_CORES: "5" })).toBe(3)
    expect(coreShareOf({ ORCHESTRA_CORES: " 5 " })).toBe(5)
    expect(coreShareOf({ TUTTI_CORES: "", ORCHESTRA_CORES: "2" })).toBe(2)
    expect(coreShareOf({})).toBeUndefined()
  })

  test("takes no share from anything but a whole number of at least one", () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const share = coreShareOf({ TUTTI_CORES: value })
        if (share !== undefined) {
          expect(Number.isInteger(share)).toBe(true)
          expect(share).toBeGreaterThanOrEqual(1)
          expect(value.trim()).toMatch(/^\d+$/)
        }
      }),
    )
    for (const value of ["0", "-2", "1.5", "two", "4x"]) {
      expect(coreShareOf({ TUTTI_CORES: value })).toBeUndefined()
    }
  })

  test("keeps bun's threads to a share below the machine's cores", () => {
    expect(coreThreadVariables({ TUTTI_CORES: "2" }, 10)).toEqual({
      BUN_JSC_numberOfGCMarkers: "2",
      BUN_JSC_numberOfFTLCompilerThreads: "2",
    })
    expect(Object.keys(coreThreadVariables({ ORCHESTRA_CORES: "1" }, 10))).toEqual([
      ...jscThreadVariables,
    ])
  })

  test("leaves bun's threads alone without a share, or with all the cores", () => {
    expect(coreThreadVariables({}, 10)).toEqual({})
    expect(coreThreadVariables({ TUTTI_CORES: "10" }, 10)).toEqual({})
    expect(coreThreadVariables({ TUTTI_CORES: "12" }, 10)).toEqual({})
  })

  test("keeps a thread count the environment sets", () => {
    expect(coreThreadVariables({ TUTTI_CORES: "2", BUN_JSC_numberOfGCMarkers: "6" }, 10)).toEqual({
      BUN_JSC_numberOfFTLCompilerThreads: "2",
    })
  })
})
