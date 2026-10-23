// The composer keeps the focus a click elsewhere doesn't take (§ 7.5, § 4.10; tutti-yzkg): a click
// on a transcript's line, while you write, leaves the keys in the composer rather than give them to
// the view, where they would answer the request in the panel; and a focus a click does move
// elsewhere leaves the composer, its hint with it, so the hint says where the keys go. The answer
// form's body takes no focus either, so a click on it leaves the keys in the line you type in.
import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { Effect, Queue } from "effect"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import { interviewWorker } from "../src/agent/interview.ts"
import { Filing } from "../src/agent/interviewTools.ts"
import { type Item, transcriptVersion } from "../src/agent/Transcripts.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { type Commands, makeCommands, UiCommand } from "../src/run/commands.ts"
import { interviewCard, interviewView } from "../src/run/interview.ts"
import { emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import { settle } from "../src/ui/attentionKeys.ts"
import { InterviewContext } from "../src/ui/InterviewView.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  emptyTranscript,
  type OpenTranscript,
  type TranscriptFeed,
  type TranscriptState,
  windowOf,
} from "../src/ui/transcriptItems.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()
const session = "0a4f5c3e-1111-4c8e-9a51-6f0d1f0b2a01"

// SDK messages with only the fields tutti reads, cast as the SDK's types allow.
const sdk = (message: Record<string, unknown>): SDKMessage => message as unknown as SDKMessage
const assistant = (content: ReadonlyArray<unknown>) =>
  sdk({ type: "assistant", message: { role: "assistant", content }, parent_tool_use_id: null })
const said = (words: string) => assistant([{ type: "text", text: words }])
const call = (id: string, name: string, input: unknown) =>
  assistant([{ type: "tool_use", id, name, input }])
const answered = (id: string, content: string) =>
  sdk({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }],
    },
    parent_tool_use_id: null,
  })

const itemsOf = (messages: ReadonlyArray<SDKMessage>): ReadonlyArray<Item> =>
  messages.map((message, i) => ({
    v: transcriptVersion,
    seq: i + 1,
    session,
    time: "2026-10-20T13:00:00.000Z",
    message,
  }))

/** A session that read a file, then said what it would do: the read is a line to click. */
const items = itemsOf([
  call("read-1", "Read", { file_path: "src/build.ts" }),
  answered("read-1", "export const build = () => {}"),
  said("I'll clean the build."),
])
const toolLine = "Read  src/build.ts"

/** A feed with `ticket`'s transcript fixed at `items`. */
const feedOf = (ticket: string): TranscriptFeed => ({
  open: (opened): OpenTranscript => ({
    state: external<TranscriptState>({
      ...emptyTranscript,
      window: windowOf(opened === ticket ? items : []),
    }),
    older: () => {},
    scrolledBack: () => {},
    follow: () => {},
    close: () => {},
  }),
})

const permission: AttentionRequest = {
  id: "r1",
  ticket: "t-1",
  kind: {
    _tag: "Permission",
    tool: "Bash",
    input: { command: "rm -rf build", description: "Remove the build cache" },
    suggestions: [],
    summary: "rm -rf build",
  },
  displayName: "Bash",
  description: "Remove the build cache",
  decisionReason: "Path is outside allowed working directories",
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: began,
}

const question = {
  id: "q1",
  ticket: interviewWorker,
  kind: {
    _tag: "Question",
    questions: [
      {
        question: "One JSON object, or one per line?",
        options: [{ label: "One object" }, { label: "One per line" }],
        multiSelect: false,
      },
    ],
    input: {},
  },
  defaultToNo: false,
  suppressAlwaysAllowRule: true,
  createdAt: began,
} as AttentionRequest

