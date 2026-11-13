// The checks running, as the dashboard shows them (§ 7.2): the full check in Current's box, the
// checks gate in its place, and a ticket's merge check on its card. Each check the run starts
// watches here (`watch`): its entry holds the suite its last SUITE: line named and the latest
// PROGRESS: line of that suite, which the check itself writes through Checks' onAt, and it goes
// when the check ends. The bar fills with done over total where the check counts (fillOf); a
// suite that has printed no PROGRESS: line, and a check that prints none at all, fills it instead
// by the time it has run against the median of that check's recent passes, which the run keeps
// (`passed`, by the check's kind, so that every merge check's passes count for the next), marked as
// an estimate and stopping short of full until the check ends. With no pass to go by there is no
// bar: the suite's name alone.
//
// Nothing here is an Effect in the hot path: a check's output moves its entry through a plain
// callback, as CheckOutput takes its chunks, and the run's watchers read `now` as they draw
// (src/run/run/watchers.ts), which also writes the count as lines at intervals for a plain run,
// which has no dashboard to draw a bar on (§ 7.6). What is read is the bar as it is drawn, filled
// and counted at the time it is read, and it is the map read before where nothing in it has
// changed: an estimate creeping a hundredth of a percent redraws no card (tutti-rvzn.1).
import { Clock, Context, Duration, Effect, Layer, Option, type Scope } from "effect"
import { detail, type Log } from "../core/log.ts"
import type { CheckAt, CheckKind, CheckProgress, RunOptions } from "../services/Checks.ts"
import { noCheckAt } from "../services/Checks.ts"
import type { checkSuites } from "../services/events.ts"
import { median } from "../services/scorecard.ts"
import { marks } from "../text/marks.ts"
import { same } from "./same.ts"

/** What a check running is called where it is shown. */
export type CheckName = "merge check" | "full check" | "checks gate"

/** Where the full check and the checks gate are kept: Current's box shows the one that runs. */
export const fullCheckKey = "the full check"

/** How many of a check's last passes the estimate's median is of. */
export const recentPasses = 5

/** How full the estimate's bar may be before the check has ended: it stops short of full. */
export const estimateCap = 0.9

/** A check running, for the dashboard. */
export interface CheckShown {
  /** What it is called where it is shown. */
  readonly name: CheckName
  /** When it began, in epoch milliseconds. */
  readonly began: number
  /** The suite its last SUITE: line named; null before any. */
  readonly suite: string | null
  /** The latest PROGRESS: line of that suite; null where it has printed none. */
  readonly progress: CheckProgress | null
  /** The median of the recent passes of its kind, in seconds; null before any passed in the run. */
  readonly usual: number | null
  /** How full its bar is and what the count beside it says; null where no bar is drawn for it. */
  readonly fill: CheckFill | null
}

/** How full a check's bar is, and what the count beside it says. */
export interface CheckFill {
  /** How much of the bar is filled, 0 to 1. */
  readonly filled: number
  /** `312/848` from its PROGRESS: lines, or `≈23%` of the time its passes usually take. */
  readonly count: string
  /** Whether it is the estimate from its recent passes rather than what the check counted. */
  readonly estimate: boolean
}

/**
 * How full the bar of a check at `at` is, begun at `began` and `usual` seconds the median of its
 * kind's recent passes, at `now`: done over total where its suite has printed a PROGRESS: line,
 * else the time it has run against that median, short of full until it ends, marked as an
 * estimate. null where it has neither: no bar is drawn for it.
 */
export const fillOf = (
  at: CheckAt,
  began: number,
  usual: number | null,
  now: number,
): CheckFill | null => {
  const { progress } = at
  if (progress !== null) {
    const filled = progress.total === 0 ? 1 : Math.min(1, progress.done / progress.total)
    return { filled, count: `${progress.done}/${progress.total}`, estimate: false }
  }
  if (usual === null || usual <= 0) return null
  const ran = Math.max(0, now - began) / 1000
  const filled = Math.min(estimateCap, ran / usual)
  return { filled, count: `${marks.estimate}${Math.round(filled * 100)}%`, estimate: true }
}

/** `test 312/848`, `tsc ≈23%`, the suite left out where none is named; null with no bar to draw. */
export const checkWords = (shown: CheckShown): string | null =>
  shown.fill === null
    ? shown.suite
    : shown.suite === null
      ? shown.fill.count
      : `${shown.suite} ${shown.fill.count}`

/** What a check watched here says of itself as it runs. */
export interface Watched {
  /** Hand it to the check as Checks' RunOptions onAt, which calls it as the check's output moves. */
  readonly onAt: (at: CheckAt) => void
}

/** A check running, as the service keeps it. */
interface Entry {
  readonly name: CheckName
  readonly kind: CheckKind
  readonly began: number
  at: CheckAt
}

/**
 * The checks running and the recent passes their bars are estimated from, as a value: the run
 * provides it as the Checking service, and what runs a check picks it up where there is one.
 */
