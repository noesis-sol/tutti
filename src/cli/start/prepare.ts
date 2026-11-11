// What a bare `tutti`'s run (src/main.ts's runFrom) runs: a spec run's setup, the startup checks
// (exit 2), and the feature a --feature run talks through, which needs the renderer.
import { Console, type Context, Effect, Result } from "effect"
import type { GettingReady } from "../../print/gettingReady.ts"
import { readySteps } from "../../print/gettingReady.ts"
import type { RunFlags } from "../../project/flags.ts"
import { fetchOnce, fetchSpecLive, type LiveFetch, type SpecFetch } from "../../run/specSource.ts"
import { setUpFromFlags } from "../../run/specStart.ts"
import { check, live, type Started, StartupFailed } from "../../run/startup.ts"
import { outputMode, type TtyValue } from "../../services/Tty.ts"
import { featureUnavailable } from "../choose.ts"
import { setUpForSpec } from "../commands.ts"
import { gitLayer } from "./layers.ts"
import { cannotStart } from "./preflight.ts"

/** What the run runs, as `prepareWork` found it. */
export interface Prepared {
  /** The files a spec run's setup wrote, committed with the spec. */
  readonly setup: ReadonlyArray<string>
  /** The run as the startup checks describe it. */
  readonly started: Started
  /**
   * A spec at a URL chosen at the start question: fetched again after a failure, for the URL to
   * be fixed or tried again, and what was fetched read once chosen.
   */
  readonly fieldFetch: SpecFetch<LiveFetch>
  /** What the start question's fetches run on. */
  readonly fetchContext: Context.Context<LiveFetch>
}

/**
 * What the run started in `cwd` with `flags` runs, or the exit code of a run that can't start,
 * said on stderr once the getting-ready line `ready` has gone: a spec run in a repository init
 * hasn't set up sets it up first, as init does without a terminal (§ 4.14), what that wrote
 * committed with the spec; then the startup checks, with that setup; then --feature refused where
 * `terminal` can't show the Interview view, which only the renderer shows. A spec at a URL is
 * fetched once (§ 4.14), by the setup or the checks, whichever reads it first.
 */
export const prepareWork = (
  cwd: string,
  flags: RunFlags,
  io: { readonly ready: GettingReady; readonly terminal: TtyValue },
) =>
  Effect.gen(function* () {
    const { ready, terminal } = io
    const cannot = cannotStart(ready)
    const fetch = fetchOnce(fetchSpecLive)
    const fieldFetch = fetchOnce(fetchSpecLive, { failures: false })
    const fetchContext = yield* Effect.context<LiveFetch>()
    const setup = yield* setUpFromFlags({
      cwd,
      flags,
      env: (name) => process.env[name],
      setUp: (concurrent) => setUpForSpec(cwd, concurrent),
      say: (text) => Effect.andThen(ready.end, Console.log(text)),
      fetch,
    }).pipe(Effect.provide(gitLayer))
    if (typeof setup === "number") return setup
    const checked = yield* Effect.result(
      check(live(cwd, flags, ready.unpacking, setup, fetch)).pipe(Effect.provide(gitLayer)),
    )
    if (Result.isFailure(checked)) {
      const failed = checked.failure
      return yield* cannot(failed instanceof StartupFailed ? failed.message : String(failed))
    }
    // --feature talks the feature through in the Interview view, which only the renderer shows.
    if (
      checked.success.config.feature !== null &&
      outputMode(terminal, checked.success.config.plain)._tag === "Plain"
    ) {
      return yield* cannot(featureUnavailable)
    }
    yield* ready.step(readySteps.starting)
    const prepared: Prepared = { setup, started: checked.success, fieldFetch, fetchContext }
    return prepared
  })