/** Two questions of worker 1's, which Enter opens in the answer form. */
const asked: AttentionRequest = {
  id: "q1",
  ticket: "t-1",
  kind: {
    _tag: "Question",
    questions: [
      {
        question: "Which storage?",
        options: [{ label: "SQLite" }, { label: "Postgres" }],
        multiSelect: false,
      },
      {
        question: "Which checks?",
        options: [{ label: "tsc" }, { label: "biome" }],
        multiSelect: true,
      },
    ],
    input: {},
  },
  displayName: "AskUserQuestion",
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: began,
}

/** Worker 1 on t-1, idle, with `request` open. */
const workerView = (request: AttentionRequest): RunView =>
  project({
    ledger: {
      tickets: new Map([
        [
          "t-1",
          {
            ticket: "t-1",
            title: "Title of t-1",
            phase: TicketPhase.Working({ activity: "working" }),
            since: began,
            worker: 1,
            row: 0,
            rechecking: false,
            steered: false,
            lastMessage: null,
            tallies: emptyTallies,
          },
        ],
      ]),
      rows: 1,
      windDown: null,
      bugs: [],
    },
    workers: new Map([["t-1", WS.Idle({ at: began })]]),
    requests: [request],
    status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 1 },
    actions: new Map(),
  })

/** The shell's clock, which the scenes move past the panel's guard once the request is drawn. */
const clock = (() => {
  let at = began
  return { now: () => at, pass: (millis: number) => (at += millis), reset: () => (at = began) }
})()

const linesOf = (frame: Frame): ReadonlyArray<string> =>
  frame.chars.split("\n").map((line) => line.trimEnd())

/** Captures frames until `ready` holds of one, within 5 s. */
const until = async (rendered: Rendered, ready: (frame: Frame) => boolean): Promise<Frame> => {
  const deadline = Date.now() + 5000
  for (;;) {
    await rendered.input(() => Bun.sleep(20))
    const frame = await rendered.capture()
    if (ready(frame) || Date.now() > deadline) return frame
  }
}

const has = (text: string) => (frame: Frame) => frame.chars.includes(text)

/** The commands sent since the last call. */
const taken = (commands: Commands) => Effect.runSync(Queue.clear(commands))

const type = (rendered: Rendered, text: string) =>
  rendered.input(async (setup) => {
    await setup.mockInput.typeText(text)
    await Bun.sleep(30)
  })

/** Clicks the first line that holds `text`, a few columns into it. */
const clickOn = async (rendered: Rendered, text: string) => {
  const y = linesOf(await rendered.capture()).findIndex((line) => line.includes(text))
  expect(y).toBeGreaterThan(0)
  await rendered.input(async (setup) => {
    await setup.mockMouse.click(6, y)
    await Bun.sleep(30)
  })
}

const focusedField = (rendered: Rendered) =>
  rendered.setup.renderer.currentFocusedRenderable instanceof TextareaRenderable

/** The view's scrollboxes, each made focusable, as a renderable that takes a click's focus is. */
const focusableScrollboxes = (rendered: Rendered) => {
  const walk = (node: { getChildren: () => ReadonlyArray<unknown> }): void => {
    for (const child of node.getChildren()) {
      if (child instanceof ScrollBoxRenderable) child.focusable = true
      walk(child as typeof node)
    }
  }
  walk(rendered.setup.renderer.root)
}

/** The worker view of t-1, 80×24, with `request` open past the panel's guard. */
const worker = (
  body: (rendered: Rendered, commands: Commands) => Promise<void>,
  request: AttentionRequest = permission,
) => {
  clock.reset()
  const commands = Effect.runSync(makeCommands)
  const shell: ShellValue = {
    view: external(workerView(request)),
    screen: external<Screen>(Screen.Worker({ ticket: "t-1" })),
    commands,
    appearance: external<Appearance>("dark"),
    themeOf,
    now: clock.now,
    transcripts: feedOf("t-1"),
  }
  return withRender(<Root value={shell} />, { width: 80, height: 24 }, async (rendered) => {
    await until(rendered, has("clean the build"))
    clock.pass(settle + 1)
    await body(rendered, commands)
  })
}

