// Why the machine slept (§ 5 item 15, tutti-abem): once the run notices a sleep (Wake.ts), on macOS
// it reads pmset's log for the sleep that began as the machine was last seen awake, and the SLEPT
// line names the cause in words: the lid closed, the battery low, idle, asked to sleep. A closed lid
// sleeps a Mac whatever keeping it awake does (caffeinate -i prevents idle sleep only), and the SLEPT
// line said only that the machine slept (2026-10-25: 'Clamshell Sleep' during a run).
//
// pmset's log is the system's text: only a line that reads as pmset writes it counts, its reason is
// matched against the four below, and only tutti's own words for them reach the line, so nothing of
// the log's text is shown (§ 7.10). The read has a time limit; one that fails, takes too long or
// finds no line names no cause, and the SLEPT line is as it was. Off macOS no cause is read.
//
// The run reads it through SleepCauses: main.ts gives the live source, and a run without one (the
// tests') reads none.
import { Context, Duration, Effect, type FileSystem } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { exec } from "../services/exec.ts"
import { timeoutAwake } from "../services/Wake.ts"

/** Why the machine slept, in the SLEPT line's words. */
export type SleepCause = "lid closed" | "battery low" | "idle" | "asked to sleep"

/**
 * pmset's reasons for a sleep (`Entering Sleep state due to '<reason>'`), and their words. A
 * Software Sleep's reason may name the process that asked: `Software Sleep pid=412`.
 */
export const pmsetReasons: ReadonlyMap<string, SleepCause> = new Map<string, SleepCause>([
  ["Clamshell Sleep", "lid closed"],
  ["Low Power Sleep", "battery low"],
  ["Idle Sleep", "idle"],
  ["Software Sleep", "asked to sleep"],
])

/** How far from the instant the machine was last seen awake a sleep's line may be, in ms. */
export const causeWithin: Duration.Duration = Duration.minutes(1)

/** How long reading pmset's log may take, counted awake, before it names no cause. */
export const causeReadLimit: Duration.Duration = Duration.seconds(15)

/**
 * A line of `pmset -g log` that enters sleep: `2026-10-25 12:09:30 +0200 Sleep \tEntering Sleep
 * state due to 'Clamshell Sleep':TCPKeepAlive=active …`, its date with its UTC offset.
 */
const sleepEntry =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})\s+Sleep\s+Entering Sleep state due to '([^']{1,64})'/

/** The instant of a sleep entry's date, in epoch ms; undefined for a date that isn't one. */
const instantOf = (parts: ReadonlyArray<string>): number | undefined => {
  const [year, month, day, hour, minute, second, sign, offsetHours, offsetMinutes] = parts.map(
    (each, i) => (i === 6 ? each : Number(each)),
  ) as [number, number, number, number, number, number, string, number, number]
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return undefined
  }
  if (offsetHours > 14 || offsetMinutes > 59) return undefined
  const offset = (sign === "-" ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * 60_000
  return Date.UTC(year, month - 1, day, hour, minute, second) - offset
}

/**
 * The cause of the sleep that began at `from` (epoch ms), from `pmset -g log`'s text: the reason of
 * the sleep entry nearest `from`, within causeWithin, in words; null when no entry is that near, or
 * the nearest has a reason other than pmsetReasons' (a maintenance sleep, say).
 */
export const causeFromPmsetLog = (log: string, from: number): SleepCause | null => {
  const within = Duration.toMillis(causeWithin)
  let nearest: { readonly distance: number; readonly reason: string } | null = null
  for (const each of log.split("\n")) {
    const match = sleepEntry.exec(each)
    if (match === null) continue
    const at = instantOf(match.slice(1, 10))
    if (at === undefined) continue
    const distance = Math.abs(at - from)
    if (distance > within || (nearest !== null && distance >= nearest.distance)) continue
    nearest = { distance, reason: match[10] ?? "" }
  }
  return nearest === null
    ? null
    : (pmsetReasons.get(nearest.reason.replace(/ pid=\d+$/, "")) ?? null)
}

/** Where a run reads why the machine slept from. */
export interface SleepCauseSource {
  /** Why the sleep that began at `from` (epoch ms) happened; null when that can't be told. */
  readonly read: (
    from: number,
  ) => Effect.Effect<
    SleepCause | null,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
  >
}

/**
 * The live source, for `platform`: pmset's log on macOS, read within causeReadLimit awake; none
 * elsewhere. A read that fails, exits other than 0 or takes too long names no cause.
 */
export const liveSleepCauses = (
  platform: NodeJS.Platform = process.platform,
): SleepCauseSource => ({
  read: (from) =>
    platform !== "darwin"
      ? Effect.succeed(null)
      : exec({
          command: "pmset",
          args: ["-g", "log"],
          timeLimit: causeReadLimit,
          env: { LC_ALL: "C" },
        }).pipe(
          // A log past exec's limit keeps its last bytes, the newest, where the sleep just ended is.
          Effect.map((out) => (out.exitCode === 0 ? causeFromPmsetLog(out.stdout, from) : null)),
          Effect.orElseSucceed(() => null),
          timeoutAwake({ duration: causeReadLimit, orElse: () => Effect.succeed(null) }),
        ),
})

/** The source a run reads why the machine slept from; none (null) unless a layer gives one. */
export const SleepCauses = Context.Reference<SleepCauseSource | null>(
  "tutti/run/sleepCause/SleepCauses",
  { defaultValue: () => null },
)
