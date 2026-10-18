#!/usr/bin/env bun
// tutti's entry point: the command line (src/cli/commands.ts), and a bare `tutti`'s run (§ 5): the
// startup checks (exit 2), the run lock (§ 9.2), the start question (src/run/choose.ts), then the
// run (src/run/run.ts) on a ManagedRuntime of the live layers, which is disposed of, and the lock
// released, once the run's scope has closed. When Tty says the terminal can draw the dashboard,
// the run asks the start question and shows the dashboard in the command's one OpenTUI renderer
// (src/ui/renderer.ts), the log goes to its file alone, and the run's summary and closing lines
// are printed once the renderer is gone. Otherwise the run is plain (§ 7.6): the start question as
// lines, log lines on stdout, with a line saying why when the terminal couldn't show a dashboard.
// SIGUSR1 winds the run down (§ 7.4).
// A compiled build starts from its target's entry instead (src/entries/<target>.ts), which embeds
// its Claude Code and then calls `main`.
import { join } from "node:path"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Clock, Console, Effect, Layer, ManagedRuntime, Option, Queue, Result } from "effect"
import { Command } from "effect/cli"
import pkg from "../package.json" with { type: "json" }
import { layer as agentHostLayer } from "./agent/AgentHostLive.ts"
import { Attention } from "./agent/Attention.ts"
import { Transcripts } from "./agent/Transcripts.ts"
import { AppConfig } from "./cli/AppConfig.ts"
import { mainCheckout, planServices, tuttiWith } from "./cli/commands.ts"
import type { RunFlags } from "./cli/flags.ts"
import { tuttiVersion } from "./cli/version.ts"
import { layer as languageModelLayer } from "./organs/AgentSdkLanguageModel.ts"
import { OrganCost } from "./organs/OrganCost.ts"
import { Organs } from "./organs/Organs.ts"
import { makePrinter, stdout } from "./print/organLine.ts"
import {
  asking,
  askLines,
  cancelledMessage,
  interviewUnavailable,
  ticketCount,
} from "./run/choose.ts"
import { bySignal, type DrainRequest } from "./run/drain.ts"
import { EventStream } from "./run/eventstream.ts"
import { planAndFile, scopedTo } from "./run/feature.ts"
import { layer as fibersLayer } from "./run/fibers.ts"
import { exitCodes } from "./run/holds.ts"
import { detail, Log, logFile, type Sink } from "./run/log.ts"
import {
  check as checkNothing,
  type Options as NothingOptions,
  noHolds,
  nothingToRun,
  type Output,
  report as reportNothing,
  themeStyles,
} from "./run/nothing.ts"
import { run } from "./run/run.ts"
import { check, live, type Started, StartupFailed, startBlock } from "./run/startup.ts"
import { stillUnmerged } from "./run/unmerged.ts"
import { Beads } from "./services/Beads.ts"
import { Checks } from "./services/Checks.ts"
import { Git, GitWriter } from "./services/Git.ts"
import { type Holder, RunLock } from "./services/RunLock.ts"
import { Store } from "./services/Store.ts"
import { outputMode, plainReasonLine, Tty, layer as ttyLayer } from "./services/Tty.ts"
import { Worktrees } from "./services/Worktrees.ts"
import { dashboard } from "./ui/App.tsx"
import { liveClipboard } from "./ui/clipboard.ts"
import { planConfirmation, streamInput } from "./ui/plain/forms.ts"
import { chosenLines, TicketCount, Work } from "./ui/questions.ts"
import { open as openRenderer } from "./ui/renderer.ts"
import { askStart } from "./ui/StartQuestion.tsx"
import { type Appearance, appearanceOf, makeTheme, outputAppearance } from "./ui/theme.ts"

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
  // The organs, over the Agent SDK, their costs logged.
  const organs = Organs.layer.pipe(
    Layer.provideMerge(languageModelLayer({ account: started.account })),
    Layer.provideMerge(OrganCost.layer),
  )
  return Layer.mergeAll(host, organs).pipe(
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
    const holder: Holder = {
      pid: process.pid,
      started: at,
      version,
      branch: base,
      ...(config.ticket === null ? {} : { scope: config.ticket }),
      ...(config.feature === null ? {} : { feature: config.feature }),
    }
    const locked = yield* Effect.result(
      Effect.flatMap(RunLock, (lock) =>
        lock.acquire({ repo: config.repo, commonDir: commonDir.success, holder }),
      ).pipe(Effect.provide(RunLock.layer)),
    )
    if (Result.isFailure(locked)) return yield* cannotStart(locked.failure.message)
    const lock = locked.success

    const terminal = yield* Effect.provide(
      Effect.gen(function* () {
        return yield* Tty
      }),
      ttyLayer,
    )
    const mode = outputMode(terminal, config.plain)
    const asks = asking(terminal, config, mode)
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

      const depth = tty.colourDepth === "truecolor" ? "truecolor" : "256"
      const themeOf = (appearance: Appearance) =>
        makeTheme(config.scheme.scheme, { appearance, depth, noColor: config.noColor })
      // The main screen's theme: the box's, and the line form's. A dumb terminal isn't asked for
      // its background.
      const mainTheme =
        mode._tag === "Dashboard" || asks === "lines"
          ? themeOf(
              tty.dumb
                ? appearanceOf(config.appearance, null)
                : yield* outputAppearance(config.appearance, null),
            )
          : undefined
      const output: Output =
        mainTheme === undefined || mode._tag === "Plain"
          ? { _tag: "Plain" }
          : { _tag: "Box", width: (yield* tty.size).columns, styles: themeStyles(mainTheme) }

      // The run's scope: --ticket's, or the epic --feature filed.
      let scope = config.ticket
      // bd failing to list the tickets left unmerged is something to run: the run lists them again,
      // and stops on it.
      const unmerged = yield* Effect.result(stillUnmerged({ repo: config.repo, base }))
      const nothingOptions = (): NothingOptions => ({
        scope,
        filter: { excludeTypes: config.settings.queue.exclude_types },
        repo: config.repo,
        base,
        carried: new Set(),
        unmerged: Result.isSuccess(unmerged) ? unmerged.success : new Set(),
        held: noHolds,
      })
      /** Whether there is nothing to run, which it then reports on the main screen. */
      const nothingReported = Effect.gen(function* () {
        if (Result.isFailure(unmerged) || !(yield* nothingToRun(nothingOptions(), output))) {
          return false
        }
        yield* events.emit({ kind: "end", code: exitCodes.ok })
        return true
      })
      const count = asks === "no" ? TicketCount.Unknown() : yield* ticketCount(nothingOptions())

      /** The run begins on `work`: the feature chosen named in the lock, and the start event. */
      const begin = (work: Work) =>
        Effect.gen(function* () {
          const feature = work._tag === "Feature" ? work.description : config.feature
          // The lock is held all the same if its holder can't be rewritten.
          if (work._tag === "Feature") {
            yield* Effect.ignore(lock.rewrite({ ...holder, feature: work.description }))
          }
          yield* events.emit({
            kind: "start",
            version,
            repo: config.repo,
            branch: base,
            ...(config.ticket === null ? {} : { scope: config.ticket }),
            ...(feature === null ? {} : { feature }),
            concurrency: config.settings.concurrent,
            billing: config.billing,
            permission_mode: started.account.permissionMode.inEffect,
          })
        })
      const cancelled = Effect.as(Console.error(cancelledMessage), exitCodes.interrupted)
      /** The new feature's interview (tutti-nrg.9.8 builds it); for now the run ends there. */
      const interview = Effect.gen(function* () {
        yield* Console.error(interviewUnavailable)
        yield* events.emit({ kind: "end", code: exitCodes.ok })
        return exitCodes.ok
      })

      // --feature: the screen and the plan, the plan confirmed and filed, then the run scoped to
      // its epic. The confirmation asks a line at a time, before the renderer opens. The exit code
      // when it stopped the run.
      const planFeature = Effect.gen(function* () {
        if (config.feature === null) return undefined
        const theme = themeOf(yield* outputAppearance(config.appearance, null))
        const featured = yield* planAndFile(
          { request: config.feature, repo: config.repo, yes: config.yes },
          {
            printer: makePrinter(stdout, theme),
            theme,
            error: (text) => Console.error(text),
            confirm:
              tty.stdinIsTty && tty.stdoutIsTty
                ? Option.some((plan, question) =>
                    Effect.scoped(
                      Effect.flatMap(streamInput(process.stdin), (input) =>
                        planConfirmation(
                          { input, write: (text) => process.stdout.write(text), theme },
                          plan,
                          question,
                        ),
                      ),
                    ),
                  )
                : Option.none(),
          },
        )
        if (featured._tag === "Stopped") {
          yield* events.emit({ kind: "end", code: featured.exitCode })
          return featured.exitCode
        }
        scope = featured.epic
        return undefined
      })
      const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        scope === null ? effect : scopedTo(scope)(effect)

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
      const start = () => [
        ...startBlock({ ...started, config: { ...config, ticket: scope } }, version),
        ...(why === undefined ? [] : [detail`${why}`]),
      ]

      if (mode._tag === "Plain") {
        const asked =
          asks === "lines" && mainTheme !== undefined
            ? yield* Effect.result(
                askLines(process.stdin, (text) => process.stdout.write(text), mainTheme, count),
              )
            : Result.succeed(Work.Tickets())
        if (Result.isFailure(asked)) return yield* cancelled
        yield* begin(asked.success)
        if (asked.success._tag === "Feature") return yield* interview
        const stopped = yield* planFeature
        if (stopped !== undefined) return stopped
        if (yield* nothingReported) return exitCodes.ok
        return (yield* Effect.scoped(scoped(run({ version, base, start: start(), drains }))))
          .exitCode
      }
      if (asks === "no") {
        yield* begin(Work.Tickets())
        const stopped = yield* planFeature
        if (stopped !== undefined) return stopped
        if (yield* nothingReported) return exitCodes.ok
      }
      // The renderer, from the start question through the dashboard, destroyed once the run's
      // scope and then its own have closed. What follows it goes to the main screen.
      const shown = yield* Effect.scoped(
        Effect.gen(function* () {
          const shell = yield* openRenderer({ chosen: config.appearance, mouse: config.mouse })
          if (asks !== "no") {
            const asked = yield* Effect.result(askStart(shell, themeOf, count))
            if (Result.isFailure(asked)) return { _tag: "Cancelled" } as const
            const work = asked.success
            yield* begin(work)
            if (work._tag === "Feature") return { _tag: "Feature", work } as const
            const nothing = Result.isSuccess(unmerged)
              ? yield* Effect.result(checkNothing(nothingOptions()))
              : Result.succeed(null)
            if (Result.isSuccess(nothing) && nothing.success !== null) {
              return { _tag: "Nothing", nothing: nothing.success } as const
            }
          }
          const clipboard = yield* liveClipboard(shell.renderer)
          const ran = yield* Effect.scoped(
            scoped(
              run({
                version,
                base,
                start: start(),
                drains,
                dashboard: dashboard(shell, themeOf, clipboard),
              }),
            ),
          )
          return { _tag: "Ran", ...ran } as const
        }),
      ).pipe(Effect.result)
      if (Result.isFailure(shown)) {
        return yield* cannotStart(`tutti cannot open its screen: ${shown.failure.message}`)
      }
      const ended = shown.success
      switch (ended._tag) {
        case "Cancelled":
          return yield* cancelled
        case "Feature":
          yield* Console.log(chosenLines(ended.work).join("\n"))
          return yield* interview
        case "Nothing":
          yield* reportNothing(ended.nothing, output)
          yield* events.emit({ kind: "end", code: exitCodes.ok })
          return exitCodes.ok
        case "Ran":
          yield* Console.log(ended.ending.join("\n"))
          return ended.exitCode
      }
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
