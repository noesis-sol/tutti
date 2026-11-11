// How a bare `tutti`'s run (src/main.ts's runFrom) begins on what was chosen: the machine kept
// awake, the feature chosen named in the lock, and the start event.
import { Duration, Effect, type Scope } from "effect"
import type { GettingReady } from "../../print/gettingReady.ts"
import { EventStream } from "../../services/EventStream.ts"
import type { HeldLock } from "../../services/RunLock.ts"
import type { OutputMode } from "../../services/Tty.ts"
import type { Work } from "../../ui/questions.ts"
import { version } from "../version.ts"
import type { Choice } from "./choice.ts"
import type { Power } from "./power.ts"

/**
 * The run's beginning on the work chosen, for the run `choice` describes on `base`: `begin` keeps
 * the machine awake until `runScope` closes (its line going to the log, which plain output
 * prints), names the feature chosen in the `lock` (held all the same if its holder can't be
 * rewritten) and emits the start event; `beginUnlessSpec` leaves a spec chosen at the start
 * question to begin once its breakdown has scoped the run.
 */
export const beginningOf = (options: {
  readonly machine: Power
  readonly runScope: Scope.Scope
  readonly mode: OutputMode
  readonly ready: GettingReady
  readonly lock: HeldLock
  readonly base: string
  readonly choice: Choice
}) => {
  const { machine, runScope, mode, ready, lock, base, choice } = options
  const begin = (work: Work) =>
    Effect.gen(function* () {
      const events = yield* EventStream
      yield* machine.hold(runScope, mode._tag === "Plain" ? ready.end : Effect.void)
      const { config, started, scope, spec } = choice
      const feature = work._tag === "Feature" ? work.description : config.feature
      if (work._tag === "Feature") {
        yield* Effect.ignore(lock.rewrite({ ...choice.holder, feature: work.description }))
      }
      yield* events.emit({
        kind: "start",
        version,
        repo: config.repo,
        branch: base,
        ...(scope === null ? {} : { scope }),
        ...(feature === null ? {} : { feature }),
        ...(spec === null ? {} : { spec: spec.path }),
        ...(spec?.url === undefined ? {} : { spec_source: spec.url }),
        concurrency: config.settings.concurrent,
        billing: config.billing,
        permission_mode: started.account.permissionMode.inEffect,
        ...(config.autoAnswer === null
          ? {}
          : { auto_answer: Duration.toMillis(config.autoAnswer) }),
        ...(config.overnight ? { overnight: true as const } : {}),
      })
    })
  const beginUnlessSpec = (work: Work) => (work._tag === "Spec" ? Effect.void : begin(work))
  return { begin, beginUnlessSpec }
}

/** The run's beginning as `beginningOf` made it. */
export type Beginning = ReturnType<typeof beginningOf>
