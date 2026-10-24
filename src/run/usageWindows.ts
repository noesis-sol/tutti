// The account's usage windows (§ 4.12, § 7.2), the run's own (run.ts makes it). Every worker's
// rate_limit_event carries the account's windows in `unifiedWindows` (UsageLimits keeps each at its
// latest figure), `allowed` events too, so the title line shows them all the time,
// `Current usage ▰▰▱▱▱▱▱▱▱▱  17% · This week 41%`, where the usage banner (usageLimit.ts) shows
// only near a limit.
//
// Each window's figure is recorded as a `usage_window` event: the first the run hears, its figure
// at the run's start, then each that differs, so that a ticket's share of a window can be told from
// how the window rose while its worker ran.
import { Effect, FiberSet, Ref, type Scope, Stream } from "effect"
import { UsageLimits, type Windows } from "../agent/UsageLimits.ts"
import { EventStream } from "./eventstream.ts"
import { RunFibers } from "./fibers.ts"
import { timestamp } from "./localTime.ts"
import type { UsageWindow } from "./runView.ts"

/** The windows the title line shows: those with a figure, in the order first reported. */
export const shownWindows = (windows: Windows): ReadonlyArray<UsageWindow> =>
  [...windows].flatMap(([name, window]) =>
    window.utilization === null
      ? []
      : [{ name, utilization: window.utilization, resetsAt: window.resetsAt }],
  )

/**
 * Watches the account's windows for the rest of the scope: each figure that differs from the last
 * recorded is a `usage_window` event, and `show` shows the windows on the dashboard.
 */
export const make = (options: {
  readonly show: (windows: ReadonlyArray<UsageWindow>) => Effect.Effect<void>
}): Effect.Effect<void, never, UsageLimits | EventStream | RunFibers | Scope.Scope> =>
  Effect.gen(function* () {
    const usage = yield* UsageLimits
    const events = yield* EventStream
    const fibers = yield* RunFibers
    const watchers = yield* fibers.make("usageWindows")
    // The last figure recorded of each window.
    const recorded = yield* Ref.make<ReadonlyMap<string, UsageWindow>>(new Map())

    const heard = (windows: Windows) =>
      Effect.gen(function* () {
        const shown = shownWindows(windows)
        const before = yield* Ref.get(recorded)
        for (const window of shown) {
          const last = before.get(window.name)
          if (last?.utilization === window.utilization && last.resetsAt === window.resetsAt) {
            continue
          }
          yield* events.emit({
            kind: "usage_window",
            window: window.name,
            utilization: window.utilization,
            ...(window.resetsAt === null
              ? {}
              : { resets_at: timestamp(new Date(window.resetsAt)) }),
          })
        }
        yield* Ref.set(recorded, new Map(shown.map((window) => [window.name, window])))
        yield* options.show(shown)
      })

    yield* FiberSet.run(watchers, Stream.runForEach(usage.windows, heard))
  })
