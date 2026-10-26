// What the printer says while the renderer holds the screen, drawn in it (§ 5 item 3, § 7.1): a
// spec chosen at the start question, run as it is, is broken down with the renderer open, which the
// dashboard then takes; its organ lines, which `tutti --spec` draws on the main screen before the
// renderer opens, are drawn here instead, the spinner turning, until the breakdown ends or the run
// starts on its environment ticket. Ctrl+C stops the breakdown, as it does on the main screen.
//
// The printer writes to screenOut's Out as to a terminal, a line rewritten with a carriage return
// and an erase; the screen shows the last of its lines that fit.
import { createRoot, useTerminalDimensions } from "@opentui/react"
import { Effect, type Scope } from "effect"
import { useSyncExternalStore } from "react"
import { eraseLine, type Out } from "../print/organLine.ts"
import { formHintSegments, Themed } from "./Form.tsx"
import { useFormCommands } from "./keyCommands.ts"
import { InputGuards } from "./keys.ts"
import { cut, Lines, seg, wrap } from "./line.tsx"
import type { Shell } from "./renderer.ts"
import type { Appearance, Theme } from "./theme.ts"
import { type External, external } from "./useRunView.ts"

/** An Out drawn on the renderer's screen: what was written, as the text it leaves. */
export interface ScreenOut {
  readonly out: Out
  readonly text: External<string>
}

/**
 * An Out that keeps what is written to it as a terminal would show it, `columns` wide: a line
 * erased (`\r\x1b[2K`) and rewritten is the line rewritten.
 */
export const screenOut = (columns: () => number): ScreenOut => {
  const text = external("")
  return {
    out: {
      write: (written) => {
        let now = text.get()
        for (const [i, part] of written.split(eraseLine).entries()) {
          if (i > 0) now = now.slice(0, now.lastIndexOf("\n") + 1)
          now += part
        }
        text.set(now)
      },
      columns,
      tty: true,
    },
    text,
  }
}

/** The organ lines `text` leaves, the last that fit in `height` lines `width` wide. */
export const organLines = (text: string, width: number, height: number) => {
  const lines = text
    .replace(/\n$/, "")
    .split("\n")
    .flatMap((line) => wrap([seg(line)], Math.max(width, 1)))
  return lines.slice(Math.max(lines.length - Math.max(height, 0), 0))
}

/** The screen: the organ lines, then the hint, `Ctrl+C stop`; Ctrl+C runs `stop`. */
export const OrganScreen = ({
  theme,
  text,
  stop,
}: {
  readonly theme: Theme
  readonly text: External<string>
  readonly stop: () => void
}) => {
  const written = useSyncExternalStore(text.subscribe, text.get)
  const { width, height } = useTerminalDimensions()
  const hint = useFormCommands([
    { keys: ["ctrl+c"], run: stop, hint: { keys: "Ctrl+C", does: "stop" } },
  ])
  const hintLine = cut(formHintSegments(hint, theme), Math.max(width - 2, 1))
  const lines = organLines(written, width - 2, height - 3)
  return (
    <box flexDirection="column" paddingX={1} paddingTop={1}>
      <box flexDirection="column" height={Math.max(height - 3, 0)} flexShrink={0}>
        <Lines lines={lines} />
      </box>
      <Lines lines={[hintLine]} />
    </box>
  )
}

/**
 * Shows the organ lines `text` holds in `shell`'s renderer for the rest of the scope; Ctrl+C runs
 * `stop`.
 */
export const showOrgans = (
  shell: Shell,
  themeOf: (appearance: Appearance) => Theme,
  text: External<string>,
  stop: () => void,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const root = createRoot(shell.renderer)
      root.render(
        <>
          <InputGuards />
          <Themed appearance={shell.appearance} themeOf={themeOf}>
            {(theme) => <OrganScreen theme={theme} text={text} stop={stop} />}
          </Themed>
        </>,
      )
      return root
    }),
    (root) => Effect.sync(() => root.unmount()),
  )
