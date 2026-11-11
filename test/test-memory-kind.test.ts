// scripts/test.ts sizes a test process from the runs of its own kind, plain or TUTTI_SLOW
// (tutti-k4if.2): plain runs' processes peaked at 150-240 MB and TUTTI_SLOW runs' at 577-841 MB
// (2026-11-08), and the 90th percentile of both, set by the slow ones, held a plain worker check at
// a 1.0 GB share to one process.

import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { childrenMark, highMark, type MemoryRun, testProcesses } from "../scripts/test.ts"
import { mebibyte } from "../src/core/env.ts"

const run = (peak: number, children: number, slow: boolean): MemoryRun => ({
  at: "2026-11-08T10:00:00.000Z",
  peak_mb: peak,
  children_mb: children,
  processes: 1,
  files: 454,
  slow,
})

// The record of 2026-11-08: 16 plain runs, 4 TUTTI_SLOW ones.
const plainPeaks = [150, 160, 170, 175, 180, 185, 190, 195, 200, 205, 210, 215, 220, 230, 235, 240]
const record = {
  runs: [
    ...plainPeaks.map((peak) => run(peak, 100, false)),
    ...[577, 640, 760, 841].map((peak) => run(peak, 2551, true)),
  ],
}

describe("what one test process takes", () => {
  test("is learned from the runs of the same kind, else from all, and is none without a run", () => {
    expect(highMark(record, false)).toBe(235 * mebibyte)
    expect(highMark(record, true)).toBe(841 * mebibyte)
    const plain = { runs: [run(200, 100, false)] }
    expect(highMark(plain, true)).toBe(200 * mebibyte)
    expect(highMark({ runs: [] }, false)).toBeUndefined()
  })

  test("is no more than the most a run of the same kind took", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ peak: fc.integer({ min: 1, max: 4096 }), slow: fc.boolean() }), {
          maxLength: 20,
        }),
        fc.boolean(),
        (runs, slow) => {
          const kept = { runs: runs.map(({ peak, slow }) => run(peak, 0, slow)) }
          const alike = runs.filter((each) => each.slow === slow)
          const mark = highMark(kept, slow)
          if (runs.length === 0) expect(mark).toBeUndefined()
          else {
            const most = Math.max(...(alike.length > 0 ? alike : runs).map(({ peak }) => peak))
            expect(mark).toBeLessThanOrEqual(most * mebibyte)
          }
        },
      ),
    )
  })

  test("gives a plain run at a 1.0 GB share two processes, and a TUTTI_SLOW run one", () => {
    const sizing = (slow: boolean) => ({
      memory: 1024 * mebibyte,
      each: highMark(record, slow) ?? 0,
      children: childrenMark(record, slow),
    })
    expect(testProcesses({ TUTTI_CORES: "2" }, [], sizing(false), 10)).toEqual({
      processes: 2,
      line:
        "scripts/test.sh: 2 processes (cores 2, memory 1.0 GB less ~0.1 GB for what the tests" +
        " start, at ~0.2 GB each)",
    })
    expect(testProcesses({ TUTTI_CORES: "2" }, [], sizing(true), 10)).toEqual({
      processes: 1,
      line:
        "scripts/test.sh: 1 process (cores 2, memory 1.0 GB less ~2.5 GB for what the tests" +
        " start, at ~0.8 GB each)",
    })
  })
})
