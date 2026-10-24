// The start question's description and the keys of one read (§ 7.1): those after the Enter that
// chose New feature are the description's, and those after Shift+Tab are the select's, though
// React hasn't drawn either step yet.
import { expect, test } from "bun:test"
import { TicketCount, type Work } from "../src/ui/questions.ts"
import { StartQuestion } from "../src/ui/StartQuestion.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { type Rendered, withRender } from "./render.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })
const size = { width: 100, height: 24 }

/** The start question with three tickets ready, and the answers it gave. */
const start = () => {
  const answers: Array<Work> = []
  const node = (
    <StartQuestion
      theme={theme}
      count={TicketCount.Ready({ n: 3 })}
      answer={(work) => {
        answers.push(work)
      }}
      cancel={() => {}}
    />
  )
  return { answers, node }
}

/** Sends `data` to the renderer as one read of stdin. */
const read = (rendered: Rendered, data: string) =>
  rendered.input(async (setup) => {
    setup.renderer.stdin.emit("data", Buffer.from(data))
    await Bun.sleep(40)
  })

test("the keys after Down and Enter in one read are the description's", async () => {
  const { answers, node } = start()
  await withRender(node, size, async (rendered) => {
    expect((await rendered.capture()).chars).not.toContain("Describe the feature")
    await read(rendered, "\x1b[B\rundo stack")
    const frame = await rendered.capture()
    expect(frame.chars).toContain("Describe the feature")
    expect(frame.chars).toContain("undo stack")
    // The Enter that chose New feature didn't submit the description empty.
    expect(frame.chars).not.toContain("describe the feature first")
    expect(answers).toEqual([])
    await rendered.input((setup) => setup.mockInput.pressEnter())
  })
  expect(answers).toEqual([{ _tag: "Feature", description: "undo stack" }] as Array<Work>)
})

test("the keys after Shift+Tab in one read are the select's, not the description's", async () => {
  const { answers, node } = start()
  await withRender(node, size, async (rendered) => {
    await read(rendered, "\x1b[B\rundo stack")
    // Shift+Tab, Up and Enter: the Enter chooses the current tickets and submits no description.
    await read(rendered, "\x1b[Z\x1b[A\r")
  })
  expect(answers.map((work) => work._tag)).toEqual(["Tickets"])
})

test("Shift+Tab hides the description and keeps what was typed in it", async () => {
  const { answers, node } = start()
  await withRender(node, size, async (rendered) => {
    await read(rendered, "\x1b[B\rundo stack")
    // The x after Shift+Tab, in its read, is the select's: it doesn't reach the hidden description.
    await read(rendered, "\x1b[Zx")
    const frame = await rendered.capture()
    expect(frame.chars).not.toContain("Describe the feature")
    expect(frame.chars).not.toContain("undo stack")
    await read(rendered, "\r")
    expect((await rendered.capture()).chars).toContain("undo stack")
    await rendered.input((setup) => setup.mockInput.pressEnter())
  })
  expect(answers).toEqual([{ _tag: "Feature", description: "undo stack" }] as Array<Work>)
})
