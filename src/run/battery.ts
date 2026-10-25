// The machine's battery (§ 5 item 16): a run on a laptop's battery goes only as long as the
// battery, and a Mac that runs it flat sleeps, or shuts down, under the run (tutti-yhjt: 19% to 1%
// unannounced, then 'Low Power Sleep'). The run reads the battery's level and whether it draws on
// it: on macOS from `pmset -g batt`, on Linux from /sys/class/power_supply/BAT*; a machine with no
// battery, or one that can't be read, reads as none. The START block says when the run starts on
// battery (`batteryNote`); while it goes, the run reads the battery every batteryEvery, counted
// awake, and as it falls to 20% and to 10% says so once each per discharge: the log's BATTERY line
// and a `battery` record (§ 10), which notifies at 10% (notices.ts), and the dashboard's warning
// line while it stays low. Plugged in again, the notice goes, and the next discharge says both again.
//
// The run reads it through Battery: main.ts gives the live source, and a run without one (the
// tests') reads nothing; src/testing/Battery.ts gives a test the battery's readings.
import { Context, Duration, Effect, FileSystem } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { exec } from "../services/exec.ts"
import { sleepAwake, timeoutAwake } from "../services/Wake.ts"
import { EventStream } from "./eventstream.ts"
import { type Line, Log, Tag, tagged } from "./log.ts"

/** What the battery says: its charge, in percent, and whether the machine draws on it. */
export interface BatteryReading {
  /** 0 to 100. */
  readonly level: number
  /** Not plugged in: the machine runs on the battery, which is running down. */
  readonly discharging: boolean
}

/** The levels at which the run says the battery is low, highest first. */
export const batteryThresholds = [20, 10] as const
export type Threshold = (typeof batteryThresholds)[number]

/** The level at which a notice also notifies. */
export const notifyAt: Threshold = 10

/** How often the run reads the battery while it goes, counted awake. */
export const batteryEvery: Duration.Duration = Duration.minutes(1)

/** How long a reading may take, counted awake, before it reads as none. */
export const batteryReadLimit: Duration.Duration = Duration.seconds(10)

/** A percentage, `62` of `62%`, or undefined for anything but a whole number from 0 to 100. */
const percent = (text: string): number | undefined => {
  const trimmed = text.trim()
  if (!/^\d{1,3}$/.test(trimmed)) return undefined
  const n = Number(trimmed)
  return n <= 100 ? n : undefined
}

/**
 * `pmset -g batt`'s answer: where the power comes from (`Now drawing from 'Battery Power'`), then
 * a line per battery (` -InternalBattery-0 (id=…)\t62%; discharging; 3:45 remaining present:
 * true`); null when it names no battery, as on a Mac without one. The source says whether the
 * machine draws on the battery; without it, the battery's state does.
 */
export const parsePmset = (text: string): BatteryReading | null => {
  const source = /Now drawing from '([^']*)'/.exec(text)?.[1]
  for (const each of text.split("\n")) {
    const match = /(\d+)%;\s*([^;]*)/.exec(each)
    if (match === null) continue
    const level = percent(match[1] ?? "")
    if (level === undefined) continue
    const state = (match[2] ?? "").trim().toLowerCase()
    const discharging = source === undefined ? state === "discharging" : source === "Battery Power"
    return { level, discharging }
  }
  return null
}

/** One battery under /sys/class/power_supply: its `capacity` and `status` files, "" unread. */
export interface SysBattery {
  readonly capacity: string
  readonly status: string
}

/**
 * Linux's batteries, from each BAT*'s `capacity` (`62`) and `status` (`Discharging`, `Charging`,
 * `Full`, `Not charging`, `Unknown`): their mean level, and discharging when one of them is; null
 * when none has a level that reads.
 */
export const parseSys = (batteries: ReadonlyArray<SysBattery>): BatteryReading | null => {
  const levels: Array<number> = []
  let discharging = false
  for (const battery of batteries) {
    const level = percent(battery.capacity)
    if (level === undefined) continue
    levels.push(level)
    if (battery.status.trim().toLowerCase() === "discharging") discharging = true
  }
  if (levels.length === 0) return null
  const level = Math.round(levels.reduce((sum, n) => sum + n, 0) / levels.length)
  return { level, discharging }
}

/**
 * Where a run reads the battery from: null for no battery, undefined for one that can't be read
 * now (the command failed, or took too long), which changes nothing the run has said.
 */
export interface BatterySource {
  readonly read: Effect.Effect<
    BatteryReading | null | undefined,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
  >
}

/** Linux's folder of power supplies. */
export const powerSupplies = "/sys/class/power_supply"

