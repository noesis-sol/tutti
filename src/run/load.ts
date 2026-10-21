// The machine's load (orchestra 0.8.5's internal/load): whether the workers are overloading the
// machine. The memory each worker's processes take (its Claude Code, the leader of a process group of
// its own, § 3.2, and everything in that group or below it) and what tutti itself runs besides (its
// merge check above all), from one process listing; and the kernel's memory pressure, swapping and
// CPU load, on macOS (sysctl and vm_stat) and Linux (/proc). On macOS memory used against the total
// says little, as the kernel keeps spare memory full of cache and compressed pages: the pressure
// level and the swap rate do. The dashboard shows a reading on its load line, each figure in the
// colour of its own level (src/ui/LoadLine.tsx), and each worker's memory on its line in Current.
//
// The run reads it every loadEvery while it shows the dashboard, through LoadSource: main.ts gives
// the live one, and a run without one (the tests') reads nothing.
import { availableParallelism } from "node:os"
import { Clock, Context, Duration, Effect, FileSystem } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { exec, TimeLimit } from "../services/exec.ts"

/** The memory of a worker whose processes can't be found: none of them in the listing. */
export const unknownMemory = -1

// The thresholds that colour the line's figures (levelsOf): tune them here.
/** The 1-minute load average per core past which the CPU turns amber. */
export const busyLoad = 1.5
/** The load per core past which, held for overLoadFor, the CPU turns red. */
export const overLoad = 3
export const overLoadFor = 60_000
/** The pages swapped in and out a minute at which swapping is under way, and shows, in amber. */
export const swappingPerMinute = 600
/**
 * Linux's pressure stall information (/proc/pressure/memory) gives the level of memory pressure
 * macOS gives itself: the share of the last 10 seconds, in percent, in which some task stalled on
 * memory (stallWarn: warn), or every task did (stallCritical: critical). A kernel without it gives
 * the share of memory available: under availableWarn, warn; under availableCritical, critical.
 */
export const stallWarn = 10
export const stallCritical = 10
export const availableWarn = 0.1
export const availableCritical = 0.05

/** How often the run reads the machine's load: one process listing and the kernel's figures. */
export const loadEvery: Duration.Duration = Duration.seconds(5)

/** How hard the machine is pressed, for a figure's colour. */
export type Level = "green" | "amber" | "red"

/** The kernel's memory pressure, as macOS names its levels; unknown where it can't be read. */
export type Pressure = "unknown" | "normal" | "warn" | "critical"

/** What the kernel says of the machine's memory and CPU. */
export interface Kernel {
  readonly pressure: Pressure
  /** Pages swapped in and out since the machine started; -1 when not known. */
  readonly swaps: number
  /** The 1-minute load average; -1 when not known. */
  readonly load1: number
  /** 0 when not known. */
  readonly cores: number
  /** The memory available to start programs without swapping, in bytes (Linux's MemAvailable); -1
   * where the kernel doesn't say, as on macOS. */
  readonly available: number
}

/** A Kernel that says nothing. */
export const unknownKernel: Kernel = {
  pressure: "unknown",
  swaps: -1,
  load1: -1,
  cores: 0,
  available: -1,
}

/** Each signal's own level, for its figure: the memory, which has no threshold, has none. */
export interface Levels {
  /** The load per core: amber past busyLoad, red past overLoad for overLoadFor. */
  readonly cpu: Level
  /** The kernel's memory pressure: red at warn or worse. */
  readonly pressure: Level
  /** Amber while swapping is under way. */
  readonly swapping: Level
}

/** One look at the machine. */
export interface Reading {
  /** When it was taken, in epoch milliseconds. */
  readonly at: number
  /** The memory of each running worker's processes, in bytes, by ticket: unknownMemory for one
   * whose processes can't be found. */
  readonly workers: ReadonlyMap<string, number>
  /** The memory of what tutti runs besides its workers, its merge check above all, in bytes. */
  readonly check: number
  readonly kernel: Kernel
  /** The pages swapped in and out a minute since the reading before; -1 before there are two. */
  readonly swapping: number
  readonly levels: Levels
}

/** One process in a listing: its parent, its process group and its resident memory, in bytes. */
export interface Process {
  readonly parent: number
  readonly group: number
  readonly memory: number
}

/** The machine's processes, by ID, as one listing found them. */
export type Processes = ReadonlyMap<number, Process>

