// A question answered stays answered on the dashboard (tutti-cl5e, § 5.1, § 7.2): off the panel over
// a worker's view opened and closed, while the view still has its need, unless bd refuses that
// answer; off the panel once the news says it is recorded, however it was answered; and an answer
// that finds bd has the question closed says so plainly and brings nothing back.
import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { orchestra } from "../src/project/scheme.ts"
import { type Commands, makeCommands, type UiCommand } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { newsKept, QuestionNews } from "../src/run/questionNews.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { settle } from "../src/ui/attentionKeys.ts"
import { answersAfter } from "../src/ui/Dashboard.tsx"
import { newsToast } from "../src/ui/QuestionsBox.tsx"
import { type Appearance, makeTheme } from "../src/ui/theme.ts"
import { external, type Settable } from "../src/ui/useRunView.ts"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 10, 6, 11, 0, 0).getTime()

const q1 = "q-1" as TicketId

/** a-1, Asked: it waits on your answer to q-1. */
const asked: Entry = {
  ticket: "a-1" as TicketId,
  title: "Add the flag",
  phase: TicketPhase.Asked({ question: q1 }),
  since: began,
  worker: null,
  row: 0,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
}

const view: RunView = project({
  ledger: { tickets: new Map([[asked.ticket, asked]]), rows: 1, windDown: null, bugs: [] },
  workers: new Map(),
  requests: [],
  status: {
    ...emptyStatus,
    version: "0.1.0",
    branch: "batch",
    began,
    concurrency: 4,
    questions: new Map([
      [
        q1,
        {
          id: q1,
          title: "Which flag name?",
          description: "",
          options: [
            { label: "Use --flag", description: "" },
            { label: "Use --other", description: "" },
          ],
          maintainerOnly: false,
          waiting: [asked.ticket],
        },
      ],
    ]),
  },
  actions: new Map(),
})

interface At {
  readonly news: Settable<ReadonlyArray<QuestionNews>>
  readonly screen: Settable<Screen>
  readonly commands: Commands
  readonly rendered: Rendered
}

const scene = async (
  body: (at: At) => Promise<void>,
  size: { readonly width: number; readonly height: number } = { width: 155, height: 36 },
) => {
  const news = external<ReadonlyArray<QuestionNews>>([])
  const screen = external<Screen>(Screen.Dashboard())
  const commands = Effect.runSync(makeCommands)
  await withRender(
    <Root
      value={{
        view: external(view),
        screen,
        commands,
        appearance: external<Appearance>("dark"),
        themeOf,
        now: () => began + 60_000,
        questions: news,
      }}
    />,
    size,
    (rendered) => body({ news, screen, commands, rendered }),
  )
}

/** Captures frames until `ready` holds of one. */
const until = async (rendered: Rendered, ready: (frame: Frame) => boolean): Promise<Frame> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const frame = await rendered.capture()
    if (ready(frame) || Date.now() > deadline) return frame
    await Bun.sleep(20)
  }
}

// The question's title is its row's too, whichever: its options are the panel's alone.
const hidden = (frame: Frame) =>
  frame.chars.includes("0 Needs you") &&
  frame.chars.includes("Nothing needs you") &&
  !frame.chars.includes("Use --flag")
const shown = (frame: Frame) =>
  frame.chars.includes("1 Needs you") && frame.chars.includes("Use --flag")

const drawn = async ({ rendered }: At) => {
  expect(shown(await until(rendered, shown))).toBe(true)
  await Bun.sleep(settle + 50)
}

/** The uuid of the answer the panel offers on `1`, the question gone from the panel and the count. */
const answer = async ({ rendered, commands }: At): Promise<string> => {
  await rendered.input((setup) => setup.mockInput.typeText("1"))
  const offered: ReadonlyArray<UiCommand> = Effect.runSync(Queue.clear(commands))
  const given = offered.find((each) => each._tag === "AnswerQuestion")
  if (given === undefined) throw new Error("no answer was offered")
  expect(hidden(await until(rendered, hidden))).toBe(true)
  return given.uuid
}

/** A worker's view opened, the dashboard unmounted; then closed, the dashboard mounted anew. */
const throughWorkerView = async ({ rendered, screen }: At, meanwhile = async () => {}) => {
  await rendered.input(() => screen.set(Screen.Worker({ ticket: asked.ticket })))
  const away = await until(rendered, (frame) => frame.chars.includes("← Dashboard"))
  expect(away.chars).toContain("← Dashboard")
  await meanwhile()
  await rendered.input(() => screen.set(Screen.Dashboard()))
  await until(rendered, (frame) => !frame.chars.includes("← Dashboard"))
}

const recorded = (uuid: string) =>
  QuestionNews.Answered({ uuid, question: q1, title: "Which flag name?", decided: [] })

const closed = (uuid: string) => QuestionNews.AlreadyAnswered({ uuid, question: q1 })

const refusal = (uuid: string) =>
  QuestionNews.NotAnswered({ uuid, question: q1, why: "bd is locked" })

/** Long enough for a question wrongly brought back to be drawn. */
const stillHidden = async ({ rendered }: At) => {
  await Bun.sleep(50)
  expect(hidden(await rendered.capture())).toBe(true)
}

