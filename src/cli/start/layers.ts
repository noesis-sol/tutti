// The services a bare `tutti`'s run goes on (src/main.ts's runFrom): the live layers of the run, on
// a ManagedRuntime disposed of as the run's scope closes, and the layers --overnight's pre-flight
// runs on before them, each built for the pre-flight alone.
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, ManagedRuntime } from "effect"
import { layer as agentHostLayer } from "../../agent/AgentHostLive.ts"
import { Attention } from "../../agent/Attention.ts"
import { ClaudeCode } from "../../agent/ClaudeCode.ts"
import { interviewWorker } from "../../agent/inView.ts"
import { Transcripts } from "../../agent/Transcripts.ts"
import { UsageLimits } from "../../agent/UsageLimits.ts"
import { AppConfig } from "../../core/AppConfig.ts"
import { BranchEnv, branchEnv, WorkerEnv, workerEnv } from "../../core/env.ts"
import { Log, type Sink } from "../../core/log.ts"
import { chosenLayer as languageModelLayer } from "../../organs/AnthropicProvider.ts"
import { Organs } from "../../organs/Organs.ts"
import { UsageProbe } from "../../organs/UsageProbe.ts"
import { Battery, liveBattery } from "../../run/battery.ts"
import { layer as fibersLayer } from "../../run/fibers.ts"
import { Load, liveLoad } from "../../run/load.ts"
import { notifying } from "../../run/notices.ts"
import { requiresServerFor } from "../../run/requiresTools.ts"
import { liveSleepCauses, SleepCauses } from "../../run/sleepCause.ts"
import type { Started } from "../../run/startup.ts"
import { layer as trashLayer } from "../../run/trash.ts"
import { organHold } from "../../run/usageLimit.ts"
import { Beads } from "../../services/Beads.ts"
import { Checks } from "../../services/Checks.ts"
import { EventStream } from "../../services/EventStream.ts"
import { Git, GitWriter } from "../../services/Git.ts"
import { otherWorkers } from "../../services/machine.ts"
import { layer as notifierLayer } from "../../services/Notifier.ts"
import { OrganCost } from "../../services/OrganCost.ts"
import { Spending } from "../../services/Spending.ts"
import { Store } from "../../services/Store.ts"
import { layer as straysLayer } from "../../services/Strays.ts"
import { shares } from "../../services/share.ts"
import { layer as ttyLayer } from "../../services/Tty.ts"
import { wakeLayer } from "../../services/Wake.ts"
import { Worktrees } from "../../services/Worktrees.ts"
import { version } from "../version.ts"

/** git, with its one writer at a time. */
export const gitLayer = Git.layer().pipe(Layer.provideMerge(GitWriter.layer))

/**
 * The live layers of the run `started` describes, which started at `at` (RFC 3339), its log lines
 * printed to `sink` too.
 */