/** The listing's arguments to ps, the same on macOS and Linux: a process a line. */
export const psArgs = ["-A", "-o", "pid=,ppid=,pgid=,rss="] as const

/**
 * ps's listing of each process's ID, its parent's, its group's and its resident memory in
 * kilobytes, a process a line; undefined when a line isn't four numbers.
 */
export const parseProcesses = (text: string): Processes | undefined => {
  const all = new Map<number, Process>()
  for (const line of text.split("\n")) {
    const fields = line
      .trim()
      .split(/\s+/)
      .filter((field) => field !== "")
    if (fields.length === 0) continue
    if (fields.length !== 4 || !fields.every((field) => /^\d+$/.test(field))) return undefined
    const [pid, parent, group, rss] = fields.map(Number) as [number, number, number, number]
    all.set(pid, { parent, group, memory: rss * 1024 })
  }
  return all
}

/** Each process's children. */
const childrenOf = (all: Processes): ReadonlyMap<number, ReadonlyArray<number>> => {
  const children = new Map<number, Array<number>>()
  for (const [pid, each] of all) {
    if (each.parent === pid) continue
    const list = children.get(each.parent)
    if (list === undefined) children.set(each.parent, [pid])
    else list.push(pid)
  }
  return children
}

/**
 * The processes of the worker whose Claude Code is `root`: it, those in its process group (a
 * command it started lives on in it, even once its parent has gone), and all below them, each once;
 * empty when `root` is in neither.
 */
export const treeOf = (all: Processes, root: number): ReadonlySet<number> => {
  const children = childrenOf(all)
  const found = new Set<number>()
  const walk = (pid: number) => {
    if (found.has(pid) || !all.has(pid)) return
    found.add(pid)
    for (const child of children.get(pid) ?? []) walk(child)
  }
  walk(root)
  for (const [pid, each] of all) if (each.group === root) walk(pid)
  return found
}

/** The memory of `pids` in `all`, in bytes. */
const memoryOf = (all: Processes, pids: Iterable<number>): number => {
  let sum = 0
  for (const pid of pids) sum += all.get(pid)?.memory ?? 0
  return sum
}

/** The memory of every process below `self`, itself not counted, nor `skip` and what is below them. */
export const below = (all: Processes, self: number, skip: ReadonlySet<number>): number => {
  const children = childrenOf(all)
  const seen = new Set<number>([self, ...skip])
  let sum = 0
  const walk = (pid: number) => {
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      sum += all.get(child)?.memory ?? 0
      walk(child)
    }
  }
  walk(self)
  return sum
}

/**
 * The number on `text`'s line that starts with `name`, as vm_stat (`Swapins:  8873329.`),
 * /proc/meminfo (`MemTotal:  16384 kB`) and /proc/vmstat (`pswpin 12`) give theirs.
 */
const counter = (text: string, name: string): number | undefined => {
  for (const line of text.split("\n")) {
    if (!line.startsWith(name)) continue
    const first = line.slice(name.length).trim().split(/\s+/)[0]?.replace(/\.$/, "") ?? ""
    return /^\d+$/.test(first) ? Number(first) : undefined
  }
  return undefined
}

/** A decimal number, or undefined. */
const decimal = (text: string | undefined): number | undefined =>
  text !== undefined && /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : undefined

/**
 * macOS's figures: sysctl -n's answer for kern.memorystatus_vm_pressure_level, vm.loadavg and
 * hw.ncpu, a line each (`1`, `{ 9.80 8.12 7.40 }`, `10`), and vm_stat's page counts; undefined when
 * sysctl's answer isn't three lines.
 */
export const parseDarwin = (sysctl: string, vmstat: string): Kernel | undefined => {
  const lines = sysctl.trim().split("\n")
  if (lines.length !== 3) return undefined
  const [level, average, cores] = lines.map((line) => line.trim()) as [string, string, string]
  const pressure: Pressure =
    level === "1" ? "normal" : level === "2" ? "warn" : level === "4" ? "critical" : "unknown"
  const load1 = decimal(average.replace(/[{}]/g, " ").trim().split(/\s+/)[0])
  const ins = counter(vmstat, "Swapins:")
  const outs = counter(vmstat, "Swapouts:")
  return {
    pressure,
    swaps: ins === undefined || outs === undefined ? -1 : ins + outs,
    load1: load1 ?? -1,
    cores: /^\d+$/.test(cores) ? Number(cores) : 0,
    available: -1,
  }
}

