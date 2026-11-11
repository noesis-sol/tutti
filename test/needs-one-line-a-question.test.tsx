// Two Asked tickets waiting on one question (tutti-fnvd.20, § 7.2): the Needs you list has one line
// for it, not one a ticket, naming the tickets while it hasn't read the question; answered from the
// list, that one line leaves it, and the list opens again at the question after it, none skipped.
import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { orchestra } from "../src/project/scheme.ts"
import { type Commands, makeCommands, type UiCommand } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { QuestionNews } from "../src/run/questionNews.ts"
import { emptyStatus, Need, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { itemLine, listReadingText, needsItems, questionOf } from "../src/ui/NeedsList.tsx"
import type { OpenQuestion } from "../src/ui/questions.ts"
import { type Appearance, makeTheme } from "../src/ui/theme.ts"
import { external, type Settable } from "../src/ui/useRunView.ts"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 10, 8, 8, 0, 0).getTime()

const question = (id: string, title: string, waiting: ReadonlyArray<string>): OpenQuestion => ({
  id: id as TicketId,
  title,
  description: "",
  options: [{ label: "Yes", description: "" }],
  maintainerOnly: false,
  waiting: waiting.map((each) => each as TicketId),
})

const flag = question("q-1", "Which flag name?", ["a-1", "a-2"])
const licence = question("q-2", "Which licence?", ["a-3"])
const colour = question("q-3", "Which colour?", ["a-4"])
const questions = [flag, licence, colour]

const asked = (ticket: string, title: string, on: string, row: number): Entry => ({
  ticket: ticket as TicketId,
  title,
  phase: TicketPhase.Asked({ question: on }),
  since: began,
  worker: null,
  row,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

const entries = [
  asked("a-1", "Add the flag", "q-1", 0),
  asked("a-2", "Document the flag", "q-1", 1),
  asked("a-3", "Add a licence", "q-2", 2),
  asked("a-4", "Paint it", "q-3", 3),
]

const view: RunView = project({
  ledger: {
    tickets: new Map(entries.map((each) => [each.ticket, each])),
    rows: entries.length,
    windDown: null,
    bugs: [],
  },
  workers: new Map(),
  requests: [],
  status: {
    ...emptyStatus,
    version: "0.1.0",
    branch: "batch",
    began,
    concurrency: 1,
    questions: new Map(questions.map((each) => [each.id, each])),
  },
  actions: new Map(),
})

const has = (text: string) => (frame: Frame) => frame.chars.includes(text)

/** Captures frames until `ready` holds of one. */
const until = async (rendered: Rendered, ready: (frame: Frame) => boolean): Promise<Frame> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const frame = await rendered.capture()
    if (ready(frame) || Date.now() > deadline) return frame
    await Bun.sleep(20)
  }
}

interface At {
  readonly news: Settable<ReadonlyArray<QuestionNews>>
  readonly commands: Commands
  readonly rendered: Rendered
}

/** Has the run read `open` for the ReadQuestions among `offered`, else for the next one offered. */
const reads = async (
  at: At,
  open: ReadonlyArray<OpenQuestion>,
  offered: ReadonlyArray<UiCommand> = [],
): Promise<void> => {
  const deadline = Date.now() + 5000
  for (let now = offered; ; now = Effect.runSync(Queue.clear(at.commands))) {
    const read = now.find((each) => each._tag === "ReadQuestions")
    if (read?._tag === "ReadQuestions") {
      await at.rendered.input(() =>
        at.news.set([...at.news.get(), QuestionNews.Read({ uuid: read.uuid, questions: open })]),
      )
      return
    }
    if (Date.now() > deadline) throw new Error("nothing read the questions")
    await at.rendered.capture()
    await Bun.sleep(20)
  }
}

const enter = (rendered: Rendered) => rendered.input((setup) => setup.mockInput.pressEnter())

