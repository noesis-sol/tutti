// The boxes a question's talk opens on the dashboard (tutti-34k9.4, § 4.11): the talk is drawn in
// place of the dashboard with a shell of its own, whose requests the dashboard's RunView leaves out.
// Answer in view's form and Shift+D's reason box read the shell of the view that opened them, so
// their answers reach the talk's session rather than be dropped as `no longer open`; a talk ending
// with one of them open closes it.
import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Queue } from "effect"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import { interviewWorker } from "../src/agent/inView.ts"
import { type Item, transcriptVersion } from "../src/agent/Transcripts.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { orchestra } from "../src/project/scheme.ts"
import { talkLeaveAbout, talkLeaveQuestion, talkName } from "../src/run/answerTalk.ts"
import { type Commands, makeCommands, UiCommand } from "../src/run/commands.ts"
import { interviewCard, interviewView } from "../src/run/interview.ts"
import type { QuestionNews } from "../src/run/questionNews.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import { reasonQuestion } from "../src/ui/AttentionCard.tsx"
import { settle, staleToast } from "../src/ui/attentionKeys.ts"
import { type Appearance, makeTheme } from "../src/ui/theme.ts"
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
const description = "q-1: Which flag name?"

const dashboardView = (): RunView =>
  project({
    ledger: { tickets: new Map(), rows: 1, windDown: null, bugs: [] },
    workers: new Map(),
    requests: [],
    status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 1 },
    actions: new Map(),
  })

/** The talk's session asks two questions at once: the card's only button is Answer in view. */
const asked: AttentionRequest = {
  id: "talk-q1",
  ticket: interviewWorker,
  kind: {
    _tag: "Question",
    questions: [
      {
        question: "Which flag name?",
        options: [{ label: "--long-flag" }, { label: "--flag" }],
        multiSelect: false,
      },
      {
        question: "Which colour?",
        options: [{ label: "red" }, { label: "blue" }],
        multiSelect: false,
      },
    ],
    input: {},
  },
  displayName: "AskUserQuestion",
  defaultToNo: false,
  suppressAlwaysAllowRule: true,
  createdAt: began,
}

const taken = (commands: Commands): ReadonlyArray<UiCommand> =>
  Effect.runSync(Queue.clear(commands))

const has = (text: string) => (frame: Frame) => frame.chars.includes(text)
const lacks = (text: string) => (frame: Frame) => !frame.chars.includes(text)

const until = async (rendered: Rendered, ready: (frame: Frame) => boolean): Promise<Frame> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const frame = await rendered.capture()
    if (ready(frame) || Date.now() > deadline) return frame
    await Bun.sleep(20)
  }
}

const press = (rendered: Rendered, ...keys: ReadonlyArray<string>) =>
  rendered.input(async (setup) => {
    for (const key of keys) {
      switch (key) {
        case "enter":
          setup.mockInput.pressEnter()
          break
        case "escape":
          await pressEscape(setup)
          break
        case "down":
          setup.mockInput.pressArrow(key)
          break
        case "space":
          setup.mockInput.pressKey(" ")
          break
        default:
          await setup.mockInput.typeText(key)
      }
    }
  })

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

/** The talk's shell's clock, which the tests move past the panel's guard. */
const clock = (() => {
  let at = began + 5_000
  return { now: () => at, pass: (millis: number) => (at += millis) }
})()

/** The talk the run would show for q-1, asking `requests`, with its own view and commands. */
const talkOf = (commands: Commands, view: Settable<RunView>): TalkShown => ({
  shell: {
    view,
    screen: external<Screen>(Screen.Interview()),
    commands,
    appearance: external<Appearance>("dark"),
    themeOf,
    now: clock.now,
    transcripts: feed,
  },
  interview: {
    description,
    filed: external(false),
    name: talkName,
    leaveQuestion: talkLeaveQuestion,
    leaveAbout: talkLeaveAbout,
  },
})

const talkView = (requests: ReadonlyArray<AttentionRequest>): RunView =>
  interviewView(interviewCard(description, began, WS.Idle({ at: began }), requests))

