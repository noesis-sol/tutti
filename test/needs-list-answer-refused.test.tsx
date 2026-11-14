// A question whose answer from the Needs you list bd refuses (tutti-zpzj, § 7.2): answered from the
// list it leaves the list at once, before the run's next look; the run's news saying NotAnswered,
// under that answer's uuid, brings it back, for good, whatever news comes after, and a failure of
// another answer doesn't, and a refusal while the questions box is over the list holds for the list
// that box goes back to.
import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { tuttiScheme } from "../src/project/scheme.ts"
import { type Commands, makeCommands, type UiCommand } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { newsKept, QuestionNews } from "../src/run/questionNews.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { Box } from "../src/ui/keys.ts"
import { listReadingText } from "../src/ui/NeedsList.tsx"
import { withoutRefused } from "../src/ui/QuestionsBox.tsx"
import type { OpenQuestion } from "../src/ui/questions.ts"
import { type Appearance, makeTheme } from "../src/ui/theme.ts"
import { external, type Settable } from "../src/ui/useRunView.ts"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(tuttiScheme, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 10, 4, 8, 0, 0).getTime()

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

const entries = [asked("a-1", "Add the flag", "q-1", 0), asked("a-2", "Add a licence", "q-2", 1)]

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
    questions: new Map([
      ["q-1", flag],
      ["q-2", licence],
    ]),
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

/** What a scene's steps act on. */
interface At {
  readonly news: Settable<ReadonlyArray<QuestionNews>>
  readonly commands: Commands
  readonly rendered: Rendered
}

/** Waits for the box or the list to offer ReadQuestions, and has the run read both questions. */
const reads = async ({ news, commands, rendered }: At): Promise<void> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const offered: ReadonlyArray<UiCommand> = Effect.runSync(Queue.clear(commands))
    const read = offered.find((each) => each._tag === "ReadQuestions")
    if (read?._tag === "ReadQuestions") {
      const questions = [flag, licence]
      await rendered.input(() =>
        news.set([...news.get(), QuestionNews.Read({ uuid: read.uuid, questions })]),
      )
      return
    }
    if (Date.now() > deadline) throw new Error("nothing read the questions")
    await rendered.capture()
    await Bun.sleep(20)
  }
}

const enter = (rendered: Rendered) => rendered.input((setup) => setup.mockInput.pressEnter())

/** The list open and read, on a dashboard too narrow for the panel. */
const openList = async (at: At) => {
  await until(at.rendered, has("Which flag name?"))
  await at.rendered.input((setup) => setup.mockInput.pressTab())
  await enter(at.rendered)
  await reads(at)
  const read = (frame: Frame) => !frame.chars.includes(listReadingText)
  expect(has("> ? q-1")(await until(at.rendered, read))).toBe(true)
}

/** Opens the chosen question, `id`, in the questions box, and has the run read it. */
const openQuestion = async (at: At, id: string) => {
  await enter(at.rendered)
  await reads(at)
  await until(at.rendered, has(`Open question 1 of 1 · ${id}`))
}

/** Answers `id`, open in the questions box, back to the list, which reads it; the answer's uuid. */
const give = async (at: At, id: string): Promise<string> => {
  await enter(at.rendered)
  const offered: ReadonlyArray<UiCommand> = Effect.runSync(Queue.clear(at.commands))
  const given = offered.find((each) => each._tag === "AnswerQuestion")
  if (given === undefined) throw new Error("no answer was offered")
  const read = offered.find((each) => each._tag === "ReadQuestions")
  if (read?._tag === "ReadQuestions") {
    await at.rendered.input(() =>
      at.news.set([
        ...at.news.get(),
        QuestionNews.Read({ uuid: read.uuid, questions: [flag, licence] }),
      ]),
    )
  } else await reads(at)
  const gone = await until(at.rendered, (frame) => !frame.chars.includes(`? ${id}`))
  expect(gone.chars).not.toContain(`? ${id}`)
  return given.uuid
}

/** Answers the chosen question, `id`, from the list and back to it; the answer's uuid. */
const answer = async (at: At, id: string): Promise<string> => {
  await openQuestion(at, id)
  return give(at, id)
}

const refusal = (uuid: string, on = "q-1") =>
  QuestionNews.NotAnswered({ uuid, question: on as TicketId, why: "bd is locked" })

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

