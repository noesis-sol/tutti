// An Out on the renderer's screen (§ 5 item 3): what the printer writes to it, kept as a terminal
// would show it, for src/ui/OrganScreen.tsx to draw while the renderer holds the screen.
import { type External, external } from "../ui/useRunView.ts"
import { eraseLine, type Out } from "./organLine.ts"

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
