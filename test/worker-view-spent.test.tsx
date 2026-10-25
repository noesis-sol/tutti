// Spent gone from the worker view (§ 7.5, tutti-cxgo.6; it was the whole ticket's last section
// since tutti-cxgo.3): a click on line 1's figures does nothing, the whole ticket ends with its
// labels, and the ticket's tokens, model calls and dollars at API prices show nowhere in the view.
import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { type Commands, makeCommands } from "../src/run/commands.ts"
import { emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, ticketText } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { Issue, TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { panelLines } from "../src/ui/TicketHead.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  emptyTranscript,
  type OpenTranscript,
  type TranscriptFeed,
  type TranscriptState,
  windowOf,
} from "../src/ui/transcriptItems.ts"
import { external } from "../src/ui/useRunView.ts"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const began = new Date(2026, 9, 24, 13, 0, 0).getTime()
const now = began + 413_000
const model = "claude-opus-5-5"

const spent = {
  costUsd: 1.84,
  turns: 41,
  results: 3,
  tokens: {
    [model]: { input: 2_000, output: 30_000, cache_write: 168_000, cache_read: 1_000_000 },
  },
}
const context = {
  tokens: 126_000,
  window: 200_000,
  percentage: 63,
  split: [{ name: "Messages", tokens: 100_000 }],
}

/** A ticket longer than the panel shows: thirty notes, a line each. */
const issue: Issue = {
  id: "t-1" as TicketId,
  title: "Title of t-1",
  description: "The first line of the description.",
  design: "",
  acceptance: "",
  notes: Array.from({ length: 30 }, (_, i) => `Note ${i + 1}.`).join("\n\n"),
  status: "in_progress",
  priority: 2,
  type: "task",
  assignee: "",
  labels: ["bookmarks"],
  dependencies: [],
  metadata: {},
  files: [],
  predictedFiles: [],
  createdAt: "",
  closeReason: "",
}

const said = {
  v: 1,
  seq: 1,
  session: "s-1",
  time: "2026-10-24T13:00:00.000Z",
  message: {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Reading the scripts." }] },
    parent_tool_use_id: null,
  },
}
const feed: TranscriptFeed = {
  open: (): OpenTranscript => {
    const state = external<TranscriptState>({
      ...emptyTranscript,
      window: windowOf([said as never]),
    })
    return { state, older: () => {}, scrolledBack: () => {}, follow: () => {}, close: () => {} }
  },
}

const view = project({
  ledger: {
    tickets: new Map([
      [
        "t-1" as TicketId,
        {
          ticket: "t-1" as TicketId,
          title: "Title of t-1",
          issue,
          phase: TicketPhase.Working(),
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
  workers: new Map([["t-1", WS.Working({ doing: "working" })]]),
  requests: [],
  status: {
    ...emptyStatus,
    version: "0.1.0",
    branch: "batch",
    began,
    concurrency: 1,
    subscription: true,
    rise: 0.06,
    spending: { tickets: new Map([["t-1", spent]]), total: { ...spent, costUsd: 9.2 } },
    contexts: new Map([["t-1", context]]),
  },
  actions: new Map(),
  now,
})

const scene = (body: (rendered: Rendered, commands: Commands) => Promise<void>) => {
  const commands = Effect.runSync(makeCommands)
  return withRender(
    <Root
      value={{
        view: external(view),
        screen: external<Screen>(Screen.Worker({ ticket: "t-1" as TicketId })),
        commands,
        appearance: external<Appearance>("dark"),
        themeOf,
        now: () => now,
        transcripts: feed,
      }}
    />,
    { width: 100, height: 30 },
    (rendered) => body(rendered, commands),
  )
}

const linesOf = (frame: Frame): ReadonlyArray<string> =>
  frame.chars.split("\n").map((line) => line.trimEnd())

/** Captures frames until `ok` holds of one, or 5 s have gone. */
const until = async (rendered: Rendered, ok: (frame: Frame) => boolean): Promise<Frame> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const frame = await rendered.capture()
    if (ok(frame) || Date.now() > deadline) return frame
    await Bun.sleep(20)
  }
}

const has = (text: string) => (frame: Frame) => frame.chars.includes(text)

/** The panel's lines inside its frame. */
const inside = (frame: Frame): ReadonlyArray<string> => {
  const lines = linesOf(frame)
  const bottom = lines.findIndex((line) => line.startsWith("╰") && line.includes("▴ less"))
  const top = lines.findLastIndex((line, i) => i < bottom && line.startsWith("╭"))
  return top < 0 || bottom < 0 ? [] : lines.slice(top + 1, bottom)
}

/** Clicks line 1's `text`, among its figures. */
const clickOn = (rendered: Rendered, frame: Frame, text: RegExp) => {
  const lines = linesOf(frame)
  const y = lines.findIndex((line) => line.includes("← Dashboard"))
  const x = text.exec(lines[y] ?? "")?.index ?? 0
  return rendered.input((setup) => setup.mockMouse.click(x + 1, y))
}

const taken = (commands: Commands) =>
  Effect.runSync(Queue.clear(commands)).map((command) => command._tag)

const pageDown = "\x1b[6~"

/** What the view shows of the worker's spending: none of it. */
const spending = ["Spent", "model calls", "at API prices", "1.2M", "cache"]

describe("Spent gone from the worker view", () => {
  test("a click on line 1's figures opens nothing", async () => {
    await scene(async (rendered, commands) => {
      const frame = await until(rendered, has("Reading the scripts."))
      taken(commands)
      for (const text of [/\d+m\d+s/, /≈\d+% \(estimate\)/, /context /, /126k of/]) {
        await clickOn(rendered, frame, text)
        await Bun.sleep(50)
        const after = await rendered.capture()
        expect(after.chars).not.toContain("▴ less")
        expect(after.chars).toBe(frame.chars)
      }
      expect(taken(commands)).toEqual([])
    })
  })

  test("the whole ticket ends with its labels, and nothing of the spending shows", async () => {
    await scene(async (rendered) => {
      const frame = await until(rendered, has("Reading the scripts."))
      for (const text of spending) expect(frame.chars).not.toContain(text)
      await rendered.input(async (setup) => {
        await setup.mockInput.typeText("t")
      })
      await until(rendered, has("▴ less"))
      for (let i = 0; i < 10; i++) {
        await rendered.input(async (setup) => {
          await setup.mockInput.typeText(pageDown)
        })
      }
      const end = await until(rendered, (each) => !each.chars.includes("more line"))
      const lines = inside(end).filter((line) => !/^│ +│$/.test(line))
      expect(lines.at(-1)).toMatch(/^│ (\*\*)?Labels(\*\*)? {2}bookmarks +│$/)
      for (const text of spending) expect(end.chars).not.toContain(text)
    })
  })
})

describe("the panel's height", () => {
  test("its head's lines count, Spent's no longer, up to the cap", () => {
    const short = ticketText({ ...issue, notes: "" })
    expect(panelLines(short, 60, 80, 2)).toBe(panelLines(short, 60, 80) + 2)
    expect(panelLines(ticketText(issue), 30, 80, 2)).toBe(18)
  })
})