describe("a question answered on the panel", () => {
  test("stays off it over a worker's view, while the view still has its need", async () => {
    await scene(async (at) => {
      await drawn(at)
      const uuid = await answer(at)
      await throughWorkerView(at)
      await stillHidden(at)

      await at.rendered.input(() => at.news.set([recorded(uuid)]))
      await throughWorkerView(at)
      await stillHidden(at)
    })
  })

  test("stays off it once the news has dropped its answer", async () => {
    await scene(async (at) => {
      await drawn(at)
      const uuid = await answer(at)
      await at.rendered.input(() => at.news.set([recorded(uuid)]))
      const later = Array.from({ length: newsKept }, (_, i) =>
        QuestionNews.Read({ uuid: `u-${i}`, questions: [] }),
      )
      await at.rendered.input(() => at.news.set(later))
      await throughWorkerView(at)
      await stillHidden(at)
    })
  })

  test("comes back if bd refuses the answer while a worker's view is open", async () => {
    await scene(async (at) => {
      await drawn(at)
      const uuid = await answer(at)
      await throughWorkerView(at, () => at.rendered.input(() => at.news.set([refusal(uuid)])))
      expect(shown(await until(at.rendered, shown))).toBe(true)
    })
  })
})

describe("a question answered elsewhere", () => {
  test("leaves the panel as the news says it is recorded, and stays off it", async () => {
    await scene(async (at) => {
      await drawn(at)
      await at.rendered.input(() => at.news.set([recorded("u-from-the-box")]))
      expect(hidden(await until(at.rendered, hidden))).toBe(true)
      await throughWorkerView(at)
      await stillHidden(at)
    })
  })
})

describe("an answer that finds the question closed", () => {
  test("says it is already answered, not a failure", () => {
    expect(newsToast(closed("u"))).toEqual({ text: "q-1 is already answered", failure: false })
  })

  test("from the panel: a plain toast, and the panel doesn't bring it back", async () => {
    await scene(async (at) => {
      await drawn(at)
      const uuid = await answer(at)
      await at.rendered.input(() => at.news.set([closed(uuid)]))
      const said = await until(at.rendered, (frame) =>
        frame.chars.includes("q-1 is already answered"),
      )
      expect(said.chars).toContain("q-1 is already answered")
      expect(said.chars).not.toContain("couldn't record")
      await stillHidden(at)
      await throughWorkerView(at)
      await stillHidden(at)
    })
  })

  test("from the questions box: it drops the question from the panel", async () => {
    await scene(async (at) => {
      await drawn(at)
      await at.rendered.input(() => at.news.set([closed("u-from-the-box")]))
      expect(hidden(await until(at.rendered, hidden))).toBe(true)
    })
  })

  test("from the Needs you list: a plain toast, and the list doesn't bring it back", async () => {
    await scene(
      async (at) => {
        const { rendered, commands, news } = at
        const has = (text: string) => (frame: Frame) => frame.chars.includes(text)
        const enter = () => rendered.input((setup) => setup.mockInput.pressEnter())
        // Has the run read the question, which it still has open, for the list or the box.
        const reads = async () => {
          const deadline = Date.now() + 5000
          for (;;) {
            const offered: ReadonlyArray<UiCommand> = Effect.runSync(Queue.clear(commands))
            const read = offered.find((each) => each._tag === "ReadQuestions")
            if (read?._tag === "ReadQuestions") {
              const questions = [...view.needs].flatMap((need) =>
                need._tag === "Question" && need.question !== null ? [need.question] : [],
              )
              return rendered.input(() =>
                news.set([...news.get(), QuestionNews.Read({ uuid: read.uuid, questions })]),
              )
            }
            if (Date.now() > deadline) throw new Error("nothing read the questions")
            await rendered.capture()
            await Bun.sleep(20)
          }
        }
        await until(rendered, has("Which flag name?"))
        await rendered.input((setup) => setup.mockInput.pressTab())
        await enter()
        await reads()
        await until(rendered, has("> ? q-1"))
        await enter()
        await reads()
        await until(rendered, has("Open question 1 of 1 · q-1"))
        await enter()
        const offered: ReadonlyArray<UiCommand> = Effect.runSync(Queue.clear(commands))
        const given = offered.find((each) => each._tag === "AnswerQuestion")
        if (given === undefined) throw new Error("no answer was offered")

        await rendered.input(() => news.set([...news.get(), closed(given.uuid)]))
        const said = await until(rendered, has("q-1 is already answered"))
        expect(said.chars).toContain("q-1 is already answered")
        expect(said.chars).not.toContain("couldn't record")
        expect(said.chars).not.toContain("? q-1")
      },
      { width: 100, height: 30 },
    )
  })
})

describe("answersAfter", () => {
  const none: ReadonlyMap<string, string> = new Map()

  test("takes in what is recorded or closed, wherever it was answered", () => {
    expect([...answersAfter(none, [recorded("u-1"), closed("u-2")])]).toEqual([
      ["u-1", q1],
      ["u-2", q1],
    ])
  })

  test("takes out only what bd refused, by its uuid", () => {
    const given = new Map([
      ["u-1", q1],
      ["u-2", q1],
    ])
    expect([...answersAfter(given, [refusal("u-1")])]).toEqual([["u-2", q1]])
  })

  test("is the map itself where the news changes nothing", () => {
    const given = new Map([["u-1", q1 as string]])
    const reads = QuestionNews.Read({ uuid: "u-r", questions: [] })
    expect(answersAfter(given, [recorded("u-1"), refusal("u-other"), reads])).toBe(given)
  })
})
