// The worker view's resource line (§ 7.5, worker-view design D2): what the worker consumes, on a
// subscription and on an API key; the estimate's colour and its word, under NO_COLOR too; the
// context gauge's amounts and colours; compactions once there has been one; the warning near a
// limit; a narrow pane dropping its parts in order; the two-space gaps; and the breakdown a click
// on the line opens.
import { describe, expect, test } from "bun:test"
import { TextAttributes } from "@opentui/core"
import { Effect } from "effect"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { makeCommands } from "../src/run/commands.ts"
import { emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import type { Resources } from "../src/run/resources.ts"
import { emptyStatus, project, type Usage } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import { workerMemory } from "../src/ui/LoadLine.tsx"
import { type Segments, widthOf } from "../src/ui/line.tsx"
import {
  contextLook,
  type LineInputs,
  resourceSegments,
  shareText,
  spentLines,
} from "../src/ui/ResourceLine.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  emptyTranscript,
  type OpenTranscript,
  type TranscriptFeed,
  type TranscriptState,
  windowOf,
} from "../src/ui/transcriptItems.ts"
import { external } from "../src/ui/useRunView.ts"
import { type Frame, pressEscape, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")
const noColor = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: true })

const began = new Date(2026, 9, 24, 13, 0, 0).getTime()
/** 6m53s on. */
const now = began + 413_000
const model = "claude-opus-5-5"
const memory = 0.8 * 1024 ** 3

/** A worker 6m53s on its ticket, 1.2M tokens in, its context 126k of 200k. */
const resources = (over: Partial<Resources> = {}): Resources => ({
  ticket: "t-1",
  took: began,
  spent: {
    costUsd: 1.84,
    turns: 41,
    results: 3,
    tokens: {
      [model]: { input: 2_000, output: 30_000, cache_write: 168_000, cache_read: 1_000_000 },
    },
  },
  runTokens: 10_000_000,
  subscription: true,
  window: { share: 0.012, rise: 0.06, cost: 1.84, runCost: 9.2 },
  context: {
    tokens: 126_000,
    window: 200_000,
    percentage: 63,
    split: [
      { name: "Messages", tokens: 100_000 },
      { name: "System tools", tokens: 26_000 },
    ],
  },
  compactions: 0,
  ...over,
})

const inputs = (over: Partial<LineInputs> = {}): LineInputs => ({
  memory,
  usage: null,
  now,
  ...over,
})

const textOf = (segments: Segments): string => segments.map((each) => each.text).join("")

const lineOf = (r: Resources, over: Partial<LineInputs> = {}, width = 200) =>
  resourceSegments(r, inputs(over), theme, width)

