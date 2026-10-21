// The machine's runs (orchestra 0.8.5's machine.go): runs share the machine, and their checks slow
// each other down. Each run registers itself while it runs, a file of its own in the folder the
// machine's orchestra runs register in (`runs/` in orchestra's cache folder, or ORCHESTRA_RUNS_DIR),
// in orchestra's format, so that tutti and orchestra see each other's runs: its PID, repository,
// concurrent, start time and how many of its workers run, written again as that changes, through a
// file beside it renamed over it, and removed as the run ends. tutti's files also say `"tool":
// "tutti"`, which orchestra skips.
//
// A run reads the others' as it goes: it says once of each other run that it is going
// (SHARED_MACHINE), and that it has ended. With --machine-workers, a free slot waits while the
// workers running across all the runs are at that cap (HOLD: MACHINE, run.ts). A file whose PID is
// gone, or is a process that started after the run did (the PID taken again since), is a run that
// ended without removing it: it is ignored and removed. A folder that can't be read holds no run,
// and one removed under the runs (a cache cleaner) is made again as the run next writes.
import { isAbsolute, join } from "node:path"
import { Context, Duration, Effect, FileSystem, Ref, type Scope, Semaphore } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { exec, TimeLimit } from "../services/exec.ts"
import { detail, type Line, Tag, tagged } from "./log.ts"

/** The variable naming the folder the machine's runs register in; `off` registers the run nowhere. */
export const runsDirVariable = "ORCHESTRA_RUNS_DIR"

/** The variables `runsDir` reads. */
export const runsDirVariables = [runsDirVariable, "HOME", "XDG_CACHE_HOME"] as const

/**
 * The folder the machine's runs register in, as orchestra finds it: ORCHESTRA_RUNS_DIR, else
 * `runs/` in orchestra's folder in the user's cache folder (`~/Library/Caches/orchestra/runs` on
 * macOS, `$XDG_CACHE_HOME/orchestra/runs` or `~/.cache/orchestra/runs` elsewhere); null for none,
 * when ORCHESTRA_RUNS_DIR is `off` or there is no cache folder.
 */
export const runsDir = (
  env: (name: string) => string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | null => {
  const given = env(runsDirVariable)
  if (given === "off") return null
  if (given !== undefined && given !== "") return given
  const home = env("HOME")
  const xdg = env("XDG_CACHE_HOME")
  const cache =
    platform === "darwin"
      ? home === undefined || home === ""
        ? null
        : join(home, "Library", "Caches")
      : xdg !== undefined && xdg !== ""
        ? isAbsolute(xdg)
          ? xdg
          : null
        : home === undefined || home === ""
          ? null
          : join(home, ".cache")
  return cache === null ? null : join(cache, "orchestra", "runs")
}

/** A run's file in the machine's folder of runs, as orchestra writes and reads it. */
export interface Registration {
  readonly pid: number
  readonly repo: string
  readonly concurrent: number
  /** When the run started, in epoch milliseconds (RFC 3339 in the file). */
  readonly started: number
  /** Its workers running, merges and checks included. */
  readonly running: number
  /** The tool that runs it: tutti says so in its files, orchestra doesn't. */
  readonly tool: "orchestra" | "tutti"
}

/** A registration's name ends so; one being written ends in `.tmp` until it is renamed. */
const registrationExt = ".json"

const count = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0

/**
 * The registration `text` holds, or undefined when it isn't one: not JSON, without a PID, or with
 * a start that isn't a time. Missing counts are 0, as Go's decoding leaves them.
 */
export const readRegistration = (text: string): Registration | undefined => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const fields = value as Record<string, unknown>
  const pid = count(fields.pid)
  const started = typeof fields.started === "string" ? Date.parse(fields.started) : Number.NaN
  if (pid === 0 || Number.isNaN(started)) return undefined
  return {
    pid,
    repo: typeof fields.repo === "string" ? fields.repo : "",
    concurrent: count(fields.concurrent),
    started,
    running: count(fields.running),
    tool: fields.tool === "tutti" ? "tutti" : "orchestra",
  }
}

/**
 * `started` in RFC 3339 with milliseconds, in UTC, as Go's encoding/json decodes a time. tutti's
 * event stream writes local times (events.ts); a registration's time is only compared.
 */
const showStarted = (millis: number): string => new Date(millis).toISOString()

/** The registration's JSON, as orchestra's encoding/json writes its fields, and tutti's tool. */
export const writeRegistration = (reg: Registration): string =>
  JSON.stringify({
    pid: reg.pid,
    repo: reg.repo,
    concurrent: reg.concurrent,
    started: showStarted(reg.started),
    running: reg.running,
    tool: reg.tool,
  })

/**
 * How the run tells whether a registered run's process is there: `alive`, whether process `pid`
 * runs; `start`, when it started, in epoch milliseconds, or null when that can't be read.
 */
