// How a bare `tutti`'s run (src/main.ts's runFrom) ends on the main screen, once the renderer is
// gone: what the presentation left to say, the report, the end record, then the newer-release
// notice; and the exit code.
import { Console, Effect, Option } from "effect"
import type { AppConfigValue } from "../../core/AppConfig.ts"
import { endWith } from "../../print/nothing.ts"
import { stdout } from "../../print/organLine.ts"
import { stoppedAtQuestions } from "../../run/overnightQuestions.ts"
import { finish } from "../../run/run.ts"
import { EventStream } from "../../services/EventStream.ts"
import { endRecord } from "../../services/Spending.ts"
import type { TtyValue } from "../../services/Tty.ts"
import { appearanceOf, makeTheme, outputAppearance, type Theme } from "../../ui/theme.ts"
import { newerNotice } from "../../update/update.ts"
import { cancelled } from "../choose.ts"
import { version } from "../version.ts"
import type { Presented, Starting } from "./starting.ts"

/**
 * Says that release `newer` is out (§ 7.11 "A newer release"), below the run's end: on stdout after
 * the dashboard, in `theme` (the line `notice`, its command `emphasis` bold), or with plain output
 * on stderr when that is a terminal. Not on a terminal, it says nothing.
 */
export const sayNewer = (newer: string, dashboard: boolean, theme: Effect.Effect<Theme>) =>
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
 * The run's end on the main screen, as the presentation left it, `ended`: a cancelled start
 * question or open questions said on stderr; an interview's ending said, with its end record;
 * nothing to run reported; or the run's summary and report (src/run/run.ts's finish), its exit
 * code the breakdown's where that stopped the run. Then the newer release `newer` found, if any,
 * said below. Gives the exit code.
 */
export const exitWith = (
  on: Starting,
  ended: Presented,
  newer: Effect.Effect<Option.Option<string>>,
) =>
  Effect.gen(function* () {
    const events = yield* EventStream
    const code = yield* exitCodeOf(on, ended, events)
    const found = yield* newer
    if (Option.isSome(found)) {
      yield* sayNewer(
        found.value,
        on.mode._tag === "Dashboard",
        noticeTheme(on.choice.config, on.tty),
      )
    }
    return code
  })

/** The run's exit code, what `ended` left to say said. */
const exitCodeOf = (on: Starting, ended: Presented, events: EventStream["Service"]) =>
  Effect.gen(function* () {
    switch (ended._tag) {
      case "Cancelled":
        return yield* cancelled
      case "AtQuestions":
        return yield* stoppedAtQuestions(ended.answered)
      case "Stopped":
        return ended.exitCode
      case "Interviewed": {
        if (ended.chosen.length > 0) yield* Console.log(ended.chosen.join("\n"))
        const said = ended.ending
        if (said.out.length > 0) yield* Console.log(said.out.join("\n"))
        if (said.error.length > 0) yield* Console.error(said.error.join("\n"))
        yield* Effect.flatMap(endRecord(said.exitCode), events.emit)
        return said.exitCode
      }
      case "Nothing":
        yield* on.ready.end
        return yield* endWith(ended.nothing, on.looks.output)
      case "Ran": {
        const code = yield* finish(ended.outcome, ended.report, ended.styled)
        return on.specs.exitCode(code)
      }
    }
  })

/** The newer-release notice's theme on `terminal`: a dumb one isn't asked for its background. */
const noticeTheme = (
  config: Pick<AppConfigValue, "appearance" | "scheme" | "noColor">,
  terminal: TtyValue,
) => {
  const depth = terminal.colourDepth === "truecolor" ? "truecolor" : "256"
  return Effect.map(
    terminal.dumb
      ? Effect.succeed(appearanceOf(config.appearance, null))
      : outputAppearance(config.appearance, null),
    (appearance) => makeTheme(config.scheme.scheme, { appearance, depth, noColor: config.noColor }),
  )
}
