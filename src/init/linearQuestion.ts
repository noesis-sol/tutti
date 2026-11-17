// init's question Sync tickets with Linear? (tutti-qatu, § 8.3), asked with No selected, and the
// step that sets the sync up on a Yes, with the setup's steps of ./linear.ts. The form asks the team
// and the states (chooseLinear) before the project is set up; the step writes bd's keys and the
// settings' block once Beads and the settings are there. No writes nothing; so does a Yes without
// LINEAR_API_KEY, which says how to get one, and a setup that failed, which says why: init goes on
// either way, the sync off, for tutti linear setup to turn on later.
import { Effect, type FileSystem, type Layer, Result } from "effect"
import { linearKeyVariable } from "../core/env.ts"
import { settingsFile } from "../project/settings.ts"
import type { Beads } from "../services/Beads.ts"
import { type LinearApi, linearKeysPage } from "../services/LinearApi.ts"
import { sanitizeLine } from "../text/sanitize.ts"
import type { FormCancelled } from "../ui/questions.ts"
import {
  applyLinear,
  type LinearChoice,
  type LinearPlan,
  type LinearSetupFailed,
  planChosen,
  planLinear,
  storedKeyLine,
  unasked,
} from "./linear.ts"
import { step } from "./steps.ts"

/** The question as init's form asks it: Linear's API with the key, null without one. */
export interface LinearAsk {
  readonly api: Layer.Layer<LinearApi> | null
}

/**
 * The question's answer: No; Yes without a key; Yes and the setup's questions failed, why; or Yes
 * and the team and states chosen.
 */
export type LinearAnswer =
  | { readonly kind: "no" }
  | { readonly kind: "noKey" }
  | { readonly kind: "failed"; readonly why: string }
  | { readonly kind: "chosen"; readonly choice: LinearChoice }

/**
 * What init does of the sync: keep the settings' block; leave it off (No, --linear=false, or not
 * asked without a terminal); say there is no key; say why the setup failed; write the form's choice;
 * or set it up with --linear's team.
 */
export type LinearDecision =
  | { readonly kind: "kept"; readonly team: string; readonly declined: boolean }
  | { readonly kind: "off"; readonly unasked: boolean }
  | { readonly kind: "noKey" }
  | { readonly kind: "failed"; readonly why: string }
  | { readonly kind: "chosen"; readonly choice: LinearChoice }
  | { readonly kind: "team"; readonly team: string }

/** What the question says under it. */
export const linearDescription =
  "Issues filed in a Linear team become tickets, and tutti writes their status back as it works them. Needs LINEAR_API_KEY in the environment; tutti linear setup turns it on later."

/** What a Yes without a key says in the form: where to create one and how to export it. */
export const noKeyNotes: ReadonlyArray<string> = [
  `No ${linearKeyVariable} in the environment, so init goes on without the sync and writes nothing of it.`,
  `Create a personal API key in Linear, under Settings, Account, Security & access (${linearKeysPage}), export it in your shell's profile (export ${linearKeyVariable}=lin_api_...), and run tutti linear setup in a new shell.`,
]

/**
 * The decision, from --linear (`flag`: a team's key, or false), the settings' block's team, whether
 * the form could ask, and its answer.
 */
export const linearDecision = (
  flag: string | false | undefined,
  blockTeam: string | null,
  asking: boolean,
  answer: LinearAnswer | undefined,
): LinearDecision => {
  if (typeof flag === "string") return { kind: "team", team: flag }
  if (blockTeam !== null) return { kind: "kept", team: blockTeam, declined: flag === false }
  if (flag === false) return { kind: "off", unasked: false }
  if (!asking || answer === undefined) return { kind: "off", unasked: !asking }
  return answer.kind === "no" ? { kind: "off", unasked: false } : answer
}

const label = "linear"

/** Turned on later by tutti linear setup. */
const later = "tutti linear setup turns it on"

/** The step that says there is no key: where to create one, how to export it, and what then. */
const noKeyStep = step(
  "caution",
  label,
  `no ${linearKeyVariable} in the environment, so the sync is off and nothing of it was written: create a personal API key at ${linearKeysPage}, export ${linearKeyVariable} in your shell's profile, then run tutti linear setup`,
)

/** The step that says the setup failed, why, and that the sync is off. */
const failedStep = (why: string) =>
  step(
    "caution",
    label,
    `${sanitizeLine(why)}; the sync is off and its block not written: ${later}`,
  )

/**
 * The step for `decision` in the project at `repo`, which Beads and the setup are written into: what
 * init did of the sync. `api` gives Linear's API with the environment's key, null without one.
 */
export const linearSteps = (
  repo: string,
  decision: LinearDecision,
  api: Layer.Layer<LinearApi> | null,
) =>
  Effect.gen(function* () {
    switch (decision.kind) {
      case "kept":
        return [
          step(
            "kept",
            label,
            `syncs with team ${decision.team}: the settings' linear block is kept${decision.declined ? "; remove it to turn the sync off" : ""}`,
          ),
        ]
      case "off":
        return [
          step(
            "kept",
            label,
            decision.unasked
              ? `the sync is off; not asked (no terminal): --linear <team> sets it up, or ${later}`
              : `the sync is off: ${later}`,
          ),
        ]
      case "noKey":
        return [noKeyStep]
      case "failed":
        return [failedStep(decision.why)]
    }
    let planned: Effect.Effect<
      LinearPlan,
      LinearSetupFailed | FormCancelled,
      Beads | FileSystem.FileSystem
    >
    if (decision.kind === "chosen") {
      planned = planChosen(repo, decision.choice)
    } else if (api === null) {
      return [noKeyStep]
    } else {
      planned = planLinear(repo, unasked("--linear"), decision.team).pipe(Effect.provide(api))
    }
    const done = yield* Effect.result(
      Effect.gen(function* () {
        const plan = yield* planned
        return { plan, changed: yield* applyLinear(repo, plan) }
      }),
    )
    if (Result.isFailure(done)) {
      const error = done.failure
      return [failedStep(error._tag === "LinearSetupFailed" ? error.why : "cancelled")]
    }
    const { plan, changed } = done.success
    const pushed = plan.pushed.map(([status, state]) => `${status} ${sanitizeLine(state.name)}`)
    return [
      step(
        changed.length === 0 ? "kept" : "done",
        label,
        `syncs with team ${plan.team.key} as a run starts, with ${linearKeyVariable} in its environment; Beads to Linear: ${pushed.join(", ")}`,
        plan.settings === null ? undefined : [settingsFile],
      ),
      ...(plan.storedKey ? [step("caution", label, storedKeyLine)] : []),
    ]
  })
