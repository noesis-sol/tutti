// What a bare `tutti`'s run (src/main.ts's runFrom) finds before anything of it starts: the signal
// handlers that must be in place before tutti's PID is written anywhere, the terminal and the
// getting-ready line on it, and a release build's check for a newer release, in the background.
import { Console, Effect, Option, Queue } from "effect"
import { type GettingReady, gettingReady } from "../../print/gettingReady.ts"
import { stdout } from "../../print/organLine.ts"
import type { DrainRequest } from "../../run/drain.ts"
import { exitCodes } from "../../run/holds.ts"
import { catchSignals } from "../../run/quit.ts"
import { Tty, type TtyValue, layer as ttyLayer } from "../../services/Tty.ts"
import type { LineIO } from "../../ui/plain/forms.ts"
import { cacheDir, checksForUpdates, githubReleases, startCheck } from "../../update/update.ts"
import { thisBuildKind } from "../commands.ts"
import { version } from "../version.ts"

/**
 * The queues of the run's drains and suspends, their handlers in place: SIGUSR1 and SIGUSR2 wind
 * the run down (Drain), and SIGTSTP is ignored. Each handler is in place before
 * tutti's PID is written anywhere, as without one each signal kills or stops tutti.
 */
export const signalQueues = Effect.gen(function* () {
  const drains = yield* Queue.unbounded<DrainRequest>()
  const suspends = yield* Queue.unbounded<void>()
  yield* catchSignals({
    drain: (signal) => Queue.offerUnsafe(drains, { on: true, how: `by ${signal}` }),
    suspend: () => Queue.offerUnsafe(suspends, undefined),
  })
  return { drains, suspends }
})

/** What the run found before it started, as `preflight` gives it. */
export interface Preflight {
  /** What the environment says of the terminal. */
  readonly terminal: TtyValue
  /**
   * The line saying what tutti is doing until the first thing it draws (src/print/gettingReady.ts),
   * gone with the run's scope at the latest.
   */
  readonly ready: GettingReady
  /** The newer release the daily check found, if it has one by the time it is read. */
  readonly newer: Effect.Effect<Option.Option<string>>
}

/**
 * What the run finds before anything of it starts: the terminal; then the getting-ready line on
 * it, ended with the scope at the latest; then a release build's daily check for a newer release
 * (§ 12), in the background (not the npm package's, which tutti update leaves to the package
 * manager), whose answer is said once the run has ended.
 */
export const preflight = Effect.gen(function* () {
  const terminal = yield* Effect.provide(
    Effect.gen(function* () {
      return yield* Tty
    }),
    ttyLayer,
  )
  const ready = yield* gettingReady(stdout, terminal)
  yield* Effect.addFinalizer(() => ready.end)
  const env = (name: string) => process.env[name]
  const newer = checksForUpdates({ kind: thisBuildKind() }, env)
    ? yield* startCheck({
        releases: githubReleases,
        current: version,
        cache: cacheDir(env),
        now: Date.now,
      })
    : Effect.succeed(Option.none<string>())
  return { terminal, ready, newer }
})

/**
 * Says `message` on stderr, once the getting-ready line `ready` has gone, and gives the exit code
 * of a run that can't start.
 */
export const cannotStart = (ready: GettingReady) => (message: string) =>
  ready.end.pipe(Effect.andThen(Console.error(message)), Effect.as(exitCodes.setup))

/**
 * A line form's live terminal (forms.ts' LineIO), whose countdown is drawn again above its prompt:
 * stdout a terminal that moves its cursor, not TERM=dumb.
 */
export const liveLines = (terminal: TtyValue): Pick<LineIO, "live"> =>
  terminal.stdoutIsTty && !terminal.dumb
    ? { live: { columns: () => process.stdout.columns ?? 80 } }
    : {}