describe("the resource line", () => {
  test("on a subscription: time, tokens, the 5-hour share as an estimate, context, memory", () => {
    expect(textOf(lineOf(resources()))).toBe(
      `6m53s  1.2M tokens  5h window ≈1% (estimate)  context ▰▰▰▰▰▰▱▱▱▱  126k of 200k  ${workerMemory(memory)}`,
    )
  })

  test("on an API key: its dollars, in the text's colour, and no window", () => {
    const segments = lineOf(resources({ subscription: false, window: null }))
    expect(textOf(segments)).toBe(
      `6m53s  1.2M tokens  $1.84  context ▰▰▰▰▰▰▱▱▱▱  126k of 200k  ${workerMemory(memory)}`,
    )
    expect(segments.find((each) => each.text === "$1.84")?.look).toBeNull()
  })

  test("on a subscription before the window is heard, no share", () => {
    expect(textOf(lineOf(resources({ window: null })))).toBe(
      `6m53s  1.2M tokens  context ▰▰▰▰▰▰▱▱▱▱  126k of 200k  ${workerMemory(memory)}`,
    )
  })

  test("the estimate in its italic colour, followed by its word, which NO_COLOR keeps", () => {
    const estimate = lineOf(resources()).find((each) => each.text.includes("(estimate)"))
    expect(estimate?.text).toBe("≈1% (estimate)")
    expect(estimate?.look).toBe(theme.styles.estimate)
    expect((theme.styles.estimate.attributes & TextAttributes.ITALIC) !== 0).toBe(true)
    const plain = resourceSegments(resources(), inputs(), noColor, 200)
    expect(textOf(plain)).toContain("5h window ≈1% (estimate)")
    expect(shareText(0.004)).toBe("<1%")
    expect(shareText(0)).toBe("≈0%")
    expect(shareText(0.126)).toBe("≈13%")
  })

  test("the context gauge's amounts, plain at 50%, yellow from 70%, red near compaction", () => {
    const at = (tokens: number) => {
      const segments = lineOf(
        resources({ context: { tokens, window: 200_000, percentage: 0, split: [] } }),
      )
      const figure = segments.findIndex((each) => each.text === "context ")
      return {
        gauge: segments[figure + 1],
        figure: segments[figure + 3],
        text: textOf(segments.slice(figure, figure + 6)),
      }
    }
    const half = at(100_000)
    expect(half.text).toBe("context ▰▰▰▰▰▱▱▱▱▱  100k of 200k")
    expect(half.figure?.look).toBeNull()
    expect(half.gauge?.look).toBe(theme.styles.dim)
    const three = at(150_000)
    expect(three.text).toBe("context ▰▰▰▰▰▰▰▰▱▱  150k of 200k")
    expect(three.gauge?.look).toBe(theme.look("notice"))
    expect(three.figure?.look).toBe(theme.look("notice"))
    const near = at(190_000)
    expect(near.text).toBe("context ▰▰▰▰▰▰▰▰▰▰  190k of 200k")
    expect(near.gauge?.look).toBe(theme.look("needsYou"))
    expect(contextLook(0.95, theme)).toBe(theme.look("needsYou"))
    expect(contextLook(0.5, theme)).toBeNull()
  })

  test("compactions show only once there has been one", () => {
    expect(textOf(lineOf(resources()))).not.toContain("compaction")
    expect(textOf(lineOf(resources({ compactions: 1 })))).toContain(
      "126k of 200k  ↻ 1 compaction  ",
    )
    expect(textOf(lineOf(resources({ compactions: 2 })))).toContain("↻ 2 compactions")
  })

  test("near a limit, the account's figure as a warning with its reset", () => {
    const resetsAt = new Date(2026, 9, 24, 14, 20, 0).getTime()
    const usage: Usage = { utilization: 0.92, resetsAt, limit: "five-hour" }
    const segments = lineOf(resources(), { usage })
    expect(textOf(segments)).toEndWith(`${workerMemory(memory)}  ⚠ 5h window 92% · resets 14:20`)
    expect(segments.at(-1)?.look).toBe(theme.styles.deferred)
    const reached = lineOf(resources(), { usage: { ...usage, utilization: 1 } })
    expect(reached.at(-1)?.look).toBe(theme.styles.testing)
  })

  test("every gauge and figure and every part two spaces apart, segments of their own", () => {
    const segments = lineOf(resources({ compactions: 2 }))
    const gauge = segments.findIndex((each) => each.text.startsWith("▰"))
    expect(segments[gauge + 1]?.text).toBe("  ")
    expect(segments[gauge + 2]?.text).toBe("126k")
    // No segment but the gaps starts or ends with a space beside another part.
    const gaps = segments.filter((each) => each.text === "  ")
    expect(gaps.length).toBe(6)
  })

  test("a narrow pane drops the memory, then the reset time, then compactions; never a figure", () => {
    const resetsAt = new Date(2026, 9, 24, 14, 20, 0).getTime()
    const usage: Usage = { utilization: 0.92, resetsAt, limit: "five-hour" }
    const r = resources({ compactions: 2 })
    const full = lineOf(r, { usage })
    const at = (width: number) => textOf(lineOf(r, { usage }, width))
    const head = "6m53s  1.2M tokens  5h window ≈1% (estimate)  context ▰▰▰▰▰▰▱▱▱▱  126k of 200k"
    expect(at(widthOf(full))).toBe(
      `${head}  ↻ 2 compactions  ${workerMemory(memory)}  ⚠ 5h window 92% · resets 14:20`,
    )
    const noMemory = `${head}  ↻ 2 compactions  ⚠ 5h window 92% · resets 14:20`
    expect(at(widthOf(full) - 1)).toBe(noMemory)
    const noReset = `${head}  ↻ 2 compactions  ⚠ 5h window 92%`
    expect(at(noMemory.length - 1)).toBe(noReset)
    const noCompactions = `${head}  ⚠ 5h window 92%`
    expect(at(noReset.length - 1)).toBe(noCompactions)
    // Then whole parts from the end: the context goes with its figure, the estimate with its word.
    expect(at(noCompactions.length - 1)).toBe(head)
    expect(at(head.length - 1)).toBe("6m53s  1.2M tokens  5h window ≈1% (estimate)")
    expect(at(30)).toBe("6m53s  1.2M tokens")
    expect(at(4)).toBe("6m5…")
  })
})

