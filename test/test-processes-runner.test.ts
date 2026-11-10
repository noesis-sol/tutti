// A CI runner runs the tests in as many processes as its cores (tutti-34k9.9): the memory share the
// workflows set, TUTTI_MEMORY_MB, the runner's whole memory, holds them at the 1.5 GB a process is
// taken to need while a fresh runner has no record; the memory free now less tutti's 2 GB reserve,
// which scripts/test.sh falls back to without a share, held macos-latest's 7 GB to one process
// (CI run 42580956091: `1 process (TUTTI_TEST_PARALLEL 3, memory 1.8 GB at ~1.5 GB each)`, 15m44s).

import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { defaultProcessMemory, memoryShareOf, type Sizing, testProcesses } from "../scripts/test.ts"

const gb = 1024 ** 3

/** The sizing of a run on a runner with no record: `memory`, and the default a process. */
const fresh = (memory: number | undefined): Sizing => ({
  memory,
  each: defaultProcessMemory,
  children: 0,
  held: undefined,
})

describe("testProcesses on a CI runner with no memory record", () => {
  test("macos-latest's 3 cores run the tests in one process on the memory free less the reserve", () => {
    // 7 GB, of which ~3.8 GB is free as the check starts; less the 2 GB reserve, 1.8 GB.
    expect(testProcesses({ TUTTI_TEST_PARALLEL: "3" }, [], fresh(1.8 * gb), 3)).toEqual({
      processes: 1,
      line: "scripts/test.sh: 1 process (TUTTI_TEST_PARALLEL 3, memory 1.8 GB at ~1.5 GB each)",
    })
  })

  test("macos-latest's 3 cores run the tests in three processes in the runner's whole memory", () => {
    const env = { TUTTI_TEST_PARALLEL: "3", TUTTI_MEMORY_MB: "7168" }
    expect(testProcesses(env, [], fresh(memoryShareOf(env)), 3)).toEqual({
      processes: 3,
      line: "scripts/test.sh: 3 processes (TUTTI_TEST_PARALLEL 3, memory 7.0 GB at ~1.5 GB each)",
    })
  })

  test("ubuntu-latest's 4 cores run the tests in four processes in the runner's whole memory", () => {
    const env = { TUTTI_TEST_PARALLEL: "4", TUTTI_MEMORY_MB: "16384" }
    expect(testProcesses(env, [], fresh(memoryShareOf(env)), 4)).toEqual({
      processes: 4,
      line: "scripts/test.sh: 4 processes (TUTTI_TEST_PARALLEL 4, memory 16.0 GB at ~1.5 GB each)",
    })
  })

  test("a runner whose memory holds fewer processes than its cores at 1.5 GB each still keeps to the memory", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 64 }),
        fc.integer({ min: 1, max: 65536 }),
        (cores, mb) => {
          const env = { TUTTI_TEST_PARALLEL: String(cores), TUTTI_MEMORY_MB: String(mb) }
          const { processes } = testProcesses(env, [], fresh(memoryShareOf(env)), cores)
          const held = Math.max(1, Math.floor((mb * 1024 ** 2) / defaultProcessMemory))
          expect(processes).toBe(Math.min(cores, held))
        },
      ),
    )
  })
})
