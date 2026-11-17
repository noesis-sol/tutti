// The Linear sync's setup (tutti-qatu), which tutti linear setup runs and tutti init's form can run
// too: it reads the teams the key reaches and the chosen team's workflow states from Linear's API
// (LinearApi, the one place tutti calls Linear itself), and writes bd's configuration through bd
// config set (the team, the state map, the outbound map) and the linear block of
// .tutti/settings.json, whose presence turns the sync on. It runs in two steps, so that what it
// would write is shown before it writes it: planLinear asks its questions and says what is to
// change, and applyLinear writes that. It changes only what differs, so it runs again safely and
// says what it changed, or that nothing did. The key is never given to bd config, written or
// printed: these steps don't see it, but through the LinearApi their caller gives them.
import { join } from "node:path"
import { Effect, Exit, FileSystem, Predicate, Result, Schema } from "effect"
import { writeFileAtomic } from "../core/atomicFile.ts"
import { linearKeyVariable } from "../core/env.ts"
import { decodeConfig, parseConfigJson } from "../project/configFile.ts"
import { setIn } from "../project/jsonText.ts"
import { Settings, settingsFile } from "../project/settings.ts"
import { stateMapKey } from "../run/linearCheck.ts"
import { Beads, type BeadsError } from "../services/Beads.ts"
import {
  LinearApi,
  type LinearApiFailed,
  type LinearState,
  type LinearTeam,
  linearKeysPage,
} from "../services/LinearApi.ts"
import { sanitizeLine } from "../text/sanitize.ts"
import type { FormCancelled } from "../ui/questions.ts"

/** The setup couldn't be done: why, on one line. Nothing was written. */
export class LinearSetupFailed extends Schema.TaggedError<LinearSetupFailed>()(
  "LinearSetupFailed",
  { why: Schema.String },
) {}

/**
 * The Beads status each type of Linear state is pulled as. Backlog's is deferred, which holds an
 * issue until the maintainer moves it to Todo: the gate (spike 09, point 1).
 */
export const inbound = [
  ["backlog", "deferred"],
  ["unstarted", "open"],
  ["started", "in_progress"],
  ["completed", "closed"],
  ["canceled", "closed"],
] as const

/** The Linear state type each Beads status a push writes goes to: one state of it, chosen. */
export const outbound = [
  ["open", "unstarted"],
  ["in_progress", "started"],
  ["deferred", "backlog"],
  ["closed", "completed"],
] as const

/** A Beads status the setup chooses a Linear state for. */
export type OutboundStatus = (typeof outbound)[number][0]

/** The key of bd's configuration that names the Linear state Beads' `status` is pushed as. */
export const outboundKey = (status: string): string => `linear.outbound_state_map.${status}`

/** The key of bd's configuration that names the team bd linear syncs with, by its ID. */
export const teamIdKey = "linear.team_id"

/** The key of bd's configuration bd linear reads a key from, which the setup never writes. */
export const apiKeyKey = "linear.api_key"

/**
 * The questions the setup asks, each a choice's index; cancelled, or failed where it can't be
 * asked, nothing is written.
 */
export interface LinearQuestions {
  /** The team to sync with, of `teams` (more than one), `initial`'s offered first. */
  team(
    teams: ReadonlyArray<LinearTeam>,
    initial: number,
  ): Effect.Effect<number, FormCancelled | LinearSetupFailed>
  /**
   * The Linear state Beads' `status` is pushed as, of `states` (more than one, of one type, by
   * position), `initial`'s offered first.
   */
  state(
    status: OutboundStatus,
    states: ReadonlyArray<LinearState>,
    initial: number,
  ): Effect.Effect<number, FormCancelled | LinearSetupFailed>
}

/** What the setup is to write: bd's keys and the settings' block, each where it differs. */
export interface LinearPlan {
  readonly team: LinearTeam
  /** Each Beads status's Linear state, in `outbound`'s order. */
  readonly pushed: ReadonlyArray<readonly [OutboundStatus, LinearState]>
  /** bd's keys to set, each to its value, where bd's configuration differs. */
  readonly configuration: ReadonlyArray<readonly [string, string]>
  /** The settings' text with the block written, where it differs; null where it is there. */
  readonly settings: string | null
  /** bd's configuration holds a key under linear.api_key, which the Beads database syncs. */
  readonly storedKey: boolean
}