export const makeChecking = (): Checking["Service"] => {
  const entries = new Map<string, Entry>()
  const passes = new Map<CheckKind, Array<number>>()
  // The last snapshot, kept until something changes, so that showing it publishes nothing new.
  let snapshot: ReadonlyMap<string, CheckShown> | null = null
  const usualOf = (kind: CheckKind): number | null => {
    const times = passes.get(kind)
    return times === undefined || times.length === 0 ? null : median(times)
  }
  const take = (now: number): ReadonlyMap<string, CheckShown> => {
    const taken = new Map<string, CheckShown>()
    for (const [key, entry] of entries) {
      const usual = usualOf(entry.kind)
      taken.set(key, {
        name: entry.name,
        began: entry.began,
        suite: entry.at.suite,
        progress: entry.at.progress,
        usual,
        fill: fillOf(entry.at, entry.began, usual, now),
      })
    }
    // The map read before where nothing drawn has changed: what shows it then publishes nothing.
    if (snapshot !== null && same(snapshot, taken)) return snapshot
    snapshot = taken
    return taken
  }
  return {
    watch: (key, how) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          entries.set(key, { name: how.name, kind: how.kind, began: how.began, at: how.at })
          return {
            onAt: (at: CheckAt) => {
              const entry = entries.get(key)
              if (entry === undefined) return
              entry.at = at
            },
          } satisfies Watched
        }),
        () =>
          Effect.sync(() => {
            entries.delete(key)
          }),
      ),
    passed: (kind, seconds) =>
      Effect.sync(() => {
        const times = passes.get(kind) ?? []
        times.push(seconds)
        passes.set(kind, times.slice(-recentPasses))
      }),
    now: Effect.map(Clock.currentTimeMillis, take),
  }
}

export class Checking extends Context.Service<
  Checking,
  {
    /**
     * `key`'s check runs for the scope: a ticket's ID for its merge check, fullCheckKey for the
     * full check and the checks gate. It gives what the check tells it where it is through
     * (Watched), and its entry goes when the scope closes, however the check ended.
     */
    watch(
      key: string,
      how: {
        readonly name: CheckName
        readonly kind: CheckKind
        /** When it began, in epoch milliseconds. */
        readonly began: number
        /** Where it is as it starts: nothing said yet, or the setup before it left it. */
        readonly at: CheckAt
      },
    ): Effect.Effect<Watched, never, Scope.Scope>
    /** A check of `kind` passed in `seconds`: its kind's recent passes, which the estimate is of. */
    passed(kind: CheckKind, seconds: number): Effect.Effect<void>
    /**
     * The checks running now, by key, their bars filled at the time it is read; the map read before
     * where nothing drawn has changed since.
     */
    readonly now: Effect.Effect<ReadonlyMap<string, CheckShown>>
  }
>()("tutti/run/Checking") {
  /** The run's checks, none running yet. */
  static readonly layer: Layer.Layer<Checking> = Layer.sync(Checking, makeChecking)
}

/** Which check a `check` record's suite is of: every merge check's passes count for the next. */
export const kindOfSuite = (suite: (typeof checkSuites)[number]): CheckKind =>
  suite === "full" ? "full" : suite === "setup" ? "setup" : "fast"

/**
 * Watches `key`'s check for the scope, where the run has a Checking: what to give the check so that
 * it says where it is (Checks' RunOptions onAt), or nothing where there is none to tell, as in a
 * test's layers. Spread it into the check's options.
 */
export const watchCheck = (
  key: string,
  name: CheckName,
  kind: CheckKind,
): Effect.Effect<Pick<RunOptions, "onAt">, never, Scope.Scope> =>
  Effect.gen(function* () {
    const checking = yield* Effect.serviceOption(Checking)
    if (Option.isNone(checking)) return {}
    const began = yield* Clock.currentTimeMillis
    const watched = yield* checking.value.watch(key, { name, kind, began, at: noCheckAt })
    return { onAt: watched.onAt }
  })

/** Keeps the `seconds` a check of `suite` passed in, where the run has a Checking (`passed`). */
export const checkPassed = (
  suite: (typeof checkSuites)[number],
  seconds: number,
): Effect.Effect<void> =>
  Effect.flatMap(Effect.serviceOption(Checking), (checking) =>
    Option.isNone(checking) ? Effect.void : checking.value.passed(kindOfSuite(suite), seconds),
  )

/** How often the dashboard reads the checks running, to draw their bars. */
export const showEvery = Duration.millis(250)

/** How often a plain run, which has no bar to draw, says how far each check running has got. */
export const sayEvery = Duration.minutes(1)

/** Shows the checks running on the dashboard, reading them every showEvery, for the run's scope. */
export const showChecking = (
  checking: Checking["Service"],
  show: (shown: ReadonlyMap<string, CheckShown>) => Effect.Effect<void>,
): Effect.Effect<never> =>
  Effect.forever(Effect.andThen(Effect.flatMap(checking.now, show), Effect.sleep(showEvery)))

/** `the full check: test 312/848`, `t-1's merge check: tsc ≈23%`; null with nothing to say yet. */
export const checkingLine = (key: string, shown: CheckShown): string | null => {
  const words = checkWords(shown)
  if (words === null) return null
  const whose = key === fullCheckKey ? `the ${shown.name}` : `${key}'s ${shown.name}`
  return `${whose}: ${words}`
}

/**
 * Says how far each check running has got every sayEvery, for a run with no dashboard to draw a
 * bar on (§ 7.6), as a detail line; a check with nothing new to say is left out.
 */
export const sayChecking = (
  checking: Checking["Service"],
  logs: Log["Service"],
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const said = new Map<string, string>()
    yield* Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep(sayEvery)
        const running = yield* checking.now
        for (const [key, shown] of running) {
          const text = checkingLine(key, shown)
          if (text === null || said.get(key) === text) continue
          said.set(key, text)
          yield* logs.write(detail`${text}`)
        }
        for (const key of [...said.keys()]) if (!running.has(key)) said.delete(key)
      }),
    )
  })
