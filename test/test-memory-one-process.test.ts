// A run in one process (--parallel=1) has bun test run the files in its own process, starting no
// worker, so scripts/test.ts reads bun test's own memory as the test process's (tutti-96rg): it had
// read bun test's children, only what the tests started, and kept peaks of 147-210 MB where a
// worker's were 880-1107 MB, which swung the size learned for a process between 0.2 and 1 GB.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  childrenMark,
  highMark,
  type MemoryRun,
  parseMemoryRecord,
  recordRun,
  testsInWorkers,
  watchMemory,
} from "../scripts/test.ts"
import { mebibyte } from "../src/core/env.ts"
import { testEnv } from "./env.ts"

const run = (peak: number, processes: number, root?: true): MemoryRun => ({
  at: "2026-11-13T10:00:00.000Z",
  peak_mb: peak,
  children_mb: 20,
  processes,
  files: 700,
  slow: false,
  ...(root === undefined ? {} : { root }),
})

// Starts bun test on the files `files` writes, with `args` before them, and returns the process.
const bunTest = (args: ReadonlyArray<string>, files: Readonly<Record<string, string>>) => {
  const dir = mkdtempSync(join(tmpdir(), "tutti-one-process-"))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return Bun.spawn(["bun", "test", ...args, ...Object.keys(files).map((name) => `./${name}`)], {
    cwd: dir,
    env: testEnv,
    stdout: "pipe",
    stderr: "pipe",
  })
}

const output = async (proc: ReturnType<typeof bunTest>): Promise<string> => {
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return `${out}${err}`
}

// Two files, each printing the process it runs in and whether a global the other sets is there.
const twoFiles = Object.fromEntries(
  ["a", "b"].map((name) => [
    `${name}.test.ts`,
    `import { test } from "bun:test"
test("${name}", () => {
  const seen = (globalThis as { left?: string }).left ?? "none"
  ;(globalThis as { left?: string }).left = "${name}"
  console.log("FILE ${name} PID " + process.pid + " SEEN " + seen)
})
`,
  ]),
)

describe("bun test at --parallel=1", () => {
  test("runs the files in its own process, each in a fresh global", async () => {
    const proc = bunTest(["--parallel=1"], twoFiles)
    const text = await output(proc)
    expect(await proc.exited).toBe(0)
    expect(text).toContain(`FILE a PID ${proc.pid} SEEN none`)
    expect(text).toContain(`FILE b PID ${proc.pid} SEEN none`)
  })

  test("runs them in a worker of its own at --parallel=2", async () => {
    const proc = bunTest(["--parallel=2"], twoFiles)
    const text = await output(proc)
    expect(await proc.exited).toBe(0)
    expect(text).not.toContain(`PID ${proc.pid} `)
    expect(text).toMatch(/FILE a PID \d+ SEEN none/)
  })
})

describe("testsInWorkers", () => {
  test("is whether the last --parallel asks for more than one process", () => {
    expect(testsInWorkers(["--parallel=1", "--timeout=15000"])).toBe(false)
    expect(testsInWorkers(["--parallel=3"])).toBe(true)
    expect(testsInWorkers(["--parallel=3", "--parallel=1"])).toBe(false)
    expect(testsInWorkers(["--timeout=15000", "test/a.test.ts"])).toBe(false)
    expect(testsInWorkers(["--parallel", "test/a.test.ts"], 8)).toBe(true)
    expect(testsInWorkers(["--parallel"], 1)).toBe(false)
  })
})

describe("the watch of a run in one process", () => {
  // A file that holds ~300 MB for 5 s, two or three of the watch's reads.
  const hungry = {
    "hungry.test.ts": `import { expect, test } from "bun:test"
test("holds memory", async () => {
  const held = Array.from({ length: 30 }, () => new Float64Array(1_250_000).fill(1))
  await Bun.sleep(5000)
  expect(held.length).toBe(30)
}, 10_000)
`,
  }

  test("reads bun test's own memory, not only what its tests started", async () => {
    const args = ["--parallel=1"]
    const proc = bunTest(args, hungry)
    const [watched, text, code] = await Promise.all([
      watchMemory(proc.pid, testsInWorkers(args), proc.exited),
      output(proc),
      proc.exited,
    ])
    expect(code, text).toBe(0)
    expect(watched.root).toBe(true)
    expect(watched.peak).toBeGreaterThan(250 * mebibyte)
    expect(watched.children).toBeLessThan(100 * mebibyte)
  }, 20_000)
})

describe("the record of a run in one process", () => {
  test("is marked as bun test's own process, and read back", () => {
    const at = Date.parse("2026-11-13T10:00:00.000Z")
    const watched = { peak: 900 * mebibyte, children: 20 * mebibyte, warned: false, root: true }
    const record = recordRun(
      { runs: [] },
      { ...watched, at, processes: 1, files: 700, slow: false },
    )
    expect(record).toEqual({ runs: [run(900, 1, true)] })
    expect(parseMemoryRecord(JSON.stringify(record))).toEqual(record)
    const workers = recordRun(
      { runs: [] },
      { ...watched, root: false, at, processes: 3, files: 700, slow: false },
    )
    expect(workers).toEqual({ runs: [run(900, 3)] })
  })

  test("leaves out the runs in one process kept before, which read only what the tests started", () => {
    const before = [run(182, 1), run(150, 1), run(210, 1)]
    const kept = [run(887, 4), run(950, 1, true), run(1022, 2)]
    const text = JSON.stringify({
      runs: [...before, ...kept, { ...run(900, 1), root: false }, { ...run(900, 3), root: "yes" }],
    })
    const record = parseMemoryRecord(text)
    expect(record).toEqual({ runs: kept })
    expect(highMark(record, false)).toBe(1022 * mebibyte)
    expect(childrenMark(record, false)).toBe(20 * mebibyte)
  })
})