/** The Interview view, 80×24, with its question open past the panel's guard. */
const interview = (body: (rendered: Rendered, commands: Commands) => Promise<void>) => {
  clock.reset()
  const commands = Effect.runSync(makeCommands)
  const shell: ShellValue = {
    view: external(
      interviewView(interviewCard("Add a --json flag.", began, WS.Idle({ at: began }), [question])),
    ),
    screen: external<Screen>(Screen.Interview()),
    commands,
    appearance: external<Appearance>("dark"),
    themeOf,
    now: clock.now,
    transcripts: feedOf(interviewWorker),
  }
  return withRender(
    <InterviewContext.Provider
      value={{ description: "Add a --json flag.", filing: external(Filing.None()) }}
    >
      <Root value={shell} />
    </InterviewContext.Provider>,
    { width: 80, height: 24 },
    async (rendered) => {
      await until(rendered, has("clean the build"))
      clock.pass(settle + 1)
      await body(rendered, commands)
    },
  )
}

describe("a click on the worker view's transcript while you write", () => {
  test("leaves the keys in the composer: they answer no request", async () => {
    await worker(async (rendered, commands) => {
      await type(rendered, "i")
      await type(rendered, "hello ")
      await clickOn(rendered, toolLine)
      // The click expands the read, as it does out of the composer.
      expect((await until(rendered, has("the whole file"))).chars).toContain("the whole file")
      await type(rendered, "add")
      expect(taken(commands)).toEqual([])
      expect(focusedField(rendered)).toBe(true)
      const frame = await until(rendered, has("hello add"))
      expect(frame.chars).toContain(" > hello add")
      expect(frame.chars).toContain("Esc leave")
    })
  })

  test("that moves the focus elsewhere leaves the composer, so the hint says where keys go", async () => {
    await worker(async (rendered, commands) => {
      focusableScrollboxes(rendered)
      await type(rendered, "i")
      await type(rendered, "hello ")
      await clickOn(rendered, toolLine)
      expect(focusedField(rendered)).toBe(false)
      const frame = await until(rendered, has("d deny"))
      expect(frame.chars).not.toContain("Esc leave")
      expect(frame.chars).toContain("i write")
      // The keys are the view's now, as the hint says.
      await type(rendered, "d")
      expect(taken(commands)).toEqual([
        UiCommand.Answer({ requestId: "r1", answer: { _tag: "Deny" } }),
      ])
      // i chooses the composer again, with what you typed in it.
      await type(rendered, "i")
      await type(rendered, "add")
      expect(focusedField(rendered)).toBe(true)
      expect((await until(rendered, has("hello add"))).chars).toContain(" > hello add")
      expect(taken(commands)).toEqual([])
    })
  })
})

describe("a click on the Interview view's transcript while you write", () => {
  test("leaves the keys in the composer: d declines no question", async () => {
    await interview(async (rendered, commands) => {
      await type(rendered, "i")
      await type(rendered, "hello ")
      await clickOn(rendered, toolLine)
      await type(rendered, "d")
      expect(taken(commands)).toEqual([])
      expect(focusedField(rendered)).toBe(true)
      const frame = await until(rendered, has("hello d"))
      expect(frame.chars).toContain(" > hello d")
      expect(frame.chars).toContain("Esc leave the composer")
    })
  })
})

describe("a click on the answer form's body while you type in its Other line", () => {
  test("leaves the keys in the line", async () => {
    await worker(async (rendered, commands) => {
      await rendered.input((setup) => setup.mockInput.pressEnter())
      expect((await until(rendered, has("t-1 asks"))).chars).toContain("t-1 asks")
      await clickOn(rendered, "Other:")
      await type(rendered, "Mongo")
      await clickOn(rendered, "Which checks?")
      await type(rendered, "DB")
      expect((await until(rendered, has("Other: MongoDB"))).chars).toContain("Other: MongoDB")
      expect(taken(commands)).toEqual([])
    }, asked)
  })
})
