// What the run says around the command's one renderer (§ 7.1): on the main screen until the
// renderer opens, the first time it is asked for, and held from then on, as the main screen can't
// show it then, until `release` says it there once the renderer is gone. A spec's breakdown, the
// feature interview and the dashboard all take the same renderer, opened once.
import { Effect, Option } from "effect"
import type { Out } from "../print/organLine.ts"

/** The run's talk with the renderer inRenderer opens. */
export interface InRenderer<S, E> {
  /** stdout on the main screen until the renderer opens; held from then on. */
  readonly out: Out
  /** stderr on the main screen until the renderer opens; held from then on. */
  readonly error: (text: string) => Effect.Effect<void>
  /** The renderer, opened the first time it is asked for. */
  readonly shell: Effect.Effect<S, E>
  /** Says what was held on the main screen, in the order it was said: once the renderer is gone. */
  readonly release: Effect.Effect<void>
}

/**
 * The run's talk with the renderer: what it says goes to `out` and `error` on the main screen
 * until the renderer is opened with `open`, once, and kept for the dashboard. What is said while
 * it is open is held until `release`.
 */
export const inRenderer = <S, E>(options: {
  readonly out: Out
  readonly error: (text: string) => Effect.Effect<void>
  readonly open: Effect.Effect<S, E>
}): InRenderer<S, E> => {
  let opened: Option.Option<S> = Option.none()
  const held: Array<{ readonly to: "out" | "error"; readonly text: string }> = []
  const shell = Effect.suspend(() =>
    Option.isSome(opened)
      ? Effect.succeed(opened.value)
      : Effect.tap(options.open, (made) =>
          Effect.sync(() => {
            opened = Option.some(made)
          }),
        ),
  )
  return {
    out: {
      ...options.out,
      write: (text) => {
        if (Option.isNone(opened)) options.out.write(text)
        else held.push({ to: "out", text })
      },
    },
    error: (text) =>
      Effect.suspend(() => {
        if (Option.isNone(opened)) return options.error(text)
        held.push({ to: "error", text })
        return Effect.void
      }),
    shell,
    release: Effect.suspend(() =>
      Effect.forEach(
        held.splice(0),
        (said) =>
          said.to === "out"
            ? Effect.sync(() => options.out.write(said.text))
            : options.error(said.text),
        { discard: true },
      ),
    ),
  }
}
