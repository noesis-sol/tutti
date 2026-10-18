// The one OpenTUI renderer of a command (§ 7.1, § 7.4): made once, in the alternate screen, and
// destroyed once, when the scope it was opened in closes. A second renderer after destroy() is
// unproven (OpenTUI #1533), so everything after it goes to the main screen as plain ANSI.
//
// Signals are tutti's: `exitOnCtrlC: false` and `exitSignals: []` keep OpenTUI from destroying the
// renderer on Ctrl+C or any of its eight default signals, so the Effect runtime decides what each
// one does. Whatever ends the process, the renderer is destroyed before anything is printed:
// uncaughtException and unhandledRejection destroy it first and then report, and the Effect
// runtime's fatal path closes the scope, and with it the renderer, before runMain prints the cause.
// Once it has closed, mode 2027 is set back as the terminal had it before (mode2027.ts).
//
// Terminal.app leaves the rightmost column stale after a resize (OpenTUI #1110), so each resize
// repaints the whole screen. The appearance (§ 7.11) is the user's choice, else the terminal's
// theme mode, waited for up to 250 ms at start, else dark; it follows the terminal's theme_mode
// events from then on.
import { type CliRenderer, type CliRendererConfig, createCliRenderer } from "@opentui/core"
import { Effect, Schema, type Scope } from "effect"
import { exitCodes } from "../run/holds.ts"
import { type Mode2027, queryMode2027, restoreMode2027 } from "./mode2027.ts"
import { type Appearance, appearanceOf } from "./theme.ts"
import { type External, external } from "./useRunView.ts"

/** How the renderer is made: the alternate screen, every signal left to tutti. */
export const rendererConfig = {
  screenMode: "alternate-screen",
  exitOnCtrlC: false,
  exitSignals: [],
} as const satisfies CliRendererConfig

/** rendererConfig, taking the mouse or leaving it to the terminal (`--no-mouse`, § 7.3). */
export const rendererConfigFor = (mouse: boolean): CliRendererConfig => ({
  ...rendererConfig,
  useMouse: mouse,
})

/** How long the renderer waits for the terminal to say its theme mode at start, in ms. */
export const themeModeLimit = 250

/** The renderer couldn't be made: OpenTUI's native library, or the terminal, refused. */
export class RendererFailed extends Schema.TaggedError<RendererFailed>()("RendererFailed", {
  message: Schema.String,
}) {}

/** The renderer open, and the appearance it draws in, which can change as it runs. */
export interface Shell {
  readonly renderer: CliRenderer
  readonly appearance: External<Appearance>
}

