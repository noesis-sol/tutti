#!/usr/bin/env bun
// tutti's entry point: the command line (src/cli/commands.ts), and a bare `tutti`'s run (§ 5), in
// the steps of src/cli/start/ (runFrom lists them): the startup checks (exit 2), the run lock
// (§ 9.2), the start question (src/cli/choose.ts), then the run (src/run/run.ts) on a
// ManagedRuntime of the live layers, which is disposed of, and the lock released, once the run's
// scope has closed. When Tty says the terminal can draw the dashboard, the run asks the start
// question and shows the dashboard in the command's one OpenTUI renderer (src/ui/renderer.ts), the
// log goes to its file alone, and once the renderer is gone the run's summary, closing and scope
// lines are printed in the theme of the renderer's appearance, then the report with its organ
// lines, then the end record (src/run/run.ts's finish). New feature, at the start question, and
// --feature "<request>" open the Interview view in that renderer (src/run/interview.ts); once its
// epic is filed, the run goes on, scoped to the epic, into the dashboard, with nothing asked.
// --feature without a terminal for it ends with exit 2, nothing filed. Otherwise the run is plain
// (§ 7.6): the start question as lines, log lines on stdout, with a line saying why when the
// terminal couldn't show a dashboard, the log's summary lines, then the report.
// Signals (§ 7.4, src/run/quit.ts): SIGUSR1 winds the run down, SIGUSR2 too, their handlers in place
// before the lock names tutti's PID; SIGTSTP is ignored with a log line (D18); while the run goes,
// SIGINT, SIGTERM and SIGHUP quit it (§ 4.8), the third ending tutti at once, and before and after
// it they interrupt the command. A panic outside the run's fibers is said with its stack once the
// renderer is gone, exit 4.
// A compiled build starts from its target's entry instead (src/entries/<target>.ts), which embeds
// its Claude Code and then calls `main`; the npm bundle from src/npm.ts, which detects musl first.
import { BunServices } from "@effect/platform-bun"
import { Clock, Effect, Layer, Result, Scope } from "effect"
import { Command } from "effect/cli"
import { talkHere } from "./answer/talkHere.ts"
import { asking } from "./cli/choose.ts"
import { checkoutOf, mainCheckout, planServices, tuttiWith } from "./cli/commands.ts"
import { presentDashboard } from "./cli/start/dashboard.ts"
import { exitWith } from "./cli/start/exit.ts"
import { runLayers } from "./cli/start/layers.ts"
import { lockRun } from "./cli/start/lock.ts"
import { overnight } from "./cli/start/overnight.ts"
import { presentPlain } from "./cli/start/plain.ts"
import { power } from "./cli/start/power.ts"
import { cannotStart, preflight, signalQueues } from "./cli/start/preflight.ts"
import { prepareWork } from "./cli/start/prepare.ts"
import { starting } from "./cli/start/starting.ts"
import { tuttiVersion, version } from "./cli/version.ts"
import { runStarted } from "./core/localTime.ts"
import { Log } from "./core/log.ts"
import { guardOutput } from "./print/organLine.ts"
import type { RunFlags } from "./project/flags.ts"
import { exitCodes } from "./run/holds.ts"
import { runMain } from "./run/quit.ts"
import type { Started } from "./run/startup.ts"
import { outputMode, layer as ttyLayer } from "./services/Tty.ts"

export { version }

/**
 * A bare `tutti`: the run, in the folder tutti was started in; its exit code. Its steps are
 * src/cli/start/'s, in this order, which is behaviour: what is said first when two things are
 * wrong, and what is released when a later step fails.
 *
 * 1. The signal handlers (§ 7.4), before tutti's PID is written anywhere; the terminal and its
 *    getting-ready line, gone with the scope at the latest; the newer-release check (§ 12).
 * 2. A spec run's setup (§ 4.14), then the startup checks (§ 5 item 1, exit 2), then --feature
 *    refused without a terminal for its interview (§ 4.10): prepareWork.
 * 3. The machine's power: the keep-awake plan, the battery (§ 5 item 16) and the lid, as START
 *    block notes.
 * 4. The run lock (§ 5 item 2, § 9.2), held until the services below have been disposed of, then
 *    the worktrees' root under it (§ 9.1): lockRun.
 * 5. An overnight run keeps the machine awake from before its pre-flight, then the pre-flight
 *    (§ 5 item 2, § 8.2), with the lock held and before the services are made, so its fixes reach
 *    them.
 * 6. The run's services (runLayers), on a runtime disposed of before the lock is released.
 * 7. On them, what the run starts from (starting), the mode's presentation (§ 5 items 3 and 4,
 *    § 7.1, § 7.6: presentPlain or presentDashboard), and the end on the main screen (§ 5 item 14,
 *    § 7.11 "A newer release": exitWith), whose exit code is the process's.
 */
