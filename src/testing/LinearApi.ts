// The LinearApi test layer: the teams a key reaches and each team's workflow states, as scripted,
// and the calls it was asked, so that a test reads what was read from Linear. No test reaches it.
import { Effect, Layer } from "effect"
import {
  LinearApi,
  LinearApiFailed,
  type LinearState,
  type LinearTeam,
} from "../services/LinearApi.ts"

/** A scripted Linear: its teams, each with its states by its ID, and a failure for every call. */
export interface TestLinear {
  readonly teams: ReadonlyArray<LinearTeam & { readonly states: ReadonlyArray<LinearState> }>
  /** Why every call fails, as Linear refusing a key would. */
  readonly fails?: string
}

/** A call the layer was asked: `teams`, or `states` of a team's ID. */
export type Asked = { readonly call: "teams" } | { readonly call: "states"; readonly team: string }

/** A Linear workflow state with this name, type and position; its ID made from its name. */
export const state = (name: string, type: string, position: number): LinearState => ({
  id: `state-${name.toLowerCase().replaceAll(" ", "-")}`,
  name,
  type,
  position,
})

/** The workflow states of a new Linear team: one of each type. */
export const defaultStates: ReadonlyArray<LinearState> = [
  state("Backlog", "backlog", 0),
  state("Todo", "unstarted", 0),
  state("In Progress", "started", 0),
  state("Done", "completed", 0),
  state("Canceled", "canceled", 0),
]

/** LinearApi answering as `linear` scripts it, keeping each call in `asked`. */
export const layer = (linear: TestLinear, asked: Array<Asked> = []): Layer.Layer<LinearApi> =>
  Layer.succeed(
    LinearApi,
    LinearApi.of({
      teams: () =>
        Effect.suspend(() => {
          asked.push({ call: "teams" })
          if (linear.fails !== undefined) {
            return Effect.fail(new LinearApiFailed({ why: linear.fails }))
          }
          return Effect.succeed(linear.teams.map(({ id, key, name }) => ({ id, key, name })))
        }),
      states: (teamId) =>
        Effect.suspend(() => {
          asked.push({ call: "states", team: teamId })
          if (linear.fails !== undefined) {
            return Effect.fail(new LinearApiFailed({ why: linear.fails }))
          }
          const team = linear.teams.find((each) => each.id === teamId)
          return team === undefined
            ? Effect.fail(new LinearApiFailed({ why: `Entity not found: Team` }))
            : Effect.succeed(team.states)
        }),
    }),
  )
