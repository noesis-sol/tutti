#!/usr/bin/env bun
// tutti's entry point: the command line (src/cli/commands.ts), and a bare `tutti`'s run (§ 5): the
// startup checks (exit 2), the run lock (§ 9.2), then the run (src/run/run.ts) on a ManagedRuntime
// of the live layers, which is disposed of, and the lock released, once the run's scope has closed.
// When Tty says the terminal can draw the dashboard, the run shows it in the command's one OpenTUI
// renderer (src/ui/renderer.ts), the log goes to its file alone, and the run's summary and closing
// lines are printed once the renderer is gone. Otherwise the run is plain (§ 7.6): log lines on
// stdout, with a line saying why when the terminal couldn't show a dashboard. SIGUSR1 winds the
// run down (§ 7.4).
// A compiled build starts from its target's entry instead (src/entries/<target>.ts), which embeds
// its Claude Code and then calls `main`.
import { join } from "node:path"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Clock, Console, Effect, Layer, ManagedRuntime, Queue, Result } from "effect"
import { Command } from "effect/cli"
import pkg from "../package.json" with { type: "json" }
import { layer as agentHostLayer } from "./agent/AgentHostLive.ts"
import { Attention } from "./agent/Attention.ts"
import { Transcripts } from "./agent/Transcripts.ts"
import { AppConfig } from "./cli/AppConfig.ts"
import { mainCheckout, planServices, tuttiWith } from "./cli/commands.ts"
import type { RunFlags } from "./cli/flags.ts"
import { tuttiVersion } from "./cli/version.ts"
import { bySignal, type DrainRequest } from "./run/drain.ts"
import { EventStream } from "./run/eventstream.ts"
import { layer as fibersLayer } from "./run/fibers.ts"
import { exitCodes } from "./run/holds.ts"
import { detail, Log, logFile, type Sink } from "./run/log.ts"
import { noHolds, nothingToRun, type Output, themeStyles } from "./run/nothing.ts"
import { run } from "./run/run.ts"
import { check, live, type Started, StartupFailed, startBlock } from "./run/startup.ts"
import { stillUnmerged } from "./run/unmerged.ts"
import { Beads } from "./services/Beads.ts"
import { Checks } from "./services/Checks.ts"
import { Git, GitWriter } from "./services/Git.ts"
import { RunLock } from "./services/RunLock.ts"
import { Store } from "./services/Store.ts"
import { outputMode, plainReasonLine, Tty, layer as ttyLayer } from "./services/Tty.ts"
import { Worktrees } from "./services/Worktrees.ts"
import { dashboard } from "./ui/App.tsx"
import { open as openRenderer } from "./ui/renderer.ts"
import { type Appearance, makeTheme, outputAppearance } from "./ui/theme.ts"

export const version: string = pkg.version

/** git, with its one writer at a time. */
const gitLayer = Git.layer().pipe(Layer.provideMerge(GitWriter.layer))

/**
 * The live layers of the run `started` describes, which started at `at` (RFC 3339), its log lines
 * printed to `sink` too.
 */
const liveLayers = (started: Started, at: string, sink: Sink) => {
  const { config } = started
  const repo = config.repo
  const first = Layer.mergeAll(
    Layer.succeed(AppConfig, config),
    gitLayer,
    Beads.layer({ cwd: repo }),
    Log.layer({ file: join(repo, logFile), sink }),
    EventStream.layer({ repo, run: at }),
    Store.layer({ repo, run: { pid: process.pid, started: at, version } }),
    Transcripts.layer({ repo }),
    fibersLayer,
  )
  const second = Layer.mergeAll(
    Checks.layer,
    Worktrees.layer({ repo, root: config.worktrees, base: started.base }),
    Attention.layer,
  )
  const host = agentHostLayer({
    prompt: started.prompt,
    servers: started.mcp,
    account: started.account,
  })
  return host.pipe(
    Layer.provideMerge(second),
    Layer.provideMerge(first),
    Layer.provideMerge(BunServices.layer),
  )
}

/** Says `message` on stderr, and gives the exit code of a run that can't start. */
const cannotStart = (message: string) => Effect.as(Console.error(message), exitCodes.setup)

