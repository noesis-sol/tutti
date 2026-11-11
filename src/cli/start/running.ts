// The run itself in a bare `tutti`'s run (src/main.ts's runFrom): src/run/run.ts's run on what was
// chosen, scoped to it, its START block, and the signals that quit it while it goes.
import { availableParallelism } from "node:os"
import { Effect, Queue } from "effect"
import type { AppConfigValue } from "../../core/AppConfig.ts"
import { detail, type Line } from "../../core/log.ts"
import { stdout } from "../../print/organLine.ts"
import type { DrainRequest } from "../../run/drain.ts"
import { scopedTo } from "../../run/feature.ts"
import { liveLoad } from "../../run/load.ts"
import { listen, type QuitRequest, quitBy } from "../../run/quit.ts"
import type { RunOptions } from "../../run/run/shared.ts"
import { run } from "../../run/run.ts"
import { startShareNote } from "../../run/share.ts"
import { startBlock } from "../../run/startup.ts"
import { type OutputMode, plainReasonLine, type TtyValue } from "../../services/Tty.ts"
import { version } from "../version.ts"
import type { Choice } from "./choice.ts"
import type { Power } from "./power.ts"
import type { Specs } from "./specs.ts"

/** Ends tutti at once with `code` (a third request to quit), `said` printed first if given. */
export const exitNow =
  (destroy?: () => Promise<void>) =>
  (code: number, said: ReadonlyArray<Line>): Effect.Effect<void> =>
    Effect.promise(async () => {
      if (destroy !== undefined) {
        await destroy()
        stdout.write(`${said.join("\n")}\n`)
      }
      process.exit(code)
    })

/**
 * The run of what `choice` describes, on `base`: its START block from the workers' share of the
 * machine, read once, and the line saying why the output is plain; scoped to its ticket, epic or
 * spec; SIGINT, SIGTERM and SIGHUP quitting it while it goes (§ 4.8); a breakdown its end cut
 * short stopped with it.
 */
export const runnerOf = (options: {
  readonly config: Pick<AppConfigValue, "machineWorkers" | "settings">
  readonly base: string
  /** Whether workers bill the subscription login: the summary's dollars are estimates then. */
  readonly subscription: boolean
  readonly mode: OutputMode
  readonly tty: TtyValue
  readonly drains: Queue.Queue<DrainRequest>
  readonly quits: Queue.Queue<QuitRequest>
  readonly machine: Power
  readonly specs: Specs
  readonly choice: Choice
}) =>
  Effect.gen(function* () {
    const { config, base, subscription, mode, tty, drains, quits, machine, specs, choice } = options
    const why = mode._tag === "Plain" ? plainReasonLine(mode.reason, tty.term) : undefined
    // The workers' share of the machine, from one reading of it, for the START block.
    const share = yield* startShareNote(
      liveLoad(),
      { cores: availableParallelism(), limit: config.machineWorkers },
      config.settings.concurrent,
    )
    const start = () => [
      ...startBlock(
        {
          ...choice.started,
          config: { ...choice.config, ticket: choice.scope, feature: choice.feature },
        },
        version,
        share,
      ),
      ...(why === undefined ? [] : [detail`${why}`]),
    ]
    const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      choice.scope === null
        ? effect
        : scopedTo(choice.scope, choice.spec?.path ?? null, choice.feature)(effect)
    // While the run goes, SIGINT, SIGTERM and SIGHUP quit it (§ 4.8).
    const listening = <A, E, R>(running: Effect.Effect<A, E, R>) =>
      Effect.scoped(
        Effect.andThen(
          listen((signal) => Queue.offerUnsafe(quits, quitBy(signal))),
          running,
        ),
      )
    /** The run, with `exitNow` and the dashboard where there is one; its outcome. */
    const go = (io: Pick<RunOptions, "exitNow" | "dashboard">) =>
      Effect.gen(function* () {
        const ran = yield* listening(
          scoped(
            run({
              version,
              base,
              subscription,
              start: start(),
              drains,
              quits,
              ...machine.runOption(),
              ...specs.runOptions(),
              ...io,
              endLater: true,
            }),
          ),
        )
        // A breakdown the run's end cut short stops with it.
        yield* specs.stop
        return ran
      })
    return { go }
  })

/** The run as `runnerOf` made it ready. */
export type Runner = Effect.Success<ReturnType<typeof runnerOf>>