/** Opens the list, on a dashboard too narrow for the panel, and has the run read the questions. */
const openList = async (at: At): Promise<Frame> => {
  await until(at.rendered, has("Which flag name?"))
  await at.rendered.input((setup) => setup.mockInput.pressTab())
  await enter(at.rendered)
  await reads(at, questions)
  return until(at.rendered, (frame) => !frame.chars.includes(listReadingText))
}

const scene = async (body: (at: At) => Promise<void>) => {
  const news = external<ReadonlyArray<QuestionNews>>([])
  const commands = Effect.runSync(makeCommands)
  await withRender(
    <Root
      value={{
        view: external(view),
        screen: external<Screen>(Screen.Dashboard()),
        commands,
        appearance: external<Appearance>("dark"),
        themeOf,
        now: () => began + 60_000,
        questions: news,
      }}
    />,
    { width: 100, height: 30 },
    (rendered) => body({ news, commands, rendered }),
  )
}

const count = (text: string, part: string) => text.split(part).length - 1

describe("two Asked tickets on one question, in the Needs you list", () => {
  test("are one line", async () => {
    await scene(async (at) => {
      const list = await openList(at)
      expect(count(list.chars, "? q-1")).toBe(1)
      expect(list.chars).toContain("> ? q-1 Which flag name?")
      expect(list.chars).toContain("? q-2 Which licence?")
      expect(list.chars).toContain("? q-3 Which colour?")
    })
  })

  test("answered, the list opens again at the question after it", async () => {
    await scene(async (at) => {
      await openList(at)
      await enter(at.rendered)
      await reads(at, questions)
      await until(at.rendered, has("Open question 1 of 1 · q-1"))
      await enter(at.rendered)
      const offered: ReadonlyArray<UiCommand> = Effect.runSync(Queue.clear(at.commands))
      expect(offered.some((each) => each._tag === "AnswerQuestion")).toBe(true)
      await reads(at, questions, offered)
      const back = await until(at.rendered, has("> ? q-2"))
      expect(back.chars).not.toContain("? q-1")
      expect(back.chars).toContain("> ? q-2 Which licence?")
      expect(back.chars).toContain("? q-3 Which colour?")
    })
  })
})

describe("needsItems", () => {
  const needOf = (ticket: string, id: string, on: OpenQuestion | null = null) =>
    Need.Question({ ticket: ticket as TicketId, label: ticket, title: "", id, question: on })

  test("is one item a question, in the order its first ticket comes, the others with it", () => {
    const needs = [needOf("a-1", "q-1"), needOf("a-3", "q-2"), needOf("a-2", "q-1")]
    const items = needsItems(needs, new Set(), undefined)
    expect(items.map(questionOf)).toEqual(["q-1", "q-2"])
    const [first] = items
    const also = first?._tag === "Need" ? first.also.map((need) => need.label) : []
    expect(also).toEqual(["a-2"])
  })

  test("leaves out an answered question whichever tickets ask it", () => {
    const needs = [needOf("a-1", "q-1"), needOf("a-3", "q-2"), needOf("a-2", "q-1")]
    expect(needsItems(needs, new Set(["q-1"]), undefined).map(questionOf)).toEqual(["q-2"])
  })

  test("names each ticket on a question it hasn't read", () => {
    const theme = themeOf("dark")
    const [item] = needsItems([needOf("a-1", "q-1"), needOf("a-2", "q-1")], new Set(), undefined)
    if (item === undefined) throw new Error("no item")
    const line = itemLine(item, theme, false, 80)
      .map((each) => each.text)
      .join("")
    expect(line).toContain("? q-1 a-1, a-2 wait on it")
    const [one] = needsItems([needOf("a-1", "q-1")], new Set(), undefined)
    if (one === undefined) throw new Error("no item")
    expect(
      itemLine(one, theme, false, 80)
        .map((each) => each.text)
        .join(""),
    ).toContain("? q-1 a-1 waits on it")
  })
})
