// What the worker spent as the whole ticket's last section (§ 7.5, tutti-cxgo.3): a click on the
// resource line opens the whole ticket scrolled to `Spent`, or scrolls it there while it is open
// (Spent being the last section, as far as the panel scrolls: all of it in view); `t` opens it at
// its top; a scroll after it was put there stays where you put it; and the section has no Esc line
// of its own, as the breakdown's box over the view had.
import { describe, expect, test } from "bun:test"
import { Effect, Queue } from "effect"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { type Commands, makeCommands } from "../src/run/commands.ts"
import { emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import type { Resources } from "../src/run/resources.ts"
import { emptyStatus, project, ticketText } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { Issue, TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { spentLines } from "../src/ui/ResourceLine.tsx"
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
import { type Frame, pressEscape, type Rendered, withRender } from "./render.ts"

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
  labels: [],
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
  const top = lines.findIndex((line) => line.includes("▴ less"))
  const bottom = lines.findIndex((line, i) => i > top && line.startsWith("  ╰"))
  return top < 0 || bottom < 0 ? [] : lines.slice(top + 1, bottom)
}

/** The panel's first line inside its frame. */
const firstInside = (frame: Frame): string => inside(frame)[0] ?? ""

/** Whether the panel shows all of Spent, from its heading to its last row. */
const showsSpent = (frame: Frame): boolean => {
  const lines = inside(frame)
  return (
    lines.some((line) => /^ {2}│ Spent +│$/.test(line)) &&
    lines.some((line) => line.includes("of the run  100% of its 1.2M tokens"))
  )
}

/** The resource line's row. */
const resourceRow = (frame: Frame): number =>
  linesOf(frame).findIndex((line) => line.includes("tokens"))

const taken = (commands: Commands) =>
  Effect.runSync(Queue.clear(commands)).map((command) => command._tag)

describe("Spent in the whole ticket", () => {
  test("a click on the resource line opens the whole ticket scrolled to Spent", async () => {
    await scene(async (rendered, commands) => {
      const frame = await until(rendered, has("Reading the scripts."))
      taken(commands)
      await rendered.input((setup) => setup.mockMouse.click(4, resourceRow(frame)))
      const open = await until(rendered, showsSpent)
      expect(showsSpent(open)).toBe(true)
      // Nothing below it: the bottom border counts no more lines.
      expect(open.chars).not.toContain("more line")
      expect(open.chars).toContain("41 model calls")
      expect(open.chars).toContain("$1.84 at API prices (estimate)")
      expect(open.chars).not.toContain("Note 1.")
      // The panel has no line of its own to close Spent: its frame's top says how.
      expect(open.chars).not.toContain("Esc close")
      expect(taken(commands)).toEqual(["ReadTicket"])
      // Esc closes the whole ticket, as it does opened with t.
      await rendered.input((setup) => pressEscape(setup))
      const closed = await until(rendered, (each) => !each.chars.includes("▴ less"))
      expect(closed.chars).not.toContain("41 model calls")
      expect(closed.chars).toContain("← Dashboard")
    })
  })

  test("t opens it at its top, and a click on the resource line then scrolls it to Spent", async () => {
    await scene(async (rendered) => {
      await until(rendered, has("Reading the scripts."))
      await rendered.input(async (setup) => {
        await setup.mockInput.typeText("t")
      })
      const open = await until(rendered, has("▴ less"))
      expect(firstInside(open)).toContain("The first line of the description.")
      expect(open.chars).not.toContain("41 model calls")
      await rendered.input((setup) => setup.mockMouse.click(4, resourceRow(open)))
      const scrolled = await until(rendered, showsSpent)
      expect(showsSpent(scrolled)).toBe(true)
      expect(firstInside(scrolled)).not.toContain("The first line of the description.")
    })
  })

  test("a scroll after it was put at Spent stays where you put it", async () => {
    await scene(async (rendered) => {
      const frame = await until(rendered, has("Reading the scripts."))
      await rendered.input((setup) => setup.mockMouse.click(4, resourceRow(frame)))
      const open = await until(rendered, showsSpent)
      const y = linesOf(open).findIndex((line) => line.includes("│ Spent"))
      await rendered.input(async (setup) => {
        await setup.mockMouse.scroll(10, y + 1, "up")
        await Bun.sleep(30)
      })
      const up = await until(rendered, (each) => firstInside(each) !== firstInside(open))
      expect(firstInside(up)).not.toBe(firstInside(open))
      expect(up.chars).toContain("more line")
      // Frames on, it hasn't gone back.
      await Bun.sleep(100)
      expect(firstInside(await rendered.capture())).toBe(firstInside(up))
    })
  })
})

describe("the panel's height with Spent", () => {
  test("Spent's lines and the one over them count, up to the cap", () => {
    const resources: Resources = {
      ticket: "t-1" as TicketId,
      took: began,
      spent,
      runTokens: 10_000_000,
      subscription: true,
      window: { share: 0.012, rise: 0.06, cost: 1.84, runCost: 9.2 },
      context,
      compactions: 0,
    }
    const short = ticketText({ ...issue, notes: "" })
    const lines = spentLines(resources, theme, 76).length
    expect(panelLines(short, 60, 80, lines)).toBe(panelLines(short, 60, 80) + lines + 1)
    expect(panelLines(ticketText(issue), 30, 80, lines)).toBe(18)
  })
})
