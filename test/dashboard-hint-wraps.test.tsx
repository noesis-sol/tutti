// The dashboard's hint wraps every key onto as many lines as it takes, as the views' do (§ 7.5;
// tutti-p19v): at 60 to 75 columns with a request open, the whole hint is 76 columns, and a hint cut
// to one line lost `? keys` and part of `s`. Where a request's buttons aren't drawn, the hint
// without `d` and `a` gives the lines it no longer needs to the blank ones above the foot. A toast
// is drawn above the hint's lines, however many it wraps onto (useLinesUnderToasts).

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { makeCommands } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { dashboardLayout } from "../src/ui/Dashboard.tsx"
import { widthOf } from "../src/ui/line.tsx"
import { suspendToast } from "../src/ui/Toasts.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external } from "../src/ui/useRunView.ts"
import { type Rendered, renderFrame, type Size, withRender } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()

const entryOf = (ticket: TicketId, worker: number, row: number): Entry => ({
  ticket,
  title: `Title of ${ticket}`,
  phase: TicketPhase.Working(),
  since: began,
  worker,
  row,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

/** RunView for workers 1 to `workers` on t-1, t-2, …, a Bash call on t-1's waiting for you. */
const viewOf = (workers: number): RunView =>
  project({
    ledger: {
      tickets: new Map(
        Array.from({ length: workers }, (_, i) => [
          `t-${i + 1}` as TicketId,
          entryOf(`t-${i + 1}` as TicketId, i + 1, i),
        ]),
      ),
      rows: workers,
      windDown: null,
      bugs: [],
    },
    workers: new Map(
      Array.from({ length: workers }, (_, i) => [`t-${i + 1}`, WS.Idle({ at: began })]),
    ),
    requests: [permission],
    status: {
      ...emptyStatus,
      version: "0.1.0",
      branch: "batch",
      began,
      concurrency: workers,
      endOfRun: null,
    },
    actions: new Map(),
  })

const permission: AttentionRequest = {
  id: "r1",
  ticket: "t-1" as TicketId,
  kind: {
    _tag: "Permission",
    tool: "Bash",
    input: { command: "rm -rf build" },
    suggestions: [],
    summary: "rm -rf build",
  },
  displayName: "Bash",
  description: "Remove the build cache",
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: began,
}

/** The dashboard over `view`. */
const dashboard = (view: RunView) => {
  const value = {
    view: external(view),
    screen: external<Screen>(Screen.Dashboard()),
    commands: Effect.runSync(makeCommands),
    appearance: external<Appearance>("dark"),
    themeOf,
    now: () => began,
  }
  return <Root value={value} />
}

const linesOf = (chars: string): ReadonlyArray<string> =>
  chars.split("\n").map((line) => line.trimEnd())

/** The frame's lines, their trailing spaces left out. */
const draw = async (view: RunView, size: Size): Promise<ReadonlyArray<string>> =>
  linesOf((await renderFrame(dashboard(view), size)).chars)

/** The frame's lines once `text` shows, or after 5 s. */
const until = async (rendered: Rendered, text: string): Promise<ReadonlyArray<string>> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const frame = await rendered.capture()
    if (frame.chars.includes(text) || Date.now() > deadline) return linesOf(frame.chars)
    await Bun.sleep(20)
  }
}

/** The pane's last `count` lines, the hint's, joined on one. */
const footOf = (lines: ReadonlyArray<string>, height: number, count: number): string =>
  lines
    .slice(height - count, height)
    .map((line) => line.trim())
    .join(" ")

const everyKey = ["Tab select", "Enter open", "d deny", "a allow", "s stop after current", "? keys"]

describe("the dashboard's hint", () => {
  test("is 76 columns whole with a request open, so it takes one line from 76 columns", () => {
    for (const width of [76, 120]) {
      const laid = dashboardLayout(viewOf(1), theme, width, 40)
      expect(laid.cards._tag).toBe("Cards")
      expect(laid.hint).toHaveLength(1)
    }
  })

  test("at 60 to 75 columns, with a request's buttons drawn, wraps every key onto two lines", async () => {
    for (const width of [60, 65, 70, 75]) {
      const size = { width, height: 40 }
      const laid = dashboardLayout(viewOf(1), theme, width, size.height)
      expect(laid.cards._tag).toBe("Cards")
      expect(laid.hint).toHaveLength(2)
      expect(laid.hint.every((line) => widthOf(line) <= width)).toBe(true)
      const lines = await draw(viewOf(1), size)
      expect(lines.some((line) => line.includes("[ Deny ]"))).toBe(true)
      const foot = footOf(lines, size.height, 2)
      for (const key of everyKey) expect(foot).toContain(key)
      // A line breaks between two keys, not inside one.
      expect(lines[size.height - 2]?.trimEnd().endsWith("·")).toBe(false)
    }
  })

  test("without a request's buttons, leaves out d and a and gives the line it frees to the blanks", () => {
    const view = viewOf(4)
    const laid = dashboardLayout(view, theme, 70, 24)
    expect(laid.cards._tag).toBe("Compact")
    expect(laid.hint).toHaveLength(1)
    const sections = [
      laid.title,
      laid.gap,
      laid.load,
      laid.totals.length,
      laid.table,
      laid.current,
      laid.spare,
      laid.windDown,
      laid.warnings.length,
      laid.hint.length,
    ]
    expect(sections.reduce((sum, lines) => sum + lines, 0)).toBe(24)
  })

  test("below the minimum size, wraps every key it offers rather than cut it", async () => {
    const size = { width: 40, height: 15 }
    const laid = dashboardLayout(viewOf(1), theme, size.width, size.height)
    expect(laid.small).toBe(true)
    expect(laid.hint.length).toBeGreaterThan(1)
    const foot = footOf(await draw(viewOf(1), size), size.height, laid.hint.length)
    for (const key of ["Tab select", "Enter open", "s stop after current", "? keys"]) {
      expect(foot).toContain(key)
    }
    expect(foot).not.toContain("a allow")
  })

  test("has a toast drawn above its two lines, not over the first", async () => {
    const size = { width: 70, height: 40 }
    await withRender(dashboard(viewOf(1)), size, async (rendered) => {
      await rendered.input((setup) => setup.mockInput.pressKey("z", { ctrl: true }))
      const lines = await until(rendered, "can't be suspended")
      expect(footOf(lines, size.height, 2)).toBe(
        "Tab select · Enter open · d deny · a allow · s stop after current ? keys",
      )
      expect(lines[size.height - 3]).toContain(suspendToast.slice(0, 30))
    })
  })
})
