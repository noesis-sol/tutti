// tutti init's steps for the project's requires list (§ 8.4's `requires`, src/project/requires.ts),
// as orchestra 0.9.1's init takes them: it writes the README's section on what to install from the
// list where the README has none, or keeps it in step, and, once the login probe has run, checks
// the list as a run's start does, installing what it can, a line of the summary for each
// requirement among what the machine needs.
import { Effect } from "effect"
import {
  readmeName,
  readmeState,
  requiresEnd,
  requiresStart,
  writeReadmeRequires,
} from "../project/requires.ts"
import { type Requirement, readSettings } from "../project/settings.ts"
import { checkRequires, says, whyMissing } from "../run/requires.ts"
import { type Step, step } from "./steps.ts"

/** The README step's label. */
const readmeLabel = "README"

/**
 * The README's step, `list` the requires list as init wrote the settings: its section written or
 * updated from the list; none where there is no README.md (init writes none), or where the list is
 * empty and the README has no section.
 */
export const readmeSteps = (repo: string, list: ReadonlyArray<Requirement>) =>
  Effect.gen(function* () {
    const state = yield* Effect.result(readmeState(repo, list))
    if (state._tag === "Failure") {
      return [step("caution", readmeLabel, `cannot read ${readmeName}: ${state.failure}`)]
    }
    switch (state.success) {
      case "none":
        return []
      case "noSection":
        if (list.length === 0) return []
        break
      case "unpaired":
        return [
          step(
            "caution",
            readmeLabel,
            `${readmeName} has ${requiresStart} and ${requiresEnd} out of pair; its section on what to install is left as it is`,
          ),
        ]
      case "inStep":
        return [
          step(
            "kept",
            readmeLabel,
            `${readmeName}'s section on what to install is the requires list's`,
          ),
        ]
    }
    const written = yield* Effect.result(writeReadmeRequires(repo, list))
    if (written._tag === "Failure") {
      return [step("caution", readmeLabel, `cannot write ${readmeName}: ${written.failure}`)]
    }
    return [
      step(
        "done",
        readmeLabel,
        `${state.success === "stale" ? "updated" : "wrote"} ${readmeName}'s section on what to install from the requires list, between ${requiresStart} and ${requiresEnd}`,
        [readmeName],
      ),
    ]
  })

/**
 * The requirements of the project at `repo`, as its settings have them once init has written them,
 * checked as a run's start checks them, installing what it can: a step for each, one missing saying
 * its manual step, or why its install failed and where its output is.
 */
export const requiresSteps = (repo: string) =>
  Effect.gen(function* () {
    const settings = yield* Effect.result(readSettings(repo))
    if (settings._tag === "Failure") {
      return settings.failure.problems.map((problem) =>
        step(
          "missing",
          "requires",
          `${problem.path === "" ? "" : `${problem.path}: `}${problem.message}`,
        ),
      )
    }
    const { requires, checks } = settings.success
    const report = yield* checkRequires(requires, { repo, installLimit: checks.fast.timeout })
    return report.map((res): Step => {
      const name = res.requirement.name
      if (res.state === "missing") return step("missing", name, whyMissing(res))
      if (res.state === "otherOS") return step("kept", name, says(res))
      return step("done", name, res.state === "met" ? "" : says(res))
    })
  })