/** The avg10 on the line of /proc/pressure/memory that starts with `kind`, some or full. */
const stall = (pressure: string, kind: "some" | "full"): number | undefined => {
  for (const line of pressure.split("\n")) {
    const fields = line.trim().split(/\s+/)
    if (fields[0] !== kind) continue
    const value = fields[1]
    return value?.startsWith("avg10=") === true ? decimal(value.slice(6)) : undefined
  }
  return undefined
}

/**
 * Linux's figures from /proc/loadavg, /proc/pressure/memory, /proc/meminfo and /proc/vmstat, each
 * "" where it can't be read, and the CPU count; undefined when neither the load nor the pressure
 * can be read.
 */
export const parseLinux = (files: {
  readonly loadavg: string
  readonly pressure: string
  readonly meminfo: string
  readonly vmstat: string
  readonly cores: number
}): Kernel | undefined => {
  const load1 = decimal(files.loadavg.trim().split(/\s+/)[0]) ?? -1
  const total = counter(files.meminfo, "MemTotal:")
  const availableKb = counter(files.meminfo, "MemAvailable:")
  const available = availableKb === undefined ? -1 : availableKb * 1024
  const some = stall(files.pressure, "some")
  const full = stall(files.pressure, "full")
  let pressure: Pressure = "unknown"
  if (some !== undefined || full !== undefined) {
    pressure =
      (full ?? 0) >= stallCritical ? "critical" : (some ?? 0) >= stallWarn ? "warn" : "normal"
  } else if (total !== undefined && total > 0 && available >= 0) {
    const share = available / (total * 1024)
    pressure = share < availableCritical ? "critical" : share < availableWarn ? "warn" : "normal"
  }
  const ins = counter(files.vmstat, "pswpin")
  const outs = counter(files.vmstat, "pswpout")
  if (load1 < 0 && pressure === "unknown") return undefined
  return {
    pressure,
    swaps: ins === undefined || outs === undefined ? -1 : ins + outs,
    load1,
    cores: files.cores,
    available,
  }
}

/** What a sampler keeps of its last reading: the swap count, for the rate, and since when the load
 * has been past overLoad per core. */
export interface Sampler {
  readonly last: { readonly swaps: number; readonly at: number } | null
  /** When the load went past overLoad per core; null while it isn't. */
  readonly overSince: number | null
}

export const newSampler: Sampler = { last: null, overSince: null }

/** `kernel`'s levels at `now`, with `swapping`, keeping since when the load has been past overLoad. */
export const levelsOf = (
  sampler: Sampler,
  kernel: Kernel,
  swapping: number,
  now: number,
): { readonly levels: Levels; readonly overSince: number | null } => {
  const perCore = kernel.cores > 0 && kernel.load1 >= 0 ? kernel.load1 / kernel.cores : -1
  const overSince = perCore > overLoad ? (sampler.overSince ?? now) : null
  const cpu: Level =
    overSince !== null && now - overSince >= overLoadFor
      ? "red"
      : perCore > busyLoad
        ? "amber"
        : "green"
  return {
    levels: {
      cpu,
      pressure: kernel.pressure === "warn" || kernel.pressure === "critical" ? "red" : "green",
      swapping: swapping >= swappingPerMinute ? "amber" : "green",
    },
    overSince,
  }
}

/**
 * Whether `levels` have the machine pressed hard enough to slow a worker's tests several times over,
 * as orchestra 0.9.0 has it: the kernel's memory pressure red, swapping under way, or the CPU red. A
 * CPU in amber alone doesn't: a run's workers keep it there. A hand-back's time limit leaves out
 * the time it is (handback.ts's clock).
 */
export const pressing = (levels: Levels): boolean =>
  levels.pressure === "red" || levels.swapping !== "green" || levels.cpu === "red"

/**
 * A reading at `now` from a listing (undefined: every worker unknown and nothing of tutti's own) and
 * the kernel's figures (undefined: no pressure or load), for the workers whose Claude Code is each
 * of `roots`, by ticket, and tutti's process `self`; and the sampler to take the next with.
 */