const runFrom = (cwd: string, flags: RunFlags) =>
  Effect.gen(function* () {
    const { drains, suspends } = yield* signalQueues
    const { terminal, ready, newer } = yield* preflight
    const cannot = cannotStart(ready)
    const prepared = yield* prepareWork(cwd, flags, { ready, terminal })
    if (typeof prepared === "number") return prepared
    const { setup, fieldFetch, fetchContext } = prepared
    const machine = yield* power(prepared.started.config)
    const { awake, battery } = machine
    const checked: Started =
      machine.notes.length > 0
        ? { ...prepared.started, warnings: [...prepared.started.warnings, ...machine.notes] }
        : prepared.started
    // `config` as --overnight's pre-flight leaves it, below.
    let config = checked.config
    const { base } = checked
    // Whether workers bill the subscription login: the summary's dollars are estimates then.
    const subscription = checked.account.billing._tag === "Subscription"
    const at = runStarted(yield* Clock.currentTimeMillis)

    // The run lock, held until the runtime below has been disposed of.
    const locked = yield* lockRun(checked, at, ready)
    if (typeof locked === "number") return locked
    const { lock } = locked
    const { holder } = locked
    let { started } = locked
    config = started.config

    // The scope the run's services and the keep-awake command close with, once the report is done.
    const runScope = yield* Effect.scope
    // An overnight run keeps the machine awake from before its pre-flight, whose questions wait for
    // a maintainer who may have walked away (tutti-epza.17); the others as the run begins. Its lines
    // go to the log, opened for it in the run's scope, which plain output prints, as the run's;
    // one that can't be opened leaves it to begin.
    if (config.overnight && awake._tag === "Command") {
      const plain = outputMode(terminal, config.plain)._tag === "Plain"
      if (plain) yield* ready.end
      const logged = yield* Effect.result(
        Layer.build(Log.layer({ repo: config.repo, sink: plain ? "stdout" : "none" })).pipe(
          Scope.provide(runScope),
        ),
      )
      if (Result.isSuccess(logged)) {
        yield* machine.holdFirst(runScope).pipe(Effect.provideContext(logged.success))
      }
    }

    // --overnight's pre-flight (src/run/overnight.ts), with the lock held and before the run's
    // services are made, so that its fixes reach those that read AppConfig as they are built. A
    // question of it nobody answered leaves the open questions open, not put, nobody being there.
    let unanswered = false
    if (config.overnight) {
      const cleared = yield* overnight(started, { terminal, ready, awake, battery })
      if (cleared._tag === "Exit") return cleared.code
      started = cleared.started
      config = started.config
      unanswered = cleared.unanswered
    }

    const mode = outputMode(terminal, config.plain)
    const asks = asking(terminal, config, mode)
    const services = yield* Effect.result(
      runLayers(started, at, mode._tag === "Plain" ? "stdout" : "none"),
    )
    if (Result.isFailure(services)) {
      return yield* cannot(`tutti cannot start its run: ${String(services.failure)}`)
    }

    const code = yield* Effect.gen(function* () {
      const on = yield* starting({
        started,
        holder,
        base,
        subscription,
        setup,
        ready,
        mode,
        asks,
        lock,
        runScope,
        machine,
        unanswered,
        drains,
        suspends,
        fieldFetch,
        fetchContext,
      })
      const ended = yield* mode._tag === "Plain" ? presentPlain(on) : presentDashboard(on)
      return yield* exitWith(on, ended, newer)
    }).pipe(Effect.provideContext(services.success), Effect.provide(ttyLayer))
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
  // tutti answer --talk: the question's talk in a renderer of its own (src/answer/talkHere.ts).
  talkHere(process.cwd(), version),
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
