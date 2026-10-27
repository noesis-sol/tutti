// A question's talk in the Interview view (tutti-i0sz, § 4.11): its head names it Talk, not
// Interview; leaving before an answer asks `End the talk?`, saying the question stays open; once
// give_answer has taken an answer, leaving asks nothing.
import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Queue } from "effect"
import { interviewWorker } from "../src/agent/interview.ts"
import { Filing } from "../src/agent/interviewTools.ts"
import { type Item, transcriptVersion } from "../src/agent/Transcripts.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { talkLeaveAbout, talkLeaveQuestion, talkName } from "../src/run/answerTalk.ts"
import { type Commands, makeCommands, UiCommand } from "../src/run/commands.ts"
import { interviewCard, interviewView } from "../src/run/interview.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import { InterviewContext, leaveAbout } from "../src/ui/InterviewView.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  emptyTranscript,
  type OpenTranscript,
  type TranscriptFeed,
  type TranscriptState,
  windowOf,
} from "../src/ui/transcriptItems.ts"
import { external, type Settable, type ShellValue } from "../src/ui/useRunView.ts"
import { pressEscape, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 9, 27, 13, 0, 0).getTime()
const description = "q-1: Which flag name?"

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

/** The talk's view, `given` saying whether give_answer has taken an answer. */
const scene = async (
  body: (at: {
    readonly commands: Commands
    readonly given: Settable<boolean>
    readonly rendered: Rendered
  }) => Promise<void>,
) => {
  const commands = Effect.runSync(makeCommands)
  const given = external(false)
  const shell: ShellValue = {
    view: external(interviewView(interviewCard(description, began, WS.Idle({ at: began }), []))),
    screen: external<Screen>(Screen.Interview()),
    commands,
    appearance: external<Appearance>("dark"),
    themeOf,
    now: () => began + 5_000,
    transcripts: feed,
  }
  await withRender(
    <InterviewContext.Provider
      value={{
        description,
        filing: external(Filing.None()),
        filed: given,
        name: talkName,
        leaveQuestion: talkLeaveQuestion,
        leaveAbout: talkLeaveAbout,
      }}
    >
      <Root value={shell} />
    </InterviewContext.Provider>,
    { width: 80, height: 24 },
    (rendered) => body({ commands, given, rendered }),
  )
}

const until = async (rendered: Rendered, text: string) => {
  const deadline = Date.now() + 5000
  for (;;) {
    const frame = await rendered.capture()
    if (frame.chars.includes(text) || Date.now() > deadline) return frame
    await Bun.sleep(20)
  }
}

const taken = (commands: Commands) => Effect.runSync(Queue.clear(commands))

describe("a question's talk in the Interview view", () => {
  test("its head names it Talk and the question", async () => {
    await scene(async ({ rendered }) => {
      const frame = await until(rendered, "reads better")
      expect(frame.chars).toContain(`${talkName}  your turn`)
      expect(frame.chars).toContain(description)
      expect(frame.chars).not.toContain("Interview")
    })
  })

  test("leaving before an answer asks End the talk?, the question staying open", async () => {
    await scene(async ({ commands, rendered }) => {
      await until(rendered, "reads better")
      await rendered.input((setup) => pressEscape(setup))
      const frame = await until(rendered, talkLeaveQuestion)
      expect(frame.chars).toContain(talkLeaveQuestion)
      expect(frame.chars).toContain(talkLeaveAbout)
      expect(frame.chars).not.toContain(leaveAbout)
      expect(taken(commands)).toEqual([])
    })
  })

  test("once give_answer has taken an answer, leaving asks nothing", async () => {
    await scene(async ({ commands, given, rendered }) => {
      await until(rendered, "reads better")
      given.set(true)
      await rendered.input((setup) => pressEscape(setup))
      expect((await rendered.capture()).chars).not.toContain(talkLeaveQuestion)
      expect(taken(commands)).toEqual([UiCommand.CloseWorker()])
    })
  })
})