export interface ProcessCheck {
  readonly alive: (pid: number) => boolean
  readonly start: (
    pid: number,
  ) => Effect.Effect<
    number | null,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
  >
}

/**
 * The seconds `ps -o etime=` says a process has run: `[[dd-]hh:]mm:ss`, as macOS and Linux give
 * it; undefined for anything else. Elapsed time has no time zone, which a start time printed in
 * local time has, and the test runner's isn't the machine's.
 */
export const elapsedSeconds = (text: string): number | undefined => {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text.trim())
  if (match === null) return undefined
  const [, days, hours, minutes, seconds] = match
  return (
    ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)
  )
}

/**
 * When process `pid` started, in epoch milliseconds to the second: now, less how long `ps` says it
 * has run. null when ps can't say.
 */
const psStart = (pid: number) =>
  exec({
    command: "ps",
    args: ["-o", "etime=", "-p", String(pid)],
    timeLimit: TimeLimit.read,
    env: { LC_ALL: "C" },
  }).pipe(
    Effect.map((output) => {
      const seconds = output.exitCode === 0 ? elapsedSeconds(output.stdout) : undefined
      // Wall-clock time, as the registrations' starts are.
      return seconds === undefined ? null : Date.now() - seconds * 1000
    }),
    Effect.orElseSucceed(() => null),
  )

/**
 * Whether process `pid` runs: one this user may not signal does too, as another user's. (carry.ts
 * has its own, which AppConfig, importing this module, can't reach without a cycle.)
 */
const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** The live check: kill -0 for whether it runs, ps for when it started. */
export const liveProcesses: ProcessCheck = { alive: processAlive, start: psStart }

/** The process check the machine uses: the live one, unless a test gives its own. */
export const Processes = Context.Reference<ProcessCheck>("tutti/run/machine/Processes", {
  defaultValue: () => liveProcesses,
})

/**
 * How far a process's start time, as `ps` gives it, may fall after the start in its run's
 * registration: ps gives its time to the second.
 */
export const startSlack = 2000

/** What a look at the other runs found: the lines to say, and how many other runs are going. */
export interface Seen {
  /** `SHARED_MACHINE: another … run is going in …`, or `the other … run in … has ended`. */
  readonly text: Line
  /** How many other runs are going, which can be 0. */
  readonly shared: number
}

/** The run's registration, and what it knows of the machine's other runs. */
export interface Machine {
  /** Writes that `n` of the run's workers run, when that changed; a failed write is tried again. */
  running(n: number): Effect.Effect<void>
  /**
   * Reads the other runs' files, removing those whose run is gone, and gives what it says of the
   * runs that started and ended since it last read them, those that started first first.
   */
  readonly look: Effect.Effect<ReadonlyArray<Seen>>
  /** The workers running in the other runs, as last read. */
  readonly others: Effect.Effect<number>
}

/** The word of the hold at --machine-workers, on the dashboard's title line while it holds. */
export const holdWord = "MACHINE"

/** How often a run held at --machine-workers reads the other runs, to fill the slot one frees. */
export const machinePoll: Duration.Duration = Duration.seconds(2)

/** HOLD: MACHINE: the workers across the machine's runs, `own` of them this run's, are at `cap`. */
export const holdLine = (all: number, own: number, cap: number): Line =>
  tagged(
    Tag.hold,
  )`${holdWord}: the machine's tutti and orchestra runs have ${workersCount(all)} running, ${own} of them this run's, at the cap of ${cap} (--machine-workers); the next ticket starts once one of them finishes`

/** `1 worker` or `<n> workers`. */
export const workersCount = (n: number): string => (n === 1 ? "1 worker" : `${n} workers`)

/** SHARED_MACHINE: another run is going in `reg`'s repository. */
export const sharedLine = (reg: Registration): Line =>
  tagged(
    "SHARED_MACHINE",
  )`another ${reg.tool} run is going in ${reg.repo} with ${workersCount(reg.concurrent)}; their checks slow each other down`

/** The other run in `reg`'s repository has ended. */
export const endedLine = (reg: Registration): Line =>
  detail`the other ${reg.tool} run in ${reg.repo} has ended`

/** A registration file's name of its own for process `pid`: runs in one process (tests) share one. */
const nameFor = (pid: number): string =>
  `run-${pid}-${crypto.getRandomValues(new Uint32Array(1))[0]}${registrationExt}`

/**
 * The run's registration in `dir`, written as the run starts (`concurrent`, its repository) and
 * removed as its scope closes, and what it knows of the other runs. With `dir` null the run
 * registers nowhere and sees no other run. A folder or file it can't make leaves the run without a
 * registration, still reading the others'; `cannot` says why, once.
 */
