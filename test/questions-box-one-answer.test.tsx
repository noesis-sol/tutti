// The questions box takes one answer per question (tutti-kr6y; src/ui/QuestionsBox.tsx): two Enters
// in one read answer the question put and show the next, unanswered; an Enter at the next question
// before `settle` ms have passed since the box went on to it answers nothing, and one after does.
import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { tuttiScheme } from "../src/project/scheme.ts"
import { type Commands, makeCommands, type UiCommand } from "../src/run/commands.ts"
import { emptyTallies, type Entry as LedgerEntry } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { QuestionNews } from "../src/run/questionNews.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { settle } from "../src/ui/attentionKeys.ts"
import { readingText } from "../src/ui/QuestionsBox.tsx"
import type { OpenQuestion } from "../src/ui/questions.ts"
import { type Appearance, makeTheme } from "../src/ui/theme.ts"
import { external, type Settable } from "../src/ui/useRunView.ts"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(tuttiScheme, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 10, 16, 9, 0, 0).getTime()

/** t-1, Asked: it waits on your answer to q-1. */
const asked: LedgerEntry = {
  ticket: "t-1" as TicketId,
  title: "Add the flag",
  phase: TicketPhase.Asked({ question: "q-1" }),
  since: began,
  worker: null,
  row: 0,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
}

const view: RunView = project({
  ledger: { tickets: new Map([["t-1" as TicketId, asked]]), rows: 1, windDown: null, bugs: [] },
  workers: new Map(),
  requests: [],
  status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 1 },
  actions: new Map(),
})

/** Question `n`, with two options. */
const questionOf = (n: number, title: string): OpenQuestion => ({
  id: `q-${n}` as TicketId,
  title,
  description: "",
  options: [
    { label: `yes-${n}`, description: "go ahead" },
    { label: `no-${n}`, description: "leave it" },
  ],
  maintainerOnly: false,
  waiting: [],
})

const questions = [
  questionOf(1, "Ship the flag?"),
  questionOf(2, "Rename the file?"),
  questionOf(3, "Drop the alias?"),
]

/** The answers offered since the last call, as question and answer. */
const answers = (commands: Commands): ReadonlyArray<string> =>
  Effect.runSync(Queue.clear(commands)).flatMap((command: UiCommand) =>
    command._tag === "AnswerQuestion" ? [`${command.question} ${command.answer}`] : [],
  )

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

/** The box open at the first of `questions`, on a clock that moves only with `pass`. */
const scene = async (
  body: (at: {
    readonly commands: Commands
    readonly rendered: Rendered
    readonly pass: (ms: number) => void
  }) => Promise<void>,
) => {
  const news = external<ReadonlyArray<QuestionNews>>([])
  const commands = Effect.runSync(makeCommands)
  let time = began + 60_000
  await withRender(
    <Root
      value={{
        view: external(view),
        screen: external<Screen>(Screen.Dashboard()),
        commands,
        appearance: external<Appearance>("dark"),
        themeOf,
        now: () => time,
        questions: news as Settable<ReadonlyArray<QuestionNews>>,
      }}
    />,
    { width: 100, height: 30 },
    async (rendered) => {
      await until(rendered, has("t-1"))
      await rendered.input((setup) => setup.mockInput.pressKey("A", { shift: true }))
      await until(rendered, has(readingText))
      const read = Effect.runSync(Queue.clear(commands)).find(
        (command) => command._tag === "ReadQuestions",
      )
      const uuid = read?._tag === "ReadQuestions" ? read.uuid : ""
      await rendered.input(() => news.set([QuestionNews.Read({ uuid, questions })]))
      await until(rendered, has("Ship the flag?"))
      await body({
        commands,
        rendered,
        pass: (ms) => {
          time += ms
        },
      })
    },
  )
}

describe("the questions box takes one answer per question", () => {
  test("two Enters in one read answer the first question once and show the second", async () => {
    await scene(async ({ commands, rendered }) => {
      await rendered.input((setup) => {
        setup.mockInput.pressEnter()
        setup.mockInput.pressEnter()
      })
      const frame = await until(rendered, has("Rename the file?"))
      expect(frame.chars).toContain("Open question 2 of 3 · q-2")
      expect(answers(commands)).toEqual(["q-1 yes-1"])
    })
  })

  test("an Enter at the next question before the settle answers nothing; one after does", async () => {
    await scene(async ({ commands, rendered, pass }) => {
      await rendered.input((setup) => setup.mockInput.pressEnter())
      await until(rendered, has("Rename the file?"))
      await rendered.input((setup) => setup.mockInput.pressEnter())
      const early = await rendered.capture()
      expect(early.chars).toContain("Open question 2 of 3 · q-2")
      expect(answers(commands)).toEqual(["q-1 yes-1"])

      pass(settle - 1)
      await rendered.input((setup) => setup.mockInput.pressEnter())
      expect((await rendered.capture()).chars).toContain("Rename the file?")
      expect(answers(commands)).toEqual([])

      pass(1)
      await rendered.input((setup) => setup.mockInput.pressEnter())
      const third = await until(rendered, has("Drop the alias?"))
      expect(third.chars).toContain("Open question 3 of 3 · q-3")
      expect(answers(commands)).toEqual(["q-2 yes-2"])
    })
  })
})
