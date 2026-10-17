// The printer after the dashboard (§ 7.1): plain ANSI on the main screen, with organ lines (§ 7.11
// "The summary"). An organ line is a step of an organ's under way, such as the run report: a
// spinner, its text and the time it has taken, drawn by rewriting one line (carriage return and
// erase line) ten times a second until the step ends, then its final line, `◆ ` and the text with
// how long it took. It is drawn from a fiber rather than by a renderer, so the terminal stays out
// of raw mode and Ctrl+C comes as a signal. What is printed while it is drawn goes above it.
import { Clock, Duration, Effect, Fiber } from "effect"
import { sanitizeLine } from "../ui/sanitize.ts"
import type { Theme } from "../ui/theme.ts"

/** Where the printer writes. */
export interface Out {
  readonly write: (text: string) => void
  /** The terminal's width now, as a resize changes it; 0 when it doesn't say. */
  readonly columns: () => number
  /** Whether it is a terminal, where a line can be redrawn. */
  readonly tty: boolean
}

/** The process's stdout. */
export const stdout: Out = {
  write: (text) => {
    process.stdout.write(text)
  },
  columns: () => process.stdout.columns ?? 0,
  tty: process.stdout.isTTY === true,
}

/** The spinner, Bubbles' `Dot` (§ 7.11 "Glyphs and motion"). */
export const spinnerFrames = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"] as const

/** How often the spinner turns: ten times a second. */
export const frameInterval = Duration.millis(100)

/** Returns the cursor to the start of its line and erases the line. */
export const eraseLine = "\r\x1b[2K"

/** A step under way, drawn until `done` or `warn` ends it; one of them must. */
export interface OrganLine {
  /** Shows how far the step has got, `3 tickets`, before the time taken; "" shows nothing. */
  readonly detail: (text: string) => Effect.Effect<void>
  /** Ends the step with its final line: `◆ ` and `text`, and the time it took, a second or more. */
  readonly done: (text: string) => Effect.Effect<void>
  /** Ends the step with a warning in its place. */
  readonly warn: (text: string) => Effect.Effect<void>
}

export interface Printer {
  /** Prints `text`, whole lines, above the organ line if one is drawn. */
  readonly print: (text: string) => Effect.Effect<void>
  /** An organ's line: `◆ ` and `text`, as a step's final line is. */
  readonly say: (text: string) => Effect.Effect<void>
  /** A warning from an organ: `◆ ` and `text` in `notice`. */
  readonly warn: (text: string) => Effect.Effect<void>
  /**
   * Starts a step, `text` beside a spinner, its first frame after `frameInterval`, so a step that
   * ends sooner shows only its final line. Where `out` isn't a terminal, only the final line.
   */
  readonly organ: (text: string) => Effect.Effect<OrganLine>
}

/** A step's time on its spinner line: `0:42`, with hours once there are any, `1:02:03`. */
export const clock = (millis: number): string => {
  const s = Math.floor(Math.max(0, millis) / 1000)
  const pad = (n: number) => String(n).padStart(2, "0")
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
    : `${Math.floor(s / 60)}:${pad(s % 60)}`
}

/** A step's time on its final line: `12s`, `1m04s`, `1h02m03s`. */
export const duration = (millis: number): string => {
  const s = Math.floor(Math.max(0, millis) / 1000)
  const pad = (n: number) => String(n).padStart(2, "0")
  if (s >= 3600) return `${Math.floor(s / 3600)}h${pad(Math.floor(s / 60) % 60)}m${pad(s % 60)}s`
  if (s >= 60) return `${Math.floor(s / 60)}m${pad(s % 60)}s`
  return `${s}s`
}

/** The width a spinner line is cut to: the terminal's, else 80, less a column so it never wraps. */
const lineWidth = (out: Out): number => {
  const columns = out.columns()
  return (columns > 1 ? columns : 80) - 1
}

/** `line` cut to `width` columns, its styles reset after it. */
const cut = (line: string, width: number): string =>
  Bun.stringWidth(line) <= width ? line : `${Bun.sliceAnsi(line, 0, width)}\x1b[0m`

/** The printer on `out`, in `theme`'s styles. */
export const makePrinter = (out: Out, theme: Theme): Printer => {
  const { organ, say, deferred, picked, dim } = theme.styles
  /** The organ line as drawn, the cursor at its end; "" while none is. */
  let live = ""

  const draw = (line: string) => {
    if (live === "" && line === "") return
    out.write(eraseLine + line)
    live = line
  }

  const print = (text: string) =>
    Effect.sync(() => {
      const lines = text.endsWith("\n") ? text : `${text}\n`
      out.write(live === "" ? lines : `${eraseLine}${lines}${live}`)
    })

  const sayLine = (text: string) => `${organ.paint("◆ ")}${say.paint(sanitizeLine(text))}`
  const warnLine = (text: string) => `${organ.paint("◆ ")}${deferred.paint(sanitizeLine(text))}`

  const step = (text: string): Effect.Effect<OrganLine> =>
    Effect.gen(function* () {
      const began = yield* Clock.currentTimeMillis
      let detail = ""
      const shown = sanitizeLine(text)
      const spin = Effect.gen(function* () {
        for (let i = 0; ; i++) {
          yield* Effect.sleep(frameInterval)
          const now = yield* Clock.currentTimeMillis
          const took = clock(now - began)
          const line =
            `${picked.paint(spinnerFrames[i % spinnerFrames.length] as string)} ` +
            `${say.paint(shown)} ${dim.paint(detail === "" ? took : `${detail} · ${took}`)}`
          draw(cut(line, lineWidth(out)))
        }
      }).pipe(Effect.ensuring(Effect.sync(() => draw(""))))
      const spinner = out.tty ? yield* Effect.forkChild(spin) : null
      const end = spinner === null ? Effect.void : Fiber.interrupt(spinner)
      return {
        detail: (text) =>
          Effect.sync(() => {
            detail = sanitizeLine(text)
          }),
        done: (text) =>
          Effect.gen(function* () {
            yield* end
            const took = (yield* Clock.currentTimeMillis) - began
            const time = took >= 1000 ? ` ${dim.paint(`(${duration(took)})`)}` : ""
            yield* print(`${sayLine(text)}${time}`)
          }),
        warn: (text) => Effect.andThen(end, print(warnLine(text))),
      }
    })

  return {
    print,
    say: (text) => print(sayLine(text)),
    warn: (text) => print(warnLine(text)),
    organ: step,
  }
}
