// The machine's load (src/run/load.ts, orchestra 0.8.5): the process listing and each worker's
// processes, the kernel's figures on macOS and Linux, and each signal's level from fake readings.
import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import {
  below,
  type Kernel,
  levelsOf,
  newSampler,
  overLoadFor,
  parseDarwin,
  parseLinux,
  parseProcesses,
  sample,
  swappingPerMinute,
  treeOf,
  unknownKernel,
  unknownMemory,
} from "../src/run/load.ts"

const kb = 1024
const gb = 1024 ** 3

/** A listing as ps gives it: pid, ppid, pgid, rss in kilobytes. */
const listing = [
  "    1     0     1   1000",
  "  100     1   100  50000", // tutti
  "  200   100   200 1048576", // t-1's Claude Code, a group of its own
  "  201   200   200 524288", // a command it runs
  "  202     1   200 262144", // one whose parent has gone, still in its group
  "  300   100   300 2097152", // t-2's Claude Code
  "  400   100   400 1048576", // the merge check
  "  401   400   400 524288", // its tests
  "  500     1   500 100000", // another program
].join("\n")

describe("the process listing", () => {
  test("reads each process's parent, group and memory", () => {
    const all = parseProcesses(listing)
    expect(all?.get(201)).toEqual({ parent: 200, group: 200, memory: 524288 * kb })
    expect(all?.size).toBe(9)
  })

  test("is not a listing with a line that isn't four numbers", () => {
    expect(parseProcesses("  1 0 1\n")).toBeUndefined()
    expect(parseProcesses("  1 0 1 x\n")).toBeUndefined()
    expect(parseProcesses("")).toEqual(new Map())
  })

  test("never throws, whatever ps says", () => {
    fc.assert(fc.property(fc.string(), (text) => void parseProcesses(text)))
  })

  test("a worker's processes are its Claude Code, its group and all below them", () => {
    const all = parseProcesses(listing) ?? new Map()
    expect([...treeOf(all, 200)].toSorted()).toEqual([200, 201, 202])
    expect([...treeOf(all, 300)]).toEqual([300])
    expect(treeOf(all, 999).size).toBe(0)
  })

  test("what tutti runs besides is below it, the workers' processes left out", () => {
    const all = parseProcesses(listing) ?? new Map()
    const workers = new Set([...treeOf(all, 200), ...treeOf(all, 300)])
    expect(below(all, 100, workers)).toBe((1048576 + 524288) * kb)
  })
})

describe("the kernel's figures", () => {
  const vmstat = [
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                               12345.",
    "Swapins:                                  8873329.",
    "Swapouts:                                 1000.",
  ].join("\n")

  test("macOS: sysctl's pressure level, load and cores, and vm_stat's swaps", () => {
    expect(parseDarwin("1\n{ 9.80 8.12 7.40 }\n10\n", vmstat)).toEqual({
      pressure: "normal",
      swaps: 8874329,
      load1: 9.8,
      cores: 10,
      available: -1,
    })
    expect(parseDarwin("2\n{ 1.00 1.00 1.00 }\n8\n", vmstat)?.pressure).toBe("warn")
    expect(parseDarwin("4\n{ 1.00 1.00 1.00 }\n8\n", vmstat)?.pressure).toBe("critical")
    expect(parseDarwin("7\n{ x }\nten\n", "")).toEqual(unknownKernel)
    expect(parseDarwin("1\n10\n", vmstat)).toBeUndefined()
  })

  const proc = {
    loadavg: "3.10 2.00 1.00 2/400 12345\n",
    pressure: [
      "some avg10=1.53 avg60=0.40 avg300=0.10 total=123",
      "full avg10=0.20 avg60=0.10 avg300=0.00 total=45",
    ].join("\n"),
    meminfo: "MemTotal:       16384000 kB\nMemFree:  100 kB\nMemAvailable:    8192000 kB\n",
    vmstat: "nr_free_pages 1\npswpin 12\npswpout 30\n",
    cores: 8,
  }

  test("Linux: the load, the pressure stall information, the memory available and the swaps", () => {
    expect(parseLinux(proc)).toEqual({
      pressure: "normal",
      swaps: 42,
      load1: 3.1,
      cores: 8,
      available: 8192000 * kb,
    })
    const stalled = (some: number, full: number) =>
      parseLinux({
        ...proc,
        pressure: `some avg10=${some} avg60=0 avg300=0 total=1\nfull avg10=${full} avg60=0 avg300=0 total=1`,
      })?.pressure
    expect(stalled(10, 0)).toBe("warn")
    expect(stalled(50, 10)).toBe("critical")
  })

  test("Linux without pressure stall information: the share of memory available", () => {
    const available = (kB: number) =>
      parseLinux({
        ...proc,
        pressure: "",
        meminfo: `MemTotal: 1000000 kB\nMemAvailable: ${kB} kB\n`,
      })?.pressure
    expect(available(500000)).toBe("normal")
    expect(available(90000)).toBe("warn")
    expect(available(40000)).toBe("critical")
  })

  test("Linux with nothing readable says nothing", () => {
    expect(
      parseLinux({ loadavg: "", pressure: "", meminfo: "", vmstat: "", cores: 4 }),
    ).toBeUndefined()
  })

  test("never throws, whatever the kernel says", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), (a, b, c) => {
        parseDarwin(a, b)
        parseLinux({ loadavg: a, pressure: b, meminfo: c, vmstat: a, cores: 1 })
      }),
    )
  })
})

