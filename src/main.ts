#!/usr/bin/env bun
// tutti's entry point: the command line (src/cli/commands.ts), and a bare `tutti`'s run (§ 5): the
// startup checks (exit 2), the run lock (§ 9.2), the start question (src/run/choose.ts), then the
// run (src/run/run.ts) on a ManagedRuntime of the live layers, which is disposed of, and the lock
// released, once the run's scope has closed. When Tty says the terminal can draw the dashboard,
// the run asks the start question and shows the dashboard in the command's one OpenTUI renderer
// (src/ui/renderer.ts), the log goes to its file alone, and once the renderer is gone the run's
// summary, closing and scope lines are printed in the theme of the renderer's appearance, then the
// report with its organ lines, then the end record (src/run/run.ts's finish). New feature, at the start question, opens the Interview
// view in that renderer (src/run/interview.ts); once its epic is filed and you say y, the run goes
// on, scoped to the epic, into the dashboard. Otherwise the run is plain (§ 7.6): the start question as
// lines, log lines on stdout, with a line saying why when the terminal couldn't show a dashboard,
// the log's summary lines, then the report.
// Signals (§ 7.4, src/run/quit.ts): SIGUSR1 winds the run down, SIGUSR2 too, their handlers in place
// before the lock names tutti's PID; SIGTSTP is ignored with a log line (D18); while the run goes,
// SIGINT, SIGTERM and SIGHUP quit it (§ 4.8), the third ending tutti at once, and before and after
// it they interrupt the command. A panic outside the run's fibers is said with its stack once the
// renderer is gone, exit 4.
// A compiled build starts from its target's entry instead (src/entries/<target>.ts), which embeds
// its Claude Code and then calls `main`; the npm bundle from src/npm.ts, which detects musl first.
import { BunServices } from "@effect/platform-bun"
import { Clock, Console, Effect, Layer, ManagedRuntime, Option, Queue, Result, Scope } from "effect"
import { Command } from "effect/cli"
import pkg from "../package.json" with { type: "json" }
import { layer as agentHostLayer } from "./agent/AgentHostLive.ts"
import { Attention } from "./agent/Attention.ts"
import { requiresServerFor } from "./agent/requiresTools.ts"
import { Transcripts } from "./agent/Transcripts.ts"
import { UsageLimits } from "./agent/UsageLimits.ts"
import { UsageProbe } from "./agent/UsageProbe.ts"
import { AppConfig } from "./cli/AppConfig.ts"
import { checkoutOf, mainCheckout, planServices, thisBuildKind, tuttiWith } from "./cli/commands.ts"
import type { RunFlags } from "./cli/flags.ts"
import { tuttiVersion } from "./cli/version.ts"
import { chosenLayer as languageModelLayer } from "./organs/AnthropicProvider.ts"
import { OrganCost } from "./organs/OrganCost.ts"
import { Organs } from "./organs/Organs.ts"
import { guardOutput, makePrinter, type Out, stdout } from "./print/organLine.ts"
import { carriedTickets } from "./run/carry.ts"
import {
  asking,
  askLines,
  askThenBegin,
  cancelled,
  interviewUnavailable,
  ticketCount,
} from "./run/choose.ts"
import { startBranches } from "./run/closedBranches.ts"
import type { DrainRequest } from "./run/drain.ts"
import { EventStream } from "./run/eventstream.ts"
import { type FeatureIO, inRenderer, planAndFile, scopedTo } from "./run/feature.ts"
import { layer as fibersLayer } from "./run/fibers.ts"
import { exitCodes } from "./run/holds.ts"
import { interview, interviewEnding } from "./run/interview.ts"
import { keepAwake, keepAwakePlan } from "./run/keepAwake.ts"
import { Load, liveLoad } from "./run/load.ts"
import { detail, type Line, Log, type Sink } from "./run/log.ts"
import { otherWorkers } from "./run/machine.ts"
import {
  check as checkNothing,
  endIfNothing,
  endWith,
  heldAtStart,
  type Options as NothingOptions,
  type Output,
  themeStyles,
} from "./run/nothing.ts"
import { notifying } from "./run/notices.ts"
import { catchSignals, listen, logSuspends, type QuitRequest, quitBy, runMain } from "./run/quit.ts"
import { finish, run } from "./run/run.ts"
import { endRecord, Spending } from "./run/spending.ts"
import { check, live, type Started, StartupFailed, startBlock } from "./run/startup.ts"
import { stillUnmerged } from "./run/unmerged.ts"
import { organHold } from "./run/usageLimit.ts"
import { Beads } from "./services/Beads.ts"
import { Checks } from "./services/Checks.ts"
import { Git, GitWriter } from "./services/Git.ts"
import { layer as notifierLayer } from "./services/Notifier.ts"
import { type Holder, RunLock } from "./services/RunLock.ts"
import { Store } from "./services/Store.ts"
import { outputMode, plainReasonLine, Tty, layer as ttyLayer } from "./services/Tty.ts"
import { Worktrees } from "./services/Worktrees.ts"
import { dashboard, interviewScreen } from "./ui/App.tsx"
import { liveClipboard } from "./ui/clipboard.ts"
import { liveUrlOpener } from "./ui/openUrl.ts"
import { askPlan } from "./ui/PlanConfirmation.tsx"
import { planConfirmation, streamInput } from "./ui/plain/forms.ts"
import { chosenLines, TicketCount, Work } from "./ui/questions.ts"
import { closeLimit, open as openRenderer, type RendererFailed } from "./ui/renderer.ts"
import { askStart } from "./ui/StartQuestion.tsx"
import {
  type Appearance,
  appearanceOf,
  makeTheme,
  outputAppearance,
  printedTheme,
  type Theme,
} from "./ui/theme.ts"
import {
  cacheDir,
  checksForUpdates,
  githubReleases,
  newerNotice,
  startCheck,
} from "./update/update.ts"

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
    Log.layer({ repo, sink }),
    EventStream.layer({ repo, run: at }),
    Store.layer({ repo, run: { pid: process.pid, started: at, version } }),
    Transcripts.layer({ repo }),
    UsageLimits.layer,
    fibersLayer,
    // The other runs' workers, which the run reads and its workers' share of the cores counts.
    otherWorkers,
    // The machine's load, which the run reads for the dashboard's load line.
    Layer.succeed(Load, liveLoad()),
  )
  const second = Layer.mergeAll(
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
  // The organs, over the Agent SDK or, with TUTTI_ORGAN_PROVIDER=anthropic, the Messages API, their
  // costs logged, skipped while the usage limit holds, as the report asks too. The startup checks
  // reported a choice that can't be used.
  // The usage-limit hold's probe of the account (§ 4.12) is billed and its cost logged as an
  // organ call's.
  const organs = Layer.mergeAll(
    Organs.layer.pipe(
      Layer.provideMerge(Layer.orDie(languageModelLayer({ account: started.account }))),
    ),
    UsageProbe.layer({ account: started.account }),
  ).pipe(Layer.provideMerge(OrganCost.layer), Layer.provideMerge(organHold))
  // Attention's records notify too: it is given the EventStream that notifies (notices.ts).
  return Layer.mergeAll(host, organs).pipe(
    Layer.provideMerge(Attention.layer),
    Layer.provideMerge(notifying),
    Layer.provideMerge(second),
    Layer.provideMerge(first),
    Layer.provideMerge(BunServices.layer),
  )
}

