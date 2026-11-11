// scripts/test.ts keeps what a test process's tests start apart from the process (tutti-q61i): a
// few slow files start big short-lived processes (build-script.test.ts' bun build --compile, 2.5
// GB), which had set every run's processes at their size. It keeps that memory once for the run,
// learned from runs of the same kind, plain or TUTTI_SLOW, and sizes the processes by the rest.

import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import {
  childrenMark,
  highMark,
  type MemoryRun,
  parseMemoryRecord,
  recordRun,
  testProcesses,
} from "../scripts/test.ts"
import { mebibyte } from "../src/core/env.ts"

const gb = 1024 ** 3

const run = (peak: number, children: number, slow: boolean): MemoryRun => ({
  at: "2026-11-03T10:00:00.000Z",
  peak_mb: peak,
  children_mb: children,
  processes: 3,
  files: 700,
  slow,
})

describe("what the tests start", () => {
  test("is learned from the runs of the same kind, else from all, and is none without a run", () => {
    const record = {
      runs: [run(600, 300, false), run(620, 450, false), run(610, 2551, true)],
    }
    expect(childrenMark(record, false)).toBe(450 * mebibyte)
    expect(childrenMark(record, true)).toBe(2551 * mebibyte)
    expect(childrenMark({ runs: [run(600, 300, false)] }, true)).toBe(300 * mebibyte)
    expect(childrenMark({ runs: [] }, false)).toBe(0)
    // A slow run's compile sets no process's size.
    expect(highMark(record, false)).toBe(620 * mebibyte)
  })

  test("is kept with each run, and whether it was TUTTI_SLOW", () => {
    const at = Date.parse("2026-11-03T10:00:00.000Z")
    const watched = { peak: 610 * mebibyte, children: 2551 * mebibyte - 1, warned: false }
    expect(
      recordRun({ runs: [] }, { ...watched, at, processes: 3, files: 700, slow: true }),
    ).toEqual({ runs: [run(610, 2551, true)] })
  })

  test("leaves out the runs kept before it, whose peaks counted what their tests started", () => {
    const old = { at: "2026-11-03T10:00:00.000Z", peak_mb: 2551, processes: 1, files: 733 }
    const kept = run(610, 2551, true)
    const text = JSON.stringify({
      runs: [old, kept, { ...kept, children_mb: -1 }, { ...kept, slow: "yes" }],
    })
    expect(parseMemoryRecord(text)).toEqual({ runs: [kept] })
    expect(parseMemoryRecord(JSON.stringify({ runs: [run(610, 0, false)] })).runs).toHaveLength(1)
  })

  test("is taken once from the memory share, and the first line says so", () => {
    const sizing = { memory: 4.6 * gb, each: 0.6 * gb, children: gb }
    expect(testProcesses({ TUTTI_CORES: "8" }, [], sizing, 10)).toEqual({
      processes: 6,
      line:
        "scripts/test.sh: 6 processes (cores 8, memory 4.6 GB less ~1.0 GB for what the tests" +
        " start, at ~0.6 GB each)",
    })
    expect(testProcesses({ TUTTI_CORES: "8" }, [], { ...sizing, children: 0 }, 10)).toEqual({
      processes: 7,
      line: "scripts/test.sh: 7 processes (cores 8, memory 4.6 GB at ~0.6 GB each)",
    })
    expect(testProcesses({ TUTTI_CORES: "8" }, [], { ...sizing, children: 8 * gb }, 10)).toEqual({
      processes: 1,
      line:
        "scripts/test.sh: 1 process (cores 8, memory 4.6 GB less ~8.0 GB for what the tests" +
        " start, at ~0.6 GB each)",
    })
  })

  test("leaves the processes no more than the rest of the share holds, and at least one", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 64 }),
        fc.integer({ min: 0, max: 64 * 1024 }),
        fc.integer({ min: 64, max: 4096 }),
        fc.integer({ min: 0, max: 8192 }),
        (share, memoryMb, eachMb, childrenMb) => {
          const sizing = {
            memory: memoryMb * mebibyte,
            each: eachMb * mebibyte,
            children: childrenMb * mebibyte,
          }
          const { processes } = testProcesses({ TUTTI_CORES: String(share) }, [], sizing, 64)
          expect(processes).toBeGreaterThanOrEqual(1)
          expect(processes).toBeLessThanOrEqual(share)
          if (memoryMb >= eachMb + childrenMb) {
            expect(processes * eachMb + childrenMb).toBeLessThanOrEqual(memoryMb)
          } else expect(processes).toBe(1)
        },
      ),
    )
  })
})