export const make = (options: {
  readonly dir: string | null
  readonly repo: string
  readonly concurrent: number
  readonly cannot?: (why: string) => Effect.Effect<void>
}): Effect.Effect<
  Machine,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const check = yield* Processes
    const context = yield* Effect.context<
      FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
    >()
    const { dir } = options
    // Wall-clock time, not the run's Clock: the others compare it with when the process started.
    let me: Registration = {
      pid: process.pid,
      repo: options.repo,
      concurrent: options.concurrent,
      started: Date.now(),
      running: 0,
      tool: "tutti",
    }
    const path = dir === null ? null : join(dir, nameFor(process.pid))
    // Whether `me` is in its file as it is: a failed write, or a folder removed under the run, is
    // written again at the next chance.
    const written = yield* Ref.make(false)
    const seen = yield* Ref.make<ReadonlyMap<string, Registration>>(new Map())
    const others = yield* Ref.make(0)
    // When each PID's process started, once read: a PID gone since is read again.
    const starts = new Map<number, number | null>()
    // One look at a time, so that a run that started is said once.
    const oneLook = yield* Semaphore.make(1)

    const write = (reg: Registration) =>
      Effect.gen(function* () {
        if (dir === null || path === null) return false
        const temporary = `${path}.tmp`
        const text = writeRegistration(reg)
        yield* fs.makeDirectory(dir, { recursive: true })
        yield* fs.writeFileString(temporary, text)
        yield* fs.rename(temporary, path)
        return true
      })

    const writeMe = (reg: Registration) =>
      Effect.flatMap(Effect.result(write(reg)), (result) =>
        Ref.set(written, result._tag === "Success" && result.success),
      )

    if (path !== null) {
      const first = yield* Effect.result(write(me))
      if (first._tag === "Failure") {
        yield* (options.cannot ?? (() => Effect.void))(
          `could not register the run among the machine's runs in ${dir}: ${first.failure.message}`,
        )
      }
      yield* Ref.set(written, first._tag === "Success")
      // The others remove one left behind, whose PID is gone.
      yield* Effect.addFinalizer(() => Effect.ignore(fs.remove(path)))
    }

    // Whether `reg`'s run has ended: its PID runs no process, or one that started after the run
    // did, which took the PID once the run had ended. A start time that can't be read doesn't say.
    const gone = (reg: Registration) =>
      Effect.gen(function* () {
        if (!check.alive(reg.pid)) {
          starts.delete(reg.pid)
          return true
        }
        let start = starts.get(reg.pid)
        if (start === undefined) {
          start = yield* check.start(reg.pid).pipe(Effect.provideContext(context))
          starts.set(reg.pid, start)
        }
        return start !== null && start > reg.started + startSlack
      })

    const look = Effect.gen(function* () {
      if (dir === null) return []
      const names = yield* Effect.result(fs.readDirectory(dir))
      if (names._tag === "Failure") {
        // No folder yet, or one removed under the runs: the run's own file is written again, the
        // folder with it, and the runs last seen are heard of again once it can be read.
        yield* Ref.set(others, 0)
        yield* Ref.set(written, false)
        return []
      }
      const now = new Map<string, Registration>()
      const mine = path !== null && names.success.some((name) => join(dir, name) === path)
      for (const name of names.success.toSorted()) {
        const file = join(dir, name)
        if (!name.endsWith(registrationExt) || file === path) continue
        const text = yield* Effect.result(fs.readFileString(file))
        // One being made, removed meanwhile, or not a run's.
        const reg = text._tag === "Success" ? readRegistration(text.success) : undefined
        if (reg === undefined) continue
        if (yield* gone(reg)) {
          yield* Effect.ignore(fs.remove(file)) // another run may have removed it first
          continue
        }
        now.set(name, reg)
      }
      if (path !== null && !mine) yield* Ref.set(written, false)
      const before = yield* Ref.get(seen)
      yield* Ref.set(seen, now)
      yield* Ref.set(
        others,
        [...now.values()].reduce((sum, reg) => sum + reg.running, 0),
      )
      const shared = now.size
      const ended = [...before]
        .filter(([name]) => !now.has(name))
        .map(([, reg]) => ({ text: endedLine(reg), shared }))
      const started = [...now]
        .filter(([name]) => !before.has(name))
        .toSorted(([a, x], [b, y]) => x.started - y.started || a.localeCompare(b))
        .map(([, reg]) => ({ text: sharedLine(reg), shared }))
      return [...ended, ...started]
    })

    return {
      running: (n) =>
        Effect.gen(function* () {
          if (path === null || ((yield* Ref.get(written)) && me.running === n)) return
          me = { ...me, running: n }
          yield* writeMe(me)
        }),
      look: oneLook.withPermits(1)(look),
      others: Ref.get(others),
    }
  })