describe("the breakdown", () => {
  const linesText = (r: Resources) =>
    spentLines(r, theme, 200)
      .map((line) => textOf(line).trimEnd())
      .join("\n")

  test("on a subscription: tokens by model, calls, dollars and the window as estimates, context", () => {
    const text = linesText(resources({ compactions: 2 }))
    expect(text).toContain("Spent")
    expect(text).toContain("tokens      1.2M · 85% of the input from the cache")
    expect(text).toContain(`${model}  1.2M · 2k in, 168k cache writes, 1M cache reads, 30k out`)
    expect(text).toContain("model calls 41 model calls")
    expect(text).toContain("dollars     $1.84 at API prices (estimate)")
    expect(text).toContain("5h window   ≈1% (estimate): the window rose 6% over the run")
    expect(text).toContain("this ticket's $1.84 of the run's $9.20")
    expect(text).toContain("context     63% of 200k, 126k tokens: Messages 100k · System tools 26k")
    expect(text).toContain("compactions ↻ 2")
    expect(text).toContain("of the run  12% of its 10M tokens")
    const estimates = spentLines(resources(), theme, 76)
      .flat()
      .filter((each) => each.text.includes("(estimate)"))
    expect(estimates.every((each) => each.look === theme.styles.estimate)).toBe(true)
  })

  test("on an API key: the dollars spent, plain, and no window", () => {
    const text = linesText(resources({ subscription: false, window: null }))
    expect(text).toContain("dollars     $1.84")
    expect(text).not.toContain("estimate")
    expect(text).not.toContain("5h window")
  })

  test("before the session has said, the context is not measured yet", () => {
    expect(linesText(resources({ context: null }))).toContain("context     not measured yet")
  })
})

describe("in the worker view", () => {
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
            tallies: { ...emptyTallies, compactions: 2 },
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
      spending: {
        tickets: new Map([["t-1", resources().spent]]),
        total: { ...resources().spent, costUsd: 9.2 },
      },
      contexts: new Map([
        ["t-1", resources().context ?? { tokens: 0, window: 1, percentage: 0, split: [] }],
      ]),
    },
    actions: new Map(),
    now,
  })

  const scene = (
    body: (rendered: Parameters<Parameters<typeof withRender>[2]>[0]) => Promise<void>,
  ) =>
    withRender(
      <Root
        value={{
          view: external(view),
          screen: external<Screen>(Screen.Worker({ ticket: "t-1" })),
          commands: Effect.runSync(makeCommands),
          appearance: external<Appearance>("dark"),
          themeOf,
          now: () => now,
          transcripts: feed,
        }}
      />,
      { width: 100, height: 30 },
      body,
      { treeSitter: "mock" },
    )

  const linesOf = (frame: Frame): ReadonlyArray<string> =>
    frame.chars.split("\n").map((line) => line.trimEnd())

  test("the line under the head; a click opens the breakdown, Esc closes it", async () => {
    await scene(async (rendered) => {
      const frame = await rendered.capture()
      const lines = linesOf(frame)
      const row = lines.findIndex((line) => line.includes("tokens"))
      expect(row).toBe(1)
      expect(lines[row]).toBe(
        "  6m53s  1.2M tokens  5h window ≈1% (estimate)  context ▰▰▰▰▰▰▱▱▱▱  126k of 200k  ↻ 2 compactions",
      )
      await rendered.input((setup) => setup.mockMouse.click(4, row))
      const open = await rendered.capture()
      expect(open.chars).toContain("Spent")
      expect(open.chars).toContain("41 model calls")
      expect(open.chars).toContain("$1.84 at API prices (estimate)")
      await rendered.input((setup) => pressEscape(setup))
      const closed = await rendered.capture()
      expect(closed.chars).not.toContain("41 model calls")
      expect(closed.chars).toContain("← Dashboard")
    })
  })
})
