// What src/main.ts does with a spec run (§ 4.14) between the pieces it calls: the setup read from
// the flags and their variables (specSetup), its files handed to specRun to commit with the spec,
// the outcome taken (the run scoped to the root epic, which the lock then names), and an early
// start's breakdown followed as the run goes: one that fails stops the run, whose exit code is then
// the breakdown's, and one the run's end cut short is stopped with it.
import { Effect, Option, Result, type Scope, type SubscriptionRef } from "effect"
import type { AppConfigValue } from "../cli/AppConfig.ts"
import { type RunFlags, runFlags } from "../cli/flags.ts"
import type { TicketId } from "../services/Beads.ts"
import type { Holder, LockFailed } from "../services/RunLock.ts"
import type { Spec } from "./spec.ts"
import { followRest, type SpecIO, type SpecOutcome, specRun } from "./specRun.ts"
import { specSetup } from "./specSetup.ts"
import type { LiveFetch, SpecFetch } from "./specSource.ts"

/** What a spec run's setup reads of the flags, each else its variable (`env`). */
export const setupFlags = (
  flags: Pick<RunFlags, "spec" | "prompt" | "concurrent">,
  env: (name: string) => string | undefined,
) => {
  const variable = (name: string) => {
    const value = env(name)
    return value === undefined || value === "" ? Option.none<string>() : Option.some(value)
  }
  const given = (key: "spec" | "prompt" | "concurrent") =>
    Option.orElse(flags[key], () => variable(runFlags[key].variable))
  return {
    /** The spec as given, and what gave it; null for no spec run. */
    spec: Option.match(given("spec"), {
      onNone: () => null,
      onSome: (text) => ({
        given: text.trim(),
        from: Option.isSome(flags.spec) ? "--spec" : runFlags.spec.variable,
      }),
    }),
    /** A worker prompt of its own was given. */
    ownPrompt: Option.isSome(given("prompt")),
    /** The concurrency the setup writes; null where none is given, or it can't be read. */
    concurrent: Option.getOrNull(
      Option.flatMap(given("concurrent"), (text) =>
        Result.getSuccess(runFlags.concurrent.read(text)),
      ),
    ),
  }
}

/**
 * A spec run's setup (src/run/specSetup.ts), from the flags and their variables: the files it wrote,
 * or an earlier one left, for the startup checks and the run to commit with the spec; the exit code
 * the run ends with when it failed, having said why, or was cancelled. `setUp` sets the repository
 * up with the concurrency given.
 */
export const setUpFromFlags = <R>(options: {
  readonly cwd: string
  readonly flags: Pick<RunFlags, "spec" | "prompt" | "concurrent">
  readonly env: (name: string) => string | undefined
  readonly setUp: (concurrent: number | null) => Effect.Effect<number, never, R>
  readonly say: (text: string) => Effect.Effect<void>
  /** Fetches a spec at a URL: the run's one fetch, which the startup checks share (fetchOnce). */
  readonly fetch?: SpecFetch<LiveFetch>
}) => {
  const read = setupFlags(options.flags, options.env)
  return specSetup({
    cwd: options.cwd,
    spec: read.spec,
    ownPrompt: read.ownPrompt,
    setUp: options.setUp(read.concurrent),
    say: options.say,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })
}

/** Where a spec run's start is wired into the run. */
export interface SpecWiring {
  /** The files the setup wrote, committed with the spec. */
  readonly setup: ReadonlyArray<string>
  /** The run lock's holder, and how its file is rewritten: with the root epic as its scope. */
  readonly holder: Holder
  readonly rewrite: (holder: Holder) => Effect.Effect<void, LockFailed>
  /** The run's scope, which an early start's breakdown goes on in. */
  readonly runScope: Scope.Scope
  /** Stops the run, for an early start's breakdown that fails or is stopped. */
  readonly quit: Effect.Effect<unknown>
}

/** How a spec run's start ended: the root epic the run is scoped to, or the exit code it stopped with. */
export type SpecStarted =
  | { readonly _tag: "Scoped"; readonly root: TicketId }
  | { readonly _tag: "Stopped"; readonly exitCode: number }

/** A spec run's start, and what the run does with an early start's breakdown around it. */
export interface SpecStart<R> {
  /** specRun on `spec` with the setup's files, the lock rewritten once it gives the root epic. */
  readonly start: (
    spec: Spec,
    config: Pick<AppConfigValue, "repo" | "refine" | "settings">,
    io: SpecIO,
  ) => Effect.Effect<SpecStarted, never, R>
  /** The run's options for an early start: what the breakdown has filed meanwhile. */
  readonly runOptions: () => {
    readonly filing?: SubscriptionRef.SubscriptionRef<string | null>
  }
  /** Once the run has ended: an early start's breakdown that hasn't finished is stopped. */
  readonly stop: Effect.Effect<void>
  /** The run's exit code: the breakdown's where it stopped the run, else the run's own `code`. */
  readonly exitCode: (code: number) => number
}

/** A spec run's start wired into the run by `wiring`. */
export const specStart = (
  wiring: SpecWiring,
): SpecStart<Effect.Services<ReturnType<typeof specRun>>> => {
  // A breakdown going on as the run starts on its environment ticket, and its exit code where it
  // stopped the run.
  let early: Extract<SpecOutcome, { readonly _tag: "Early" }> | null = null
  let stoppedWith: number | null = null
  return {
    start: (spec, config, io) =>
      Effect.gen(function* () {
        const outcome = yield* specRun(
          {
            spec,
            repo: config.repo,
            setup: wiring.setup,
            refine: config.refine,
            timeLimit: config.settings.spec.timeout,
            effort: config.settings.spec.effort,
            earlyIn: wiring.runScope,
          },
          io,
        )
        if (outcome._tag === "Stopped") {
          return { _tag: "Stopped", exitCode: outcome.exitCode } as const
        }
        if (outcome._tag === "Early") {
          early = outcome
          // The rest of the breakdown, as the run goes on its environment ticket: one that fails,
          // or is stopped, stops the run, whose exit code is then the breakdown's.
          yield* followRest(outcome.rest, (code) =>
            Effect.andThen(
              Effect.sync(() => {
                stoppedWith = code
              }),
              wiring.quit,
            ),
          ).pipe(Effect.forkIn(wiring.runScope))
        }
        // The lock is held all the same if its holder can't be rewritten.
        yield* Effect.ignore(wiring.rewrite({ ...wiring.holder, scope: outcome.root }))
        return { _tag: "Scoped", root: outcome.root } as const
      }),
    runOptions: () => (early === null ? {} : { filing: early.filing }),
    stop: Effect.suspend(() => (early === null ? Effect.void : early.stop)),
    exitCode: (code) => stoppedWith ?? code,
  }
}
