// --overnight's pre-flight (src/run/overnight.ts) as a bare `tutti`'s run (src/main.ts's runFrom)
// makes it: with the run lock held and before the run's services are made, so that its fixes
// reach those that read AppConfig as they are built.
import { availableParallelism } from "node:os"
import { Console, Effect, Layer, Option, Result } from "effect"
import { Account } from "../../agent/Account.ts"
import { AppConfig } from "../../core/AppConfig.ts"
import { updateTemplates } from "../../init/update.ts"
import type { GettingReady } from "../../print/gettingReady.ts"
import { makePrinter, stdout } from "../../print/organLine.ts"
import { claudeUserSettingsFile } from "../../run/askRules.ts"
import type { BatteryReading } from "../../run/battery.ts"
import { exitCodes } from "../../run/holds.ts"
import type { KeepAwakePlan } from "../../run/keepAwake.ts"
import { liveLoad } from "../../run/load.ts"
import { type Ask, preflight, refusal } from "../../run/overnight.ts"
import { freeDisk, listNamed } from "../../run/processes.ts"
import type { Started } from "../../run/startup.ts"
import { otherRuns } from "../../services/machine.ts"
import type { TtyValue } from "../../services/Tty.ts"
import { confirm, streamInput } from "../../ui/plain/forms.ts"
import { type Appearance, appearanceOf, makeTheme, printedTheme } from "../../ui/theme.ts"
import { cancelled } from "../choose.ts"
import { preflightLayers } from "./layers.ts"
import { liveLines } from "./preflight.ts"

/**
 * --overnight's pre-flight of the run `started` (src/run/overnight.ts): the run as its fixes left
 * it, or the exit code of a run that doesn't start, said on stderr. In a terminal (stdin and stdout
 * both, without --plain) it asks its questions as lines, below the checklist, before any renderer
 * takes the screen; without one it prints the checklist plain and asks nothing.
 */
export const overnight = (
  started: Started,
  options: {
    readonly terminal: TtyValue
    readonly ready: GettingReady
    readonly awake: KeepAwakePlan
    readonly battery: BatteryReading | null | undefined
  },
): Effect.Effect<
  | { readonly _tag: "Cleared"; readonly started: Started; readonly unanswered: boolean }
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
    const live = liveLines(terminal)
    const ask: Ask = (question, initial, limit) =>
      Effect.scoped(
        Effect.flatMap(streamInput(process.stdin), (input) =>
          confirm({ input, write, theme, ...live }, { question, initial, limit }),
        ),
      )
    const ran = yield* Effect.result(
      preflight({
        started,
        update: updateTemplates,
        night: {
          platform: process.platform,
          cores: availableParallelism(),
          awake: options.awake,
          battery: options.battery,
          kernel: liveLoad().kernel,
          processes: listNamed,
          disk: freeDisk,
          otherRuns: otherRuns(config.runs),
          claudeSettings: yield* claudeUserSettingsFile,
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
        return {
          _tag: "Cleared",
          started: cleared.started,
          unanswered: cleared.unanswered,
        } as const
      case "Cancelled":
        return { _tag: "Exit", code: yield* cancelled } as const
      case "Refused":
        yield* Console.error(refusal(cleared.failed))
        return { _tag: "Exit", code: exitCodes.setup } as const
    }
  })