const kernel = (over: Partial<Kernel> = {}): Kernel => ({
  pressure: "normal",
  swaps: 0,
  load1: 1,
  cores: 10,
  available: -1,
  ...over,
})

describe("each signal's level", () => {
  test("green: nothing pressed", () => {
    const { levels } = levelsOf(newSampler, kernel(), 0, 0)
    expect(levels).toEqual({ cpu: "green", pressure: "green", swapping: "green" })
  })

  test("the CPU amber past 1.5 times the cores", () => {
    expect(levelsOf(newSampler, kernel({ load1: 15 }), 0, 0).levels.cpu).toBe("green")
    expect(levelsOf(newSampler, kernel({ load1: 15.1 }), 0, 0).levels.cpu).toBe("amber")
  })

  test("the CPU red past 3 times the cores for a minute, and amber until then", () => {
    const first = levelsOf(newSampler, kernel({ load1: 31 }), 0, 1000)
    expect(first).toEqual({
      levels: { cpu: "amber", pressure: "green", swapping: "green" },
      overSince: 1000,
    })
    const held = { last: null, overSince: first.overSince }
    expect(levelsOf(held, kernel({ load1: 31 }), 0, 1000 + overLoadFor - 1).levels.cpu).toBe(
      "amber",
    )
    expect(levelsOf(held, kernel({ load1: 31 }), 0, 1000 + overLoadFor).levels.cpu).toBe("red")
    // Back under it, the minute starts again.
    expect(levelsOf(held, kernel({ load1: 20 }), 0, 1000 + overLoadFor)).toEqual({
      levels: { cpu: "amber", pressure: "green", swapping: "green" },
      overSince: null,
    })
  })

  test("the pressure red at warn and critical; the CPU stays green", () => {
    for (const pressure of ["warn", "critical"] as const) {
      const { levels } = levelsOf(newSampler, kernel({ pressure }), 0, 0)
      expect(levels).toEqual({ cpu: "green", pressure: "red", swapping: "green" })
    }
  })

  test("swapping amber at its rate", () => {
    expect(levelsOf(newSampler, kernel(), swappingPerMinute - 1, 0).levels.swapping).toBe("green")
    expect(levelsOf(newSampler, kernel(), swappingPerMinute, 0).levels.swapping).toBe("amber")
  })

  test("an unknown load or cores is green", () => {
    expect(levelsOf(newSampler, kernel({ load1: -1 }), -1, 0).levels.cpu).toBe("green")
    expect(levelsOf(newSampler, kernel({ cores: 0, load1: 99 }), -1, 0).levels.cpu).toBe("green")
  })
})

describe("a reading", () => {
  const all = parseProcesses(listing)
  const roots = new Map([
    ["t-1", 200],
    ["t-2", 300],
    ["t-3", 999],
  ])

  test("has each worker's memory, unknown for one not in the listing, and tutti's own", () => {
    const { reading } = sample({
      sampler: newSampler,
      now: 0,
      processes: all,
      kernel: kernel(),
      roots,
      self: 100,
    })
    expect(reading.workers).toEqual(
      new Map([
        ["t-1", (1048576 + 524288 + 262144) * kb],
        ["t-2", 2 * gb],
        ["t-3", unknownMemory],
      ]),
    )
    expect(reading.check).toBe(1.5 * gb)
  })

  test("without a listing, every worker unknown and nothing of tutti's own", () => {
    const { reading } = sample({
      sampler: newSampler,
      now: 0,
      processes: undefined,
      kernel: undefined,
      roots,
      self: 100,
    })
    expect([...reading.workers.values()]).toEqual([unknownMemory, unknownMemory, unknownMemory])
    expect(reading.check).toBe(0)
    expect(reading.kernel).toEqual(unknownKernel)
  })

  test("swapping is the swaps a minute since the reading before", () => {
    const at = (sampler: typeof newSampler, now: number, swaps: number) =>
      sample({ sampler, now, processes: all, kernel: kernel({ swaps }), roots, self: 100 })
    const first = at(newSampler, 0, 1000)
    expect(first.reading.swapping).toBe(-1)
    const second = at(first.sampler, 5000, 1100)
    expect(second.reading.swapping).toBe(1200)
    expect(second.reading.levels.swapping).toBe("amber")
    expect(at(second.sampler, 10_000, 1101).reading.levels.swapping).toBe("green")
  })
})
