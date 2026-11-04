// A question whose answer on the panel bd refuses (tutti-kojj, § 5.1, § 7.2): answered on the panel
// it leaves the panel and the strip's Needs you at once, before the run's next look; the run's news
// saying NotAnswered, under that answer's uuid, brings it back to both, for good, whatever news comes
// after, and a failure of another answer doesn't.
import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { type Commands, makeCommands, type UiCommand } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { newsKept, QuestionNews } from "../src/run/questionNews.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { settle } from "../src/ui/attentionKeys.ts"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type Settable } from "../src/ui/useRunView.ts"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 10, 4, 8, 0, 0).getTime()

/** a-1, Asked: it waits on your answer to q-1. */
const asked: Entry = {
  ticket: "a-1" as TicketId,
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
        "q-1",
        {
          id: "q-1" as TicketId,
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
        view: external(view),
        screen: external<Screen>(Screen.Dashboard()),
        commands,
        appearance: external<Appearance>("dark"),
        themeOf,
        now: () => began + 60_000,
        questions: news,
      }}
    />,
    { width: 155, height: 36 },
    (rendered) => body({ news, commands, rendered }),
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

/** The uuid of the answer the panel offers on `1`, the question gone from the panel and the count. */
const answered = async (rendered: Rendered, commands: Commands): Promise<string> => {
  await rendered.input((setup) => setup.mockInput.typeText("1"))
  const offered: ReadonlyArray<UiCommand> = Effect.runSync(Queue.clear(commands))
  const answer = offered.find((each) => each._tag === "AnswerQuestion")
  if (answer === undefined) throw new Error("no answer was offered")
  expect(hidden(await until(rendered, hidden))).toBe(true)
  return answer.uuid
}

const refusal = (uuid: string) =>
  QuestionNews.NotAnswered({ uuid, question: "q-1" as TicketId, why: "bd is locked" })

const drawn = async (rendered: Rendered) => {
  const frame = await until(rendered, shown)
  expect(shown(frame)).toBe(true)
  await Bun.sleep(settle + 50)
}

describe("a question whose answer on the panel bd refuses", () => {
  test("comes back to the panel and the count, its toast saying why", async () => {
    await scene(async ({ news, commands, rendered }) => {
      await drawn(rendered)
      const uuid = await answered(rendered, commands)
      await rendered.input(() => news.set([refusal(uuid)]))
      const back = await until(rendered, shown)
      expect(shown(back)).toBe(true)
      expect(back.chars).toContain("couldn't record the answer to q-1: bd is locked")
    })
  })

  test("can be answered again, and the earlier failure doesn't bring it back", async () => {
    await scene(async ({ news, commands, rendered }) => {
      await drawn(rendered)
      const first = await answered(rendered, commands)
      await rendered.input(() => news.set([refusal(first)]))
      await drawn(rendered)

      const second = await answered(rendered, commands)
      expect(second).not.toBe(first)
      await rendered.input(() =>
        news.set([...news.get(), QuestionNews.Read({ uuid: "u-read", questions: [] })]),
      )
      await Bun.sleep(50)
      expect(hidden(await rendered.capture())).toBe(true)

      await rendered.input(() => news.set([...news.get(), refusal(second)]))
      expect(shown(await until(rendered, shown))).toBe(true)
    })
  })

  test("stays back once the news has dropped its failure", async () => {
    await scene(async ({ news, commands, rendered }) => {
      await drawn(rendered)
      const uuid = await answered(rendered, commands)
      await rendered.input(() => news.set([refusal(uuid)]))
      await until(rendered, shown)
      const later = Array.from({ length: newsKept }, (_, i) =>
        QuestionNews.Read({ uuid: `u-${i}`, questions: [] }),
      )
      await rendered.input(() => news.set(later))
      await Bun.sleep(50)
      expect(shown(await rendered.capture())).toBe(true)
    })
  })

  test("another answer's failure, or this one recorded, leaves it out", async () => {
    await scene(async ({ news, commands, rendered }) => {
      await drawn(rendered)
      const uuid = await answered(rendered, commands)
      await rendered.input(() => news.set([refusal("u-from-the-box")]))
      await Bun.sleep(50)
      expect(hidden(await rendered.capture())).toBe(true)

      await rendered.input(() =>
        news.set([
          ...news.get(),
          QuestionNews.Answered({
            uuid,
            question: "q-1" as TicketId,
            title: "Which flag name?",
            decided: [],
          }),
        ]),
      )
      await Bun.sleep(50)
      expect(hidden(await rendered.capture())).toBe(true)
    })
  })
})
