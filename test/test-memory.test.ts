// scripts/test.ts sizes its test processes by the memory as well as the cores (tutti-epza.19): the
// least of the cores share (or TUTTI_TEST_PARALLEL) and the memory share over what one process
// takes, which each run learns and keeps in .cache/test-memory.json, and says its choice first.

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import fc from "fast-check"
import {
  darwinAvailable,
  defaultProcessMemory,
  heldProcesses,
  highMark,
  linuxAvailable,
  type MemoryRecord,
  memoryRecordPath,
  memoryShareOf,
  parseMemoryRecord,
  processPeak,
  recordedRuns,
  recordFiles,
  recordRun,
  shareFileVariables,
  testProcesses,
  warnHold,
} from "../scripts/test.ts"
import { mebibyte } from "../src/agent/env.ts"
import { parseProcesses } from "../src/run/load.ts"
import { testEnv } from "./env.ts"

const gb = 1024 ** 3

describe("testProcesses", () => {
  const each = 1.5 * gb

  test("are the cores share where the memory holds that many", () => {
    const sizing = { memory: 8 * gb, each }
    expect(testProcesses({ TUTTI_CORES: "3" }, [], sizing, 10)).toEqual({
      processes: 3,
      line: "scripts/test.sh: 3 processes (cores 3, memory 8.0 GB at ~1.5 GB each)",
    })
    expect(testProcesses({}, [], sizing, 10).processes).toBe(5)
  })

  test("are the processes the memory share holds where it holds fewer", () => {
    expect(testProcesses({ TUTTI_CORES: "5" }, [], { memory: 4.6 * gb, each }, 10)).toEqual({
      processes: 3,
      line: "scripts/test.sh: 3 processes (cores 5, memory 4.6 GB at ~1.5 GB each)",
    })
    expect(
      testProcesses({ TUTTI_CORES: "5" }, [], { memory: 3 * gb, each: gb }, 10).processes,
    ).toBe(3)
  })

  test("are at least one, though the memory holds none", () => {
    expect(testProcesses({ TUTTI_CORES: "5" }, [], { memory: 0, each }, 10)).toEqual({
      processes: 1,
      line: "scripts/test.sh: 1 process (cores 5, memory 0.0 GB at ~1.5 GB each)",
    })
  })

  test("are the cores share where the memory isn't known", () => {
    expect(testProcesses({ TUTTI_CORES: "4" }, [], { memory: undefined, each }, 10)).toEqual({
      processes: 4,
      line: "scripts/test.sh: 4 processes (cores 4, memory not known)",
    })
  })

  test("take TUTTI_TEST_PARALLEL for the cores share, and the memory still caps it", () => {
    const env = { TUTTI_TEST_PARALLEL: "8", TUTTI_CORES: "2" }
    expect(testProcesses(env, [], { memory: 20 * gb, each }, 10).processes).toBe(8)
    expect(testProcesses(env, [], { memory: 6 * gb, each }, 10)).toEqual({
      processes: 4,
      line: "scripts/test.sh: 4 processes (TUTTI_TEST_PARALLEL 8, memory 6.0 GB at ~1.5 GB each)",
    })
    expect(testProcesses({ TUTTI_TEST_PARALLEL: "1" }, [], { memory: 20 * gb, each }, 10)).toEqual({
      processes: 1,
      line: "scripts/test.sh: 1 process (TUTTI_TEST_PARALLEL 1, memory 20.0 GB at ~1.5 GB each)",
    })
  })

  test("are no more than the files named, nor than a run that met memory pressure allows", () => {
    const sizing = { memory: 20 * gb, each }
    expect(
      testProcesses({ TUTTI_CORES: "5" }, ["test/a.test.ts", "test/b.test.ts"], sizing, 10),
    ).toEqual({
      processes: 2,
      line: "scripts/test.sh: 2 processes (cores 5, memory 20.0 GB at ~1.5 GB each, 2 files)",
    })
    expect(testProcesses({ TUTTI_CORES: "5" }, [], { ...sizing, held: 2 }, 10)).toEqual({
      processes: 2,
      line:
        "scripts/test.sh: 2 processes (cores 5, memory 20.0 GB at ~1.5 GB each, " +
        "no more than 2 as memory pressure reached warn lately)",
    })
  })

  test("leave the processes to arguments that choose --parallel themselves", () => {
    expect(testProcesses({}, ["--parallel=3"], { memory: 0, each }, 10).processes).toBe(1)
  })

  test("are at least one and at most what each of the cores, the memory and the files allow", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 64 }),
        fc.integer({ min: 1, max: 64 }),
        fc.integer({ min: 0, max: 64 * 1024 }),
        fc.integer({ min: 64, max: 4096 }),
        fc.integer({ min: 0, max: 10 }),
        (cores, share, memoryMb, eachMb, files) => {
          const args = Array.from({ length: files }, (_, index) => `test/f${index}.test.ts`)
          const sizing = { memory: memoryMb * mebibyte, each: eachMb * mebibyte }
          const { processes } = testProcesses({ TUTTI_CORES: String(share) }, args, sizing, cores)
          expect(processes).toBeGreaterThanOrEqual(1)
          expect(processes).toBeLessThanOrEqual(share)
          if (files > 0) expect(processes).toBeLessThanOrEqual(files)
          if (memoryMb >= eachMb) expect(processes * eachMb).toBeLessThanOrEqual(memoryMb)
          else expect(processes).toBe(1)
        },
      ),
    )
  })
})

