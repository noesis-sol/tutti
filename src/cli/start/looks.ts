// How a bare `tutti`'s run (src/main.ts's runFrom) looks on the main screen: its themes, where its
// report goes, and the shape of the nothing-to-run message.
import { Effect } from "effect"
import type { AppConfigValue } from "../../core/AppConfig.ts"
import { type Output, themeStyles } from "../../print/nothing.ts"
import { makePrinter, type Out, stdout } from "../../print/organLine.ts"
import type { ReportOut } from "../../run/report.ts"
import type { OutputMode, TtyValue } from "../../services/Tty.ts"
import {
  type Appearance,
  appearanceOf,
  makeTheme,
  outputAppearance,
  printedTheme,
  type Theme,
} from "../../ui/theme.ts"
import type { Asking } from "../choose.ts"

/** The run's looks on the main screen. */
export interface Looks {
  /** The theme of `appearance`, in the terminal's colour depth; unstyled when not `styled`. */
  readonly themeOf: (appearance: Appearance, styled?: boolean) => Theme
  /** The theme of what is printed to `out` with no renderer's appearance: unstyled off a TTY. */
  readonly printedThemeOf: (out: Out) => Effect.Effect<Theme>
  /**
   * The main screen's theme: the box's, and the line form's; none where neither is drawn. A dumb
   * terminal isn't asked for its background.
   */
  readonly mainTheme: Theme | undefined
  /** Where the report goes, in `theme`, on the main screen. */
  readonly reportOut: (theme: Theme) => Effect.Effect<ReportOut>
  /** The shape of the nothing-to-run message: the box in the main theme, or plain lines. */
  readonly output: Output
}

/**
 * The run's looks on the terminal `tty`, its output in `mode`, the start question asked as
 * `asks`: the main theme asks the terminal for its background where a box or a line form is drawn
 * on it.
 */
export const looksOf = (
  config: Pick<AppConfigValue, "scheme" | "noColor" | "appearance">,
  tty: TtyValue,
  mode: OutputMode,
  asks: Asking,
) =>
  Effect.gen(function* () {
    const depth = tty.colourDepth === "truecolor" ? "truecolor" : "256"
    const themeOf = (appearance: Appearance, styled = true) =>
      makeTheme(config.scheme.scheme, { appearance, depth, noColor: config.noColor, styled })
    const printedThemeOf = (out: Out) =>
      printedTheme(themeOf, config.appearance, { dumb: tty.dumb, tty: out.tty })
    const mainTheme =
      mode._tag === "Dashboard" || asks === "lines"
        ? themeOf(
            tty.dumb
              ? appearanceOf(config.appearance, null)
              : yield* outputAppearance(config.appearance, null),
          )
        : undefined
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
    const made: Looks = { themeOf, printedThemeOf, mainTheme, reportOut, output }
    return made
  })
