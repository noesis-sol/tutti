// Talking a question through from the dashboard's questions box (tutti-i0sz, § 4.11): Talk it
// through closes the box and offers TalkQuestion with the question after it; the talk is drawn in
// place of the dashboard while the shell has one; once the run says it is over, the box opens again,
// at the next question once it was answered, at the same one otherwise, and a toast says why a talk
// that wasn't left gave no answer.
import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Queue } from "effect"
import { talkLeftWhy } from "../src/agent/answerTalk.ts"
import { interviewWorker } from "../src/agent/interview.ts"
import { Filing } from "../src/agent/interviewTools.ts"
import { type Item, transcriptVersion } from "../src/agent/Transcripts.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { talkLeaveAbout, talkLeaveQuestion, talkName } from "../src/run/answerTalk.ts"
import { type Commands, makeCommands, UiCommand } from "../src/run/commands.ts"
import { interviewCard, interviewView } from "../src/run/interview.ts"
import { QuestionNews } from "../src/run/questionNews.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { newsToast, readingText, returnTo } from "../src/ui/QuestionsBox.tsx"
import type { OpenQuestion } from "../src/ui/questions.ts"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  emptyTranscript,
  type OpenTranscript,
  type TranscriptFeed,
  type TranscriptState,
  windowOf,
} from "../src/ui/transcriptItems.ts"
import { external, type Settable, type ShellValue, type TalkShown } from "../src/ui/useRunView.ts"
import { type Frame, pressEscape, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 9, 27, 13, 0, 0).getTime()

const viewOf = (): RunView =>
  project({
    ledger: { tickets: new Map(), rows: 1, windDown: null, bugs: [] },
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

const taken = (commands: Commands): ReadonlyArray<UiCommand> =>
  Effect.runSync(Queue.clear(commands))

const has = (text: string) => (frame: Frame) => frame.chars.includes(text)

const until = async (rendered: Rendered, ready: (frame: Frame) => boolean): Promise<Frame> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const frame = await rendered.capture()
    if (ready(frame) || Date.now() > deadline) return frame
    await Bun.sleep(20)
  }
}

const items: ReadonlyArray<Item> = [
  {
    v: transcriptVersion,
    seq: 1,
    session: "0a4f5c3e-1111-4c8e-9a51-6f0d1f0b2a01",
    time: "2026-10-27T13:00:00.000Z",
    message: {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "--long-flag reads better in scripts." }],
      },
      parent_tool_use_id: null,
    } as unknown as SDKMessage,
  },
]

const feed: TranscriptFeed = {
  open: (ticket): OpenTranscript => ({
    state: external<TranscriptState>({
      ...emptyTranscript,
      window: windowOf(ticket === interviewWorker ? items : []),
    }),
    older: () => {},
    scrolledBack: () => {},
    follow: () => {},
    close: () => {},
  }),
}

/** The talk the run would show for q-1, with its own commands. */
const talkOf = (commands: Commands): TalkShown => ({
  shell: {
    view: external(
      interviewView(interviewCard("q-1: Which flag name?", began, WS.Idle({ at: began }), [])),
    ),
    screen: external<Screen>(Screen.Interview()),
    commands,
    appearance: external<Appearance>("dark"),
    themeOf,
    now: () => began + 5_000,
    transcripts: feed,
  },
  interview: {
    description: "q-1: Which flag name?",
    filing: external(Filing.None()),
    filed: external(false),
    name: talkName,
    leaveQuestion: talkLeaveQuestion,
    leaveAbout: talkLeaveAbout,
  },
})

const scene = async (
  body: (at: {
    readonly news: Settable<ReadonlyArray<QuestionNews>>
    readonly talk: Settable<TalkShown | null>
    readonly commands: Commands
    readonly rendered: Rendered
  }) => Promise<void>,
) => {
  const news = external<ReadonlyArray<QuestionNews>>([])
  const talk = external<TalkShown | null>(null)
  const commands = Effect.runSync(makeCommands)
  const value: ShellValue = {
    view: external(viewOf()),
    screen: external<Screen>(Screen.Dashboard()),
    commands,
    appearance: external<Appearance>("dark"),
    themeOf,
    now: () => began + 67_000,
    questions: news,
    talk,
  }
  await withRender(<Root value={value} />, { width: 100, height: 30 }, (rendered) =>
    body({ news, talk, commands, rendered }),
  )
}

/** Opens the box, the questions read: the uuid of its ReadQuestions. */
const openBox = async (
  rendered: Rendered,
  commands: Commands,
  news: Settable<ReadonlyArray<QuestionNews>>,
) => {
  await rendered.input((setup) => setup.mockInput.pressKey("A", { shift: true }))
  await until(rendered, has(readingText))
  const read = taken(commands).find((command) => command._tag === "ReadQuestions")
  const uuid = read?._tag === "ReadQuestions" ? read.uuid : ""
  await rendered.input(() => news.set([...news.get(), QuestionNews.Read({ uuid, questions })]))
  return uuid
}

