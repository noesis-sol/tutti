// The worker view's head as redesigned (§ 7.5, tutti-cxgo.4 and .6): a blank line above it, as the
// dashboard has above its title line; line 1 on one line, the ticket's ID and status, then the
// figures (the time in the text's colour, the estimate or dollars, the context, the memory), the
// time and memory once and no tokens; a blank line and the box named Ticket, the type and priority
// at its top border's right, the title in bold in it, a blank line and the description, its
// control in the bottom border, which grows into the whole ticket with its control in the same
// place; a short pane giving up the description's lines, then the box's blank line, then the one
// above the box, then the box, line 1 then ending with the type and priority; a narrow pane
// dropping line 1's parts in order; and the Interview view's blank line. The border's own narrow
// steps and the colours are worker-view-ticket-box.test.tsx's.

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { makeCommands } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import type { Resources } from "../src/run/resources.ts"
import { emptyStatus, project, type RunView, type Usage } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { Issue, TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { InterviewContext } from "../src/ui/InterviewView.tsx"
import { workerMemory } from "../src/ui/LoadLine.tsx"
import { type Segments, widthOf } from "../src/ui/line.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  emptyTranscript,
  type OpenTranscript,
  type TranscriptFeed,
  type TranscriptState,
  windowOf,
} from "../src/ui/transcriptItems.ts"
import { external } from "../src/ui/useRunView.ts"
import { fullHeadFrom, headExtras } from "../src/ui/WorkerView.tsx"
import { aboveLines, lineOneSegments } from "../src/ui/worker/Head.tsx"
import { type Frame, type Rendered, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const began = new Date(2026, 9, 25, 13, 0, 0).getTime()
/** 12m53s on. */
const now = began + 773_000
const memory = 0.4 * 1024 ** 3
const model = "claude-opus-5-5"

const title = "Question tickets give their options and the recommended one in metadata"

const description =
  "Question tickets carry their options and the recommended one in their metadata, as " +
  "orchestra's have since 0.9.x, so tutti can read which option a worker recommends. Today " +
  "tutti's worker prompt asks for the context, the options and your recommendation in the " +
  "description only, as free text. In this project's 18 question tickets it is written several " +
  "ways or not at all, and no code can read it. The fix asks for metadata with the options and " +
  "the recommended one, reads it, and shows it on the card, so that a person answering sees " +
  "which option the worker would take, and why."

/** t-1's issue, a feature at P2, with `fields` over it. */
const issueOf = (fields: Partial<Issue> = {}): Issue => ({
  id: "t-1" as TicketId,
  title,
  description,
  design: "",
  acceptance: "",
  notes: "",
  status: "in_progress",
  priority: 2,
  type: "feature",
  assignee: "",
  labels: [],
  dependencies: [],
  metadata: {},
  files: [],
  predictedFiles: [],
  createdAt: "",
  closeReason: "",
  ...fields,
})

/** t-1's resources: 1.2M tokens, its context 40k of 200k. */
const spent = {
  costUsd: 1.84,
  turns: 41,
  results: 3,
  tokens: {
    [model]: { input: 2_000, output: 30_000, cache_write: 168_000, cache_read: 1_000_000 },
  },
}

/** Worker 1 on t-1, its ticket `issue`, on a subscription unless `apiKey`. */
const viewOf = (
  options: {
    readonly issue?: Issue | undefined
    readonly title?: string
    readonly apiKey?: boolean
    readonly compactions?: number
    readonly usage?: Usage | null
  } = {},
): RunView => {
  const entry: Entry = {
    ticket: "t-1" as TicketId,
    title: options.title ?? title,
    ...("issue" in options
      ? options.issue === undefined
        ? {}
        : { issue: options.issue }
      : { issue: issueOf() }),
    phase: TicketPhase.Working(),
    since: began,
    worker: 1,
    row: 0,
    rechecking: false,
    steered: false,
    lastMessage: null,
    tallies: { ...emptyTallies, compactions: options.compactions ?? 0 },
  }
  const view = project({
    ledger: { tickets: new Map([["t-1" as TicketId, entry]]), rows: 1, windDown: null, bugs: [] },
    workers: new Map([["t-1", WS.Working({ doing: "working" })]]),
    requests: [],
    status: {
      ...emptyStatus,
      version: "0.1.0",
      branch: "batch",
      began,
      concurrency: 1,
      subscription: options.apiKey !== true,
      rise: 0.06,
      usage: options.usage ?? null,
      spending: { tickets: new Map([["t-1", spent]]), total: { ...spent, costUsd: 9.2 } },
      contexts: new Map([["t-1", { tokens: 40_000, window: 200_000, percentage: 20, split: [] }]]),
    },
    actions: new Map(),
    now,
  })
  return { ...view, cards: view.cards.map((card) => ({ ...card, memory })) }
}

const said = {
  v: 1,
  seq: 1,
  session: "s-1",
  time: "2026-10-25T13:00:00.000Z",
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

/** The `screen` of `view` at `size`. */
const scene = (
  view: RunView,
  size: { readonly width: number; readonly height: number },
  body: (rendered: Rendered) => Promise<void>,
  screen: Screen = Screen.Worker({ ticket: "t-1" as TicketId }),
) =>
  withRender(
    <InterviewContext.Provider
      value={{ description: "Add a --json flag.", filed: external(false) }}
    >
      <Root
        value={{
          view: external(view),
          screen: external<Screen>(screen),
          commands: Effect.runSync(makeCommands),
          appearance: external<Appearance>("dark"),
          themeOf,
          now: () => now,
          transcripts: feed,
        }}
      />
    </InterviewContext.Provider>,
    size,
    body,
    { treeSitter: "mock" },
  )

const linesOf = (frame: Frame): ReadonlyArray<string> =>
  frame.chars
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => line.trimEnd())

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

const textOf = (segments: Segments): string => segments.map((each) => each.text).join("")

/** The row of the first line holding `text`, and its column there. */
const find = (frame: Frame, text: string): { readonly x: number; readonly y: number } => {
  const lines = linesOf(frame)
  const y = lines.findIndex((line) => line.includes(text))
  const row = lines[y] ?? ""
  return { x: Bun.stringWidth(row.slice(0, row.indexOf(text))), y }
}

const sizes = [
  { width: 80, height: 24 },
  { width: 120, height: 40 },
  { width: 60, height: 16 },
]

describe("the blank line above the head", () => {
  for (const size of sizes) {
    test(`at ${size.width}x${size.height}, on the dashboard's row, in both transcript views`, async () => {
      let titleRow = -1
      await scene(
        viewOf(),
        size,
        async (rendered) => {
          const frame = await until(rendered, has("Tutti"))
          titleRow = linesOf(frame).findIndex((line) => line.trim() !== "")
        },
        Screen.Dashboard(),
      )
      expect(titleRow).toBe(1)
      await scene(viewOf(), size, async (rendered) => {
        const lines = linesOf(await until(rendered, has("Reading the scripts.")))
        expect(lines[0]).toBe("")
        expect(lines[1]).toStartWith(" ← Dashboard")
        expect(lines.length).toBe(size.height)
      })
      await scene(
        viewOf(),
        size,
        async (rendered) => {
          const lines = linesOf(await until(rendered, has("Interview")))
          expect(lines[0]).toBe("")
          expect(lines[1]).toContain("Interview")
          expect(lines.length).toBe(size.height)
        },
        Screen.Interview(),
      )
    })
  }

  test("below the minimum size, none, as the dashboard has none", async () => {
    expect([aboveLines(60, 16), aboveLines(59, 16), aboveLines(60, 15)]).toEqual([1, 0, 0])
    await scene(viewOf(), { width: 60, height: 15 }, async (rendered) => {
      const lines = linesOf(await until(rendered, has("Reading the scripts.")))
      expect(lines[0]).toStartWith(" ← Dashboard")
    })
  })
})

describe("line 1", () => {
  const view = viewOf({ compactions: 2 })
  const card = view.cards[0]
  const resources = view.resources[0]
  if (card === undefined || resources === undefined) throw new Error("no card")
  const lineOf = (
    over: {
      readonly resources?: Resources
      readonly usage?: Usage | null
      readonly badges?: boolean
    } = {},
    width = 300,
  ) =>
    lineOneSegments(
      card,
      {
        status: [{ text: "working", look: null }],
        spin: "⣻",
        resources: over.resources ?? resources,
        figures: { usage: over.usage ?? null, now },
        badges: over.badges ?? false,
      },
      theme,
      width,
    )
  const memoryText = workerMemory(memory)
  const resetsAt = new Date(2026, 9, 25, 14, 20, 0).getTime()
  const usage: Usage = { utilization: 0.92, resetsAt, limit: "five-hour" }

  test("on a subscription: ID, status, time, estimate, context, compactions, memory; no type", () => {
    expect(textOf(lineOf())).toBe(
      `⣻ t-1  working  12m53s  ≈1% (estimate)  context 40k of 200k  ↻ 2 compactions  ${memoryText}`,
    )
  })

  test("on an API key: the dollars in the estimate's place", () => {
    const api = viewOf({ apiKey: true }).resources[0]
    if (api === undefined) throw new Error("no resources")
    expect(textOf(lineOf({ resources: api }))).toBe(
      `⣻ t-1  working  12m53s  $1.84  context 40k of 200k  ${memoryText}`,
    )
  })

  test("the time in the text's colour, the estimate without 5h window, no tokens", () => {
    const segments = lineOf()
    expect(segments.find((each) => each.text === "12m53s")?.look).toBeNull()
    const text = textOf(segments)
    expect(text).not.toContain("5h window")
    expect(text).not.toContain("tokens")
    expect(segments.find((each) => each.text === "≈1% (estimate)")?.look).toBe(
      theme.styles.estimate,
    )
  })

  test("the warning near a limit after the memory, still naming its window", () => {
    expect(textOf(lineOf({ usage }))).toBe(
      `⣻ t-1  working  12m53s  ≈1% (estimate)  context 40k of 200k  ↻ 2 compactions  ${memoryText}  ⚠ 5h window 92% · resets 14:20`,
    )
  })

  test("a narrow pane drops the memory, the reset time, the compactions, then from the end", () => {
    const lead = "⣻ t-1  working  12m53s"
    const context = "context 40k of 200k"
    const steps = [
      `${lead}  ≈1% (estimate)  ${context}  ↻ 2 compactions  ${memoryText}  ⚠ 5h window 92% · resets 14:20`,
      `${lead}  ≈1% (estimate)  ${context}  ↻ 2 compactions  ⚠ 5h window 92% · resets 14:20`,
      `${lead}  ≈1% (estimate)  ${context}  ↻ 2 compactions  ⚠ 5h window 92%`,
      `${lead}  ≈1% (estimate)  ${context}  ⚠ 5h window 92%`,
      `${lead}  ≈1% (estimate)  ${context}`,
      `${lead}  ≈1% (estimate)`,
      lead,
    ]
    const at = (width: number) => textOf(lineOf({ usage }, width))
    for (const [i, step] of steps.entries()) {
      expect(at(Bun.stringWidth(step))).toBe(step)
      const next = steps[i + 1]
      if (next !== undefined) expect(at(Bun.stringWidth(step) - 1)).toBe(next)
    }
    // The ID, status and time are never dropped: the line is cut once nothing more can go.
    expect(at(10)).toBe("⣻ t-1  wo…")
    expect(widthOf(lineOf({ usage }, 10))).toBe(10)
  })

  test("where the box isn't drawn: the type and priority at its end, the first whole part from it to go", () => {
    const lead = "⣻ t-1  working  12m53s"
    const context = "context 40k of 200k"
    const steps = [
      `${lead}  ≈1% (estimate)  ${context}  ↻ 2 compactions  ${memoryText}  ⚠ 5h window 92% · resets 14:20  feature · P2`,
      `${lead}  ≈1% (estimate)  ${context}  ↻ 2 compactions  ⚠ 5h window 92% · resets 14:20  feature · P2`,
      `${lead}  ≈1% (estimate)  ${context}  ↻ 2 compactions  ⚠ 5h window 92%  feature · P2`,
      `${lead}  ≈1% (estimate)  ${context}  ⚠ 5h window 92%  feature · P2`,
      `${lead}  ≈1% (estimate)  ${context}  ⚠ 5h window 92%`,
    ]
    const at = (width: number) => textOf(lineOf({ usage, badges: true }, width))
    for (const [i, step] of steps.entries()) {
      expect(at(Bun.stringWidth(step))).toBe(step)
      const next = steps[i + 1]
      if (next !== undefined) expect(at(Bun.stringWidth(step) - 1)).toBe(next)
    }
    const segments = lineOf({ badges: true })
    expect(segments.find((each) => each.text === "feature")?.look).toBe(theme.look("typeFeature"))
    expect(segments.find((each) => each.text === "P2")?.look).toBe(theme.styles.dim)
  })

  test("drawn: one line, the time and memory once, no tokens, no type", async () => {
    await scene(viewOf({ compactions: 2 }), { width: 140, height: 40 }, async (rendered) => {
      const frame = await until(rendered, has("Reading the scripts."))
      const lines = linesOf(frame)
      expect(lines[1]).toBe(
        ` ← Dashboard   ⣻ t-1  working  12m53s  ≈1% (estimate)  context 40k of 200k  ↻ 2 compactions  ${memoryText}`,
      )
      expect(frame.chars.split("12m53s").length - 1).toBe(1)
      expect(frame.chars.split(memoryText).length - 1).toBe(1)
      expect(frame.chars).not.toContain("tokens")
      const spans = frame.spans.lines[1]?.spans ?? []
      const time = spans.find((each) => each.text.includes("12m53s"))
      const word = spans.find((each) => each.text.includes("context"))
      const dim = spans.find((each) => each.text.includes(memoryText))
      // Not faint, as the memory is.
      expect(time?.attributes ?? 0).toBe(0)
      expect(word?.attributes ?? 0).toBe(0)
      expect(dim?.attributes ?? 0).not.toBe(0)
    })
  })
})

describe("the ticket's box", () => {
  test("at 120x40: a blank line, then the box named Ticket, its type and priority at its top right; the title in bold, a blank line, 5 lines", async () => {
    await scene(viewOf(), { width: 120, height: 40 }, async (rendered) => {
      const frame = await until(rendered, has("Reading the scripts."))
      const lines = linesOf(frame)
      expect(lines[2]).toBe("")
      expect(lines[3]).toMatch(/^╭─ Ticket ─+ feature · P2 ─╮$/)
      expect(Bun.stringWidth(lines[3] ?? "")).toBe(120)
      const top = frame.spans.lines[3]?.spans ?? []
      const name = top.find((each) => each.text === "Ticket")
      expect((name?.attributes ?? 0) & 1).toBe(1)
      expect(top.find((each) => each.text === "feature")?.fg.toInts()).toEqual(
        theme.rgba("typeFeature", "fg").toInts(),
      )
      expect(lines[4]).toBe(`│ ${title}${" ".repeat(120 - 4 - title.length)} │`)
      const span = frame.spans.lines[4]?.spans.find((each) => each.text.includes("Question"))
      expect((span?.attributes ?? 0) & 1).toBe(1)
      expect(lines[5]).toMatch(/^│ +│$/)
      for (const row of lines.slice(6, 11)) expect(row).toMatch(/^│ \S.*│$/)
      expect(lines[10]).toContain("…")
      expect(lines[11]).toMatch(/^╰─+ ▾ whole ticket {2}t ─╯$/)
      expect(lines[12]).toMatch(/^─+$/)
      const control = frame.spans.lines[11]?.spans.find((each) => each.text.includes("▾"))
      expect(control?.fg.toInts()).toEqual(theme.rgba("link", "fg").toInts())
      // The title has no line of its own outside the box.
      expect(lines.filter((line) => line.includes("Question tickets give")).length).toBe(1)
    })
  })

  test("a long title on 2 lines in the box, cut with …", async () => {
    const long = Array.from({ length: 14 }, () => "a long title").join(" ")
    await scene(viewOf({ title: long }), { width: 80, height: 40 }, async (rendered) => {
      const lines = linesOf(await until(rendered, has("Reading the scripts.")))
      expect(lines[3]).toMatch(/^╭─ Ticket ─+ feature · P2 ─╮$/)
      expect(lines[4]).toStartWith("│ a long title")
      expect(lines[5]).toMatch(/^│ .*… +│$/)
      expect(Bun.stringWidth(lines[5] ?? "")).toBe(80)
      expect(lines[6]).toMatch(/^│ +│$/)
      expect(lines[7]).toStartWith("│ Question tickets carry")
    })
  })

  test("expanded, the same box grows: its top border, title and blank line kept, its control still in its bottom border", async () => {
    const notes = Array.from({ length: 30 }, (_, i) => `Note ${i + 1}.`).join("\n\n")
    await scene(
      viewOf({ issue: issueOf({ notes }) }),
      { width: 120, height: 40 },
      async (rendered) => {
        const closed = await until(rendered, has("Reading the scripts."))
        const at = find(closed, "▾ whole ticket")
        await rendered.input((setup) => setup.mockMouse.click(at.x, at.y))
        const open = await until(rendered, has("▴ less"))
        const lines = linesOf(open)
        // The box starts where it did, its top border as it was.
        expect(lines[3]).toMatch(/^╭─ Ticket ─+ feature · P2 ─╮$/)
        expect(lines[4]).toStartWith(`│ ${title}`)
        expect(lines[5]).toMatch(/^│ +│$/)
        expect(lines[6]).toStartWith("│ Question tickets carry")
        const bottom = lines.findIndex((line) => line.startsWith("╰"))
        expect(bottom).toBeGreaterThan(11)
        // Up to 60% of the pane, its frame and title included.
        expect(bottom - 3 + 1).toBeLessThanOrEqual(Math.floor(40 * 0.6))
        expect(lines[bottom]).toMatch(/^╰─+ ↓ \d+ more lines ── ▴ less {2}t · Esc ─╯$/)
        expect(open.chars).not.toContain("▾ whole ticket")
        // Scrolled, the title and its blank line stay at the box's top.
        await rendered.input(async (setup) => {
          await setup.mockMouse.scroll(10, 8, "down")
          await Bun.sleep(30)
        })
        const scrolled = await until(
          rendered,
          (frame) => !frame.chars.includes("Question tickets carry"),
        )
        expect(linesOf(scrolled)[4]).toStartWith(`│ ${title}`)
        expect(linesOf(scrolled)[5]).toMatch(/^│ +│$/)
        // Only ▴ less closes it.
        const less = find(scrolled, "▴ less")
        await rendered.input((setup) => setup.mockMouse.click(less.x, less.y))
        const shut = await until(rendered, has("▾ whole ticket"))
        expect(linesOf(shut)[11]).toMatch(/^╰─+ ▾ whole ticket {2}t ─╯$/)
      },
    )
  })

  test("a short description's box is as tall as it needs, with no control", async () => {
    await scene(
      viewOf({ issue: issueOf({ description: "Read the second file too." }) }),
      { width: 80, height: 40 },
      async (rendered) => {
        const lines = linesOf(await until(rendered, has("Reading the scripts.")))
        expect(lines.slice(4, 8)).toEqual([
          `│ ${title}${" ".repeat(76 - title.length)} │`,
          `│${" ".repeat(78)}│`,
          `│ Read the second file too.${" ".repeat(52)}│`,
          `╰${"─".repeat(78)}╯`,
        ])
        expect(lines[8]).toMatch(/^─+$/)
      },
    )
  })

  test("no description: No description., faint, in the box", async () => {
    await scene(
      viewOf({ issue: issueOf({ description: "" }) }),
      { width: 80, height: 40 },
      async (rendered) => {
        const frame = await until(rendered, has("Reading the scripts."))
        expect(linesOf(frame)[6]).toStartWith("│ No description.")
        const span = frame.spans.lines[6]?.spans.find((each) =>
          each.text.includes("No description"),
        )
        expect(span?.attributes ?? 0).not.toBe(0)
      },
    )
  })
})

describe("a shorter pane", () => {
  test("gives up the description's lines, then the box's blank line, then the one above it", () => {
    const all = { head: 1, ticket: 1 }
    expect([31, 30, 29, 28, 27, 26, 25, 20].map((height) => headExtras(height, all, 3))).toEqual([
      { headGap: 1, ticketGap: 1, ticketMore: 3 },
      { headGap: 1, ticketGap: 1, ticketMore: 3 },
      { headGap: 1, ticketGap: 1, ticketMore: 2 },
      { headGap: 1, ticketGap: 1, ticketMore: 1 },
      { headGap: 1, ticketGap: 1, ticketMore: 0 },
      { headGap: 1, ticketGap: 0, ticketMore: 0 },
      { headGap: 0, ticketGap: 0, ticketMore: 0 },
      { headGap: 0, ticketGap: 0, ticketMore: 0 },
    ])
    expect(fullHeadFrom).toBe(30)
  })

  /**
   * The head's rows at `height`: the box's description lines, whether the blank line above it and
   * the one in it are there, and where the title is.
   */
  const headAt = async (height: number) => {
    let shape = { described: 0, above: false, inBox: false, title: "", lineOne: "" }
    await scene(viewOf(), { width: 120, height }, async (rendered) => {
      const lines = linesOf(await until(rendered, has("Reading the scripts.")))
      const rule = lines.findIndex((line) => /^─+$/.test(line))
      const head = lines.slice(2, rule)
      const sides = head.filter((line) => line.startsWith("│"))
      shape = {
        described: sides.filter((line) => /^│ (?!Question tickets give)\S/.test(line)).length,
        above: head[0] === "",
        inBox: sides.some((line) => /^│ +│$/.test(line)),
        title: sides.some((line) => line.startsWith(`│ ${title}`))
          ? "box"
          : head.some((line) => line === `  ${title}`)
            ? "alone"
            : "",
        lineOne: lines.find((line) => line.includes("← Dashboard")) ?? "",
      }
    })
    return shape
  }

  test("drawn, at 30, 28, 26, 24 and 16 rows", async () => {
    const at = async (height: number) => {
      const { lineOne, ...shape } = await headAt(height)
      return { ...shape, badges: lineOne.endsWith("feature · P2") }
    }
    expect(await at(30)).toEqual({
      described: 5,
      above: true,
      inBox: true,
      title: "box",
      badges: false,
    })
    expect(await at(28)).toEqual({
      described: 3,
      above: true,
      inBox: true,
      title: "box",
      badges: false,
    })
    expect(await at(26)).toEqual({
      described: 2,
      above: true,
      inBox: false,
      title: "box",
      badges: false,
    })
    expect(await at(24)).toEqual({
      described: 2,
      above: false,
      inBox: false,
      title: "box",
      badges: false,
    })
    // The minimum size: line 1, ending with the type and priority, and the title alone in bold.
    expect(await at(16)).toEqual({
      described: 0,
      above: false,
      inBox: false,
      title: "alone",
      badges: true,
    })
  })

  test("at the minimum size, the type and priority on line 1 in their colours, the title bold under it", async () => {
    await scene(viewOf(), { width: 120, height: 16 }, async (rendered) => {
      const frame = await until(rendered, has("Reading the scripts."))
      const lines = linesOf(frame)
      expect(lines[1]).toEndWith("feature · P2")
      expect(frame.chars).not.toContain("Ticket")
      const spans = frame.spans.lines[1]?.spans ?? []
      expect(spans.find((each) => each.text === "feature")?.fg.toInts()).toEqual(
        theme.rgba("typeFeature", "fg").toInts(),
      )
      expect(lines[2]).toStartWith("  Question tickets")
      const span = frame.spans.lines[2]?.spans.find((each) => each.text.includes("Question"))
      expect((span?.attributes ?? 0) & 1).toBe(1)
    })
  })
})

describe("the dashboard's card", () => {
  test("keeps its own head, the time and memory faint after the status", async () => {
    await scene(
      viewOf(),
      { width: 120, height: 40 },
      async (rendered) => {
        const frame = await until(rendered, has("12m53s"))
        expect(frame.chars).toMatch(
          new RegExp(`t-1 +working +12m53s +${workerMemory(memory).replace(".", "\\.")}`),
        )
      },
      Screen.Dashboard(),
    )
  })
})
