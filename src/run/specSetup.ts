// A spec run's setup (§ 4.14 "From an empty repository"): where --spec (or TUTTI_SPEC) is given in a
// repository `tutti init` hasn't set up, and no worker prompt of its own, the run sets it up first,
// as init does without a terminal (`setUp`, src/cli/commands.ts's setUpForSpec), before its startup
// checks; the files that wrote are no clean-tree problem, and are committed with the spec.
//
// Nothing is set up for a spec the run can't read: the startup checks then say what is wrong with
// it, beside the setup that is missing, and nothing is left behind. A setup an earlier spec run
// wrote and stopped before committing (its settings untracked) is taken again as it is, its files
// committed with the spec, so that it doesn't hold the next run as uncommitted changes.
import { join } from "node:path"
import { Effect, FileSystem, Result } from "effect"
import { settingsFile } from "../project/settings.ts"
import { Git, type StatusEntry } from "../services/Git.ts"
import { readSpec } from "./spec.ts"
import { findRepository } from "./startup.ts"

/** The runners init writes, beside `.tutti/`. */
export const setupRunners: ReadonlyArray<string> = [
  "scripts/check-fast.sh",
  "scripts/check-full.sh",
]

/** What a spec run's setup is given. */
export interface SpecSetup<R = never> {
  /** The folder tutti was started in. */
  readonly cwd: string
  /** The spec as given, and what gave it (`--spec`, `TUTTI_SPEC`); null for no spec run. */
  readonly spec: { readonly given: string; readonly from: string } | null
  /** A worker prompt of its own was given (--prompt): a run that needs no setup. */
  readonly ownPrompt: boolean
  /** Sets the repository up from `cwd`, as init does without a terminal: whether it did. */
  readonly setUp: Effect.Effect<boolean, never, R>
  /** Says a line before the setup: what it is doing. */
  readonly say: (text: string) => Effect.Effect<void>
}

/** What a spec run's setup says as it begins. */
export const settingUpLine =
  "tutti init hasn't set this repository up: setting it up as init does without a terminal"

/** What it says of a setup an earlier spec run left uncommitted. */
export const leftSetupLine =
  "the setup an earlier spec run wrote is uncommitted: it is committed with the spec"

/** The files of a setup left uncommitted: untracked ones under `.tutti/`, and the runners. */
export const leftSetup = (status: ReadonlyArray<StatusEntry>): ReadonlyArray<string> =>
  status
    .filter(
      (entry) =>
        entry.code === "??" &&
        (entry.path.startsWith(".tutti/") || setupRunners.includes(entry.path)),
    )
    .map((entry) => entry.path)

/**
 * The files a spec run's setup wrote, or left uncommitted from an earlier run, for the startup
 * checks to take as no uncommitted changes and the run to commit with the spec: none where there is
 * nothing to set up, the checks saying what else is amiss; null when the setup failed, having said
 * why.
 */
export const specSetup = <R>(
  setup: SpecSetup<R>,
): Effect.Effect<ReadonlyArray<string> | null, never, FileSystem.FileSystem | Git | R> =>
  Effect.gen(function* () {
    if (setup.spec === null || setup.ownPrompt) return []
    const found = yield* findRepository(setup.cwd)
    if (Result.isFailure(found)) return []
    const { repo } = found.success
    const fs = yield* FileSystem.FileSystem
    const git = yield* Git
    const status = git.status(repo).pipe(Effect.orElseSucceed((): ReadonlyArray<StatusEntry> => []))
    const set = yield* fs.exists(join(repo, settingsFile)).pipe(Effect.orElseSucceed(() => true))
    if (set) {
      const left = (yield* status).some(
        (entry) => entry.code === "??" && entry.path === settingsFile,
      )
        ? leftSetup(yield* status)
        : []
      if (left.length > 0) yield* setup.say(leftSetupLine)
      return left
    }
    // A spec the run can't read sets nothing up: the checks say why.
    const spec = yield* readSpec(setup.spec.given, setup.spec.from, setup.cwd, repo)
    if (Result.isFailure(spec)) return []
    const already = new Set((yield* status).map((entry) => entry.path))
    yield* setup.say(settingUpLine)
    if (!(yield* setup.setUp)) return null
    return (yield* status).map((entry) => entry.path).filter((path) => !already.has(path))
  })