/** What the setup says without a key: where to create one and how to export it. Nothing is written. */
export const noKeyLines: ReadonlyArray<string> = [
  `no ${linearKeyVariable} in the environment; nothing written.`,
  `Create a personal API key in Linear, under Settings, Account, Security & access: ${linearKeysPage}`,
  "Then export it in your shell's profile (~/.zshrc, ~/.bashrc), so that every shell that starts tutti has it:",
  `  export ${linearKeyVariable}=lin_api_...`,
  "and run tutti linear setup again in a new shell. tutti never stores the key: it reads it from the environment, and gives it only to the bd linear processes it starts.",
]

/** What a failed bd call says, on one line. */
const bdWhy = (error: BeadsError): string => {
  switch (error._tag) {
    case "BeadsFailed":
      return sanitizeLine(error.stderr.trim().split("\n")[0] ?? "") || `exit code ${error.exitCode}`
    case "BeadsTimedOut":
      return "bd didn't answer in time"
    case "BeadsUnreadable":
      return sanitizeLine(error.reason)
  }
}

const failed = (why: string) => new LinearSetupFailed({ why })

/** `states` of `type`, by their position in Linear's workflow, Linear's order kept between equals. */
export const statesOfType = (
  states: ReadonlyArray<LinearState>,
  type: string,
): ReadonlyArray<LinearState> =>
  states
    .map((state, at) => ({ state, at }))
    .filter(({ state }) => state.type === type)
    .sort((a, b) => a.state.position - b.state.position || a.at - b.at)
    .map(({ state }) => state)

/** The index in `list` of the first that `is`, or 0. */
const indexOr0 = <A>(list: ReadonlyArray<A>, is: (a: A) => boolean) =>
  Math.max(0, list.findIndex(is))

/** The settings file's text and JSON, or why the setup can't write its block into it. */
const readSettingsText = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = join(repo, settingsFile)
    const text = yield* fs
      .readFileString(file)
      .pipe(
        Effect.mapError((error) =>
          failed(
            error.reason._tag === "NotFound"
              ? `${settingsFile} isn't there: set the project up with tutti init first`
              : `${settingsFile} can't be read: ${sanitizeLine(error.message)}`,
          ),
        ),
      )
    const json = parseConfigJson(text)
    if (
      Result.isFailure(json) ||
      !Predicate.isObject(json.success) ||
      Array.isArray(json.success)
    ) {
      return yield* failed(`${settingsFile} isn't a JSON object; fix it, then run setup again`)
    }
    return { file, text, json: json.success as Readonly<Record<string, unknown>> }
  })

/** The team key of the settings' linear block, if it has one. */
const blockTeam = (json: Readonly<Record<string, unknown>>): string | null => {
  const block = json.linear
  return Predicate.isObject(block) && typeof block.team === "string" ? block.team : null
}

/**
 * Asks the setup's questions in the project at `repo`, and says what it would write: bd's keys and
 * the settings' linear block, each where it differs from what is there. `team`, a team's key, answers
 * the team's question. Nothing is written.
 */
