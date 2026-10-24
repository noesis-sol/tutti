// The start question on a screen too short for it (tutti-lfii): each of its lines is one the form
// draws on a tall screen, none drawn over another; the select gives up its top lines first.
import { describe, expect, test } from "bun:test"
import { TicketCount } from "../src/ui/questions.ts"
import { StartQuestion } from "../src/ui/StartQuestion.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { type Size, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const node = () => (
  <StartQuestion
    theme={themeOf("dark")}
    count={TicketCount.Ready({ n: 3 })}
    answer={() => {}}
    cancel={() => {}}
  />
)

/** The frame's lines at `size`, in the select, and after a click on New feature. */
const frames = (size: Size) =>
  withRender(node(), size, async (rendered) => {
    const choosing = (await rendered.capture()).chars.split("\n")
    const y = choosing.findIndex((line) => line.includes("New"))
    expect(y).toBeGreaterThan(0)
    await rendered.input((setup) => setup.mockMouse.click(6, y))
    const describing = (await rendered.capture()).chars.split("\n")
    return { choosing, describing }
  })

/** Each of `lines` is one of `whole`'s, as tall a screen draws it. */
const expectLinesOf = (lines: ReadonlyArray<string>, whole: ReadonlyArray<string>) => {
  const known = new Set(whole)
  expect(lines.filter((line) => !known.has(line))).toEqual([])
}

describe("the start question on a short screen", () => {
  for (const width of [20, 30, 40]) {
    test(`at ${width} columns, no line is drawn over another`, async () => {
      const tall = await frames({ width, height: 60 })
      for (const height of [10, 16, 20, 24, 26, 27, 28, 32]) {
        const short = await frames({ width, height })
        expectLinesOf(short.choosing, tall.choosing)
        expectLinesOf(short.describing, tall.describing)
        // The select keeps its options while it is answered; the description, its title.
        expect(short.choosing.join("\n")).toContain("> Current")
        expect(short.describing.join("\n")).toContain("┃ Describe the")
      }
    })
  }

  test("the select gives up its top lines first", async () => {
    const { describing } = await frames({ width: 30, height: 24 })
    const text = describing.join("\n")
    expect(text).not.toContain("What should this run")
    expect(text).toContain("> New feature: describe")
    expect(text).toContain("┃ Describe the feature")
  })
})