/** A bare `tutti`: the run, in the folder tutti was started in; its exit code. */
const runFrom = (cwd: string, flags: RunFlags) =>
  Effect.gen(function* () {
    const checked = yield* Effect.result(check(live(cwd, flags)).pipe(Effect.provide(gitLayer)))
    if (Result.isFailure(checked)) {
      const failed = checked.failure
      return yield* cannotStart(failed instanceof StartupFailed ? failed.message : String(failed))
    }
    const started = checked.success
    const { config, base } = started
    const at = new Date(yield* Clock.currentTimeMillis).toISOString()

    // The run lock, held until the runtime below has been disposed of.
    const commonDir = yield* Effect.result(
      Effect.flatMap(Git, (git) => git.commonDir(config.repo)).pipe(Effect.provide(gitLayer)),
    )
    if (Result.isFailure(commonDir)) {
      return yield* cannotStart(`tutti cannot find the git folder of ${config.repo}`)
    }
    const locked = yield* Effect.result(
      Effect.flatMap(RunLock, (lock) =>
        lock.acquire({
          repo: config.repo,
          commonDir: commonDir.success,
          holder: {
            pid: process.pid,
            started: at,
            version,
            branch: base,
            ...(config.ticket === null ? {} : { scope: config.ticket }),
          },
        }),
      ).pipe(Effect.provide(RunLock.layer)),
    )
    if (Result.isFailure(locked)) return yield* cannotStart(locked.failure.message)

    const terminal = yield* Effect.provide(
      Effect.gen(function* () {
        return yield* Tty
      }),
      ttyLayer,
    )
    const mode = outputMode(terminal, config.plain)
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() =>
        ManagedRuntime.make(liveLayers(started, at, mode._tag === "Plain" ? "stdout" : "none")),
      ),
      (made) => made.disposeEffect,
    )
    const services = yield* Effect.result(runtime.contextEffect)
    if (Result.isFailure(services)) {
      return yield* cannotStart(`tutti cannot start its run: ${String(services.failure)}`)
    }

    return yield* Effect.gen(function* () {
      const events = yield* EventStream
      const tty = yield* Tty
      yield* events.emit({
        kind: "start",
        version,
        repo: config.repo,
        branch: base,
        ...(config.ticket === null ? {} : { scope: config.ticket }),
        ...(config.feature === null ? {} : { feature: config.feature }),
        concurrency: config.settings.concurrent,
        billing: config.billing,
        permission_mode: started.account.permissionMode.inEffect,
      })

      const depth = tty.colourDepth === "truecolor" ? "truecolor" : "256"
      const themeOf = (appearance: Appearance) =>
        makeTheme(config.scheme.scheme, { appearance, depth, noColor: config.noColor })
      const output: Output =
        mode._tag === "Plain"
          ? { _tag: "Plain" }
          : {
              _tag: "Box",
              width: (yield* tty.size).columns,
              styles: themeStyles(themeOf(yield* outputAppearance(config.appearance, null))),
            }
      // bd failing to list the tickets left unmerged is something to run: the run lists them again,
      // and stops on it.
      const unmerged = yield* Effect.result(stillUnmerged({ repo: config.repo, base }))
      const nothing =
        Result.isSuccess(unmerged) &&
        (yield* nothingToRun(
          {
            scope: config.ticket,
            filter: { excludeTypes: config.settings.queue.exclude_types },
            repo: config.repo,
            base,
            carried: new Set(),
            unmerged: unmerged.success,
            held: noHolds,
          },
          output,
        ))
      if (nothing) {
        yield* events.emit({ kind: "end", code: exitCodes.ok })
        return exitCodes.ok
      }

      // SIGUSR1 winds the run down, as orchestra's drain.
      const drains = yield* Queue.unbounded<DrainRequest>()
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const drain = () => Queue.offerUnsafe(drains, { on: true, how: bySignal })
          process.on("SIGUSR1", drain)
          return drain
        }),
        (drain) => Effect.sync(() => process.off("SIGUSR1", drain)),
      )
      const why = mode._tag === "Plain" ? plainReasonLine(mode.reason, tty.term) : undefined
      const start = [
        ...startBlock(started, version),
        ...(why === undefined ? [] : [detail`${why}`]),
      ]
      if (mode._tag === "Plain") {
        return (yield* Effect.scoped(run({ version, base, start, drains }))).exitCode
      }
      // The renderer, destroyed once the run's scope and then its own have closed.
      const shown = yield* Effect.scoped(
        Effect.gen(function* () {
          const shell = yield* openRenderer({ chosen: config.appearance })
          return yield* Effect.scoped(
            run({ version, base, start, drains, dashboard: dashboard(shell, themeOf) }),
          )
        }),
      ).pipe(Effect.result)
      if (Result.isFailure(shown)) {
        return yield* cannotStart(`tutti cannot open its screen: ${shown.failure.message}`)
      }
      yield* Console.log(shown.success.ending.join("\n"))
      return shown.success.exitCode
    }).pipe(Effect.provideContext(services.success), Effect.provide(ttyLayer))
  }).pipe(
    Effect.scoped,
    Effect.flatMap((code) =>
      Effect.sync(() => {
        process.exitCode = code
      }),
    ),
    Effect.onInterrupt(() =>
      Effect.sync(() => {
        process.exitCode = exitCodes.interrupted
      }),
    ),
  )

/** tutti's commands, each finding the main checkout from the folder it was started in. */
export const tutti = tuttiWith(
  Effect.suspend(() => mainCheckout(process.cwd())),
  planServices,
  (flags) => runFrom(process.cwd(), flags),
)

/** Runs tutti's command line, and exits when it is done. */
export const main = (): void =>
  BunRuntime.runMain(
    Effect.flatMap(tuttiVersion, (shown) => Command.run(tutti, { version: shown })).pipe(
      // The command has said why on stderr.
      Effect.catchTag("CommandFailed", () =>
        Effect.sync(() => {
          process.exitCode = 1
        }),
      ),
      Effect.provide(BunServices.layer),
    ),
  )

if (import.meta.main) main()
