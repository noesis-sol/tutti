// The Tty test layer (§ 3.3): a fixed value. `tty` builds one as a 256-colour terminal on stdin and
// stdout would give, 80×24, with `overrides` laid over it.
import { Effect, Layer } from "effect"
import { defaultSize, type Size, Tty, type TtyValue } from "../services/Tty.ts"

/** A terminal's Tty: a TTY on both streams, xterm-256color, 80×24, with `overrides` over it. */
export const tty = (
  overrides: Partial<Omit<TtyValue, "size">> & { size?: Size } = {},
): TtyValue => {
  const { size = defaultSize, ...rest } = overrides
  return {
    stdinIsTty: true,
    stdoutIsTty: true,
    dumb: false,
    noColor: false,
    term: "xterm-256color",
    colourDepth: "256",
    ...rest,
    size: Effect.succeed(size),
  }
}

/** The test layer: Tty as the literal `value`. */
export const layer = (value: TtyValue = tty()) => Layer.succeed(Tty, value)