/** Ends tutti at once with `code` (a third request to quit), `said` printed first if given. */
const exitNow =
  (destroy?: () => Promise<void>) =>
  (code: number, said: ReadonlyArray<Line>): Effect.Effect<void> =>
    Effect.promise(async () => {
      if (destroy !== undefined) {
        await destroy()
        stdout.write(`${said.join("\n")}\n`)
      }
      process.exit(code)
    })

/** Says `message` on stderr, and gives the exit code of a run that can't start. */
const cannotStart = (message: string) => Effect.as(Console.error(message), exitCodes.setup)

/**
 * Says that release `newer` is out (§ 7.11 "A newer release"), below the run's end: on stdout after
 * the dashboard, in `theme` (the line `notice`, its command `emphasis` bold), or with plain output
 * on stderr when that is a terminal. Not on a terminal, it says nothing.
 */
const sayNewer = (newer: string, dashboard: boolean, theme: Effect.Effect<Theme>) =>
  Effect.gen(function* () {
    const { text, command } = newerNotice(newer, version)
    if (dashboard) {
      const { styles } = yield* theme
      stdout.write(`${styles.deferred.paint(text)}${styles.key.paint(command)}\n`)
    } else if (process.stderr.isTTY) {
      process.stderr.write(`${text}${command}\n`)
    }
  })