/** Says a fatal error on stderr, the renderer gone, and exits as a panic does (exit 4). */
export const reportFatal = (error: unknown): void => {
  process.stderr.write(
    `tutti: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exit(exitCodes.tool)
}

/** How long a fatal error's report waits for the renderer to close, in ms. */
export const closeLimit = 1000

/**
 * The handler for an error nothing caught: destroys `renderer`, waits until it has closed (the
 * terminal back on the main screen, out of raw mode; OpenTUI closes it a microtask after destroy())
 * or `closeLimit` has passed, `restore`s what destroy() leaves set, then `report`s the error. The
 * promise is done once it has reported.
 */
export const fatalHandler =
  (renderer: CliRenderer, report: (error: unknown) => void, restore: () => void = () => {}) =>
  (error: unknown): Promise<void> => {
    renderer.destroy()
    return Promise.race([renderer.closed.catch(() => undefined), Bun.sleep(closeLimit)]).then(
      () => {
        restore()
        report(error)
      },
    )
  }

/** Asks the terminal for mode 2027 before the renderer starts, and writes it back after. */
export interface Mode2027Io {
  readonly ask: Effect.Effect<Mode2027>
  readonly write: (sequence: string) => void
}

/** Mode 2027 on this process's terminal. */
export const terminalMode2027: Mode2027Io = {
  ask: queryMode2027(),
  write: (sequence) => void process.stdout.write(sequence),
}

/** The process events a fatal handler listens to. */
export const fatalEvents = ["uncaughtException", "unhandledRejection"] as const

// The renderer's flag for a full repaint on its next frame. OpenTUI sets it for its own reasons
// (a resume, the split footer), but not after a resize in the alternate screen.
interface Repaintable {
  forceFullRepaintRequested: boolean
}

/** Repaints the whole screen on the renderer's next frame, not only the cells that changed. */
export const repaintFully = (renderer: CliRenderer): void => {
  if ("forceFullRepaintRequested" in renderer) {
    ;(renderer as unknown as Repaintable).forceFullRepaintRequested = true
  }
  renderer.requestRender()
}

/**
 * The appearance `renderer` draws in: `chosen` when the user chose one, else the terminal's theme
 * mode, waited for up to `themeModeLimit`, else dark; following the terminal's theme_mode events
 * when nothing was chosen. The returned function stops following them.
 */
export const followAppearance = (
  renderer: CliRenderer,
  chosen: "auto" | "light" | "dark",
): Effect.Effect<readonly [External<Appearance>, () => void]> =>
  Effect.gen(function* () {
    if (chosen !== "auto") return [external<Appearance>(chosen), () => {}] as const
    const detected = yield* Effect.promise(() => renderer.waitForThemeMode(themeModeLimit))
    const appearance = external(appearanceOf(chosen, detected))
    const onMode = (mode: Appearance) => appearance.set(mode)
    renderer.on("theme_mode", onMode)
    return [appearance, () => renderer.off("theme_mode", onMode)] as const
  })

/**
 * Opens the command's renderer in the caller's scope, which destroys it when it closes. `make`
 * makes it from its config (OpenTUI's, on this terminal, by default; a test renderer in the
 * tests), taking the mouse unless `mouse` is false, and `report`
 * says an error nothing caught once the renderer is gone (reportFatal by default). `mode2027` asks
 * for mode 2027 before the renderer is made and writes it back once it has closed: this terminal's
 * when `make` is OpenTUI's, none for another renderer unless given.
 */
export const open = (options: {
  readonly chosen: "auto" | "light" | "dark"
  readonly mouse?: boolean
  readonly make?: (config: CliRendererConfig) => Promise<CliRenderer>
  readonly report?: (error: unknown) => void
  readonly mode2027?: Mode2027Io
}): Effect.Effect<Shell, RendererFailed, Scope.Scope> => {
  const make = options.make ?? createCliRenderer
  const config = rendererConfigFor(options.mouse ?? true)
  const report = options.report ?? reportFatal
  const mode2027 = options.mode2027 ?? (options.make === undefined ? terminalMode2027 : undefined)
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const before = mode2027 === undefined ? undefined : yield* mode2027.ask
      let restored = false
      // Once, whichever of the scope and a fatal error closes the renderer first.
      const restore = () => {
        if (mode2027 === undefined || before === undefined || restored) return
        restored = true
        mode2027.write(restoreMode2027(before))
      }
      const renderer = yield* Effect.tryPromise({
        try: () => make(config),
        catch: (error) =>
          new RendererFailed({ message: error instanceof Error ? error.message : String(error) }),
      })
      const onFatal = fatalHandler(renderer, report, restore)
      for (const event of fatalEvents) process.on(event, onFatal)
      const onResize = () => repaintFully(renderer)
      renderer.on("resize", onResize)
      const [appearance, unfollow] = yield* followAppearance(renderer, options.chosen)
      const stop = () => {
        unfollow()
        renderer.off("resize", onResize)
        for (const event of fatalEvents) process.off(event, onFatal)
      }
      return { shell: { renderer, appearance } satisfies Shell, stop, restore }
    }),
    ({ shell, stop, restore }) =>
      Effect.promise(async () => {
        shell.renderer.destroy()
        stop()
        // The terminal is back on the main screen once it settles, before anything is printed.
        await shell.renderer.closed.catch(() => undefined)
        restore()
      }),
  ).pipe(Effect.map(({ shell }) => shell))
}
