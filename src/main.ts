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
import { availableParallelism } from "node:os"
import { BunServices } from "@effect/platform-bun"
import {
  Clock,
  Console,
  Duration,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Queue,
  Result,
  Scope,
  SubscriptionRef,
} from "effect"
import { Command } from "effect/cli"
import pkg from "../package.json" with { type: "json" }
import { Account } from "./agent/Account.ts"
import { layer as agentHostLayer } from "./agent/AgentHostLive.ts"
import { Attention } from "./agent/Attention.ts"
import { ClaudeCode } from "./agent/ClaudeCode.ts"
import { BranchEnv, branchEnv, WorkerEnv, workerEnv } from "./agent/env.ts"
import { interviewWorker } from "./agent/interview.ts"
import { requiresServerFor } from "./agent/requiresTools.ts"
import { Transcripts } from "./agent/Transcripts.ts"
import { UsageLimits } from "./agent/UsageLimits.ts"
import { UsageProbe } from "./agent/UsageProbe.ts"
import { AppConfig } from "./cli/AppConfig.ts"
import {
  checkoutOf,
  mainCheckout,
  planServices,
  setUpForSpec,
  thisBuildKind,
  tuttiWith,
} from "./cli/commands.ts"
import { type RunFlags, runFlags } from "./cli/flags.ts"
import { tuttiVersion } from "./cli/version.ts"
import { chosenLayer as languageModelLayer } from "./organs/AnthropicProvider.ts"
import { OrganCost } from "./organs/OrganCost.ts"
import { Organs } from "./organs/Organs.ts"
import { guardOutput, makePrinter, type Out, stdout } from "./print/organLine.ts"
import { Battery, type BatteryReading, batteryNote, liveBattery } from "./run/battery.ts"
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
import { type GettingReady, gettingReady, readySteps } from "./run/gettingReady.ts"
import { exitCodes } from "./run/holds.ts"
import { type InterviewScreen, interview, interviewEnding } from "./run/interview.ts"
import { type KeepAwakePlan, keepAwake, keepAwakePlan, lidNote } from "./run/keepAwake.ts"
import { Load, liveLoad } from "./run/load.ts"
import { runStarted } from "./run/localTime.ts"
import { detail, type Line, Log, type Sink } from "./run/log.ts"
import { otherRuns, otherWorkers } from "./run/machine.ts"
import {
  check as checkNothing,
  endWith,
  heldAtStart,
  type Options as NothingOptions,
  type Output,
  themeStyles,
} from "./run/nothing.ts"
import { notifying } from "./run/notices.ts"
import { type Ask, preflight, refusal } from "./run/overnight.ts"
import {
  openQuestions,
  type Put,
  putQuestions,
  stoppedAtQuestions,
} from "./run/overnightQuestions.ts"
import { freeDisk, listNamed } from "./run/processes.ts"
import {
  breakdownFailed,
  catchSignals,
  listen,
  logSuspends,
  type QuitRequest,
  quitBy,
  runMain,
} from "./run/quit.ts"
import { finish, run } from "./run/run.ts"
import { liveSleepCauses, SleepCauses } from "./run/sleepCause.ts"
import { followRest, type SpecOutcome, specRun } from "./run/specRun.ts"
import { specSetup } from "./run/specSetup.ts"
import { endRecord, Spending } from "./run/spending.ts"
import { check, live, type Started, StartupFailed, startBlock } from "./run/startup.ts"
import { layer as trashLayer } from "./run/trash.ts"
import { stillUnmerged } from "./run/unmerged.ts"
import { organHold } from "./run/usageLimit.ts"
import { Beads, beadsWhy, type TicketId } from "./services/Beads.ts"
import { Checks } from "./services/Checks.ts"
import { Git, GitWriter } from "./services/Git.ts"
import { layer as notifierLayer } from "./services/Notifier.ts"
import { whichOnPath } from "./services/onPath.ts"
import { type Holder, RunLock } from "./services/RunLock.ts"
import { Store } from "./services/Store.ts"
import {
  outputMode,
  plainReasonLine,
  Tty,
  type TtyValue,
  layer as ttyLayer,
} from "./services/Tty.ts"
import { wakeLayer } from "./services/Wake.ts"
import { Worktrees } from "./services/Worktrees.ts"
import { dashboard, interviewScreen } from "./ui/App.tsx"
import { liveClipboard } from "./ui/clipboard.ts"
import { askOpenQuestion } from "./ui/OpenQuestion.tsx"
import { liveUrlOpener } from "./ui/openUrl.ts"
import { askPlan } from "./ui/PlanConfirmation.tsx"
import { confirm, openQuestion, planConfirmation, streamInput } from "./ui/plain/forms.ts"
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
  const attention = Attention.layer(
    config.autoAnswer === null
      ? {}
      : {
          autoAnswer: {
            after: config.autoAnswer,
            answers: (ticket) => ticket !== interviewWorker,
          },
        },
  )
  return Layer.mergeAll(host, organs).pipe(
    Layer.provideMerge(attention),
    // Merged worktrees' folders, deleted in the background (trash.ts).
    Layer.provideMerge(trashLayer),
    Layer.provideMerge(notifying),
    Layer.provideMerge(second),
    Layer.provideMerge(first),
    // The machine's sleeps, which every time limit of the run leaves out (src/services/Wake.ts).
    Layer.provideMerge(wakeLayer),
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

/**
 * Says `message` on stderr, once the getting-ready line `ready` has gone, and gives the exit code
 * of a run that can't start.
 */
export const cannotStart = (ready: GettingReady) => (message: string) =>
  ready.end.pipe(Effect.andThen(Console.error(message)), Effect.as(exitCodes.setup))

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

/**
 * The services --overnight's pre-flight runs on, for the run `started` describes: bd, the log, the
 * worktrees and the checks for the merge check on the base, and the usage probe, billed as workers
 * are, each built for the pre-flight alone, before the run's own.
 */
const preflightLayers = (started: Started) => {
  const { config } = started
  const repo = config.repo
  const env = { subscription: started.account.subscription, billing: config.billing }
  const first = Layer.mergeAll(
    Layer.succeed(AppConfig, config),
    gitLayer,
    Log.layer({ repo }),
    Layer.succeed(BranchEnv, branchEnv(env)),
    Layer.succeed(WorkerEnv, workerEnv(env)),
  )
  return Layer.mergeAll(
    Beads.layer({ cwd: repo }),
    Worktrees.layer({ repo, root: config.worktrees, base: started.base }),
    Checks.layer,
    UsageProbe.layer.pipe(Layer.provide(ClaudeCode.layer), Layer.provideMerge(OrganCost.layer)),
  ).pipe(Layer.provideMerge(first), Layer.provideMerge(BunServices.layer))
}

/**
 * --overnight's pre-flight of the run `started` (src/run/overnight.ts): the run as its fixes left
 * it, or the exit code of a run that doesn't start, said on stderr. In a terminal (stdin and stdout
 * both, without --plain) it asks its questions as lines, below the checklist, before any renderer
 * takes the screen; without one it prints the checklist plain and asks nothing.
 */
const overnight = (
  started: Started,
  options: {
    readonly terminal: TtyValue
    readonly ready: GettingReady
    readonly awake: KeepAwakePlan
    readonly battery: BatteryReading | null | undefined
  },
): Effect.Effect<
  | { readonly _tag: "Cleared"; readonly started: Started }
  | { readonly _tag: "Exit"; readonly code: number }
> =>
  Effect.gen(function* () {
    const { config } = started
    const { terminal, ready } = options
    const asks = terminal.stdinIsTty && terminal.stdoutIsTty && !config.plain
    const depth = terminal.colourDepth === "truecolor" ? "truecolor" : "256"
    const themeOf = (appearance: Appearance, styled: boolean) =>
      makeTheme(config.scheme.scheme, { appearance, depth, noColor: config.noColor, styled })
    const theme = asks
      ? yield* printedTheme(themeOf, config.appearance, { dumb: terminal.dumb, tty: stdout.tty })
      : themeOf(appearanceOf(config.appearance, null), false)
    const printer = makePrinter(stdout, theme)
    // The checklist follows the getting-ready line, gone first: one line drawn at a time.
    yield* ready.end
    const write = (text: string) => process.stdout.write(text)
    const ask: Ask = (question, initial) =>
      Effect.scoped(
        Effect.flatMap(streamInput(process.stdin), (input) =>
          confirm({ input, write, theme }, { question, initial }),
        ),
      )
    const ran = yield* Effect.result(
      preflight({
        started,
        night: {
          platform: process.platform,
          cores: availableParallelism(),
          awake: options.awake,
          battery: options.battery,
          kernel: liveLoad().kernel,
          processes: listNamed,
          disk: freeDisk,
          otherRuns: otherRuns(config.runs),
          // As the startup checks probe the login, under the configuration a fix leaves.
          probeAccount: (fixed) =>
            Effect.scoped(
              Layer.build(Layer.provide(Account.layer, Layer.succeed(AppConfig, fixed))).pipe(
                Effect.flatMap((built) =>
                  Effect.provideContext(
                    Effect.flatMap(Account, (account) => account.probe),
                    built,
                  ),
                ),
              ),
            ).pipe(Effect.mapError((error) => error.message)),
        },
        say: { ...printer, theme },
        ask: asks ? Option.some(ask) : Option.none(),
        puts: terminal.stdinIsTty && terminal.stdoutIsTty,
        force: config.forceOvernight,
      }).pipe(Effect.provide(preflightLayers(started))),
    )
    if (Result.isFailure(ran)) {
      yield* Console.error(`tutti --overnight cannot run its pre-flight: ${String(ran.failure)}`)
      return { _tag: "Exit", code: exitCodes.setup } as const
    }
    const cleared = ran.success
    switch (cleared._tag) {
      case "Cleared":
        return { _tag: "Cleared", started: cleared.started } as const
      case "Cancelled":
        return { _tag: "Exit", code: yield* cancelled } as const
      case "Refused":
        yield* Console.error(refusal(cleared.failed))
        return { _tag: "Exit", code: exitCodes.setup } as const
    }
  })

/**
 * A spec run's setup (src/run/specSetup.ts), from the flags and their variables: the files it wrote,
 * or an earlier one left, for the run to commit with the spec; null when it failed, having said why.
 * `before` ends the line saying what tutti is doing.
 */
const setUpForSpecRun = (cwd: string, flags: RunFlags, before: Effect.Effect<void>) => {
  const variable = (name: string) => {
    const value = process.env[name]
    return value === undefined || value === "" ? Option.none<string>() : Option.some(value)
  }
  const given = (key: "spec" | "prompt" | "concurrent") =>
    Option.orElse(flags[key], () => variable(runFlags[key].variable))
  const concurrent = Option.getOrNull(
    Option.flatMap(given("concurrent"), (text) =>
      Result.getSuccess(runFlags.concurrent.read(text)),
    ),
  )
  return specSetup({
    cwd,
    spec: Option.match(given("spec"), {
      onNone: () => null,
      onSome: (text) => ({
        given: text.trim(),
        from: Option.isSome(flags.spec) ? "--spec" : runFlags.spec.variable,
      }),
    }),
    ownPrompt: Option.isSome(given("prompt")),
    setUp: setUpForSpec(cwd, concurrent),
    say: (text) => Effect.andThen(before, Console.log(text)),
  })
}

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
    // What the environment says of the terminal; then the line saying what tutti is doing until
    // the first thing it draws (src/run/gettingReady.ts), gone with the run's scope at the latest.
    const terminal = yield* Effect.provide(
      Effect.gen(function* () {
        return yield* Tty
      }),
      ttyLayer,
    )
    const ready = yield* gettingReady(stdout, terminal)
    yield* Effect.addFinalizer(() => ready.end)
    const cannot = cannotStart(ready)
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
    // A spec run in a repository init hasn't set up sets it up first, as init does without a
    // terminal (§ 4.14): what that wrote is committed with the spec.
    const setup = yield* setUpForSpecRun(cwd, flags, ready.end).pipe(Effect.provide(gitLayer))
    if (setup === null) return exitCodes.setup
    const checked = yield* Effect.result(
      check(live(cwd, flags, ready.unpacking, setup)).pipe(Effect.provide(gitLayer)),
    )
    if (Result.isFailure(checked)) {
      const failed = checked.failure
      return yield* cannot(failed instanceof StartupFailed ? failed.message : String(failed))
    }
    yield* ready.step(readySteps.starting)
    // --keep-awake (src/run/keepAwake.ts): the command started as the run begins, or the warning
    // the START block gives where there is none.
    const awake = keepAwakePlan({
      on: checked.success.config.keepAwake,
      platform: process.platform,
      pid: process.pid,
      which: whichOnPath,
    })
    // A run that starts on battery says so in its START block (src/run/battery.ts); one kept
    // awake on a machine with a battery, a laptop, that a closed lid still sleeps it.
    const battery = yield* liveBattery().read
    const onBattery = batteryNote(battery)
    const lid =
      awake._tag === "Command" && battery !== null && battery !== undefined
        ? lidNote(process.platform)
        : null
    const notes = [
      ...(awake._tag === "Missing" ? [awake.warning] : []),
      ...(lid === null ? [] : [lid]),
      ...(onBattery === null ? [] : [onBattery]),
    ]
    let started: Started =
      notes.length > 0
        ? { ...checked.success, warnings: [...checked.success.warnings, ...notes] }
        : checked.success
    // `config` as --overnight's pre-flight leaves it, below.
    let config = started.config
    const { base } = started
    // Whether workers bill the subscription login: the summary's dollars are estimates then.
    const subscription = started.account.billing._tag === "Subscription"
    const at = runStarted(yield* Clock.currentTimeMillis)

    // The run lock, held until the runtime below has been disposed of.
    const commonDir = yield* Effect.result(
      Effect.flatMap(Git, (git) => git.commonDir(config.repo)).pipe(Effect.provide(gitLayer)),
    )
    if (Result.isFailure(commonDir)) {
      return yield* cannot(`tutti cannot find the git folder of ${config.repo}`)
    }
    const holder: Holder = {
      pid: process.pid,
      started: at,
      version,
      branch: base,
      ...(config.ticket === null ? {} : { scope: config.ticket }),
      ...(config.feature === null ? {} : { feature: config.feature }),
      ...(started.spec == null ? {} : { spec: started.spec.path }),
    }
    const locked = yield* Effect.result(
      Effect.flatMap(RunLock, (lock) =>
        lock.acquire({ repo: config.repo, commonDir: commonDir.success, holder }),
      ).pipe(Effect.provide(RunLock.layer)),
    )
    if (Result.isFailure(locked)) return yield* cannot(locked.failure.message)
    const lock = locked.success

    // --overnight's pre-flight (src/run/overnight.ts), with the lock held and before the run's
    // services are made, so that its fixes reach those that read AppConfig as they are built.
    if (config.overnight) {
      const cleared = yield* overnight(started, { terminal, ready, awake, battery })
      if (cleared._tag === "Exit") return cleared.code
      started = cleared.started
      config = started.config
    }

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
      return yield* cannot(`tutti cannot start its run: ${String(services.failure)}`)
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

      // The run's scope: --ticket's, the epic --feature filed, or a spec's root epic.
      let scope = config.ticket
      const spec = started.spec ?? null
      yield* ready.step(readySteps.backlog)
      // bd failing to list the tickets left unmerged is something to run: the run lists them again,
      // and stops on it. Only the nothing check needs them: read once, as the start question opens
      // or when the check first asks.
      const unmergedNow = yield* Effect.cached(
        Effect.result(stillUnmerged({ repo: config.repo, base })),
      )
      const beads = yield* Beads
      const carried = yield* carriedTickets
      const filter = { excludeTypes: config.settings.queue.exclude_types }
      const nothingOptions = (left: ReadonlySet<TicketId>): NothingOptions => {
        // A blocker closed by hand while its branch has commits the base lacks holds, as in the run.
        const branches = startBranches({ repo: config.repo, base })
        return {
          scope,
          filter,
          repo: config.repo,
          base,
          carried,
          unmerged: left,
          branches,
          held: heldAtStart(beads, left, branches),
        }
      }
      /** Nothing to run, to report once the renderer has gone; null when there is something. */
      const nothingYet = Effect.gen(function* () {
        yield* ready.step(readySteps.backlog)
        const unmerged = yield* unmergedNow
        const nothing = Result.isSuccess(unmerged)
          ? yield* Effect.result(checkNothing(nothingOptions(unmerged.success)))
          : Result.succeed(null)
        yield* ready.step(readySteps.starting)
        return Result.isSuccess(nothing) && nothing.success !== null
          ? ({ _tag: "Nothing", nothing: nothing.success } as const)
          : null
      })
      /** Whether there is nothing to run, which it then reports on the main screen. */
      const nothingReported = Effect.gen(function* () {
        const nothing = yield* nothingYet
        if (nothing === null) return false
        yield* ready.end
        yield* endWith(nothing.nothing, output)
        return true
      })
      const count =
        asks === "no"
          ? TicketCount.Unknown()
          : yield* ticketCount(
              { scope, filter },
              Effect.map(unmergedNow, (unmerged) =>
                nothingOptions(Result.isSuccess(unmerged) ? unmerged.success : new Set()),
              ),
            )
      // The question opens: the tickets left unmerged are read while it is asked.
      if (asks !== "no") yield* Effect.forkChild(unmergedNow)
      yield* ready.step(readySteps.starting)

      // Whether the keep-awake command holds the machine awake, for the title line's badge.
      const keepingAwake = yield* SubscriptionRef.make(false)
      const awakeOption =
        awake._tag === "Command" ? { keepingAwake: SubscriptionRef.changes(keepingAwake) } : {}
      /**
       * The run begins on `work`: the machine kept awake until the run's scope closes, the feature
       * chosen named in the lock, and the start event.
       */
      const begin = (work: Work) =>
        Effect.gen(function* () {
          if (awake._tag === "Command") {
            // Its line goes to the log, which plain output prints.
            if (mode._tag === "Plain") yield* ready.end
            yield* keepAwake(awake.command, config.repo, keepingAwake).pipe(Scope.provide(runScope))
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
            ...(scope === null ? {} : { scope }),
            ...(feature === null ? {} : { feature }),
            ...(spec === null ? {} : { spec: spec.path }),
            concurrency: config.settings.concurrent,
            billing: config.billing,
            permission_mode: started.account.permissionMode.inEffect,
            ...(config.autoAnswer === null
              ? {}
              : { auto_answer: Duration.toMillis(config.autoAnswer) }),
            ...(config.overnight ? { overnight: true as const } : {}),
          })
        })
      /** A new feature chosen at the start question asked as lines: the interview needs the renderer. */
      const noInterview = Effect.gen(function* () {
        yield* ready.end
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
          // Its own organ lines follow the getting-ready line: one spinner at a time.
          yield* ready.end
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
      // --spec (src/run/specRun.ts): the spec committed and broken down where it needs to be, then
      // the run scoped to its root epic, which the lock then names. What it says goes to `out` and
      // `error`; a refinement is shown with `refine`. The exit code when it stopped the run.
      // A breakdown going on as the run starts on its environment ticket, and its exit code where
      // it stopped the run.
      const early: {
        breakdown: Extract<SpecOutcome, { readonly _tag: "Early" }> | null
        code: number | null
      } = { breakdown: null, code: null }
      const startSpec = (io: {
        readonly out: Out
        readonly error: (text: string) => Effect.Effect<void>
        readonly refine: Option.Option<InterviewScreen>
      }) =>
        Effect.gen(function* () {
          if (spec === null) return undefined
          yield* ready.end
          const theme = yield* printedThemeOf(io.out)
          const outcome = yield* specRun(
            {
              spec,
              repo: config.repo,
              setup,
              refine: config.refine,
              timeLimit: config.settings.spec.timeout,
              effort: config.settings.spec.effort,
              earlyIn: runScope,
            },
            { printer: makePrinter(io.out, theme), error: io.error, refine: io.refine },
          )
          if (outcome._tag === "Stopped") {
            yield* Effect.flatMap(endRecord(outcome.exitCode), events.emit)
            return outcome.exitCode
          }
          if (outcome._tag === "Early") {
            early.breakdown = outcome
            // The rest of the breakdown, as the run goes on its environment ticket: one that fails,
            // or is stopped, stops the run, whose exit code is then the breakdown's.
            yield* followRest(outcome.rest, (code) =>
              Effect.andThen(
                Effect.sync(() => {
                  early.code = code
                }),
                Queue.offer(quits, breakdownFailed),
              ),
            ).pipe(Effect.forkIn(runScope))
          }
          scope = outcome.root
          // The lock is held all the same if its holder can't be rewritten.
          yield* Effect.ignore(lock.rewrite({ ...holder, scope: outcome.root }))
          return undefined
        })
      const canAsk = tty.stdinIsTty && tty.stdoutIsTty
      const error = (text: string) => Console.error(text)
      const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        scope === null ? effect : scopedTo(scope, spec?.path ?? null)(effect)

      // While the run goes, SIGINT, SIGTERM and SIGHUP quit it (§ 4.8).
      const quits = yield* Queue.unbounded<QuitRequest>()
      const listening = <A, E, R>(running: Effect.Effect<A, E, R>) =>
        Effect.scoped(
          Effect.andThen(
            listen((signal) => Queue.offerUnsafe(quits, quitBy(signal))),
            running,
          ),
        )
      // --overnight's open questions in the run's scope, put to you before the first ticket
      // (src/run/overnightQuestions.ts): in the renderer below with a dashboard, as lines in plain
      // output, and listed, nothing asked, without a terminal. bd failing to list them leaves them
      // to you, saying so.
      const questions = config.overnight
        ? yield* openQuestions(scope).pipe(
            Effect.catch((failure) =>
              Effect.as(
                Effect.andThen(
                  ready.end,
                  Console.error(
                    `tutti --overnight couldn't read the open questions to put to you first: ${beadsWhy(failure)}`,
                  ),
                ),
                [],
              ),
            ),
          )
        : []
      const putInRenderer = questions.length > 0 && canAsk && mode._tag === "Dashboard"
      /** The questions put as lines in a terminal, or listed without one, on the main screen. */
      const putOnMainScreen = Effect.gen(function* () {
        if (questions.length === 0) return null
        yield* ready.end
        const theme = mainTheme ?? (yield* printedThemeOf(stdout))
        const write = (text: string) => process.stdout.write(text)
        const put: Put = (question, at) =>
          Effect.scoped(
            Effect.flatMap(streamInput(process.stdin), (input) =>
              openQuestion({ input, write, theme }, question, at),
            ),
          )
        const putting = yield* putQuestions({
          questions,
          put: canAsk ? Option.some(put) : Option.none(),
          say: { ...makePrinter(stdout, theme), theme },
        })
        return putting._tag === "Cancelled" ? yield* stoppedAtQuestions(putting.answered) : null
      })
      const why = mode._tag === "Plain" ? plainReasonLine(mode.reason, tty.term) : undefined
      const start = () => [
        ...startBlock({ ...started, config: { ...config, ticket: scope } }, version),
        ...(why === undefined ? [] : [detail`${why}`]),
      ]

      if (mode._tag === "Plain") {
        const stoppedAt = yield* putOnMainScreen
        if (stoppedAt !== null) return stoppedAt
        // A refinement needs the renderer, which plain output doesn't open.
        const specStopped = yield* startSpec({ out: stdout, error, refine: Option.none() })
        if (specStopped !== undefined) return specStopped
        const work = yield* askThenBegin(
          asks === "lines" && mainTheme !== undefined
            ? Effect.andThen(
                ready.end,
                askLines(process.stdin, (text) => process.stdout.write(text), mainTheme, count),
              )
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
        yield* ready.end
        const ran = yield* listening(
          scoped(
            run({
              version,
              base,
              subscription,
              start: start(),
              drains,
              quits,
              ...awakeOption,
              ...(early.breakdown === null ? {} : { filing: early.breakdown.filing }),
              exitNow: exitNow(),
              endLater: true,
            }),
          ),
        )
        // A breakdown the run's end cut short stops with it.
        if (early.breakdown !== null) yield* early.breakdown.stop
        // The report's theme, made only when the report prints: off the main screen's theme, it
        // asks the terminal for its background.
        const theme = mainTheme === undefined ? printedThemeOf(stdout) : Effect.succeed(mainTheme)
        const code = yield* finish(ran, Effect.flatMap(theme, reportOut), false)
        return early.code ?? code
      }
      if (!putInRenderer) {
        const stoppedAt = yield* putOnMainScreen
        if (stoppedAt !== null) return stoppedAt
      }
      // The questions put in the renderer come first, and a spec's breakdown: the run begins below,
      // once they are.
      if (asks === "no" && !putInRenderer && spec === null) {
        yield* begin(Work.Tickets())
        if (config.feature === null && (yield* nothingReported)) return exitCodes.ok
      }
      // The renderer, from the start question or --feature's plan confirmation through the
      // dashboard, destroyed once the run's scope and then its own have closed. What follows it goes
      // to the main screen, after what --feature said while it was open.
      const shown = yield* Effect.scoped(
        Effect.gen(function* () {
          const opened = yield* Effect.scope
          // The getting-ready line gone before the renderer takes the screen.
          const open = openRenderer({ chosen: config.appearance, mouse: config.mouse }).pipe(
            Scope.provide(opened),
          )
          const screen = inRenderer({
            out: stdout,
            error,
            open: ready.end.pipe(Effect.andThen(open)),
            ask: (shell, plan, question) => askPlan(shell, themeOf, plan, question),
          })
          // Added before the renderer opens, so it runs once the renderer has closed.
          yield* Effect.addFinalizer(() => screen.release)
          const refining = spec !== null && config.refine
          if (spec !== null && !refining) {
            // A headless breakdown on the main screen, its spinner there, before the dashboard
            // opens; what it says once that is open is held for after it.
            const specStopped = yield* startSpec({
              out: screen.out,
              error: screen.error,
              refine: Option.none(),
            })
            if (specStopped !== undefined) {
              return { _tag: "Stopped", exitCode: specStopped } as const
            }
            yield* begin(Work.Tickets())
            const nothing = yield* nothingYet
            if (nothing !== null) return nothing
          }
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
          const clipboard = yield* liveClipboard(shell.renderer, tty.overSsh)
          const desktop = { clipboard, urlOpener: yield* liveUrlOpener(clipboard, tty.overSsh) }
          if (refining) {
            // The refinement in the Interview view, in this renderer; then the run.
            const specStopped = yield* startSpec({
              out: screen.out,
              error: screen.error,
              refine: Option.some(interviewScreen(shell, themeOf, desktop)),
            })
            if (specStopped !== undefined) {
              return { _tag: "Stopped", exitCode: specStopped } as const
            }
            yield* begin(Work.Tickets())
            const nothing = yield* nothingYet
            if (nothing !== null) return nothing
          }
          if (putInRenderer) {
            // What it says is held for the main screen until the renderer is gone, in its theme now.
            const theme = themeOf(shell.appearance.get())
            const putting = yield* putQuestions({
              questions,
              put: Option.some((question, at) => askOpenQuestion(shell, themeOf, question, at)),
              say: { ...makePrinter(screen.out, theme), theme },
            })
            if (putting._tag === "Cancelled") {
              return { _tag: "AtQuestions", answered: putting.answered } as const
            }
            yield* begin(Work.Tickets())
            const nothing = yield* nothingYet
            if (nothing !== null) return nothing
          }
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
                subscription,
                start: start(),
                drains,
                quits,
                ...awakeOption,
                ...(early.breakdown === null ? {} : { filing: early.breakdown.filing }),
                exitNow: exitNow(destroy),
                dashboard: dashboard(shell, themeOf, desktop),
                endLater: true,
              }),
            ),
          )
          // A breakdown the run's end cut short stops with it.
          if (early.breakdown !== null) yield* early.breakdown.stop
          return { _tag: "Ran", outcome: ran, appearance: shell.appearance.get() } as const
        }),
      ).pipe(Effect.result)
      if (Result.isFailure(shown)) {
        return yield* cannot(`tutti cannot open its screen: ${shown.failure.message}`)
      }
      const ended = shown.success
      switch (ended._tag) {
        case "Cancelled":
          return yield* cancelled
        case "AtQuestions":
          return yield* stoppedAtQuestions(ended.answered)
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
        case "Ran": {
          const code = yield* finish(ended.outcome, reportOut(themeOf(ended.appearance)), true)
          return early.code ?? code
        }
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