describe("the memory share", () => {
  test("is TUTTI_MEMORY_MB, or ORCHESTRA_MEMORY_MB, in MiB", () => {
    expect(memoryShareOf({ TUTTI_MEMORY_MB: "2048", ORCHESTRA_MEMORY_MB: "1024" })).toBe(2 * gb)
    expect(memoryShareOf({ ORCHESTRA_MEMORY_MB: " 1024 " })).toBe(gb)
    expect(memoryShareOf({ TUTTI_MEMORY_MB: "", ORCHESTRA_MEMORY_MB: "512" })).toBe(512 * mebibyte)
    for (const value of ["0", "-1", "1.5", "lots", ""]) {
      expect(memoryShareOf({ TUTTI_MEMORY_MB: value })).toBeUndefined()
    }
  })

  test("follows the share file over the variables, which keep the share as the session started", () => {
    const file = (text: string) =>
      shareFileVariables({ TUTTI_SHARE_FILE: "/run/share.json" }, (path) => {
        expect(path).toBe("/run/share.json")
        return text
      })
    expect(file('{"cores":3,"memory_mb":3584,"at":"2026-11-03T09:12:40.000Z"}\n')).toEqual({
      TUTTI_CORES: "3",
      TUTTI_MEMORY_MB: "3584",
    })
    expect(file('{"cores":0,"memory_mb":1.5}')).toEqual({})
    expect(file('{"memory_mb":1024}')).toEqual({ TUTTI_MEMORY_MB: "1024" })
    for (const text of ["", "null", "[1]", "{not json", '"3"']) expect(file(text)).toEqual({})
  })

  test("is none from a share file that is unset or can't be read", () => {
    const unread = () => {
      throw new Error("ENOENT")
    }
    expect(shareFileVariables({}, unread)).toEqual({})
    expect(shareFileVariables({ TUTTI_SHARE_FILE: "" }, unread)).toEqual({})
    expect(shareFileVariables({ TUTTI_SHARE_FILE: "/gone/share.json" }, unread)).toEqual({})
  })

  test("outside tutti is what the machine can give programs now", () => {
    const vmstat = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                                     3984.",
      "Pages active:                                 227374.",
      "Pages inactive:                               221858.",
      "Pages speculative:                              4463.",
      "Pages wired down:                             367814.",
      "Pages purgeable:                                 532.",
    ].join("\n")
    expect(darwinAvailable(vmstat)).toBe((3984 + 221858 + 532) * 16384)
    expect(darwinAvailable(vmstat.replace(/Pages purgeable.*/, ""))).toBeUndefined()
    expect(darwinAvailable(vmstat.replace(/\(page size.*\)/, ""))).toBeUndefined()
    const meminfo = "MemTotal:       16384000 kB\nMemFree:  100 kB\nMemAvailable:    8192000 kB\n"
    expect(linuxAvailable(meminfo)).toBe(8192000 * 1024)
    expect(linuxAvailable("MemTotal: 1 kB\n")).toBeUndefined()
  })
})