/** The dashboard with the talk shown over it, asking `asked`, past the panel's guard. */
const scene = async (
  body: (at: {
    readonly talk: Settable<TalkShown | null>
    readonly talkView: Settable<RunView>
    readonly talkCommands: Commands
    readonly commands: Commands
    readonly rendered: Rendered
  }) => Promise<void>,
) => {
  const talk = external<TalkShown | null>(null)
  const commands = Effect.runSync(makeCommands)
  const talkCommands = Effect.runSync(makeCommands)
  const view = external(talkView([asked]))
  const value: ShellValue = {
    view: external(dashboardView()),
    screen: external<Screen>(Screen.Dashboard()),
    commands,
    appearance: external<Appearance>("dark"),
    themeOf,
    now: () => began + 67_000,
    questions: external<ReadonlyArray<QuestionNews>>([]),
    talk,
  }
  await withRender(<Root value={value} />, { width: 100, height: 30 }, async (rendered) => {
    await rendered.input(() => talk.set(talkOf(talkCommands, view)))
    const shown = await until(rendered, has("reads better"))
    expect(shown.chars).toContain(`${talkName}  question`)
    expect(shown.chars).toContain("[ Answer in view ]")
    clock.pass(settle)
    await body({ talk, talkView: view, talkCommands, commands, rendered })
  })
}

describe("the boxes a question's talk opens on the dashboard", () => {
  test("Answer in view opens the form for the talk's request, and its answer reaches the talk", async () => {
    await scene(async ({ rendered, talkCommands, commands }) => {
      await press(rendered, "enter")
      const form = await until(rendered, has(`${interviewWorker} asks`))
      expect(form.chars).toContain("Which flag name?")
      expect(form.chars).toContain("Which colour?")
      expect(form.chars).not.toContain(staleToast(interviewWorker))
      // 1 picks --long-flag; ↓ to the second question's options, Space picks red; ↓ to Answer.
      await press(rendered, "1", "down", "down", "down", "space")
      const picked = await until(rendered, has("(•) red"))
      expect(picked.chars).toContain("(•) --long-flag")
      await press(rendered, "down", "down", "down", "enter")
      expect(taken(talkCommands)).toEqual([
        UiCommand.Answer({
          requestId: "talk-q1",
          answer: { _tag: "Choose", answers: ["--long-flag", "red"] },
        }),
      ])
      expect(taken(commands)).toEqual([])
      const closed = await until(rendered, lacks(`${interviewWorker} asks`))
      expect(closed.chars).not.toContain(staleToast(interviewWorker))
    })
  })

  test("Shift+D opens the reason box for the talk's request, and its denial reaches the talk", async () => {
    await scene(async ({ rendered, talkCommands, commands }) => {
      await press(rendered, "D")
      const box = await until(rendered, has(reasonQuestion(interviewWorker)))
      expect(box.chars).toContain(reasonQuestion(interviewWorker))
      await press(rendered, "ask the maintainer", "enter")
      expect(taken(talkCommands)).toEqual([
        UiCommand.Answer({
          requestId: "talk-q1",
          answer: { _tag: "Deny", reason: "ask the maintainer" },
        }),
      ])
      expect(taken(commands)).toEqual([])
      const closed = await until(rendered, lacks("saying why"))
      expect(closed.chars).not.toContain(staleToast(interviewWorker))
    })
  })

  test("the form closes with the talk's toast once the talk's session withdraws the request", async () => {
    await scene(async ({ rendered, talkView, talkCommands }) => {
      await press(rendered, "enter")
      await until(rendered, has(`${interviewWorker} asks`))
      await rendered.input(() => talkView.set(talkViewWithout()))
      const gone = await until(rendered, has(staleToast(interviewWorker)))
      expect(gone.chars).not.toContain(`${interviewWorker} asks`)
      expect(taken(talkCommands)).toEqual([])
    })
  })

  test("a talk ending with its form open closes it: the dashboard's keys are its own again", async () => {
    await scene(async ({ rendered, talk, commands }) => {
      await press(rendered, "enter")
      await until(rendered, has(`${interviewWorker} asks`))
      await rendered.input(() => talk.set(null))
      const dashboard = await until(rendered, lacks(`${interviewWorker} asks`))
      expect(dashboard.chars).not.toContain(`${interviewWorker} asks`)
      expect(dashboard.chars).not.toContain(talkName)
      // Esc, free, would have closed the form; with none open it reaches no box and no toast.
      await press(rendered, "escape")
      expect(taken(commands)).toEqual([])
      expect((await rendered.capture()).chars).not.toContain(staleToast(interviewWorker))
    })
  })

  test("a talk ending with its reason box open closes it", async () => {
    await scene(async ({ rendered, talk }) => {
      await press(rendered, "D")
      await until(rendered, has(reasonQuestion(interviewWorker)))
      await rendered.input(() => talk.set(null))
      const dashboard = await until(rendered, lacks("saying why"))
      expect(dashboard.chars).not.toContain("saying why")
      expect(dashboard.chars).not.toContain(talkName)
    })
  })
})

/** The talk's view once its session has withdrawn the request. */
const talkViewWithout = (): RunView => talkView([])
