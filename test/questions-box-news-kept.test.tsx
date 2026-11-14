// The questions box keeps the questions it read (tutti-fnvd.6, src/ui/QuestionsBox.tsx): each
// answer adds news, and the screen keeps only the latest newsKept; once the box's own Read has
// fallen off them, the box still puts the questions left, and doesn't go back to reading them.
import { expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { tuttiScheme } from "../src/project/scheme.ts"
import { type Commands, makeCommands, type UiCommand } from "../src/run/commands.ts"
import { emptyTallies, type Entry as LedgerEntry } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { newsKept, QuestionNews } from "../src/run/questionNews.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { readingText } from "../src/ui/QuestionsBox.tsx"
import type { OpenQuestion } from "../src/ui/questions.ts"
import { type Appearance, makeTheme } from "../src/ui/theme.ts"
import { external } from "../src/ui/useRunView.ts"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(tuttiScheme, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 10, 8, 9, 0, 0).getTime()

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

const question = (n: number): OpenQuestion => ({
  id: `q-${n}` as TicketId,
  title: `Question number ${n}?`,
  description: "",
  options: [{ label: "Yes", description: "" }],
  maintainerOnly: false,
  waiting: [],
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

test("past newsKept answers, the box still puts the questions it read", async () => {
  const news = external<ReadonlyArray<QuestionNews>>([])
  const commands = Effect.runSync(makeCommands)
  const count = newsKept + 2
  const questions = Array.from({ length: count }, (_, i) => question(i + 1))
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
      await until(rendered, has("t-1"))
      await rendered.input((setup) => setup.mockInput.pressKey("A", { shift: true }))
      await until(rendered, has(readingText))
      const read = taken(commands).find((command) => command._tag === "ReadQuestions")
      if (read?._tag !== "ReadQuestions") throw new Error("the box read nothing")
      await rendered.input(() => news.set([QuestionNews.Read({ uuid: read.uuid, questions })]))

      // Each answer recorded as the run would, the oldest news dropped past newsKept.
      for (let n = 1; n <= newsKept; n++) {
        await until(rendered, has(`Open question ${n} of ${count} · q-${n}`))
        await rendered.input((setup) => setup.mockInput.pressEnter())
        const answer = taken(commands).find((command) => command._tag === "AnswerQuestion")
        if (answer?._tag !== "AnswerQuestion") throw new Error(`no answer to q-${n}`)
        const answered = QuestionNews.Answered({
          uuid: answer.uuid,
          question: answer.question,
          title: `Question number ${n}?`,
          decided: [],
        })
        await rendered.input(() => news.set([...news.get(), answered].slice(-newsKept)))
      }
      expect(news.get().some((each) => each._tag === "Read")).toBe(false)

      const next = `Open question ${newsKept + 1} of ${count} · q-${newsKept + 1}`
      const frame = await until(rendered, has(next))
      expect(frame.chars).toContain(next)
      expect(frame.chars).not.toContain(readingText)
    },
  )
})
