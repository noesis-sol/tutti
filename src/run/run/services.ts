// The run's services and what shows it (run.ts, § 5): the services it runs on, the base's commit as
// it starts, the START block, the attention files served (§ 7.6), its status and the dashboard
// shown from it when Tty says the terminal can draw one and main gave the run one (screen.ts,
// § 7.1), the screen's commands (screenCommands.ts), its wakes (wakes.ts) and what holds it
// (holdsGate.ts).
import { type Context, Effect, type Scope, SubscriptionRef } from "effect"
import { AgentHost } from "../../agent/AgentHost.ts"
import { Attention } from "../../agent/Attention.ts"
import { serve } from "../../agent/attentionFiles.ts"
import { AppConfig } from "../../core/AppConfig.ts"
import { Log } from "../../core/log.ts"
import { formatDuration } from "../../project/configFile.ts"
import { schemeNotices } from "../../project/scheme.ts"
import { Beads } from "../../services/Beads.ts"
import { EventStream } from "../../services/EventStream.ts"
import { Git } from "../../services/Git.ts"
import { Store } from "../../services/Store.ts"
import { outputMode, Tty } from "../../services/Tty.ts"
import { autoAnswerName } from "../autoAnswer.ts"
import { RunFibers } from "../fibers.ts"
import { type HoldsGate, make as makeHoldsGate } from "../holdsGate.ts"
import { Ledger } from "../ledger.ts"
import { emptyStatus, type Status } from "../runView.ts"
import { type ScreenInputs, show } from "../screen.ts"
import { make as makeScreenCommands, type ScreenCommands } from "../screenCommands.ts"
import { make as makeWakes, type Wakes } from "../wakes.ts"
import type { WorkEnv } from "../work.ts"
import type { RunEnv, RunOptions } from "./shared.ts"

/** The run's services, and what every part of it shows on and wakes. */
export interface Services {
  readonly config: AppConfig["Service"]
  readonly beads: Beads["Service"]
  readonly host: AgentHost["Service"]
  readonly store: Store["Service"]
  readonly attention: Attention["Service"]
  readonly ledger: Ledger["Service"]
  readonly logs: Log["Service"]
  readonly events: EventStream["Service"]
  readonly fibers: RunFibers["Service"]
  /** The context a ticket's work runs in. */
  readonly context: Context.Context<WorkEnv>
  /** Where finished tickets land: the branch the main checkout is on (RunOptions.base). */
  readonly base: string
  /** The base's commit as the run starts, for the report's commits merged. */
  readonly startHead: string
  /** What the dashboard says of the run, beside its tickets: the holds change it as they come. */
  readonly status: SubscriptionRef.SubscriptionRef<Status>
  /** The dashboard shown, or null for a plain run. */
  readonly screen: ScreenInputs | null
  /** The run's end, and the screen's commands that act on the run until then. */
  readonly commands: ScreenCommands
  /** Wakes the run to look again, each wake for its reason. */
  readonly wakes: Wakes
  readonly wakeUp: Wakes["wakeUp"]
  /** What holds the run: its stops, the tickets past --ticket-limit, the machine's hold. */
  readonly holds: HoldsGate
}

/** The run's services, its START block said and its dashboard shown, begun at `begun`. */
export const make = (
  options: Pick<RunOptions, "version" | "base" | "subscription" | "start" | "dashboard">,
  begun: number,
): Effect.Effect<Services, never, RunEnv | Ledger | Scope.Scope> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const beads = yield* Beads
    const host = yield* AgentHost
    const store = yield* Store
    const attention = yield* Attention
    const ledger = yield* Ledger
    const logs = yield* Log
    const events = yield* EventStream
    const fibers = yield* RunFibers
    const context = yield* Effect.context<WorkEnv>()
    const { base } = options
    // The base's commit as the run starts, for the report's commits merged.
    const startHead = yield* (yield* Git)
      .revParse(config.repo, base)
      .pipe(Effect.orElseSucceed(() => base))

    if (options.start !== undefined && options.start.length > 0) yield* logs.write(...options.start)
    yield* serve({ repo: config.repo })
    // What the dashboard says of the run, beside its tickets: the holds change it as they come.
    const notices = schemeNotices(config.scheme)
    const status = yield* SubscriptionRef.make<Status>({
      ...emptyStatus,
      version: options.version,
      branch: base,
      scope: config.ticket,
      ...(config.specPath === null ? {} : { spec: config.specPath }),
      began: begun,
      concurrency: config.settings.concurrent,
      autoAnswer:
        config.autoAnswer === null
          ? null
          : autoAnswerName(config.autoAnswer, formatDuration(config.autoAnswer)),
      subscription: options.subscription ?? false,
      warnings: notices,
    })
    const dashboard = options.dashboard
    const screen =
      dashboard !== undefined && outputMode(yield* Tty, config.plain)._tag === "Dashboard"
        ? yield* show(dashboard, SubscriptionRef.changes(status))
        : null
    // The run's end, set once nothing is to start or act after it, and the screen's commands that
    // act on the run until then (screenCommands.ts).
    const commands = yield* makeScreenCommands({ repo: config.repo, base, scope: config.ticket })

    // Wakes the run to look again, each wake for its reason (wakes.ts): a merge, a stop, a drain
    // request, the ready poll.
    const wakes = yield* makeWakes
    const { wakeUp } = wakes
    // What holds the run (holdsGate.ts): its stops, the tickets past --ticket-limit, the machine's
    // hold and the usage limit's view, each shown on the dashboard as it comes. A stop holds the
    // run, said as it comes while tickets still run, and wakes it.
    const holds = yield* makeHoldsGate({ status, notices, wakeUp: wakeUp("hold") })
    return {
      config,
      beads,
      host,
      store,
      attention,
      ledger,
      logs,
      events,
      fibers,
      context,
      base,
      startHead,
      status,
      screen,
      commands,
      wakes,
      wakeUp,
      holds,
    }
  })
