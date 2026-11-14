// Talk it through from the Needs you list (tutti-fnvd.7, § 7.3): the questions box opened from the
// list puts its question alone, and a talk from it comes back to the list as an answer in the box
// does: once the talk gave an answer, the list opens again at the next item, the answered question
// left out; a talk without one opens the box at the same question, whose Esc goes back to the list.
import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { talkLeftWhy } from "../src/agent/answerTalk.ts"
import { tuttiScheme } from "../src/project/scheme.ts"
import { type Commands, makeCommands, type UiCommand } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { QuestionNews } from "../src/run/questionNews.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { Box } from "../src/ui/keys.ts"
import { listReadingText } from "../src/ui/NeedsList.tsx"
import { returnTo } from "../src/ui/QuestionsBox.tsx"
import type { OpenQuestion } from "../src/ui/questions.ts"
import { type Appearance, makeTheme } from "../src/ui/theme.ts"
import { external, type Settable } from "../src/ui/useRunView.ts"
import { type Frame, pressEscape, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(tuttiScheme, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 10, 8, 8, 0, 0).getTime()

const question = (id: string, title: string, waiting: string): OpenQuestion => ({
  id: id as TicketId,
  title,
  description: "",
  options: [{ label: "Yes", description: "" }],
  maintainerOnly: false,
  waiting: [waiting as TicketId],
})

const flag = question("q-1", "Which flag name?", "a-1")
const licence = question("q-2", "Which licence?", "a-2")

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

const view: RunView = project({
  ledger: {
    tickets: new Map(
      [asked("a-1", "Add the flag", "q-1", 0), asked("a-2", "Add a licence", "q-2", 1)].map(
        (each) => [each.ticket, each],
      ),
    ),
    rows: 2,
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
    questions: new Map([flag, licence].map((each) => [each.id, each])),
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

/** Waits for a command of `tag` to be offered, the others taken with it. */
const offered = async <Tag extends UiCommand["_tag"]>(
  at: At,
  tag: Tag,
): Promise<Extract<UiCommand, { readonly _tag: Tag }>> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const taken: ReadonlyArray<UiCommand> = Effect.runSync(Queue.clear(at.commands))
    const found = taken.find((each) => each._tag === tag)
    if (found !== undefined) return found as Extract<UiCommand, { readonly _tag: Tag }>
    if (Date.now() > deadline) throw new Error(`nothing offered ${tag}`)
    await at.rendered.capture()
    await Bun.sleep(20)
  }
}

/** Has the run read `questions` open for the box or the list that offers ReadQuestions next. */
const reads = async (at: At, questions: ReadonlyArray<OpenQuestion>): Promise<void> => {
  const { uuid } = await offered(at, "ReadQuestions")
  await at.rendered.input(() =>
    at.news.set([...at.news.get(), QuestionNews.Read({ uuid, questions })]),
  )
}

const enter = (rendered: Rendered) => rendered.input((setup) => setup.mockInput.pressEnter())

/** Opens the list on a dashboard too narrow for the panel, then the box on its first question. */
const openOnFlag = async (at: At): Promise<void> => {
  await until(at.rendered, has("Which flag name?"))
  await at.rendered.input((setup) => setup.mockInput.pressTab())
  await enter(at.rendered)
  await reads(at, [flag, licence])
  await until(at.rendered, has("> ? q-1"))
  await enter(at.rendered)
  await reads(at, [flag, licence])
  await until(at.rendered, has("Open question 1 of 1"))
}

/** Picks Talk it through: after the one option and Other. Returns the talk's uuid. */
const talk = async (at: At): Promise<string> => {
  for (let i = 0; i < 2; i++) {
    await at.rendered.input((setup) => setup.mockInput.pressArrow("down"))
  }
  await until(at.rendered, has("> Talk it through"))
  await enter(at.rendered)
  const { uuid, question } = await offered(at, "TalkQuestion")
  expect(question).toBe("q-1" as TicketId)
  return uuid
}

const talked = (at: At, uuid: string, answered: boolean) =>
  at.rendered.input(() =>
    at.news.set([
      ...at.news.get(),
      QuestionNews.Talked({
        uuid,
        question: "q-1" as TicketId,
        answered,
        why: answered ? null : talkLeftWhy,
        next: null,
      }),
    ]),
  )

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

describe("Talk it through from the Needs you list", () => {
  test("once the talk gave an answer, the list opens again at the next item", async () => {
    await scene(async (at) => {
      await openOnFlag(at)
      const uuid = await talk(at)
      await talked(at, uuid, true)
      await reads(at, [licence])
      const list = await until(at.rendered, (frame) => !frame.chars.includes(listReadingText))
      expect(list.chars).toContain("> ? q-2 Which licence?")
      expect(list.chars).not.toContain("? q-1")
      expect(list.chars).not.toContain("Open question")
    })
  })

  test("a talk without an answer opens the box at its question alone, and Esc the list", async () => {
    await scene(async (at) => {
      await openOnFlag(at)
      const uuid = await talk(at)
      await talked(at, uuid, false)
      await reads(at, [flag, licence])
      const box = await until(at.rendered, has("Open question 1 of 1"))
      expect(box.chars).toContain("Which flag name?")
      await at.rendered.input((setup) => pressEscape(setup))
      await reads(at, [flag, licence])
      const list = await until(at.rendered, has("> ? q-2"))
      expect(list.chars).toContain("? q-1 Which flag name?")
      expect(list.chars).toContain("> ? q-2 Which licence?")
    })
  })
})

describe("returnTo, for a talk from the Needs you list", () => {
  const back = { at: 2, answered: [{ uuid: "u-0", question: "q-0" }] }
  const over = (answered: boolean) =>
    QuestionNews.Talked({
      uuid: "u-1",
      question: "q-1" as TicketId,
      answered,
      why: null,
      next: "q-2" as TicketId,
    })

  test("is the list at the same place once answered, the answer recorded under the talk's uuid", () => {
    expect(returnTo(over(true), back)).toEqual(
      Box.Needs({
        at: 2,
        answered: [
          { uuid: "u-0", question: "q-0" },
          { uuid: "u-1", question: "q-1" },
        ],
      }),
    )
  })

  test("is the box at the same question, the list kept, without an answer", () => {
    expect(returnTo(over(false), back)).toEqual(Box.Questions({ first: "q-1" as TicketId, back }))
  })
})
