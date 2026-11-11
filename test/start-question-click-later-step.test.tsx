// A click on the start question's select past its first step (tutti-34k9.11): the select stays
// drawn above the field answered, and a click on Current tickets' line there answered a tickets
// run, losing what was typed. Now none of its lines answers at the description, spec or refine step.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { orchestra } from "../src/project/scheme.ts"
import { type SpecAsk, TicketCount, type Work } from "../src/ui/questions.ts"
import { StartQuestion } from "../src/ui/StartQuestion.tsx"
import { makeTheme } from "../src/ui/theme.ts"
import { type Frame, type Rendered, withRender } from "./render.ts"
import { noSpecAsk } from "./specAsk.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })
const size = { width: 100, height: 32 }

/** A folder of its own with a spec file in it, the repository the spec field starts at. */
const fixture = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutti-start-click-")))
  mkdirSync(join(dir, "docs"))
  writeFileSync(join(dir, "docs/shop.md"), "# Shop\n")
  return dir
}

/** The start question asking with `spec`, and what it answered. */
const start = (spec: SpecAsk = noSpecAsk) => {
  const answers: Array<Work> = []
  let cancelled = 0
  const node = (
    <StartQuestion
      spec={spec}
      theme={theme}
      count={TicketCount.Ready({ n: 3 })}
      answer={(work) => {
        answers.push(work)
      }}
      cancel={() => {
        cancelled++
      }}
    />
  )
  return { answers, cancelled: () => cancelled, node }
}

/** The row of the frame's line holding `text`, which must be drawn. */
const rowOf = (frame: Frame, text: string): number => {
  const y = frame.chars.split("\n").findIndex((line) => line.includes(text))
  expect(y).toBeGreaterThan(0)
  return y
}

/** A click on the select's line for the current tickets, where it is drawn now. */
const clickTickets = async (rendered: Rendered) => {
  const y = rowOf(await rendered.capture(), "Current tickets")
  await rendered.input((setup) => setup.mockMouse.click(6, y))
}

const type = (rendered: Rendered, text: string) =>
  rendered.input((setup) => setup.mockInput.typeText(text))

const enter = (rendered: Rendered) => rendered.input((setup) => setup.mockInput.pressEnter())

const down = (rendered: Rendered) => rendered.input((setup) => setup.mockInput.pressArrow("down"))

describe("a click on the start question's select past its first step", () => {
  test("at the description step, answers nothing and keeps the text", async () => {
    const { answers, cancelled, node } = start()
    await withRender(node, size, async (rendered) => {
      await down(rendered)
      await down(rendered)
      await enter(rendered)
      await type(rendered, "undo stack for edits")
      let frame = await rendered.capture()
      expect(frame.chars).toContain("Describe the feature")
      expect(frame.chars).toContain("undo stack for edits")
      await clickTickets(rendered)
      frame = await rendered.capture()
      expect(answers).toEqual([])
      expect(frame.chars).toContain("Describe the feature")
      expect(frame.chars).toContain("undo stack for edits")
      // The select's highlight stays on the option chosen.
      expect(frame.chars).toContain("> New feature")
      expect(frame.chars).toContain("  Current tickets")
      // The field still takes the keys: more text, then Enter answers the feature.
      await type(rendered, " and drags")
      await enter(rendered)
    })
    expect(cancelled()).toBe(0)
    expect(answers.map((work) => work._tag)).toEqual(["Feature"])
    expect(answers[0]).toMatchObject({ description: "undo stack for edits and drags" })
  })

  test("at the spec step, answers nothing and keeps the path typed", async () => {
    const { answers, node } = start()
    await withRender(node, size, async (rendered) => {
      await down(rendered)
      await enter(rendered)
      await type(rendered, "docs/sh")
      let frame = await rendered.capture()
      expect(frame.chars).toContain("┃ > docs/sh")
      await clickTickets(rendered)
      frame = await rendered.capture()
      expect(answers).toEqual([])
      expect(frame.chars).toContain("┃ > docs/sh")
      expect(frame.chars).toContain("> Spec")
    })
    expect(answers).toEqual([])
  })

  test("at the refine step, answers nothing and keeps the step", async () => {
    const repo = fixture()
    const { answers, node } = start({ where: { repo, home: "" }, checkUrl: noSpecAsk.checkUrl })
    await withRender(node, size, async (rendered) => {
      await down(rendered)
      await enter(rendered)
      await type(rendered, "docs/shop.md")
      await enter(rendered)
      let frame = await rendered.capture()
      expect(frame.chars).toContain("Refine it with Claude first?")
      await clickTickets(rendered)
      frame = await rendered.capture()
      expect(answers).toEqual([])
      expect(frame.chars).toContain("Refine it with Claude first?")
      expect(frame.chars).toContain("> Run it as it is")
      // The refine step still answers: Enter runs the spec as it is.
      await enter(rendered)
    })
    expect(answers.map((work) => work._tag)).toEqual(["Spec"])
    expect(answers[0]).toMatchObject({ given: join(repo, "docs/shop.md"), refine: false })
  })

  test("at the first step, a click on each option still chooses it", async () => {
    const { answers, node } = start()
    await withRender(node, size, async (rendered) => {
      await clickTickets(rendered)
    })
    expect(answers.map((work) => work._tag)).toEqual(["Tickets"])
  })
})
