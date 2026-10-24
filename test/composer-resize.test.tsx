// The composer's height follows what you typed at the pane's width (§ 7.5; tutti-5bry): it grows
// as a long line wraps, and as the pane narrows and wraps it onto more lines, `composerLines` at
// most; it shrinks back when the pane widens.
import { describe, expect, test } from "bun:test"
import type { TextareaRenderable } from "@opentui/core"
import type { TestRendererSetup } from "@opentui/core/testing"
import { useTerminalDimensions } from "@opentui/react"
import { act, useRef, useState } from "react"
import { Composer, composerLines } from "../src/ui/Composer.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { type Rendered, withRender } from "./render.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

/**
 * The composer as a view holds it, the terminal's width and its height the view's; `height` reports
 * it to the test.
 */
const Held = ({ height }: { readonly height: (lines: number) => void }) => {
  const { width } = useTerminalDimensions()
  const field = useRef<TextareaRenderable | null>(null)
  const [lines, setLines] = useState(1)
  height(lines)
  return (
    <box flexDirection="column" width={width}>
      <Composer
        theme={theme}
        field={field}
        lines={lines}
        setLines={setLines}
        focused={true}
        focus={() => {}}
        send={() => true}
      />
    </box>
  )
}

/**
 * Runs `drive` and draws its frames inside act(): the composer refits from the row's size change,
 * which the frame after a resize lays out.
 */
const drawn = (rendered: Rendered, drive: (setup: TestRendererSetup) => unknown) =>
  act(async () => {
    await drive(rendered.setup)
    await rendered.setup.flush()
  })

/** The composer's height once it has settled at `want`, or what it was after 2 s. */
const heightOnce = async (rendered: Rendered, now: () => number, want: number) => {
  const deadline = Date.now() + 2000
  for (;;) {
    await drawn(rendered, (setup) => setup.renderOnce())
    if (now() === want || Date.now() > deadline) return now()
    await Bun.sleep(20)
  }
}

// Ten words of five letters, a space between: 59 columns, wrapped by word.
const typed = Array.from({ length: 10 }, () => "words").join(" ")

describe("the composer's height", () => {
  test("grows as what you type wraps past the field's width", async () => {
    let height = 0
    await withRender(
      <Held
        height={(lines) => {
          height = lines
        }}
      />,
      { width: 24, height: 16 },
      async (rendered) => {
        await drawn(rendered, (setup) => setup.mockInput.typeText(typed))
        expect(await heightOnce(rendered, () => height, 4)).toBe(4)
        const frame = await rendered.capture()
        // The field shows them all, three words a line, none past the pane's edge.
        expect(frame.chars.split("\n").slice(0, 4)).toEqual([
          " > words words words    ",
          "   words words words    ",
          "   words words words    ",
          "   words                ",
        ])
      },
    )
  })

  test("grows as the pane narrows and what you typed wraps, and shrinks as it widens", async () => {
    let height = 0
    await withRender(
      <Held
        height={(lines) => {
          height = lines
        }}
      />,
      { width: 80, height: 16 },
      async (rendered) => {
        await drawn(rendered, (setup) => setup.mockInput.typeText(typed))
        expect(await heightOnce(rendered, () => height, 1)).toBe(1)
        // The field is the width less the prompt's 3 columns: 21 at 24, three words a line.
        await drawn(rendered, (setup) => setup.resize(24, 16))
        expect(await heightOnce(rendered, () => height, 4)).toBe(4)
        // At 12, the field's 9 columns hold one word a line: ten lines, `composerLines` shown.
        await drawn(rendered, (setup) => setup.resize(12, 16))
        expect(await heightOnce(rendered, () => height, composerLines)).toBe(composerLines)
        await drawn(rendered, (setup) => setup.resize(80, 16))
        expect(await heightOnce(rendered, () => height, 1)).toBe(1)
      },
    )
  })
})