const run = (peak: number, at = "2026-11-03T10:00:00.000Z") => ({
  at,
  peak_mb: peak,
  children_mb: 0,
  processes: 3,
  files: 700,
  slow: false,
})

describe("the memory record", () => {
  test("learns the 90th percentile of its runs' peaks, and nothing without one", () => {
    expect(highMark({ runs: [] })).toBeUndefined()
    expect(highMark({ runs: [run(1149)] })).toBe(1149 * mebibyte)
    const ten = [900, 1000, 950, 1100, 1050, 980, 1020, 990, 1010, 3000].map((peak) => run(peak))
    expect(highMark({ runs: ten })).toBe(1100 * mebibyte)
    expect(highMark({ runs: [...ten, run(1200)] })).toBe(1200 * mebibyte)
  })

  test("keeps a run's peak where it ran enough files, and its recent runs only", () => {
    const at = Date.parse("2026-11-03T10:00:00.000Z")
    const watched = { peak: 1149 * mebibyte + 1, children: 0, warned: false, at, processes: 3 }
    const plain = { ...watched, slow: false }
    expect(recordRun({ runs: [] }, { ...plain, files: recordFiles })).toEqual({
      runs: [{ ...run(1150), processes: 3, files: recordFiles }],
    })
    expect(recordRun({ runs: [] }, { ...plain, files: recordFiles - 1 })).toEqual({ runs: [] })
    expect(recordRun({ runs: [] }, { ...plain, peak: 0, files: 700 })).toEqual({ runs: [] })
    const full: MemoryRecord = { runs: Array.from({ length: recordedRuns }, (_, i) => run(i + 1)) }
    const next = recordRun(full, { ...plain, files: 700 })
    expect(next.runs).toHaveLength(recordedRuns)
    expect(next.runs[0]?.peak_mb).toBe(2)
    expect(next.runs.at(-1)?.peak_mb).toBe(1150)
  })

  test("keeps the last run that met memory pressure, which holds the next runs to fewer", () => {
    const at = Date.parse("2026-11-03T10:00:00.000Z")
    const none = { peak: 0, children: 0, slow: false }
    const warned = recordRun({ runs: [] }, { ...none, warned: true, at, processes: 3, files: 2 })
    expect(warned).toEqual({ runs: [], warn: { at: "2026-11-03T10:00:00.000Z", processes: 3 } })
    expect(heldProcesses(warned, at + 60_000)).toBe(2)
    expect(heldProcesses(warned, at + warnHold)).toBeUndefined()
    expect(heldProcesses(warned, at - 60_000)).toBeUndefined()
    expect(heldProcesses({ runs: [] }, at)).toBeUndefined()
    const one = recordRun({ runs: [] }, { ...none, warned: true, at, processes: 1, files: 2 })
    expect(heldProcesses(one, at)).toBe(1)
    const calm = recordRun(warned, { ...none, warned: false, at: at + 1, processes: 2, files: 2 })
    expect(calm.warn).toEqual(warned.warn)
  })

  test("reads back what it writes, and nothing from a file that isn't one", () => {
    const record: MemoryRecord = {
      runs: [run(1149), run(980)],
      warn: { at: "2026-11-03T10:00:00.000Z", processes: 3 },
    }
    expect(parseMemoryRecord(JSON.stringify(record))).toEqual(record)
    for (const text of ["", "{", "null", "[]", '{"runs":"x"}']) {
      expect(parseMemoryRecord(text)).toEqual({ runs: [] })
    }
    expect(
      parseMemoryRecord(
        JSON.stringify({
          runs: [run(0), { ...run(5), at: "yesterday" }, null, run(700)],
          warn: { at: "2026-11-03T10:00:00.000Z", processes: 0 },
        }),
      ),
    ).toEqual({ runs: [run(700)] })
  })

  test("never reads a record from text that isn't one", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const record = parseMemoryRecord(text)
        expect(record.runs.length).toBeLessThanOrEqual(recordedRuns)
        const mark = highMark(record)
        if (mark !== undefined) expect(mark).toBeGreaterThanOrEqual(mebibyte)
      }),
    )
  })

  test("is the file TUTTI_TEST_MEMORY_FILE names, else .cache/test-memory.json in the checkout", () => {
    expect(memoryRecordPath({ TUTTI_TEST_MEMORY_FILE: "/x/record.json" })).toBe("/x/record.json")
    const outside = mkdtempSync(join(tmpdir(), "tutti-test-memory-"))
    expect(memoryRecordPath({}, outside)).toBe(join(outside, ".cache", "test-memory.json"))
    const checkout = resolve(import.meta.dir, "..")
    expect(memoryRecordPath({}, join(checkout, "test"))).toEndWith("/.cache/test-memory.json")
  })
})

