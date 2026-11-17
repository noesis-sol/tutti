// `tutti linear setup` (§ 8.1): turns the Linear sync on for the project, with the setup's steps
// (src/init/linear.ts). Without LINEAR_API_KEY in the environment it says where to create one and
// how to export it, and writes nothing. With one, it asks which team where the key reaches more than
// one (--team answers it), and which state a Beads status is pushed as where the team has more than
// one of its type; it shows the mapping, writes what differs, and says what it changed. Without a
// terminal it asks nothing: the team is --team's, or the one the key reaches, and each state the
// first of its type by position.
import { Effect, type Layer, Result } from "effect"
import { linearKeyVariable } from "../core/env.ts"
import {
  applyLinear,
  type LinearQuestions,
  LinearSetupFailed,
  mappingLines,
  noKeyLines,
  outbound,
  planLinear,
  storedKeyLine,
} from "../init/linear.ts"
import { exitCodes } from "../run/holds.ts"
import type { LinearApi } from "../services/LinearApi.ts"
import type { LineIO } from "../ui/plain/forms.ts"
import { select } from "../ui/plain/forms.ts"
import { FormCancelled } from "../ui/questions.ts"

/** Where `tutti linear setup` says what it did: stdout's lines, and stderr's. */
export interface Say {
  readonly out: (line: string) => void
  readonly error: (line: string) => void
}

/** The exit codes, as the command's help gives them. */
export const linearSetupExits =
  "Exit codes: 0 set up, or nothing to change; 2 no key, or the setup failed, the settings' block not written, so the sync stays off; 130 cancelled, nothing written."

/** How a Beads status is said in the question of the Linear state it is pushed as. */
const statusWords: Record<(typeof outbound)[number][0], string> = {
  open: "a ticket open and ready to work",
  in_progress: "a ticket in progress",
  deferred: "a ticket deferred",
  closed: "a ticket closed",
}

/** The setup's questions asked as lines, on `io`. */
export const lineQuestions = (io: LineIO): LinearQuestions => ({
  team: (teams, initial) =>
    select(io, {
      title: "Which Linear team should tutti sync with?",
      description: "Its issues become tickets, and the tickets a run files are created in it.",
      options: teams.map((team) => `${team.key}: ${team.name}`),
      initial,
    }),
  state: (status, states, initial) => {
    const type = outbound.find(([each]) => each === status)?.[1] ?? status
    return select(io, {
      title: `Which Linear state is ${statusWords[status]}?`,
      description: `The team has ${states.length} states of type ${type}; tutti moves the Linear issue of ${statusWords[status]} to the one chosen.`,
      options: states.map((state) => state.name),
      initial,
    })
  },
})

/** The setup's questions with no terminal to ask them: the team must be given, each state the first. */
export const unaskedQuestions: LinearQuestions = {
  team: (teams) =>
    Effect.fail(
      new LinearSetupFailed({
        why: `the key reaches ${teams.length} teams (${teams.map((team) => team.key).join(", ")}) and there is no terminal to ask which: name one with --team`,
      }),
    ),
  state: (_status, _states, initial) => Effect.succeed(initial),
}

/**
 * `tutti linear setup` in the project at `repo`, `key` the environment's LINEAR_API_KEY (unset or
 * empty: none), `ask` its questions and `team` --team's answer: its exit code, having said what it
 * did through `say`. `api` gives Linear's API with the key; nothing else sees it.
 */
export const linearSetup = (
  repo: string,
  key: string | undefined,
  ask: LinearQuestions,
  team: string | undefined,
  say: Say,
  api: (key: string) => Layer.Layer<LinearApi>,
) =>
  Effect.gen(function* () {
    if (key === undefined || key.trim() === "") {
      const [first, ...rest] = noKeyLines
      say.error(`tutti linear setup: ${first}`)
      for (const line of rest) say.error(line)
      return exitCodes.setup as number
    }
    const done = yield* Effect.result(
      Effect.gen(function* () {
        const plan = yield* planLinear(repo, ask, team)
        for (const line of mappingLines(plan)) say.out(line)
        if (plan.storedKey) say.error(`tutti linear setup: warning: ${storedKeyLine}`)
        return { plan, changed: yield* applyLinear(repo, plan) }
      }).pipe(Effect.provide(api(key))),
    )
    if (Result.isFailure(done)) {
      const error = done.failure
      if (error instanceof FormCancelled) {
        say.error("tutti linear setup: cancelled; nothing written")
        return exitCodes.interrupted as number
      }
      say.error(`tutti linear setup: ${error.why}`)
      return exitCodes.setup as number
    }
    const { plan, changed } = done.success
    if (changed.length === 0) {
      say.out(`Nothing changed: bd and the settings already sync with team ${plan.team.key}.`)
      return exitCodes.ok as number
    }
    for (const line of changed) say.out(`- ${line}`)
    say.out(
      `The sync is on: a run pulls from team ${plan.team.key} as it starts, with ${linearKeyVariable} in its environment.`,
    )
    return exitCodes.ok as number
  })
