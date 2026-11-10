// The questions box opened at a question no longer open (tutti-34k9.5, § 7.2): answered outside the
// dashboard (tutti answer, bd by hand) before the run's look has taken its ticket back, Enter on
// its Asked row, a click on the panel's title, or Shift+A in its worker's view opened the box at
// another question as if it were the one asked for, whose Enter answered it. Now the box closes
// with the toast the Needs you list's path gives, `<id> is already answered`, whoever opened it; and
// its first frame with the questions is at the question asked for, the index derived in the render
// rather than set in an effect after a frame at the first question.
import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import fc from "fast-check"
import { type Commands, makeCommands, type UiCommand } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { QuestionNews } from "../src/run/questionNews.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { noneOpenText, placed, readingText } from "../src/ui/QuestionsBox.tsx"
import type { OpenQuestion } from "../src/ui/questions.ts"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type Settable } from "../src/ui/useRunView.ts"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 10, 10, 9, 0, 0).getTime()

const question = (id: string, title: string, waiting: ReadonlyArray<string>): OpenQuestion => ({
  id: id as TicketId,
  title,
  description: "",
  options: [{ label: "Yes", description: "the usual" }],
  maintainerOnly: false,
  waiting: waiting.map((each) => each as TicketId),
})

/** t-1 waits on it. */
const flag = question("q-1", "Which flag name?", ["t-1"])
/** Open in the run's scope, no ticket waiting on it. */
const licence = question("q-3", "Which licence?", [])