/** This machine's battery: pmset on macOS, /sys on Linux, none elsewhere. */
const readOf = (platform: NodeJS.Platform) =>
  Effect.gen(function* () {
    if (platform === "darwin") {
      const out = yield* exec({
        command: "pmset",
        args: ["-g", "batt"],
        timeLimit: batteryReadLimit,
        env: { LC_ALL: "C" },
      })
      return out.exitCode === 0 ? parsePmset(out.stdout) : undefined
    }
    if (platform === "linux") {
      const fs = yield* FileSystem.FileSystem
      const read = (path: string) => fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""))
      // No folder: no power supplies, so no battery.
      const names = yield* fs.readDirectory(powerSupplies).pipe(Effect.orElseSucceed(() => []))
      const batteries: Array<SysBattery> = []
      for (const name of names.filter((each) => each.startsWith("BAT")).toSorted()) {
        batteries.push({
          capacity: yield* read(`${powerSupplies}/${name}/capacity`),
          status: yield* read(`${powerSupplies}/${name}/status`),
        })
      }
      return parseSys(batteries)
    }
    return null
  })

/**
 * The live source, for `platform`: a reading that fails, or takes longer than batteryReadLimit
 * awake, can't be read.
 */
export const liveBattery = (platform: NodeJS.Platform = process.platform): BatterySource => ({
  read: readOf(platform).pipe(
    Effect.orElseSucceed(() => undefined),
    timeoutAwake({ duration: batteryReadLimit, orElse: () => Effect.succeed(undefined) }),
  ),
})

/** The source a run reads the battery from; none (null) unless a layer gives one. */
export const Battery = Context.Reference<BatterySource | null>("tutti/run/battery/Battery", {
  defaultValue: () => null,
})

/** The START block's note for a run that starts on `battery`; null off it, or with none. */
export const batteryNote = (battery: BatteryReading | null | undefined): string | null =>
  battery?.discharging === true
    ? `on battery (${battery.level}%): plug in to keep the run going`
    : null

/** What runs out with the battery on `platform`: `the Mac`, or `the machine`. */
const machineOf = (platform: NodeJS.Platform): string =>
  platform === "darwin" ? "the Mac" : "the machine"

/** `BATTERY: 10% left, not charging: plug in or the Mac will sleep`. */
export const batteryLine = (level: number, platform: NodeJS.Platform): Line =>
  tagged(Tag.battery)`${level}% left, not charging: plug in or ${machineOf(platform)} will sleep`

/** What the watcher keeps between readings: the thresholds said in this discharge. */
export type Said = ReadonlySet<Threshold>

/** What a reading does: the thresholds said after it, the one to say now, and whether it is low. */
export interface Step {
  readonly said: Said
  /** The threshold to say now, the lowest the level is at or under that wasn't said; or null. */
  readonly say: Threshold | null
  /** Discharging at or under a threshold: the dashboard shows the notice. */
  readonly low: boolean
}

/**
 * What `reading` does after `said`: off the battery, or with none, nothing is low and the next
 * discharge says each threshold again; discharging, the lowest threshold it is at or under says so,
 * once, and those above it count as said with it.
 */
export const step = (said: Said, reading: BatteryReading | null): Step => {
  if (reading === null || !reading.discharging) return { said: new Set(), say: null, low: false }
  const under = batteryThresholds.filter((threshold) => reading.level <= threshold)
  const lowest = under.at(-1)
  if (lowest === undefined) return { said, say: null, low: false }
  if (said.has(lowest)) return { said, say: null, low: true }
  return { said: new Set([...said, ...under]), say: lowest, low: true }
}

/**
 * Reads the battery from `source` now and every batteryEvery awake after, forever: says each
 * threshold as it is reached (its BATTERY line and `battery` record), and gives `show` the
 * dashboard's notice, the line at the level last read while it is low, null once it isn't. A
 * reading that fails changes nothing.
 */
export const watchBattery = (options: {
  readonly source: BatterySource
  readonly platform: NodeJS.Platform
  readonly show: (notice: string | null) => Effect.Effect<unknown>
}): Effect.Effect<
  never,
  never,
  Log | EventStream | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const logs = yield* Log
    const events = yield* EventStream
    let said: Said = new Set()
    let shown: string | null = null
    for (;;) {
      const reading = yield* options.source.read
      // Unread this time: as it was.
      if (reading === undefined) {
        yield* sleepAwake(batteryEvery)
        continue
      }
      const next = step(said, reading)
      said = next.said
      if (next.say !== null && reading !== null) {
        const text = batteryLine(reading.level, options.platform)
        yield* logs.writeWith(
          [text],
          events.emit({ kind: "battery", level: reading.level, threshold: next.say, text }),
        )
      }
      const notice =
        next.low && reading !== null ? batteryLine(reading.level, options.platform) : null
      if (notice !== shown) {
        shown = notice
        yield* options.show(notice)
      }
      yield* sleepAwake(batteryEvery)
    }
  })
