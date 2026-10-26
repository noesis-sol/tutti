// Mode 2027, grapheme clustering, as the terminal had it before the renderer (§ 7.4). OpenTUI
// 0.7.0 sets it at start (CSI ? 2027 h), whether or not the terminal answered its DECRQM query,
// and its destroy() resets every other mode it sets but not this one (spike 05, § 4; OpenTUI
// #1727). So tutti asks the terminal before the renderer starts and, once it has closed, sets the
// mode back: on when the terminal said it was on, else off.
import { Duration, Effect, Option } from "effect"

/** Mode 2027 as the terminal reported it: on, off, or unknown (not recognised, or no answer). */
export type Mode2027 = "on" | "off" | "unknown"

/** DECRQM for mode 2027, then the device attributes query, which every terminal answers. */
export const mode2027Query = "\x1b[?2027$p\x1b[c"

/** The sequence that puts mode 2027 back as `before` had it: on stays on, anything else is off. */
export const restoreMode2027 = (before: Mode2027): string =>
  before === "on" ? "\x1b[?2027h" : "\x1b[?2027l"

// DECRPM's reply: CSI ? 2027 ; Ps $ y, where Ps is 0 not recognised, 1 set, 2 reset, 3
// permanently set, 4 permanently reset.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the reply is an escape sequence
const modeReply = /\x1b\[\?2027;(\d+)\$y/

// The device attributes reply, CSI ? … c, sent after DECRPM's by a terminal that answers both.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the reply is an escape sequence
const attributesReply = /\x1b\[\?[\d;]*c/

/** Mode 2027 as a DECRPM reply in `text` gives it, if it holds one. */
export const parseMode2027Reply = (text: string): Option.Option<Mode2027> => {
  const match = modeReply.exec(text)
  if (match === null) return Option.none()
  const state = match[1]
  return Option.some(
    state === "1" || state === "3" ? "on" : state === "2" || state === "4" ? "off" : "unknown",
  )
}

/** How long tutti waits for the terminal to say mode 2027. */
export const mode2027QueryLimit = Duration.millis(250)

/** The terminal's streams, as the query uses them. */
export interface Terminal {
  readonly stdin: {
    readonly isTTY?: boolean
    readonly isRaw?: boolean
    setRawMode(mode: boolean): unknown
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown
    off(event: "data", listener: (chunk: Buffer | string) => void): unknown
    resume(): unknown
    pause(): unknown
  }
  readonly stdout: { readonly isTTY?: boolean; write(text: string): unknown }
}

/**
 * Asks `terminal` for mode 2027 (DECRQM) and waits up to 250 ms for the answer to the device
 * attributes query sent after it, which every terminal answers after DECRPM's, so that no reply is
 * left for the renderer to read. Unknown without an answer, or when stdin and stdout aren't a
 * terminal.
 */
export const queryMode2027 = (terminal: Terminal = process): Effect.Effect<Mode2027> =>
  Effect.suspend(() => {
    let heard = ""
    const answered = Effect.callback<void>((resume) => {
      const { stdin, stdout } = terminal
      if (!stdin.isTTY || !stdout.isTTY) {
        resume(Effect.void)
        return
      }
      const wasRaw = stdin.isRaw === true
      let listening = true
      const stop = () => {
        if (!listening) return
        listening = false
        stdin.off("data", onData)
        stdin.setRawMode(wasRaw)
        stdin.pause()
      }
      const onData = (chunk: Buffer | string) => {
        heard += chunk.toString()
        if (!attributesReply.test(heard)) return
        stop()
        resume(Effect.void)
      }
      stdin.setRawMode(true)
      stdin.on("data", onData)
      stdin.resume()
      stdout.write(mode2027Query)
      // Run when the wait ends unanswered, at the time limit.
      return Effect.sync(stop)
    })
    return answered.pipe(
      Effect.timeoutOption(mode2027QueryLimit),
      Effect.map(() => Option.getOrElse(parseMode2027Reply(heard), () => "unknown" as const)),
    )
  })