export const sample = (options: {
  readonly sampler: Sampler
  readonly now: number
  readonly processes: Processes | undefined
  readonly kernel: Kernel | undefined
  readonly roots: ReadonlyMap<string, number>
  readonly self: number
}): { readonly reading: Reading; readonly sampler: Sampler } => {
  const { sampler, now, processes } = options
  const workers = new Map<string, number>()
  const theirs = new Set<number>()
  for (const [ticket, root] of options.roots) {
    const tree = processes === undefined ? new Set<number>() : treeOf(processes, root)
    for (const pid of tree) theirs.add(pid)
    workers.set(ticket, tree.size === 0 ? unknownMemory : memoryOf(processes ?? new Map(), tree))
  }
  const check = processes === undefined ? 0 : below(processes, options.self, theirs)
  const kernel = options.kernel ?? unknownKernel
  let swapping = -1
  let last = sampler.last
  if (options.kernel !== undefined) {
    if (last !== null && last.swaps >= 0 && kernel.swaps >= last.swaps && now > last.at) {
      swapping = (kernel.swaps - last.swaps) / ((now - last.at) / 60_000)
    }
    last = { swaps: kernel.swaps, at: now }
  }
  const { levels, overSince } = levelsOf(sampler, kernel, swapping, now)
  return {
    reading: { at: now, workers, check, kernel, swapping, levels },
    sampler: { last, overSince },
  }
}

/** Where a run reads the machine's load from: ps's listing (psArgs), and the kernel's figures. */
export interface LoadSource {
  /** The process listing; undefined when it can't be read. */
  readonly processes: Effect.Effect<
    Processes | undefined,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
  >
  /** The kernel's figures; undefined when they can't be read. */
  readonly kernel: Effect.Effect<
    Kernel | undefined,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
  >
}

/** A command's output, or undefined when it can't be run or fails. */
const output = (command: string, args: ReadonlyArray<string>) =>
  exec({ command, args, timeLimit: TimeLimit.read, env: { LC_ALL: "C" } }).pipe(
    Effect.map((out) => (out.exitCode === 0 ? out.stdout : undefined)),
    Effect.orElseSucceed(() => undefined),
  )

/** This machine's kernel figures: on macOS from sysctl and vm_stat, on Linux from /proc. */
const kernelOf = (platform: NodeJS.Platform, cores: () => number) =>
  Effect.gen(function* () {
    if (platform === "darwin") {
      const sysctl = yield* output("sysctl", [
        "-n",
        "kern.memorystatus_vm_pressure_level",
        "vm.loadavg",
        "hw.ncpu",
      ])
      const vmstat = yield* output("vm_stat", [])
      return sysctl === undefined ? undefined : parseDarwin(sysctl, vmstat ?? "")
    }
    if (platform === "linux") {
      const fs = yield* FileSystem.FileSystem
      // A file the kernel lacks (no pressure stall information) says nothing.
      const read = (path: string) => fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""))
      return parseLinux({
        loadavg: yield* read("/proc/loadavg"),
        pressure: yield* read("/proc/pressure/memory"),
        meminfo: yield* read("/proc/meminfo"),
        vmstat: yield* read("/proc/vmstat"),
        cores: cores(),
      })
    }
    return undefined
  })

/** The live source, for `platform`: ps, and sysctl and vm_stat or /proc. */
export const liveLoad = (
  platform: NodeJS.Platform = process.platform,
  cores: () => number = availableParallelism,
): LoadSource => ({
  processes: Effect.map(output("ps", psArgs), (text) =>
    text === undefined ? undefined : parseProcesses(text),
  ),
  kernel: kernelOf(platform, cores),
})

/** The source a run reads the machine's load from; none (null) unless a layer gives one. */
export const Load = Context.Reference<LoadSource | null>("tutti/run/load/Load", {
  defaultValue: () => null,
})

/**
 * Reads the machine's load from `source` now and every loadEvery after, forever, and gives each
 * reading to `show`: the workers' roots, by ticket, are `roots`' as each reading starts.
 */
export const watchLoad = (options: {
  readonly source: LoadSource
  readonly roots: Effect.Effect<ReadonlyMap<string, number>>
  readonly self: number
  readonly show: (reading: Reading) => Effect.Effect<void>
}): Effect.Effect<never, never, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    let sampler = newSampler
    for (;;) {
      const roots = yield* options.roots
      const processes = yield* options.source.processes
      const kernel = yield* options.source.kernel
      const now = yield* Clock.currentTimeMillis
      const next = sample({ sampler, now, processes, kernel, roots, self: options.self })
      sampler = next.sampler
      yield* options.show(next.reading)
      yield* Effect.sleep(loadEvery)
    }
  })
