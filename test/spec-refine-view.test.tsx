// A spec's refinement in the Interview view (§ 4.14, § 4.10): leaving asks `End the breakdown?`
// while the breakdown has filed nothing, and nothing once it has, whatever the feature interview's
// filing says, which a refinement doesn't have.
import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Queue } from "effect"
import { interviewWorker } from "../src/agent/inView.ts"
import { type Item, transcriptVersion } from "../src/agent/Transcripts.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
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

const began = new Date(2026, 9, 26, 13, 0, 0).getTime()
const description = "Break the spec docs/shop.md down into Beads tickets"

const items: ReadonlyArray<Item> = [
  {
    v: transcriptVersion,
    seq: 1,
    session: "0a4f5c3e-1111-4c8e-9a51-6f0d1f0b2a01",
    time: "2026-10-26T13:00:00.000Z",
    message: {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Q1 - Which currency?" }] },
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

/** The refinement's view, `filed` saying whether the breakdown has filed something. */
const scene = async (
  body: (at: {
    readonly commands: Commands
    readonly filed: Settable<boolean>
    readonly rendered: Rendered
  }) => Promise<void>,
) => {
  const commands = Effect.runSync(makeCommands)
  const filed = external(false)
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
        filed,
        leaveQuestion: "End the breakdown?",
      }}
    >
      <Root value={shell} />
    </InterviewContext.Provider>,
    { width: 80, height: 24 },
    (rendered) => body({ commands, filed, rendered }),
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

describe("a spec's refinement in the Interview view", () => {
  test("leaving asks End the breakdown? while nothing is filed", async () => {
    await scene(async ({ commands, rendered }) => {
      await until(rendered, "Which currency?")
      await rendered.input((setup) => pressEscape(setup))
      const frame = await until(rendered, "End the breakdown?")
      expect(frame.chars).toContain("End the breakdown?")
      expect(frame.chars).toContain(leaveAbout)
      expect(taken(commands)).toEqual([])
    })
  })

  test("once the breakdown has filed something, leaving asks nothing", async () => {
    await scene(async ({ commands, filed, rendered }) => {
      await until(rendered, "Which currency?")
      filed.set(true)
      await rendered.input((setup) => pressEscape(setup))
      expect((await rendered.capture()).chars).not.toContain("End the breakdown?")
      expect(taken(commands)).toEqual([UiCommand.CloseWorker()])
    })
  })
})
