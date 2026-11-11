// The merge check is weighted in the division of the machine (tutti-k4if.3): it runs one at a time
// and every ticket waits on it, yet at one part of the memory budget, a worker's 1.0 GB, it ran the
// whole suite in one process, a median 7.3 min where the full check took 4.0 min with the machine to
// itself. So it gets mergeWeight parts of the memory where a worker's checks get one, and twice a
// worker's cores, no more than the machine's (src/run/share.ts' shareOf); the early and train
// checks, in its slot, get the same (src/services/Checks.ts).

import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { childrenMark, highMark, memoryShareOf, testProcesses } from "../scripts/test.ts"
import { checkShareEnv, mebibyte, memoryFloor, mergeWeight } from "../src/core/env.ts"
import { shareNote } from "../src/run/share.ts"
import { type Budget, shareOf } from "../src/services/share.ts"

const gb = 1024 ** 3

describe("the division, the merge check weighted", () => {
  test("gives the merge check twice a worker's memory and cores", () => {
    // 12 GB among 2 workers allowed and the merge check's 2 parts: 3 GB a part.
    expect(shareOf({ cores: 10, limit: 0 }, { budget: 12 * gb, allowed: 2, others: 0 })).toEqual({
      cores: 5,
      memory: 3072,
      merge: { cores: 10, memory: 6144 },
    })
    // The other runs' workers take their parts, as the run's own do.
    expect(shareOf({ cores: 12, limit: 0 }, { budget: 10 * gb, allowed: 2, others: 1 })).toEqual({
      cores: 4,
      memory: 2048,
      merge: { cores: 8, memory: 4096 },
    })
  })

  test("the ticket's run: 3.9 GB among 4 workers allowed, on 10 cores", () => {
    // A worker's part, 0.65 GB, is under the floor: it gets the floor, the merge check twice it.
    const share = shareOf({ cores: 10, limit: 0 }, { budget: 3.9 * gb, allowed: 4, others: 0 })
    expect(share).toEqual({ cores: 2, memory: 1024, merge: { cores: 4, memory: 2048 } })
  })

  test("gives the merge check no more cores than the machine's, nor fewer than a worker's", () => {
    expect(
      shareOf({ cores: 10, limit: 0 }, { budget: 8 * gb, allowed: 1, others: 0 }).merge,
    ).toMatchObject({ cores: 10 })
    expect(
      shareOf({ cores: 1, limit: 0 }, { budget: 8 * gb, allowed: 3, others: 0 }).merge,
    ).toMatchObject({ cores: 1 })
  })

  test("whatever the division, the merge check gets its weight of a worker's share", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 64 }),
        fc.integer({ min: 0, max: 16 }),
        fc.integer({ min: 0, max: 128 * 1024 }),
        fc.integer({ min: 0, max: 16 }),
        fc.integer({ min: 0, max: 16 }),
        (cores, limit, budgetMb, allowed, others) => {
          const share = shareOf({ cores, limit }, { budget: budgetMb * mebibyte, allowed, others })
          expect(share.merge.memory).toBe(mergeWeight * share.memory)
          expect(share.memory * mebibyte).toBeGreaterThanOrEqual(memoryFloor)
          expect(share.merge.cores).toBeGreaterThanOrEqual(share.cores)
          expect(share.merge.cores).toBeLessThanOrEqual(Math.max(cores, share.cores))
          expect(share.merge.cores).toBeLessThanOrEqual(mergeWeight * share.cores)
        },
      ),
    )
  })
})

describe("the START line", () => {
  test("names the merge check's weight and its share", () => {
    const budget: Budget = {
      bytes: 3.9 * gb,
      words: "5.9 GB available and 0.0 GB in checks, less the 2.0 GB reserve",
    }
    const note = shareNote(budget, { cores: 10, limit: 0 }, { budget: 0, allowed: 4, others: 0 })
    expect(note).toBe(
      "share: memory budget 3.9 GB (5.9 GB available and 0.0 GB in checks, less the 2.0 GB " +
        "reserve), divided into 6 parts (4 workers allowed, a part each, and the merge check, 2 " +
        "parts): 1.0 GB and 2 cores a worker's checks, 2.0 GB and 4 cores the merge check's; " +
        "kept live in .tutti/run/share.json and .tutti/run/merge-share.json",
    )
  })
})

describe("the merge check's processes", () => {
  // The record of 2026-11-08's plain runs (test/test-memory-kind.test.ts): processes peaked at
  // 150-240 MB, and what they started at 100 MB.
  const record = {
    runs: [150, 170, 190, 210, 235].map((peak) => ({
      at: "2026-11-08T10:00:00.000Z",
      peak_mb: peak,
      children_mb: 100,
      processes: 1,
      files: 803,
      slow: false,
    })),
  }

  /** The first line of scripts/test.sh in a check given `figures` of the machine. */
  const firstLine = (figures: { readonly cores: number; readonly memory: number }) => {
    const env = checkShareEnv({}, { ...figures, file: "/repo/.tutti/run/merge-share.json" })
    return testProcesses(
      env,
      [],
      {
        memory: memoryShareOf(env),
        each: highMark(record, false) ?? 0,
        children: childrenMark(record, false),
      },
      10,
    )
  }

  test("on a 1.0 GB worker share, a merge check runs more than one", () => {
    const share = shareOf({ cores: 10, limit: 0 }, { budget: 3.9 * gb, allowed: 4, others: 0 })
    expect(share.memory).toBe(1024)
    const merge = firstLine(share.merge)
    expect(merge).toEqual({
      processes: 4,
      line:
        "scripts/test.sh: 4 processes (cores 4, memory 2.0 GB less ~0.1 GB for what the tests" +
        " start, at ~0.2 GB each)",
    })
    expect(merge.processes).toBeGreaterThan(firstLine(share).processes)
  })
})
