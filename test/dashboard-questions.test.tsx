// Answering questions on the dashboard during a run (§ 7.2, tutti-kkb.35; src/ui/QuestionsBox.tsx):
// Shift+A opens the questions box, which offers ReadQuestions and says it is reading them until the
// run's news has them; each question is put in the answer form, its recommended option first, and an
// answer offers AnswerQuestion and goes on to the next; Leave open goes on without one; the toasts
// say how each answer went; with none open the box closes with a toast; Esc closes it. The hint
// names Shift+A while a ticket waits on a question.
import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { type Commands, makeCommands, type UiCommand } from "../src/run/commands.ts"
import { emptyTallies, type Entry as LedgerEntry } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { QuestionNews } from "../src/run/questionNews.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { dashboardHint, questionsWaiting } from "../src/ui/Dashboard.tsx"
import { noneOpenText, readingText } from "../src/ui/QuestionsBox.tsx"
import type { OpenQuestion } from "../src/ui/questions.ts"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type Settable } from "../src/ui/useRunView.ts"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 9, 27, 13, 0, 0).getTime()

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

/** RunView with t-1 Asked, or with no ticket. */
const viewOf = (waiting: boolean): RunView =>
  project({
    ledger: {
      tickets: new Map(waiting ? [["t-1" as TicketId, asked]] : []),
      rows: 1,
      windDown: null,
      bugs: [],
    },
    workers: new Map(),
    requests: [],
    status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 1 },
    actions: new Map(),
  })

const questions: ReadonlyArray<OpenQuestion> = [
  {
    id: "q-1" as TicketId,
    title: "Which flag name?",
    description: "The flag needs a name.",
    options: [
      { label: "--long-flag", description: "says what it does" },
      { label: "--flag", description: "short to type" },
    ],
    maintainerOnly: false,
    waiting: ["t-1" as TicketId],
  },
  {
    id: "q-2" as TicketId,
    title: "Which colour?",
    description: "",
    options: undefined,
    maintainerOnly: false,
    waiting: [],
  },
]

/** The commands sent since the last call. */
const taken = (commands: Commands): ReadonlyArray<UiCommand> =>
  Effect.runSync(Queue.clear(commands))

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

const scene = async (
  body: (at: {
    readonly news: Settable<ReadonlyArray<QuestionNews>>
    readonly commands: Commands
    readonly rendered: Rendered
  }) => Promise<void>,
) => {
  const news = external<ReadonlyArray<QuestionNews>>([])
  const commands = Effect.runSync(makeCommands)
  await withRender(
    <Root
      value={{
        view: external(viewOf(true)),
        screen: external<Screen>(Screen.Dashboard()),
        commands,
        appearance: external<Appearance>("dark"),
        themeOf,
        now: () => began + 67_000,
        questions: news,
      }}
    />,
    { width: 100, height: 30 },
    (rendered) => body({ news, commands, rendered }),
  )
}

const pressShiftA = (rendered: Rendered) =>
  rendered.input((setup) => setup.mockInput.pressKey("A", { shift: true }))

/** Opens the box, and gives the uuid of the ReadQuestions it offered. */
const open = async (rendered: Rendered, commands: Commands): Promise<string> => {
  await until(rendered, has("t-1"))
  await pressShiftA(rendered)
  await until(rendered, has(readingText))
  const read = taken(commands).find((command) => command._tag === "ReadQuestions")
  return read?._tag === "ReadQuestions" ? read.uuid : ""
}

describe("the dashboard's questions box", () => {
  test("Shift+A reads the questions, puts each, and answers with the recommended option", async () => {
    await scene(async ({ news, commands, rendered }) => {
      const uuid = await open(rendered, commands)
      expect(uuid).not.toBe("")
      await rendered.input(() => news.set([QuestionNews.Read({ uuid, questions })]))
      const first = await until(rendered, has("Which flag name?"))
      expect(first.chars).toContain("Open question 1 of 2 · q-1")
      expect(first.chars).toContain("> --long-flag (recommended) — says what it does")
      expect(first.chars).toContain("Esc close")

      await rendered.input((setup) => setup.mockInput.pressEnter())
      const second = await until(rendered, has("Which colour?"))
      expect(second.chars).toContain("Open question 2 of 2 · q-2")
      const answers = taken(commands).filter((command) => command._tag === "AnswerQuestion")
      expect(answers.map((each) => (each._tag === "AnswerQuestion" ? each.answer : ""))).toEqual([
        "--long-flag",
      ])
      const answered = answers[0]
      const answerUuid = answered?._tag === "AnswerQuestion" ? answered.uuid : ""

      // q-2 has no options: Other first, typed in, then Enter.
      await rendered.input(async (setup) => {
        await setup.mockInput.typeText("teal")
        setup.mockInput.pressEnter()
      })
      await rendered.input(() =>
        news.set([
          ...news.get(),
          QuestionNews.Answered({
            uuid: answerUuid,
            question: "q-1" as TicketId,
            title: "Which flag name?",
            decided: ["t-1" as TicketId],
          }),
        ]),
      )
      const after = await until(rendered, has("Answered q-1 (Which flag name?)"))
      expect(after.chars).not.toContain("Which colour?")
      const typed = taken(commands).filter((command) => command._tag === "AnswerQuestion")
      expect(typed.map((each) => (each._tag === "AnswerQuestion" ? each.answer : ""))).toEqual([
        "teal",
      ])
    })
  })

  test("Leave open goes on without an answer; a failed answer's toast says why", async () => {
    await scene(async ({ news, commands, rendered }) => {
      const uuid = await open(rendered, commands)
      await rendered.input(() =>
        news.set([QuestionNews.Read({ uuid, questions: [questions[1] as OpenQuestion] })]),
      )
      await until(rendered, has("Which colour?"))
      await rendered.input((setup) => {
        setup.mockInput.pressArrow("down")
        setup.mockInput.pressEnter()
      })
      const closed = await until(rendered, (frame) => !frame.chars.includes("Which colour?"))
      expect(closed.chars).not.toContain("Which colour?")
      expect(taken(commands).some((command) => command._tag === "AnswerQuestion")).toBe(false)

      await rendered.input(() =>
        news.set([
          ...news.get(),
          QuestionNews.NotAnswered({
            uuid: "u-x",
            question: "q-2" as TicketId,
            why: "bd is locked",
          }),
        ]),
      )
      const toast = await until(rendered, has("couldn't record the answer to q-2: bd is locked"))
      expect(toast.chars).toContain("couldn't record the answer to q-2: bd is locked")
    })
  })

  test("with none open, a toast says so and the box closes; Esc closes it while it reads", async () => {
    await scene(async ({ news, commands, rendered }) => {
      const uuid = await open(rendered, commands)
      await rendered.input(() => news.set([QuestionNews.Read({ uuid, questions: [] })]))
      const none = await until(rendered, has(noneOpenText))
      expect(none.chars).not.toContain(readingText)

      await open(rendered, commands)
      await rendered.input((setup) => setup.mockInput.pressEscape())
      const closed = await until(rendered, (frame) => !frame.chars.includes(readingText))
      expect(closed.chars).not.toContain(readingText)
    })
  })

  test("the hint names Shift+A while a ticket waits on a question", () => {
    expect(questionsWaiting(viewOf(true))).toBe(true)
    expect(questionsWaiting(viewOf(false))).toBe(false)
    const named = (view: RunView) => dashboardHint(view, true).some((key) => key.keys === "A")
    expect(named(viewOf(true))).toBe(true)
    expect(named(viewOf(false))).toBe(false)
  })
})
