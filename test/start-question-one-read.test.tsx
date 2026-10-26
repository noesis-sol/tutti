// The start question's keys that arrive in one read (§ 7.1): each sees the ones before it, so Downs
// and Enter together choose what Down moved to, not what was highlighted when the read began.
import { expect, test } from "bun:test"
import { TicketCount, type Work } from "../src/ui/questions.ts"
import { StartQuestion } from "../src/ui/StartQuestion.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { withRender } from "./render.ts"
import { noSpecAsk } from "./specAsk.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })
const size = { width: 100, height: 24 }

test("Down, Down and Enter in one read ask for a new feature's description", async () => {
  const answers: Array<Work> = []
  const node = (
    <StartQuestion
      spec={noSpecAsk}
      theme={theme}
      count={TicketCount.Ready({ n: 3 })}
      answer={(work) => {
        answers.push(work)
      }}
      cancel={() => {}}
    />
  )
  await withRender(node, size, async (rendered) => {
    await rendered.input(async (setup) => {
      setup.renderer.stdin.emit("data", Buffer.from("\x1b[B\x1b[B\r"))
      await Bun.sleep(40)
    })
    const frame = await rendered.capture()
    expect(frame.chars).toContain("> New feature")
    expect(frame.chars).toContain("Describe the feature")
  })
  expect(answers).toEqual([])
})

test("Shift+Tab, Up, Up and Enter in one read choose the current tickets", async () => {
  const answers: Array<Work> = []
  const node = (
    <StartQuestion
      spec={noSpecAsk}
      theme={theme}
      count={TicketCount.Ready({ n: 3 })}
      answer={(work) => {
        answers.push(work)
      }}
      cancel={() => {}}
    />
  )
  await withRender(node, size, async (rendered) => {
    await rendered.input((setup) => setup.mockInput.pressArrow("down"))
    await rendered.input((setup) => setup.mockInput.pressArrow("down"))
    await rendered.input((setup) => setup.mockInput.pressEnter())
    expect((await rendered.capture()).chars).toContain("Describe the feature")
    // Shift+Tab back to the select, then Up, Up and Enter: the current tickets.
    await rendered.input(async (setup) => {
      setup.renderer.stdin.emit("data", Buffer.from("\x1b[Z\x1b[A\x1b[A\r"))
      await Bun.sleep(40)
    })
  })
  expect(answers.map((work) => work._tag)).toEqual(["Tickets"])
})
