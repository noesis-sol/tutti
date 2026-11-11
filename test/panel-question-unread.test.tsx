// A click on the title of the panel's question before the look has read it (tutti-fnvd.5, § 7.2):
// the questions box opens at the question the ticket waits on, not at the first one open.
import { expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { orchestra } from "../src/project/scheme.ts"
import { makeCommands, type UiCommand } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { QuestionNews } from "../src/run/questionNews.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import type { OpenQuestion } from "../src/ui/questions.ts"
import { type Appearance, makeTheme } from "../src/ui/theme.ts"
import { external } from "../src/ui/useRunView.ts"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 10, 8, 8, 0, 0).getTime()

const question = (id: string, title: string, waiting: string): OpenQuestion => ({
  id: id as TicketId,
  title,
  description: "",
  options: [{ label: "Yes", description: "" }],
  maintainerOnly: false,
  waiting: [waiting as TicketId],
})

const licence = question("q-1", "Which licence?", "b-1")
const flag = question("q-2", "Which flag name?", "a-1")

const asked: Entry = {
  ticket: "a-1" as TicketId,
  title: "Add the flag",
  phase: TicketPhase.Asked({ question: "q-2" }),
  since: began,
  worker: null,
  row: 0,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
}

// The look hasn't read q-2 yet: the panel has the ticket's title, reading its question.
const view: RunView = project({
  ledger: { tickets: new Map([[asked.ticket, asked]]), rows: 1, windDown: null, bugs: [] },
  workers: new Map(),
  requests: [],
  status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 1 },
  actions: new Map(),
})

const until = async (rendered: Rendered, ready: (frame: Frame) => boolean): Promise<Frame> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const frame = await rendered.capture()
    if (ready(frame) || Date.now() > deadline) return frame
    await Bun.sleep(20)
  }
}

/** Where `text` is last on the first line that holds it twice: the panel's, right of the table's. */
const panelWhere = (frame: Frame, text: string) => {
  const lines = frame.chars.split("\n")
  const y = lines.findIndex((line) => line.indexOf(text) !== line.lastIndexOf(text))
  if (y === -1) throw new Error(`no line holds ${text} twice`)
  return { x: (lines[y] ?? "").lastIndexOf(text), y }
}

test("a click on the unread question's title opens the box at that question", async () => {
  const news = external<ReadonlyArray<QuestionNews>>([])
  const commands = Effect.runSync(makeCommands)
  const value = {
    view: external(view),
    screen: external<Screen>(Screen.Dashboard()),
    commands,
    appearance: external<Appearance>("dark"),
    themeOf,
    now: () => began + 60_000,
    questions: news,
  }
  await withRender(<Root value={value} />, { width: 155, height: 40 }, async (rendered) => {
    const panel = await until(rendered, (frame) => frame.chars.includes("reading its question"))
    const { x, y } = panelWhere(panel, "Add the flag")
    await rendered.input((setup) => setup.mockMouse.click(x + 1, y))

    const deadline = Date.now() + 5000
    let read: UiCommand | undefined
    while (read === undefined && Date.now() < deadline) {
      const offered: ReadonlyArray<UiCommand> = Effect.runSync(Queue.clear(commands))
      read = offered.find((each) => each._tag === "ReadQuestions")
      if (read === undefined) {
        await rendered.capture()
        await Bun.sleep(20)
      }
    }
    if (read?._tag !== "ReadQuestions") throw new Error("the box read no questions")
    // bd's open questions put another one first.
    await rendered.input(() =>
      news.set([QuestionNews.Read({ uuid: read.uuid, questions: [licence, flag] })]),
    )
    const box = await until(rendered, (frame) => frame.chars.includes("Open question"))
    expect(box.chars).toContain("Open question 2 of 2 · q-2")
    expect(box.chars).toContain("Which flag name?")
  })
})