const asked: Entry = {
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

/** t-1 Asked, the look having read q-1. */
const view: RunView = project({
  ledger: { tickets: new Map([[asked.ticket, asked]]), rows: 1, windDown: null, bugs: [] },
  workers: new Map(),
  requests: [],
  status: {
    ...emptyStatus,
    version: "0.1.0",
    branch: "batch",
    began,
    concurrency: 1,
    questions: new Map([["q-1", flag]]),
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

/** The commands sent since the last call. */
const taken = (commands: Commands): ReadonlyArray<UiCommand> =>
  Effect.runSync(Queue.clear(commands))

/** The first ReadQuestions' uuid among `commands`, waiting for the box to offer one. */
const readUuid = async (rendered: Rendered, commands: Commands): Promise<string> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const read = taken(commands).find((command) => command._tag === "ReadQuestions")
    if (read?._tag === "ReadQuestions") return read.uuid
    if (Date.now() > deadline) throw new Error("the box read no questions")
    await rendered.capture()
    await Bun.sleep(20)
  }
}

/** The line and column of `text` in `frame`, to click on it. */
const placeOf = (frame: Frame, text: string): { readonly x: number; readonly y: number } => {
  const lines = frame.chars.split("\n")
  const y = lines.findIndex((line) => line.includes(text))
  return { x: lines[y]?.indexOf(text) ?? -1, y }
}

/** Where `text` is last on the first line that holds it twice: the panel's, right of the table's. */
const panelWhere = (frame: Frame, text: string): { readonly x: number; readonly y: number } => {
  const lines = frame.chars.split("\n")
  const y = lines.findIndex((line) => line.indexOf(text) !== line.lastIndexOf(text))
  if (y === -1) throw new Error(`no line holds ${text} twice`)
  return { x: (lines[y] ?? "").lastIndexOf(text), y }
}

interface At {
  readonly news: Settable<ReadonlyArray<QuestionNews>>
  readonly commands: Commands
  readonly rendered: Rendered
}

const scene = async (
  screen: Screen,
  size: { readonly width: number; readonly height: number },
  body: (at: At) => Promise<void>,
) => {
  const news = external<ReadonlyArray<QuestionNews>>([])
  const commands = Effect.runSync(makeCommands)
  await withRender(
    <Root
      value={{
        view: external(view),
        screen: external<Screen>(screen),
        commands,
        appearance: external<Appearance>("dark"),
        themeOf,
        now: () => began + 60_000,
        questions: news,
      }}
    />,
    size,
    (rendered) => body({ news, commands, rendered }),
  )
}

/** Has the box, which offered ReadQuestions, read `questions` open, q-1 among them or not. */
const reads = async (at: At, questions: ReadonlyArray<OpenQuestion>): Promise<void> => {
  const uuid = await readUuid(at.rendered, at.commands)
  await at.rendered.input(() =>
    at.news.set([...at.news.get(), QuestionNews.Read({ uuid, questions })]),
  )
}

/** The box opened at q-1, read as closed meanwhile: the toast, and no question put. */
const closedMeanwhile = async (at: At, open: ReadonlyArray<OpenQuestion>): Promise<Frame> => {
  await reads(at, open)
  const said = await until(at.rendered, has("q-1 is already answered"))
  expect(said.chars).toContain("q-1 is already answered")
  expect(said.chars).not.toContain("Open question")
  expect(said.chars).not.toContain(readingText)
  // Nothing answered in its place.
  expect(taken(at.commands).some((command) => command._tag === "AnswerQuestion")).toBe(false)
  return said
}

const narrow = { width: 100, height: 30 }
const wide = { width: 155, height: 40 }

describe("the questions box opened at a question no longer open", () => {
  test("from Enter on its Asked row: says it is already answered, and closes", async () => {
    await scene(Screen.Dashboard(), narrow, async (at) => {
      await until(at.rendered, has("Which flag name?"))
      // Going in selects the one row, t-1's; Enter on it opens the box at q-1.
      await at.rendered.input((setup) => {
        setup.mockInput.pressEnter()
        setup.mockInput.pressEnter()
      })
      const said = await closedMeanwhile(at, [licence])
      // The dashboard is back, the table's row as the look still has it.
      expect(said.chars).toContain("Which flag name?")
    })
  })

  test("from a click on the panel's title: says it is already answered, and closes", async () => {
    await scene(Screen.Dashboard(), wide, async (at) => {
      const panel = await until(at.rendered, has("q-1 · t-1 waits on it"))
      const { x, y } = panelWhere(panel, "Which flag name?")
      await at.rendered.input((setup) => setup.mockMouse.click(x + 1, y))
      await closedMeanwhile(at, [licence])
    })
  })

  test("from Shift+A in its worker's view, none open: says so, not No open questions", async () => {
    await scene(Screen.Worker({ ticket: "t-1" as TicketId }), narrow, async (at) => {
      await until(at.rendered, has("[ Answer ]"))
      await at.rendered.input((setup) => setup.mockInput.pressKey("A", { shift: true }))
      const said = await closedMeanwhile(at, [])
      expect(said.chars).not.toContain(noneOpenText)
      // The worker's view is still up.
      expect(said.chars).toContain("[ Answer ]")
    })
  })

  test("from the Answer button in its worker's view: says it is already answered", async () => {
    await scene(Screen.Worker({ ticket: "t-1" as TicketId }), narrow, async (at) => {
      const frame = await until(at.rendered, has("[ Answer ]"))
      const { x, y } = placeOf(frame, "[ Answer ]")
      await at.rendered.input((setup) => setup.mockMouse.click(x + 2, y))
      await closedMeanwhile(at, [licence])
    })
  })
})

describe("the questions box opened at a question still open", () => {
  test("is at it in its first frame with the questions, another one read first", async () => {
    await scene(Screen.Dashboard(), narrow, async (at) => {
      await until(at.rendered, has("Which flag name?"))
      await at.rendered.input((setup) => {
        setup.mockInput.pressEnter()
        setup.mockInput.pressEnter()
      })
      await reads(at, [licence, flag])
      // The frame drawn with the read, not one awaited: the box is at q-1 from the first.
      const first = await at.rendered.capture()
      expect(first.chars).toContain("Open question 2 of 2 · q-1")
      expect(first.chars).not.toContain("Open question 1 of 2")
      // Enter answers q-1, not the question read first.
      await at.rendered.input((setup) => setup.mockInput.pressEnter())
      const answered = taken(at.commands).filter((command) => command._tag === "AnswerQuestion")
      expect(answered.map((command) => command.question)).toEqual([flag.id])
    })
  })
})

describe("placed", () => {
  const ids = fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 1 })
  const of = (list: ReadonlyArray<string>) => list.map((id) => question(id, `About ${id}`, []))

  test("starts at first where it is among the questions read, and puts them all", () => {
    fc.assert(
      fc.property(ids, fc.nat(), (list, pick) => {
        const read = of(list)
        const first = list[pick % list.length] as TicketId
        const { questions, start } = placed(read, first, undefined)
        return questions === read && questions[start]?.id === first
      }),
    )
  })

  test("starts at -1 where first isn't among them, and at the first with none asked for", () => {
    fc.assert(
      fc.property(ids, fc.string({ minLength: 1 }), (list, other) => {
        fc.pre(!list.includes(other))
        const read = of(list)
        return (
          placed(read, other as TicketId, undefined).start === -1 &&
          placed(read, undefined, undefined).start === 0 &&
          placed([], other as TicketId, undefined).start === -1 &&
          placed([], undefined, undefined).start === 0
        )
      }),
    )
  })

  test("from the Needs you list, puts first alone, or none where it is closed", () => {
    const back = { at: 0, answered: [] }
    expect(placed([licence, flag], flag.id, back)).toEqual({ questions: [flag], start: 0 })
    expect(placed([licence], flag.id, back)).toEqual({ questions: [], start: -1 })
  })
})
