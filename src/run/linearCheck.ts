// The startup check of the Linear sync (tutti-qatu): run only when the settings hold a linear
// block, and never failing the start. The sync needs Linear's credentials in tutti's environment,
// a bd that has bd linear, at 1.3.0 or later, and bd's state map, which turns each type of Linear
// state into a Beads status; each lack is a warning in the START block, and the run goes on without
// the sync.
// Otherwise the START block names the team and how often the run pulls.
import { Duration, Effect, Option, Result } from "effect"
import { linearCredentials, linearKeyVariable, linearOAuthVariables } from "../core/env.ts"
import { formatDuration } from "../project/configFile.ts"
import type { LinearSettings } from "../project/settings.ts"
import { Beads, type BeadsError } from "../services/Beads.ts"
import { sanitizeLine } from "../text/sanitize.ts"
import { compareVersions } from "../text/version.ts"

/** Linear's five types of workflow state, each of which bd's push needs a Beads status for. */
export const linearStateTypes = [
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
] as const

/**
 * The oldest bd the sync works with: the first with linear.outbound_state_map, without which a
 * team with two states of one type can't be pushed to at all (spike 09, point 6). 1.2.2 has bd
 * linear but not the map.
 */
export const minimumBd = "1.3.0"

/** The key of bd's configuration that maps Linear's state type `type` to a Beads status. */
export const stateMapKey = (type: string): string => `linear.state_map.${type}`

/** What each warning starts with: the run goes on without the sync. */
const notSyncing = "linear: not syncing"

/** Whether `env` gives bd linear credentials: the API key, or both halves of the OAuth pair. */
export const hasCredentials = (env: Readonly<Record<string, string | undefined>>): boolean => {
  const set = linearCredentials(env)
  return linearKeyVariable in set || linearOAuthVariables.every((name) => name in set)
}

/** What a failed bd call says, on one line. */
const reason = (error: BeadsError): string => {
  switch (error._tag) {
    case "BeadsFailed":
      return sanitizeLine(error.stderr.trim().split("\n")[0] ?? "") || `exit code ${error.exitCode}`
    case "BeadsTimedOut":
      return `bd took longer than ${formatDuration(error.timeLimit)}`
    case "BeadsUnreadable":
      return sanitizeLine(error.reason)
  }
}

/**
 * The warning for the installed bd's version `version`, when it is older than `minimumBd`. A
 * version that isn't one (a build of bd's main) is taken as new enough, bd linear being there.
 */
export const versionWarning = (version: string): string | undefined =>
  Option.contains(compareVersions(version, minimumBd), -1)
    ? `${notSyncing}: bd ${sanitizeLine(version)} is older than ${minimumBd}, which the sync needs; update Beads`
    : undefined

/**
 * The warnings of the sync's startup check, each a lack the run goes on without the sync for: none
 * when it can sync. bd's three reads run side by side.
 */
export const checkLinear = (env: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* () {
    const bd = yield* Beads
    const [linear, version, configuration] = yield* Effect.all(
      [
        Effect.result(bd.hasLinear()),
        Effect.result(bd.version()),
        Effect.result(bd.configuration()),
      ],
      { concurrency: "unbounded" },
    )
    const warnings: Array<string> = []
    if (!hasCredentials(env)) {
      warnings.push(
        `${notSyncing}: no ${linearKeyVariable} in the environment (nor ${linearOAuthVariables.join(" and ")}); export it in the shell that starts tutti`,
      )
    }
    if (Result.isFailure(linear)) {
      warnings.push(`${notSyncing}: could not run bd linear: ${reason(linear.failure)}`)
    } else if (!linear.success) {
      warnings.push(`${notSyncing}: the installed bd has no bd linear; update Beads`)
    } else if (Result.isFailure(version)) {
      warnings.push(`${notSyncing}: could not read bd's version: ${reason(version.failure)}`)
    } else {
      // A bd with no bd linear is older still: its warning says to update already.
      const old = versionWarning(version.success)
      if (old !== undefined) warnings.push(old)
    }
    if (Result.isFailure(configuration)) {
      warnings.push(
        `${notSyncing}: could not read bd's configuration: ${reason(configuration.failure)}`,
      )
    } else {
      const missing = linearStateTypes.filter(
        (type) => (configuration.success[stateMapKey(type)] ?? "") === "",
      )
      if (missing.length > 0) {
        warnings.push(
          `${notSyncing}: bd's configuration has no state map for ${missing.join(", ")}; set each with bd config set ${stateMapKey("<type>")} <status>`,
        )
      }
    }
    return warnings
  })

/** The START block's line for the sync a run has: `linear: NOE, pull at start and every 10m`. */
export const linearLine = (linear: LinearSettings): string =>
  `linear: ${linear.team}, pull at start${Duration.isZero(linear.pull_every) ? " only" : ` and every ${formatDuration(linear.pull_every)}`}`

/** The START block's line for a sync turned off for one run: `linear: off, --no-linear`. */
export const linearOffLine = (by: string): string => `linear: off, ${by}`
