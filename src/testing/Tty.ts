// The Tty test layer (§ 3.3): a fixed value, read from its streams and variables by the live
// layer's fromEnvironment. `tty` builds one as a terminal on stdin and stdout with
// TERM=xterm-256color would give, 80×24, with `options` over it.
import { Effect, Layer } from "effect"
import { defaultSize, fromEnvironment, type Size, Tty, type TtyValue } from "../services/Tty.ts"

/** What the test terminal's Tty is read from: each part as a terminal's, unless given. */
export interface TtyOptions {
  readonly stdinIsTty?: boolean
  readonly stdoutIsTty?: boolean
  /** The variables, over TERM=xterm-256color: `{ TERM: "dumb" }`, `{ NO_COLOR: "1" }`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly size?: Size
}

/** A terminal's Tty: a TTY on both streams, TERM=xterm-256color, 80×24, with `options` over it. */
export const tty = (options: TtyOptions = {}): TtyValue => {
  const env: Readonly<Record<string, string | undefined>> = {
    TERM: "xterm-256color",
    ...options.env,
  }
  return fromEnvironment({
    stdinIsTty: options.stdinIsTty ?? true,
    stdoutIsTty: options.stdoutIsTty ?? true,
    env: (name) => env[name],
    size: Effect.succeed(options.size ?? defaultSize),
  })
}

/** The test layer: Tty as the literal `value`. */
export const layer = (value: TtyValue = tty()) => Layer.succeed(Tty, value)
