// The machine's power as a bare `tutti`'s run (src/main.ts's runFrom) reads it before it begins:
// keeping the machine awake (src/run/keepAwake.ts), the battery and the lid (src/run/battery.ts).
import { Effect, Scope, SubscriptionRef } from "effect"
import type { AppConfigValue } from "../../core/AppConfig.ts"
import { type BatteryReading, batteryNote, liveBattery } from "../../run/battery.ts"
import { type KeepAwakePlan, keepAwake, keepAwakePlan, lidNote } from "../../run/keepAwake.ts"
import { whichOnPath } from "../../services/onPath.ts"

/** The machine's power as the run read it, and the keep-awake command's hold on it. */
export interface Power {
  /** The keep-awake command the run starts, or the warning the START block gives for none. */
  readonly awake: KeepAwakePlan
  /** The battery as the run started: null for none, undefined where it can't be read. */
  readonly battery: BatteryReading | null | undefined
  /**
   * The START block's notes: the warning where there is no keep-awake command, the lid on a
   * laptop kept awake, and a start on battery.
   */
  readonly notes: ReadonlyArray<string>
  /** Whether the keep-awake command holds the machine awake, for the title line's badge. */
  readonly keepingAwake: SubscriptionRef.SubscriptionRef<boolean>
  /** The run's option for the title line's badge: the hold's changes, where there is a command. */
  readonly runOption: () => {
    readonly keepingAwake?: ReturnType<typeof SubscriptionRef.changes<boolean>>
  }
  /**
   * The keep-awake command, started in the run's scope `runScope`, which it closes with, its line
   * in the log, `before` run first, as the run begins: nothing where there is no command, or where
   * `holdFirst` started it already.
   */
  readonly hold: (
    runScope: Scope.Scope,
    before?: Effect.Effect<void>,
  ) => ReturnType<typeof keepAwake>
  /**
   * The keep-awake command started before the run begins, in `runScope`, as an overnight run does
   * before its pre-flight: `hold` then starts nothing. Nothing where there is no command.
   */
  readonly holdFirst: (runScope: Scope.Scope) => ReturnType<typeof keepAwake>
}

/**
 * The machine's power as the run `config` describes reads it: the keep-awake command, or the
 * warning the START block gives where there is none; the battery, which a run that starts on says
 * so in its START block; and on a machine with a battery, a laptop, kept awake, that a closed lid
 * still sleeps it.
 */
export const power = (config: Pick<AppConfigValue, "keepAwake" | "repo">) =>
  Effect.gen(function* () {
    const awake = keepAwakePlan({
      on: config.keepAwake,
      platform: process.platform,
      pid: process.pid,
      which: whichOnPath,
    })
    const battery = yield* liveBattery().read
    const onBattery = batteryNote(battery)
    const lid =
      awake._tag === "Command" && battery !== null && battery !== undefined
        ? lidNote(process.platform)
        : null
    const notes = [
      ...(awake._tag === "Missing" ? [awake.warning] : []),
      ...(lid === null ? [] : [lid]),
      ...(onBattery === null ? [] : [onBattery]),
    ]
    const keepingAwake = yield* SubscriptionRef.make(false)
    let kept = false
    const made: Power = {
      awake,
      battery,
      notes,
      keepingAwake,
      runOption: () =>
        awake._tag === "Command" ? { keepingAwake: SubscriptionRef.changes(keepingAwake) } : {},
      hold: (runScope, before = Effect.void) =>
        Effect.gen(function* () {
          if (awake._tag !== "Command" || kept) return
          yield* before
          yield* keepAwake(awake.command, config.repo, keepingAwake).pipe(Scope.provide(runScope))
        }),
      holdFirst: (runScope) =>
        Effect.gen(function* () {
          if (awake._tag !== "Command") return
          yield* keepAwake(awake.command, config.repo, keepingAwake).pipe(Scope.provide(runScope))
          kept = true
        }),
    }
    return made
  })