const down = (rendered: Rendered, times: number) =>
  (async () => {
    for (let i = 0; i < times; i++) {
      await rendered.input((setup) => setup.mockInput.pressArrow("down"))
    }
  })()

describe("Talk it through, in the dashboard's questions box", () => {
  test("offers TalkQuestion with the question after it and closes; the talk takes the screen", async () => {
    await scene(async ({ news, talk, commands, rendered }) => {
      await openBox(rendered, commands, news)
      await until(rendered, has("Which flag name?"))
      // The options, Other, then Talk it through.
      await down(rendered, 3)
      expect(await until(rendered, has("> Talk it through"))).toBeDefined()
      await rendered.input((setup) => setup.mockInput.pressEnter())
      const sent = taken(commands)
      expect(sent).toEqual([
        UiCommand.TalkQuestion({
          question: "q-1" as TicketId,
          title: "Which flag name?",
          next: "q-2" as TicketId,
          uuid: expect.any(String) as unknown as string,
        }),
      ])
      expect((await rendered.capture()).chars).not.toContain("Which flag name?")

      // The run shows the talk: drawn in place of the dashboard, its keys its own.
      const talkCommands = Effect.runSync(makeCommands)
      await rendered.input(() => talk.set(talkOf(talkCommands)))
      const shown = await until(rendered, has("reads better"))
      expect(shown.chars).toContain(`${talkName}  your turn`)
      expect(shown.chars).toContain("q-1: Which flag name?")
      await rendered.input((setup) => pressEscape(setup))
      expect((await until(rendered, has(talkLeaveQuestion))).chars).toContain(talkLeaveAbout)
      expect(taken(commands)).toEqual([])

      // The talk over without an answer: the box opens again at the same question.
      const uuid = sent[0]?._tag === "TalkQuestion" ? sent[0].uuid : ""
      await rendered.input(() => {
        talk.set(null)
        news.set([
          ...news.get(),
          QuestionNews.Talked({
            uuid,
            question: "q-1" as TicketId,
            answered: false,
            why: talkLeftWhy,
            next: "q-2" as TicketId,
          }),
        ])
      })
      await until(rendered, has(readingText))
      const again = taken(commands).find((command) => command._tag === "ReadQuestions")
      const reread = again?._tag === "ReadQuestions" ? again.uuid : ""
      await rendered.input(() =>
        news.set([...news.get(), QuestionNews.Read({ uuid: reread, questions })]),
      )
      expect((await until(rendered, has("Which flag name?"))).chars).toContain(
        "Open question 1 of 2",
      )
    })
  })

  test("once a talk gave an answer, the box opens again at the next question", async () => {
    await scene(async ({ news, commands, rendered }) => {
      await rendered.input(() =>
        news.set([
          QuestionNews.Talked({
            uuid: "u-1",
            question: "q-1" as TicketId,
            answered: true,
            why: null,
            next: "q-2" as TicketId,
          }),
        ]),
      )
      await until(rendered, has(readingText))
      const read = taken(commands).find((command) => command._tag === "ReadQuestions")
      const uuid = read?._tag === "ReadQuestions" ? read.uuid : ""
      await rendered.input(() =>
        news.set([...news.get(), QuestionNews.Read({ uuid, questions: questions.slice(1) })]),
      )
      expect((await until(rendered, has("Which colour?"))).chars).toContain("Which colour?")
    })
  })
})

describe("where the box goes back to, and what a talk's end says", () => {
  const talked = (answered: boolean, why: string | null, next: string | null) =>
    QuestionNews.Talked({
      uuid: "u",
      question: "q-1" as TicketId,
      answered,
      why,
      next: next as TicketId | null,
    })

  test("the next question once answered, none after the last; the same one otherwise", () => {
    expect(returnTo(talked(true, null, "q-2"))).toEqual({ first: "q-2" as TicketId })
    expect(returnTo(talked(true, null, null))).toBeNull()
    expect(returnTo(talked(false, talkLeftWhy, "q-2"))).toEqual({ first: "q-1" as TicketId })
    expect(returnTo(QuestionNews.NotRead({ uuid: "u", why: "bd" }))).toBeNull()
  })

  test("a toast only for a talk that ended by itself without an answer", () => {
    expect(newsToast(talked(true, null, null))).toBeNull()
    expect(newsToast(talked(false, talkLeftWhy, null))).toBeNull()
    expect(newsToast(talked(false, "its session ended: Claude Code exited", null))).toEqual({
      text: "the talk about q-1 ended without an answer: its session ended: Claude Code exited",
      failure: true,
    })
  })
})
