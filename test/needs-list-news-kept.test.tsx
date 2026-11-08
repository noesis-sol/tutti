// The Needs you list keeps the questions it read (tutti-fgpz, src/ui/NeedsList.tsx): news of answers
// and talks comes in while it stays open, and the screen keeps only the latest newsKept; once the
// list's own Read has fallen off them, the list still puts its questions, and doesn't go back to
// reading them.
import { expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { type Commands, makeCommands, type UiCommand } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { newsKept, QuestionNews } from "../src/run/questionNews.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { listReadingText } from "../src/ui/NeedsList.tsx"
import type { OpenQuestion } from "../src/ui/questions.ts"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external } from "../src/ui/useRunView.ts"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 10, 8, 10, 0, 0).getTime()

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

/** The commands sent since the last call. */
const taken = (commands: Commands): ReadonlyArray<UiCommand> =>
  Effect.runSync(Queue.clear(commands))

test("past newsKept news from elsewhere, the list still puts the questions it read", async () => {
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
    async (rendered) => {
      await until(rendered, has("Which flag name?"))
      await rendered.input((setup) => setup.mockInput.pressTab())
      await rendered.input((setup) => setup.mockInput.pressEnter())
      await until(rendered, has(listReadingText))
      const read = taken(commands).find((command) => command._tag === "ReadQuestions")
      if (read?._tag !== "ReadQuestions") throw new Error("the list read nothing")
      await rendered.input(() =>
        news.set([QuestionNews.Read({ uuid: read.uuid, questions: [flag, licence] })]),
      )
      await until(rendered, (frame) => !frame.chars.includes(listReadingText))

      // Answers to other questions recorded meanwhile, the oldest news dropped past newsKept.
      for (let n = 1; n <= newsKept; n++) {
        const answered = QuestionNews.Answered({
          uuid: `elsewhere-${n}`,
          question: `q-other-${n}` as TicketId,
          title: `Another question ${n}?`,
          decided: [],
        })
        await rendered.input(() => news.set([...news.get(), answered].slice(-newsKept)))
      }
      expect(news.get().some((each) => each._tag === "Read")).toBe(false)

      await rendered.capture()
      const frame = await rendered.capture()
      expect(frame.chars).toContain("> ? q-1 Which flag name?")
      expect(frame.chars).toContain("? q-2 Which licence?")
      expect(frame.chars).not.toContain(listReadingText)
    },
  )
})
