// The worker view's Markdown quotes and rules (§ 7.11 "Markdown"): a quote faint italic behind a
// faint `│ ` on each of its lines, a rule a faint `─` at most 40 long; the paragraphs around them
// keep their blank lines, and a quote that streams keeps its bar.
import { describe, expect, test } from "bun:test"
import { TextAttributes } from "@opentui/core"
import { useSyncExternalStore } from "react"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type Settable } from "../src/ui/useRunView.ts"
import { ruleWidth, useSyntaxStyles } from "../src/ui/WorkerView.tsx"
import { type Frame, type Rendered, withRender } from "./render.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

/** Markdown as the worker view draws an entry's text: streaming while the text is live. */
const Markdown = ({
  content,
  streaming,
}: {
  readonly content: Settable<string>
  readonly streaming: boolean
}) => {
  const looks = useSyntaxStyles(theme)
  const text = useSyncExternalStore(content.subscribe, content.get)
  return (
    <markdown
      content={text}
      syntaxStyle={looks.markdown}
      renderNode={looks.blocks}
      {...looks.highlighter}
      conceal
      streaming={streaming}
    />
  )
}

/** The frame's lines, each a list of its characters and whether each is drawn faint. */
const cellsOf = (frame: Frame) =>
  frame.spans.lines.map((line) =>
    line.spans.flatMap((span) =>
      Array.from(span.text).map((char) => ({
        char,
        faint: (span.attributes & TextAttributes.DIM) !== 0,
        italic: (span.attributes & TextAttributes.ITALIC) !== 0,
      })),
    ),
  )

const linesOf = (frame: Frame): ReadonlyArray<string> =>
  frame.chars.split("\n").map((line) => line.trimEnd())

/** Captures frames until `ready` holds of one: Markdown is drawn once it has been highlighted. */
const until = async (rendered: Rendered, ready: (frame: Frame) => boolean): Promise<Frame> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const frame = await rendered.capture()
    if (ready(frame) || Date.now() > deadline) return frame
    await Bun.sleep(20)
  }
}

const has = (text: string) => (frame: Frame) => frame.chars.includes(text)

/** Whether `text` is drawn on some line, every one of its cells faint. */
const faintly = (frame: Frame, text: string): boolean =>
  cellsOf(frame).some((line) => {
    const chars = line.map((cell) => cell.char).join("")
    const at = chars.indexOf(text)
    return at !== -1 && line.slice(at, at + Array.from(text).length).every((cell) => cell.faint)
  })

const render = (
  content: Settable<string>,
  width: number,
  body: (r: Rendered) => Promise<void>,
  streaming = false,
) =>
  withRender(<Markdown content={content} streaming={streaming} />, { width, height: 16 }, body, {
    treeSitter: "real",
  })

describe("Markdown quotes and rules", () => {
  test("a quote is drawn behind a faint │ on each of its lines, its words faint italic", async () => {
    const content = external("Before.\n\n> first line\n> second line\n\nAfter.")
    await render(content, 60, async (rendered) => {
      const frame = await until(rendered, (f) => faintly(f, "first line"))
      expect(linesOf(frame).slice(0, 7)).toEqual([
        "Before.",
        "",
        "│ first line",
        "│ second line",
        "",
        "After.",
        "",
      ])
      const lines = cellsOf(frame)
      for (const row of [2, 3]) {
        expect(lines[row]?.[0]).toEqual({ char: "│", faint: true, italic: false })
        expect(lines[row]?.slice(2).find((cell) => cell.char !== " ")).toMatchObject({
          faint: true,
          italic: true,
        })
      }
      expect(lines[0]?.[0]?.faint).toBe(false)
    })
  })

  test("a rule is a faint ─ at most 40 long, and as wide as the text where that is less", async () => {
    for (const [width, long] of [
      [80, ruleWidth],
      [30, 30],
    ] as const) {
      const content = external("Above.\n\n---\n\nBelow.")
      await render(content, width, async (rendered) => {
        const frame = await until(rendered, has("Below."))
        expect(linesOf(frame).slice(0, 5)).toEqual(["Above.", "", "─".repeat(long), "", "Below."])
        expect(faintly(frame, "─".repeat(long))).toBe(true)
      })
    }
  })

  test("a quote that streams keeps its bar, and no other border, as it grows", async () => {
    const content = external("Said.\n\n> one")
    await render(
      content,
      40,
      async (rendered) => {
        await until(rendered, (f) => faintly(f, "one"))
        for (const more of ["> one and", "> one and\n> two"]) {
          await rendered.input(() => content.set(`Said.\n\n${more}`))
        }
        const frame = await until(rendered, (f) => faintly(f, "two"))
        expect(linesOf(frame).slice(0, 5)).toEqual(["Said.", "", "│ one and", "│ two", ""])
        expect(faintly(frame, "│")).toBe(true)
      },
      true,
    )
  })
})