describe("a question whose answer from the Needs you list bd refuses", () => {
  test("comes back to the open list, its toast saying why", async () => {
    await scene(async (at) => {
      await openList(at)
      const uuid = await answer(at, "q-1")
      await at.rendered.input(() => at.news.set([...at.news.get(), refusal(uuid)]))
      const back = await until(at.rendered, has("? q-1"))
      expect(back.chars).toContain("? q-1 Which flag name?")
      expect(back.chars).toContain("couldn't record the answer to q-1: bd is locked")
    })
  })

  test("can be answered again, and the earlier failure doesn't bring it back", async () => {
    await scene(async (at) => {
      await openList(at)
      const first = await answer(at, "q-1")
      await at.rendered.input(() => at.news.set([...at.news.get(), refusal(first)]))
      // It is back at the list's top, under the choice.
      await until(at.rendered, has("> ? q-1"))

      const second = await answer(at, "q-1")
      expect(second).not.toBe(first)
      await at.rendered.input(() =>
        at.news.set([...at.news.get(), QuestionNews.Read({ uuid: "u-read", questions: [] })]),
      )
      await Bun.sleep(50)
      expect((await at.rendered.capture()).chars).not.toContain("? q-1")

      await at.rendered.input(() => at.news.set([...at.news.get(), refusal(second)]))
      expect((await until(at.rendered, has("? q-1"))).chars).toContain("? q-1")
    })
  })

  test("stays back once the news has dropped its failure", async () => {
    await scene(async (at) => {
      await openList(at)
      const uuid = await answer(at, "q-1")
      await at.rendered.input(() => at.news.set([...at.news.get(), refusal(uuid)]))
      await until(at.rendered, has("? q-1"))
      const later = Array.from({ length: newsKept }, (_, i) =>
        QuestionNews.Read({ uuid: `u-${i}`, questions: [] }),
      )
      await at.rendered.input(() => at.news.set(later))
      await Bun.sleep(50)
      expect((await at.rendered.capture()).chars).toContain("? q-1")
    })
  })

  test("another answer's failure, or this one recorded, leaves it out", async () => {
    await scene(async (at) => {
      await openList(at)
      const uuid = await answer(at, "q-1")
      await at.rendered.input(() => at.news.set([...at.news.get(), refusal("u-other")]))
      await Bun.sleep(50)
      expect((await at.rendered.capture()).chars).not.toContain("? q-1")

      await at.rendered.input(() =>
        at.news.set([
          ...at.news.get(),
          QuestionNews.Answered({
            uuid,
            question: "q-1" as TicketId,
            title: flag.title,
            decided: [],
          }),
        ]),
      )
      await Bun.sleep(50)
      expect((await at.rendered.capture()).chars).not.toContain("? q-1")
    })
  })

  test("refused while the next question's box is open, it is in the list that box goes back to", async () => {
    await scene(async (at) => {
      await openList(at)
      const uuid = await answer(at, "q-1")
      await until(at.rendered, has("> ? q-2"))
      await openQuestion(at, "q-2")

      // The refusal, then so much news that the list, opening again, can't find it there.
      await at.rendered.input(() => at.news.set([...at.news.get(), refusal(uuid)]))
      await Bun.sleep(50)
      const boxRead = at.news.get().findLast((each) => each._tag === "Read")
      if (boxRead === undefined) throw new Error("the box read nothing")
      const later = Array.from({ length: newsKept - 1 }, (_, i) =>
        QuestionNews.Read({ uuid: `u-${i}`, questions: [] }),
      )
      await at.rendered.input(() => at.news.set([...later, boxRead]))
      await Bun.sleep(50)

      await give(at, "q-2")
      const back = await until(at.rendered, has("? q-1"))
      expect(back.chars).toContain("? q-1 Which flag name?")
      expect(back.chars).not.toContain("? q-2")
    })
  })
})

describe("withoutRefused", () => {
  const given = { uuid: "u-1", question: "q-1" }
  const other = { uuid: "u-2", question: "q-2" }
  const refused = new Set(["u-1"])

  test("takes the refused answer out of the list's, its place kept", () => {
    expect(withoutRefused(Box.Needs({ at: 2, answered: [given, other] }), refused)).toEqual(
      Box.Needs({ at: 2, answered: [other] }),
    )
  })

  test("takes it out of what the questions box goes back to", () => {
    const first = "q-2" as TicketId
    expect(
      withoutRefused(Box.Questions({ first, back: { at: 1, answered: [given] } }), refused),
    ).toEqual(Box.Questions({ first, back: { at: 1, answered: [] } }))
  })

  test("leaves as it is a box holding no refused answer, or none at all", () => {
    const list = Box.Needs({ at: 0, answered: [other] })
    expect(withoutRefused(list, refused)).toBe(list)
    const questions = Box.Questions({})
    expect(withoutRefused(questions, refused)).toBe(questions)
    expect(withoutRefused(null, refused)).toBeNull()
  })
})
