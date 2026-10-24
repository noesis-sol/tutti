// The Checks test layer (§ 3.3): scripted results. It chooses each check's command and time limit
// from AppConfig as the live layer does (checksOf), so a check with no command gives NoCheckCommand
// and runs nothing; only running a command differs. Each kind of check takes its results from its
// own list, in order; once the list is used up, it passes with nothing said. Every run is recorded.
import { type Duration, Effect, Layer } from "effect"
import { AppConfig } from "../cli/AppConfig.ts"
import {
  type CheckError,
  type CheckKind,
  CheckOutput,
  type CheckPassed,
  type CheckResult,
  Checks,
  checksOf,
  type RunOptions,
  resultOf,
  type Said,
} from "../services/Checks.ts"

/** A command that ran to its end: its exit code and what it printed, read as the live layer reads it. */
export interface Exited {
  readonly exitCode: number
  readonly output: string
}

/**
 * A scripted run: its result or error, the exit code and output of its command, an Effect giving
 * one (one that never ends, say), or a function of the run asked for giving one (to write its
 * output, say).
 */
export type Scripted =
  | CheckResult
  | Exited
  | CheckError
  | Effect.Effect<CheckResult, CheckError>
  | ((run: CheckRun) => Effect.Effect<CheckResult, CheckError>)

export type Script = { readonly [K in CheckKind]?: ReadonlyArray<Scripted> }

/** A run the layer was asked for. */
export interface CheckRun extends RunOptions {
  readonly check: CheckKind
  /** The command run, as AppConfig's settings name it (or the setup's own). */
  readonly command: string
  /** Its time limit, as AppConfig's settings give it. */
  readonly timeLimit: Duration.Input
  /** The check a setup came before. */
  readonly before?: "fast" | "full"
}

const nothingSaid: Said = {
  failingLines: [],
  lastLines: [],
  suites: [],
  suite: null,
  flaky: [],
  flakyCount: 0,
}

/** A passed check, with `said` laid over nothing said. */
export const passed = (check: CheckKind, said: Partial<Said> = {}): CheckPassed => ({
  _tag: "CheckPassed",
  check,
  command: `scripted ${check}`,
  ...nothingSaid,
  ...said,
})

const play = (scripted: Scripted, run: CheckRun): Effect.Effect<CheckResult, CheckError> => {
  if (Effect.isEffect(scripted)) return scripted
  if (typeof scripted === "function") return scripted(run)
  if (!("_tag" in scripted)) {
    const output = new CheckOutput()
    output.write(new TextEncoder().encode(scripted.output))
    return resultOf(run.check, run.command, scripted.exitCode, output, run.outputFile)
  }
  switch (scripted._tag) {
    case "CheckPassed":
    case "NoCheckCommand":
      return Effect.succeed(scripted)
    default:
      return Effect.fail(scripted)
  }
}

/**
 * The test layer, playing `script` for each check whose command AppConfig names; each run is pushed
 * onto `runs` when one is given.
 */
export const layer = (script: Script = {}, runs: Array<CheckRun> = []) => {
  const left = {
    setup: [...(script.setup ?? [])],
    fast: [...(script.fast ?? [])],
    full: [...(script.full ?? [])],
  }
  return Layer.effect(
    Checks,
    Effect.gen(function* () {
      const config = yield* AppConfig
      return checksOf(config.settings.checks, (check, command, timeLimit, options) =>
        Effect.suspend(() => {
          const run: CheckRun = { ...options, check, command, timeLimit }
          runs.push(run)
          const scripted = left[check].shift()
          return scripted === undefined ? Effect.succeed(passed(check)) : play(scripted, run)
        }),
      )
    }),
  )
}
