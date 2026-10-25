// The machine kept awake while a run goes (§ 8.2 `--keep-awake`), as orchestra's keep_awake, but
// chosen for each run rather than in the project's settings: with --keep-awake, the system's
// keep-awake command, given tutti's PID, starts as the run begins and stops as the run's scope
// closes, after the report's organs (src/main.ts). It goes through exec, in a process group of its
// own that the scope kills; given the PID, it also ends by itself should tutti end some other way.
// Where the system has none, or it isn't on the PATH, the START block warns once (`keepAwakePlan`),
// and the run goes on all the same. While the command holds, the title line says so (§ 7.2).
import { Duration, Effect, SubscriptionRef } from "effect"
import { type Command, exec, showCommand } from "../services/exec.ts"
import { type Line, Log, line } from "./log.ts"

/** A command that keeps the machine awake while it goes. */
export type AwakeCommand = Pick<Command, "command" | "args">

/**
 * The keep-awake command of `platform` for the process `pid`, or null where tutti knows none:
 * caffeinate on macOS, which prevents idle sleep (-i) until the process -w names exits, and on
 * Linux systemd-inhibit, which holds off idle and sleep while the command it runs goes, there a tail
 * that ends with the process. Neither keeps a closed laptop awake (`lidNote`).
 */
export const awakeCommandOf = (platform: string, pid: number): AwakeCommand | null => {
  switch (platform) {
    case "darwin":
      return { command: "caffeinate", args: ["-i", "-w", String(pid)] }
    case "linux":
      return {
        command: "systemd-inhibit",
        args: [
          "--what=idle:sleep",
          "--who=tutti",
          "--why=a run of workers",
          "--mode=block",
          "tail",
          `--pid=${pid}`,
          "-f",
          "/dev/null",
        ],
      }
    default:
      return null
  }
}

/** What a run does to keep the machine awake: nothing, warn that it can't, or run the command. */
export type KeepAwakePlan =
  | { readonly _tag: "Off" }
  | { readonly _tag: "Missing"; readonly warning: string }
  | { readonly _tag: "Command"; readonly command: AwakeCommand }

/**
 * What a run on `platform` does to keep the machine awake for the process `pid` when `on`: the
 * command, when the system has one and `which` finds it on the PATH, else the warning the START
 * block gives.
 */
export const keepAwakePlan = (options: {
  readonly on: boolean
  readonly platform: string
  readonly pid: number
  readonly which: (command: string) => string | null
}): KeepAwakePlan => {
  if (!options.on) return { _tag: "Off" }
  const awake = awakeCommandOf(options.platform, options.pid)
  if (awake === null) {
    return {
      _tag: "Missing",
      warning: `--keep-awake: tutti can't keep the machine awake on ${options.platform}; set it not to sleep, or the run sleeps with it`,
    }
  }
  if (options.which(awake.command) === null) {
    return {
      _tag: "Missing",
      warning: `--keep-awake: ${awake.command} isn't on the PATH, so nothing keeps the machine awake and the run sleeps with it; set the machine not to sleep`,
    }
  }
  return { _tag: "Command", command: awake }
}

/**
 * What the START block says of a closed lid on `platform`, in a run kept awake on a machine with a
 * battery, a laptop; null where tutti knows nothing to say. caffeinate -i prevents idle sleep only,
 * so a closed lid sleeps a Mac but in clamshell mode. logind ignores systemd-inhibit's sleep lock
 * for the lid (LidSwitchIgnoreInhibited defaults to yes), so a closed lid suspends a Linux laptop
 * but when it is docked (HandleLidSwitchDocked, whose default ignores the lid). tutti changes
 * neither setting itself: each is the whole machine's.
 */
export const lidNote = (platform: string): string | null => {
  switch (platform) {
    case "darwin":
      return "--keep-awake prevents idle sleep only: closing the lid still sleeps the Mac unless it runs on power with an external display; sudo pmset -a disablesleep 1 keeps a closed Mac awake, system-wide, until sudo pmset -a disablesleep 0, which tutti never runs itself"
    case "linux":
      return "--keep-awake holds off idle sleep and suspend, but closing the lid still suspends the machine unless it is docked or has an external display, as logind ignores the lock for the lid (LidSwitchIgnoreInhibited); HandleLidSwitch=ignore in logind.conf keeps a closed laptop awake, system-wide, which tutti never sets itself"
    default:
      return null
  }
}

/** How long the keep-awake command has between SIGTERM and SIGKILL as it is stopped. */
export const keepAwakeGrace: Duration.Duration = Duration.seconds(1)

/** The log's line as the run starts keeping the machine awake with `awake`. */
export const keepingAwakeLine = (awake: AwakeCommand): Line =>
  line`keeping the machine awake while the run goes: ${showCommand(awake)}`

/**
 * Keeps the machine awake with `awake`, run in `cwd`, until the scope closes, which stops it. The
 * command ending by itself while the scope is open, or not starting, is a line in the log.
 * `holding` says whether it holds, for the title line's badge: true as it starts, false once it
 * has ended.
 */
export const keepAwake = (
  awake: AwakeCommand,
  cwd: string,
  holding: SubscriptionRef.SubscriptionRef<boolean>,
) =>
  Effect.gen(function* () {
    const logs = yield* Log
    yield* logs.write(keepingAwakeLine(awake))
    yield* SubscriptionRef.set(holding, true)
    yield* exec({
      ...awake,
      cwd,
      timeLimit: Duration.infinity,
      killGrace: keepAwakeGrace,
    }).pipe(
      Effect.map(
        (output) => `exit status ${output.exitCode}${said(output.stderr || output.stdout)}`,
      ),
      Effect.match({
        onSuccess: (why) => why,
        onFailure: (error) => (error._tag === "CommandNotRun" ? error.reason : error.message),
      }),
      Effect.flatMap((why) =>
        Effect.andThen(
          SubscriptionRef.set(holding, false),
          logs.write(line`${awake.command} ended (${why}): nothing keeps the machine awake`),
        ),
      ),
      Effect.forkScoped,
    )
  })

/** `: <its first line>` of what a command said, or nothing. */
const said = (output: string): string => {
  const first = output.trim().split("\n")[0]?.trim() ?? ""
  return first === "" ? "" : `: ${first}`
}