export const planLinear = (repo: string, questions: LinearQuestions, team?: string) =>
  Effect.gen(function* () {
    const settings = yield* readSettingsText(repo)
    const bd = yield* Beads
    const hasLinear = yield* Effect.mapError(bd.hasLinear(), (error) =>
      failed(`could not run bd linear: ${bdWhy(error)}`),
    )
    if (!hasLinear) return yield* failed("the installed bd has no bd linear; update Beads")
    const configuration = yield* Effect.mapError(bd.configuration(), (error) =>
      failed(`could not read bd's configuration: ${bdWhy(error)}`),
    )
    const api = yield* LinearApi
    const linearWhy = (error: LinearApiFailed) => failed(error.why)
    const teams = yield* Effect.mapError(api.teams(), linearWhy)
    if (teams.length === 0) return yield* failed("the key reaches no Linear team")
    let chosen: LinearTeam
    if (team !== undefined) {
      const named = teams.find((each) => each.key.toLowerCase() === team.toLowerCase())
      if (named === undefined) {
        return yield* failed(
          `the key reaches no team ${sanitizeLine(team)}; it reaches ${teams.map((each) => each.key).join(", ")}`,
        )
      }
      chosen = named
    } else if (teams.length === 1) {
      chosen = teams[0] as LinearTeam
    } else {
      const current = blockTeam(settings.json)
      const initial = indexOr0(teams, (each) =>
        current === null ? each.id === configuration[teamIdKey] : each.key === current,
      )
      chosen = teams[yield* questions.team(teams, initial)] as LinearTeam
    }
    const states = yield* Effect.mapError(api.states(chosen.id), linearWhy)
    const pushed: Array<readonly [OutboundStatus, LinearState]> = []
    for (const [status, type] of outbound) {
      const candidates = statesOfType(states, type)
      if (candidates.length === 0) {
        return yield* failed(
          `team ${chosen.key} has no workflow state of type ${type}, which ${status} tickets are pushed as; add one in Linear's team settings`,
        )
      }
      const initial = indexOr0(
        candidates,
        (state) => state.name === configuration[outboundKey(status)],
      )
      const at = candidates.length === 1 ? 0 : yield* questions.state(status, candidates, initial)
      pushed.push([status, candidates[at] as LinearState])
    }
    const wanted: ReadonlyArray<readonly [string, string]> = [
      [teamIdKey, chosen.id],
      ...inbound.map(([type, status]) => [stateMapKey(type), status] as const),
      ...pushed.map(([status, state]) => [outboundKey(status), state.name] as const),
    ]
    const block = settings.json.linear
    const text =
      blockTeam(settings.json) === chosen.key
        ? null
        : Predicate.isObject(block)
          ? setIn(settings.text, ["linear", "team"], chosen.key)
          : setIn(settings.text, ["linear"], { team: chosen.key })
    if (text !== null) {
      const json = parseConfigJson(text)
      const decoded = Result.isSuccess(json)
        ? decodeConfig(Settings, settings.file, json.success)
        : null
      if (decoded === null || Exit.isFailure(decoded)) {
        return yield* failed(
          `${settingsFile} has problems the linear block can't be written beside; tutti says which as a run starts`,
        )
      }
    }
    return {
      team: chosen,
      pushed,
      configuration: wanted.filter(([key, value]) => configuration[key] !== value),
      settings: text,
      storedKey: (configuration[apiKeyKey] ?? "") !== "",
    } satisfies LinearPlan
  })

/** The mapping the plan sets, as the setup shows it before writing it. */
export const mappingLines = (plan: LinearPlan): ReadonlyArray<string> => [
  `Linear team ${plan.team.key} (${sanitizeLine(plan.team.name)})`,
  `Linear to Beads: ${inbound.map(([type, status]) => `${type} ${status}`).join(", ")}; an issue in Backlog waits, deferred, until it is moved to Todo`,
  `Beads to Linear: ${plan.pushed.map(([status, state]) => `${status} ${sanitizeLine(state.name)}`).join(", ")}`,
]

/**
 * Writes what `plan` says in the project at `repo`: bd's keys first, then the settings' linear
 * block, which turns the sync on once bd is configured for it. What it changed, a line each.
 */
export const applyLinear = (repo: string, plan: LinearPlan) =>
  Effect.gen(function* () {
    const bd = yield* Beads
    const changed: Array<string> = []
    for (const [key, value] of plan.configuration) {
      yield* Effect.mapError(bd.setConfiguration(key, value), (error) =>
        failed(`bd config set ${key} failed: ${bdWhy(error)}`),
      )
      changed.push(`set ${key} to ${sanitizeLine(value)}`)
    }
    if (plan.settings !== null) {
      yield* writeFileAtomic(join(repo, settingsFile), plan.settings).pipe(
        Effect.mapError((error) =>
          failed(`${settingsFile} can't be written: ${sanitizeLine(error.message)}`),
        ),
      )
      changed.push(`wrote the linear block to ${settingsFile}: team ${plan.team.key}`)
    }
    return changed
  })

/** What the setup says of a key it found stored in bd's configuration, which it leaves. */
export const storedKeyLine = `bd's configuration holds ${apiKeyKey}, which the Beads database syncs to its git remote: remove it with bd config unset ${apiKeyKey}, and keep the key in ${linearKeyVariable} instead`