describe("processPeak", () => {
  // pid ppid pgid rss (KiB): bun test 100, its workers 101 and 102, a git 103 one of 102's tests
  // started, and 200, not the run's.
  const listing = parseProcesses(
    [
      "100 1 100 51200",
      "101 100 101 409600",
      "102 100 102 307200",
      "103 102 102 204800",
      "200 1 200 4096000",
    ].join("\n"),
  )

  test("is the most a test process takes, and apart the most its tests started", () => {
    if (listing === undefined) throw new Error("the listing didn't parse")
    expect(processPeak(listing, 100, true)).toEqual({
      own: 400 * mebibyte,
      children: 200 * mebibyte,
    })
  })

  test("is bun test's own, and all below it, where it runs the files itself", () => {
    if (listing === undefined) throw new Error("the listing didn't parse")
    expect(processPeak(listing, 100, false)).toEqual({
      own: 50 * mebibyte,
      children: 900 * mebibyte,
    })
    expect(processPeak(listing, 999, false)).toEqual({ own: 0, children: 0 })
  })
})

const script = resolve(import.meta.dir, "../scripts/test.sh")

// Runs scripts/test.sh on a fixture that passes, with `env` over the tests' own, and returns its
// exit code and its output's first line. The tests' own leave out TUTTI_TEST_PARALLEL, which CI
// sets and which would take the cores share's place in the line.
const firstLine = (env: Record<string, string>) => {
  const seen = join(mkdtempSync(join(tmpdir(), "tutti-test-memory-")), "seen.json")
  const { TUTTI_TEST_PARALLEL: _, ...own } = testEnv
  const proc = Bun.spawnSync([script, "./test/fixtures/airtight/airtight.fixture.ts"], {
    cwd: resolve(import.meta.dir, ".."),
    env: { ...own, TUTTI_FIXTURE_AIRTIGHT: seen, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: proc.exitCode, line: proc.stdout.toString().split("\n")[0] ?? "" }
}

describe("scripts/test.sh's first line", () => {
  test("says the processes, the share and what one process takes, as the record learned it", () => {
    const folder = mkdtempSync(join(tmpdir(), "tutti-test-memory-"))
    const record = join(folder, "test-memory.json")
    writeFileSync(record, JSON.stringify({ runs: [run(512)] }))
    const share = join(folder, "share.json")
    writeFileSync(share, '{"cores":2,"memory_mb":3072,"at":"2026-11-03T09:12:40.000Z"}\n')
    const { code, line } = firstLine({
      TUTTI_TEST_MEMORY_FILE: record,
      TUTTI_CORES: "4",
      TUTTI_MEMORY_MB: "8192",
      TUTTI_SHARE_FILE: share,
    })
    expect(code).toBe(0)
    expect(line).toBe("scripts/test.sh: 1 process (cores 2, memory 3.0 GB at ~0.5 GB each, 1 file)")
    // A run in the suites' environment, as this one is, keeps no record of its own.
    expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({ runs: [run(512)] })
  }, 30_000)

  test("takes 1.5 GB a process until the record has a run", () => {
    const record = join(mkdtempSync(join(tmpdir(), "tutti-test-memory-")), "test-memory.json")
    const { code, line } = firstLine({ TUTTI_TEST_MEMORY_FILE: record, TUTTI_MEMORY_MB: "4096" })
    expect(code).toBe(0)
    expect(defaultProcessMemory).toBe(1.5 * gb)
    expect(line).toMatch(
      /^scripts\/test\.sh: 1 process \(cores \d+, memory 4\.0 GB at ~1\.5 GB each/,
    )
    expect(existsSync(record)).toBe(false)
  }, 30_000)
})