/** A bare `tutti`: the run, in the folder tutti was started in; its exit code. */
const runFrom = (cwd: string, flags: RunFlags) =>
  Effect.gen(function* () {
    // SIGUSR1 and SIGUSR2 wind the run down, as orchestra's drain, and SIGTSTP is ignored: each
    // handler is in place before tutti's PID is written anywhere, as without one each signal kills
    // or stops tutti.
    const drains = yield* Queue.unbounded<DrainRequest>()
    const suspends = yield* Queue.unbounded<void>()
    yield* catchSignals({
      drain: (signal) => Queue.offerUnsafe(drains, { on: true, how: `by ${signal}` }),
      suspend: () => Queue.offerUnsafe(suspends, undefined),
    })
    // A release build's daily check for a newer release (§ 12), in the background (not the npm
    // package's, which tutti update leaves to the package manager); its answer, if
    // it has one by then, is said once the run has ended.
    const env = (name: string) => process.env[name]
    const newer = checksForUpdates({ kind: thisBuildKind() }, env)
      ? yield* startCheck({
          releases: githubReleases,
          current: version,
          cache: cacheDir(env),
          now: Date.now,
        })
      : Effect.succeed(Option.none<string>())
    const checked = yield* Effect.result(check(live(cwd, flags)).pipe(Effect.provide(gitLayer)))
    if (Result.isFailure(checked)) {
      const failed = checked.failure
      return yield* cannotStart(failed instanceof StartupFailed ? failed.message : String(failed))
    }
    // keep_awake (src/run/keepAwake.ts): the command started as the run begins, or the warning the
    // START block gives where there is none.
    const awake = keepAwakePlan({
      on: checked.success.config.settings.keep_awake,
      platform: process.platform,
      pid: process.pid,
      which: (command) => Bun.which(command),
    })
    const started: Started =
      awake._tag === "Missing"
        ? { ...checked.success, warnings: [...checked.success.warnings, awake.warning] }
        : checked.success
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
    // The scope the run's services and the keep-awake command close with, once the report is done.
    const runScope = yield* Effect.scope
    const services = yield* Effect.result(runtime.contextEffect)
    if (Result.isFailure(services)) {
      return yield* cannotStart(`tutti cannot start its run: ${String(services.failure)}`)
    }

    const code = yield* Effect.gen(function* () {
      const events = yield* EventStream
      const tty = yield* Tty
      yield* logSuspends(suspends)

      const depth = tty.colourDepth === "truecolor" ? "truecolor" : "256"
      const themeOf = (appearance: Appearance, styled = true) =>
        makeTheme(config.scheme.scheme, { appearance, depth, noColor: config.noColor, styled })
      /** The theme of what is printed to `out` with no renderer's appearance: unstyled off a TTY. */
      const printedThemeOf = (out: Out) =>
        printedTheme(themeOf, config.appearance, { dumb: tty.dumb, tty: out.tty })
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
      /** Where the report goes, in `theme`, on the main screen. */
      const reportOut = (theme: Theme) =>
        Effect.map(tty.size, (size) => ({
          printer: makePrinter(stdout, theme),
          theme,
          width: size.columns,
        }))
      const output: Output =
        mainTheme === undefined || mode._tag === "Plain"
          ? { _tag: "Plain" }
          : { _tag: "Box", width: (yield* tty.size).columns, styles: themeStyles(mainTheme) }

      // The run's scope: --ticket's, or the epic --feature filed.
      let scope = config.ticket
      // bd failing to list the tickets left unmerged is something to run: the run lists them again,
      // and stops on it.
      const unmerged = yield* Effect.result(stillUnmerged({ repo: config.repo, base }))
      const beads = yield* Beads
      const carried = yield* carriedTickets
      const nothingOptions = (): NothingOptions => {
        const left = Result.isSuccess(unmerged) ? unmerged.success : new Set<string>()
        // A blocker closed by hand while its branch has commits the base lacks holds, as in the run.
        const branches = startBranches({ repo: config.repo, base })
        return {
          scope,
          filter: { excludeTypes: config.settings.queue.exclude_types },
          repo: config.repo,
          base,
          carried,
          unmerged: left,
          branches,
          held: heldAtStart(beads, left, branches),
        }
      }
      /** Whether there is nothing to run, which it then reports on the main screen. */
      const nothingReported = Effect.gen(function* () {
        if (Result.isFailure(unmerged)) return false
        return (yield* endIfNothing(nothingOptions(), output)) !== null
      })
      /** Nothing to run, to report once the renderer has gone; null when there is something. */
      const nothingYet = Effect.gen(function* () {
        const nothing = Result.isSuccess(unmerged)
          ? yield* Effect.result(checkNothing(nothingOptions()))
          : Result.succeed(null)
        return Result.isSuccess(nothing) && nothing.success !== null
          ? ({ _tag: "Nothing", nothing: nothing.success } as const)
          : null
      })
      const count = asks === "no" ? TicketCount.Unknown() : yield* ticketCount(nothingOptions())

      /**
       * The run begins on `work`: the machine kept awake until the run's scope closes, the feature
       * chosen named in the lock, and the start event.
       */
      const begin = (work: Work) =>
        Effect.gen(function* () {
          if (awake._tag === "Command") {
            yield* keepAwake(awake.command, config.repo).pipe(Scope.provide(runScope))
          }
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
      /** A new feature chosen at the start question asked as lines: the interview needs the renderer. */
      const noInterview = Effect.gen(function* () {
        yield* Console.error(interviewUnavailable)
        yield* Effect.flatMap(endRecord(exitCodes.ok), events.emit)
        return exitCodes.ok
      })

      // --feature: the screen and the plan, the plan confirmed and filed, then the run scoped to
      // its epic. The organ lines go to `out` and the errors to `error`; `confirm` asks, in the
      // plan's theme. The exit code when it stopped the run.
      const planFeature = <E>(io: {
        readonly out: Out
        readonly error: FeatureIO<E>["error"]
        readonly confirm: (theme: Theme) => FeatureIO<E>["confirm"]
      }) =>
        Effect.gen(function* () {
          if (config.feature === null) return undefined
          const theme = yield* printedThemeOf(io.out)
          const featured = yield* planAndFile(
            { request: config.feature, repo: config.repo, yes: config.yes },
            {
              printer: makePrinter(io.out, theme),
              theme,
              error: io.error,
              confirm: io.confirm(theme),
            },
          )
          if (featured._tag === "Stopped") {
            yield* Effect.flatMap(endRecord(featured.exitCode), events.emit)
            return featured.exitCode
          }
          scope = featured.epic
          return undefined
        })
      const canAsk = tty.stdinIsTty && tty.stdoutIsTty
      const error = (text: string) => Console.error(text)
      const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        scope === null ? effect : scopedTo(scope)(effect)

      // While the run goes, SIGINT, SIGTERM and SIGHUP quit it (§ 4.8).
      const quits = yield* Queue.unbounded<QuitRequest>()
      const listening = <A, E, R>(running: Effect.Effect<A, E, R>) =>
        Effect.scoped(
          Effect.andThen(
            listen((signal) => Queue.offerUnsafe(quits, quitBy(signal))),
            running,
          ),
        )
      const why = mode._tag === "Plain" ? plainReasonLine(mode.reason, tty.term) : undefined
      const start = () => [
        ...startBlock({ ...started, config: { ...config, ticket: scope } }, version),
        ...(why === undefined ? [] : [detail`${why}`]),
      ]

      if (mode._tag === "Plain") {
        const work = yield* askThenBegin(
          asks === "lines" && mainTheme !== undefined
            ? askLines(process.stdin, (text) => process.stdout.write(text), mainTheme, count)
            : Effect.succeed(Work.Tickets()),
          begin,
        )
        if (work === null) return yield* cancelled
        if (work._tag === "Feature") return yield* noInterview
        // The plan confirmation, a line at a time.
        const stopped = yield* planFeature<never>({
          out: stdout,
          error,
          confirm: (theme) =>
            canAsk
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
        })
        if (stopped !== undefined) return stopped
        if (yield* nothingReported) return exitCodes.ok
        const ran = yield* listening(
          scoped(
            run({
              version,
              base,
              start: start(),
              drains,
              quits,
              exitNow: exitNow(),
              endLater: true,
            }),
          ),
        )
        // The report's theme, made only when the report prints: off the main screen's theme, it
        // asks the terminal for its background.
        const theme = mainTheme === undefined ? printedThemeOf(stdout) : Effect.succeed(mainTheme)
        return yield* finish(ran, Effect.flatMap(theme, reportOut), false)
      }
      if (asks === "no") {
        yield* begin(Work.Tickets())
        if (config.feature === null && (yield* nothingReported)) return exitCodes.ok
      }
      // The renderer, from the start question or --feature's plan confirmation through the
      // dashboard, destroyed once the run's scope and then its own have closed. What follows it goes
      // to the main screen, after what --feature said while it was open.
      const shown = yield* Effect.scoped(
        Effect.gen(function* () {
          const opened = yield* Effect.scope
          const screen = inRenderer({
            out: stdout,
            error,
            open: openRenderer({ chosen: config.appearance, mouse: config.mouse }).pipe(
              Scope.provide(opened),
            ),
            ask: (shell, plan, question) => askPlan(shell, themeOf, plan, question),
          })
          // Added before the renderer opens, so it runs once the renderer has closed.
          yield* Effect.addFinalizer(() => screen.release)
          if (config.feature !== null) {
            // The organ lines on the main screen, the confirmation in the renderer.
            const stopped = yield* planFeature<RendererFailed>({
              out: screen.out,
              error: screen.error,
              confirm: () => (canAsk ? Option.some(screen.confirm) : Option.none()),
            })
            if (stopped !== undefined) return { _tag: "Stopped", exitCode: stopped } as const
            const nothing = yield* nothingYet
            if (nothing !== null) return nothing
          }
          const shell = yield* screen.shell
          const clipboard = yield* liveClipboard(shell.renderer)
          const desktop = { clipboard, urlOpener: yield* liveUrlOpener(clipboard) }
          if (asks !== "no") {
            const work = yield* askThenBegin(askStart(shell, themeOf, count), begin)
            if (work === null) return { _tag: "Cancelled" } as const
            if (work._tag === "Feature") {
              // The interview, in this renderer; once its epic is filed and you say y, the run.
              const outcome = yield* interview(work.description, {
                screen: interviewScreen(shell, themeOf, desktop),
                confirm: (plan, question) => askPlan(shell, themeOf, plan, question),
              })
              if (outcome._tag !== "Run") {
                return { _tag: "Interviewed", work, ending: interviewEnding(outcome) } as const
              }
              scope = outcome.epic
            }
            const nothing = yield* nothingYet
            if (nothing !== null) return nothing
          }
          // Exiting at once, the renderer is destroyed first, waited for up to closeLimit.
          const destroy = () => {
            shell.renderer.destroy()
            return Promise.race([
              shell.renderer.closed.catch(() => undefined),
              Bun.sleep(closeLimit),
            ]).then(() => undefined)
          }
          const ran = yield* listening(
            scoped(
              run({
                version,
                base,
                start: start(),
                drains,
                quits,
                exitNow: exitNow(destroy),
                dashboard: dashboard(shell, themeOf, desktop),
                endLater: true,
              }),
            ),
          )
          return { _tag: "Ran", outcome: ran, appearance: shell.appearance.get() } as const
        }),
      ).pipe(Effect.result)
      if (Result.isFailure(shown)) {
        return yield* cannotStart(`tutti cannot open its screen: ${shown.failure.message}`)
      }
      const ended = shown.success
      switch (ended._tag) {
        case "Cancelled":
          return yield* cancelled
        case "Stopped":
          return ended.exitCode
        case "Interviewed": {
          yield* Console.log(chosenLines(ended.work).join("\n"))
          const said = ended.ending
          if (said.out.length > 0) yield* Console.log(said.out.join("\n"))
          if (said.error.length > 0) yield* Console.error(said.error.join("\n"))
          yield* Effect.flatMap(endRecord(said.exitCode), events.emit)
          return said.exitCode
        }
        case "Nothing":
          return yield* endWith(ended.nothing, output)
        case "Ran":
          return yield* finish(ended.outcome, reportOut(themeOf(ended.appearance)), true)
      }
    }).pipe(Effect.provideContext(services.success), Effect.provide(ttyLayer))
    const found = yield* newer
    if (Option.isSome(found)) {
      const depth = terminal.colourDepth === "truecolor" ? "truecolor" : "256"
      const theme = Effect.map(
        terminal.dumb
          ? Effect.succeed(appearanceOf(config.appearance, null))
          : outputAppearance(config.appearance, null),
        (appearance) =>
          makeTheme(config.scheme.scheme, { appearance, depth, noColor: config.noColor }),
      )
      yield* sayNewer(found.value, mode._tag === "Dashboard", theme)
    }
    return code
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

/**
 * tutti's commands, each finding the main checkout from the folder it was started in; `tutti
 * requires` works in that folder's own checkout.
 */
export const tutti = tuttiWith(
  Effect.suspend(() => mainCheckout(process.cwd())),
  planServices,
  (flags) => runFrom(process.cwd(), flags),
  Effect.suspend(() => checkoutOf(process.cwd())),
)

/**
 * Runs tutti's command line, and exits when it is done. A closed stdout or stderr doesn't end it
 * (`guardOutput`).
 */
export const main = (): void =>
  runMain(
    guardOutput.pipe(
      Effect.andThen(tuttiVersion),
      Effect.flatMap((shown) => Command.run(tutti, { version: shown })),
      // The command has said why on stderr.
      Effect.catchTag("CommandFailed", () =>
        Effect.sync(() => {
          process.exitCode = 1
        }),
      ),
      // A panic: its scopes have closed, the renderer with them, before its stack is said.
      Effect.catchDefect((defect) =>
        Effect.sync(() => {
          const said = defect instanceof Error ? (defect.stack ?? defect.message) : String(defect)
          process.stderr.write(`tutti: PANIC: ${said}\n`)
          process.exitCode = exitCodes.tool
        }),
      ),
      Effect.provide(BunServices.layer),
    ),
  )

if (import.meta.main) main()
