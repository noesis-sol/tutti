// The Checks test layer (§ 3.3): scripted results. Each kind of check takes its results from its
// own list, in order; once the list is used up, it passes with nothing said. Every run is recorded.
import { Effect, Layer } from "effect"
import {
  type CheckError,
  type CheckKind,
  type CheckPassed,
  type CheckResult,
  Checks,
  type RunOptions,
  type Said,
} from "../services/Checks.ts"

/**
 * A scripted run: its result or error, an Effect giving one (one that never ends, say), or a
 * function of the run asked for giving one (to write its output, say).
 */
export type Scripted =
  | CheckResult
  | CheckError
  | Effect.Effect<CheckResult, CheckError>
  | ((run: CheckRun) => Effect.Effect<CheckResult, CheckError>)

export type Script = { readonly [K in CheckKind]?: ReadonlyArray<Scripted> }

/** A run the layer was asked for. */
export interface CheckRun extends RunOptions {
  readonly check: CheckKind
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
  switch (scripted._tag) {
    case "CheckPassed":
    case "NoCheckCommand":
      return Effect.succeed(scripted)
    default:
      return Effect.fail(scripted)
  }
}

/** The test layer, playing `script`; each run is pushed onto `runs` when one is given. */
export const layer = (script: Script = {}, runs: Array<CheckRun> = []) => {
  const left = {
    setup: [...(script.setup ?? [])],
    fast: [...(script.fast ?? [])],
    full: [...(script.full ?? [])],
  }
  const next = (run: CheckRun) =>
    Effect.suspend(() => {
      runs.push(run)
      const scripted = left[run.check].shift()
      return scripted === undefined ? Effect.succeed(passed(run.check)) : play(scripted, run)
    })
  return Layer.succeed(Checks, {
    setup: ({ before, ...options }) => next({ check: "setup", before, ...options }),
    fast: (options) => next({ check: "fast", ...options }),
    full: (options) => next({ check: "full", ...options }),
  })
}