export const liveLayers = (started: Started, at: string, sink: Sink) => {
  const { config } = started
  const repo = config.repo
  const first = Layer.mergeAll(
    Layer.succeed(AppConfig, config),
    gitLayer,
    Beads.layer({ cwd: repo }),
    Log.layer({ repo, sink }),
    EventStream.layer({ repo, run: at }),
    Store.layer({ repo, run: { pid: process.pid, started: at, version } }),
    Transcripts.layer({ repo }),
    UsageLimits.layer,
    fibersLayer,
    // What was left running in a folder (Strays.ts): stopped as the trash deletes a merged
    // worktree's, Worktrees removes a detached worktree, or a check that didn't pass ends.
    straysLayer(),
    // The other runs' workers, which the run reads and its workers' share of the cores counts.
    otherWorkers,
    // The workers' share of the machine, which the run keeps live and each session starts with.
    shares,
    // The machine's load, which the run reads for the dashboard's load line.
    Layer.succeed(Load, liveLoad()),
    // The battery, which the run reads every minute to warn before it runs low.
    Layer.succeed(Battery, liveBattery()),
    // Why the machine slept, which the run reads for each SLEPT line (src/run/sleepCause.ts).
    Layer.succeed(SleepCauses, liveSleepCauses()),
    // The environment of the setup, the checks and the requires list's commands: the workers' but
    // tutti's variables, the API key handled as theirs is (§ 4.13).
    Layer.succeed(
      BranchEnv,
      branchEnv({ subscription: started.account.subscription, billing: config.billing }),
    ),
    // The environment workers', organs' and the usage probe's sessions start from (§ 4.13),
    // resolved once from the account the probe found.
    Layer.succeed(
      WorkerEnv,
      workerEnv({ subscription: started.account.subscription, billing: config.billing }),
    ),
  )
  const second = Layer.mergeAll(
    // The one port every Claude Code session tutti opens goes through: workers', organs' and the
    // usage probe's.
    ClaudeCode.layer,
    Checks.layer,
    // What the workers' turns spent (§ 10), for the host's turn records and the ledger's sums.
    Spending.layer,
    Worktrees.layer({ repo, root: config.worktrees, base: started.base }),
    notifierLayer.pipe(Layer.provide(ttyLayer)),
  )
  // Each worker gets tutti's own MCP server with its requires tools (§ 4.11).
  const host = Layer.unwrap(
    Effect.map(requiresServerFor(repo), (ownServer) =>
      agentHostLayer({
        prompt: started.prompt,
        servers: started.mcp,
        account: started.account,
        ownServer,
      }),
    ),
  )
  // The organs, over the Agent SDK or, with TUTTI_ORGAN_PROVIDER=anthropic, the Messages API, as
  // the startup checks read it, their costs logged, skipped while the usage limit holds, as the
  // report asks too. The startup checks stopped the run on a choice that can't be used.
  // The usage-limit hold's probe of the account (§ 4.12) is billed and its cost logged as an
  // organ call's.
  const organs = Layer.mergeAll(
    Organs.layer.pipe(Layer.provideMerge(languageModelLayer({ provider: started.organs }))),
    UsageProbe.layer,
  ).pipe(Layer.provideMerge(OrganCost.layer), Layer.provideMerge(organHold))
  // Attention's records notify too: it is given the EventStream that notifies (notices.ts). With
  // --auto-answer it answers the workers' questions, not the --feature interview's, which is you.
  // An overnight run denies the workers' permission requests once they have waited (tutti-epza.10).
  const attention = Attention.layer({
    ...(config.autoAnswer === null
      ? {}
      : {
          autoAnswer: {
            after: config.autoAnswer,
            answers: (ticket) => ticket !== interviewWorker,
          },
        }),
    ...(config.denyPermissions === null
      ? {}
      : {
          denyPermissions: {
            after: config.denyPermissions,
            denies: (ticket) => ticket !== interviewWorker,
          },
        }),
  })
  return Layer.mergeAll(host, organs).pipe(
    Layer.provideMerge(attention),
    // Merged worktrees' folders, deleted in the background (trash.ts), what was left running in
    // them stopped first (Strays.ts).
    Layer.provideMerge(trashLayer),
    Layer.provideMerge(notifying),
    Layer.provideMerge(second),
    Layer.provideMerge(first),
    // The machine's sleeps, which every time limit of the run leaves out (src/services/Wake.ts).
    Layer.provideMerge(wakeLayer),
    Layer.provideMerge(BunServices.layer),
  )
}

/**
 * The run's services (liveLayers) on a ManagedRuntime of their own, made in the scope and disposed
 * of as it closes, after what the scope acquired before it: the run lock. Fails where a layer
 * can't be built.
 */
export const runLayers = (started: Started, at: string, sink: Sink) =>
  Effect.gen(function* () {
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => ManagedRuntime.make(liveLayers(started, at, sink))),
      (made) => made.disposeEffect,
    )
    return yield* runtime.contextEffect
  })

/**
 * The services --overnight's pre-flight runs on, for the run `started` describes: bd, the log, the
 * worktrees and the checks for the merge check on the base, and the usage probe, billed as workers
 * are, each built for the pre-flight alone, before the run's own.
 */
export const preflightLayers = (started: Started) => {
  const { config } = started
  const repo = config.repo
  const env = { subscription: started.account.subscription, billing: config.billing }
  const first = Layer.mergeAll(
    Layer.succeed(AppConfig, config),
    gitLayer,
    Log.layer({ repo }),
    Layer.succeed(BranchEnv, branchEnv(env)),
    Layer.succeed(WorkerEnv, workerEnv(env)),
    straysLayer(),
  )
  return Layer.mergeAll(
    Beads.layer({ cwd: repo }),
    Worktrees.layer({ repo, root: config.worktrees, base: started.base }),
    Checks.layer,
    UsageProbe.layer.pipe(Layer.provide(ClaudeCode.layer), Layer.provideMerge(OrganCost.layer)),
  ).pipe(Layer.provideMerge(first), Layer.provideMerge(BunServices.layer))
}
