// One layout function per screen (tutti-axpo.5): the dashboard's sections (dashboardLayout) and a
// transcript view's parts (viewLayout) are handed out in priority order and add up to the pane's
// height, each drawing within its own lines, so that no part draws over the one below it.

import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect } from "effect"
import fc from "fast-check"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import { type Item, transcriptVersion } from "../src/agent/Transcripts.ts"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { makeCommands } from "../src/run/commands.ts"
import { emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import {
  type Card,
  emptyStatus,
  emptyView,
  project,
  type RunView,
  shownRequest,
} from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { compactLines, labelLines, sectionLines } from "../src/ui/Card.tsx"
import { type DashboardLayout, dashboardLayout } from "../src/ui/Dashboard.tsx"
import { type Motion, motionTones } from "../src/ui/marks.ts"
import { fewestTableLines, ticketsLines } from "../src/ui/TicketsTable.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import {
  emptyTranscript,
  type OpenTranscript,
  type TranscriptFeed,
  type TranscriptState,
  windowOf,
} from "../src/ui/transcriptItems.ts"
import { external, spinnerFrames } from "../src/ui/useRunView.ts"
import { transcriptRows, type ViewChrome, viewLayout } from "../src/ui/WorkerView.tsx"
import { type Frame, renderFrame } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()
const now = began + 67_000

/** A Bash permission request on `ticket`, its command `lines` lines long. */
const bash = (id: string, ticket: TicketId, lines: number): AttentionRequest => ({
  id,
  ticket,
  kind: {
    _tag: "Permission",
    tool: "Bash",
    input: {
      command: Array.from({ length: lines }, (_, i) => `echo ${id} step ${i + 1}`).join("\n"),
    },
    suggestions: [],
    summary: `${id} steps`,
  },
  displayName: "Bash",
  description: `Run the ${id} steps`,
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: began,
})

const motions = Object.keys(motionTones) as ReadonlyArray<Motion>

const cardArb = (i: number): fc.Arbitrary<Card> =>
  fc
    .record({
      motion: fc.constantFrom(...motions),
      action: fc.option(fc.string({ maxLength: 30 }), { nil: null }),
      asks: fc.boolean(),
      title: fc.string({ maxLength: 60 }),
    })
    .map(({ motion, action, asks, title }) => ({
      ticket: `t-${i}` as TicketId,
      label: `t-${i}`,
      title,
      worker: i,
      phase: TicketPhase.Working(),
      state: null,
      status: "working",
      tone: motionTones[motion],
      motion,
      since: began,
      action,
      latest: null,
      steered: false,
      requests: asks ? [shownRequest(bash(`r${i}`, `t-${i}` as TicketId, 3))] : [],
    }))

/** A RunView of up to 30 cards, 20 slots, 8 warnings, the wind-down and the end-of-run box. */
const viewArb: fc.Arbitrary<RunView> = fc
  .record({
    cards: fc
      .integer({ min: 0, max: 30 })
      .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => cardArb(i + 1)))),
    slots: fc.integer({ min: 0, max: 20 }),
    warnings: fc.array(fc.string({ maxLength: 120 }), { maxLength: 8 }),
    windingDown: fc.boolean(),
    waiting: fc.option(
      fc.array(
        fc.record({
          ticket: fc.string({ minLength: 1, maxLength: 12 }),
          asks: fc.array(fc.string({ maxLength: 60 }), { minLength: 1, maxLength: 3 }),
        }),
        { maxLength: 8 },
      ),
      { nil: null },
    ),
  })
  .map(({ cards, slots, warnings, windingDown, waiting }) => ({
    ...emptyView,
    totals: { ...emptyView.totals, slots, workers: Math.min(slots, cards.length) },
    cards,
    warnings,
    windDown: windingDown ? { marks: [], running: cards.length } : null,
    endOfRun: waiting,
  }))

/** Every section's lines, top to bottom. */
const sectionsOf = (laid: DashboardLayout): ReadonlyArray<number> => [
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

describe("dashboardLayout", () => {
  test("its sections add up to the pane, each drawing within its lines", () => {
    fc.assert(
      fc.property(
        viewArb,
        fc.integer({ min: 20, max: 200 }),
        fc.integer({ min: 0, max: 80 }),
        (view, width, height) => {
          const laid = dashboardLayout(view, theme, width, height)
          const sections = sectionsOf(laid)
          expect(sections.every((lines) => lines >= 0)).toBe(true)
          expect(sections.reduce((sum, lines) => sum + lines, 0)).toBe(height)
          expect(laid.warnings.length).toBeLessThanOrEqual(view.warnings.length)
          if (laid.small) return
          // The pane at its minimum holds the title, the totals, the foot and Current at its fewest.
          expect([laid.title, laid.load, laid.windDown, laid.hint.length]).toEqual([2, 1, 1, 1])
          expect(laid.table === 0 || laid.table >= fewestTableLines).toBe(true)
          if (laid.table > 0) {
            expect(ticketsLines(view.rows, theme, width, { lines: laid.table })).toHaveLength(
              laid.table,
            )
          }
          if (laid.ending !== null) {
            expect(laid.ending.length).toBe(laid.current)
            expect(laid.ending.length).toBeGreaterThan(0)
            return
          }
          expect(laid.current).toBeGreaterThanOrEqual(4)
          if (laid.cards._tag === "Compact") {
            const box = compactLines(view.cards, theme, {
              now,
              spin: spinnerFrames[0],
              width,
              highlighted: null,
              lines: laid.current - labelLines,
            })
            expect(labelLines + box.length).toBeLessThanOrEqual(laid.current)
          } else {
            expect(sectionLines(laid.cards, view.cards.length)).toBeLessThanOrEqual(laid.current)
          }
        },
      ),
    )
  })

  test("below the minimum size, only the totals and the hint", () => {
    const laid = dashboardLayout(emptyView, theme, 59, 30)
    expect(laid.small).toBe(true)
    expect([laid.totals.length, laid.hint.length, laid.spare]).toEqual([1, 1, 28])
    expect(dashboardLayout(emptyView, theme, 80, 1).totals).toHaveLength(0)
  })

  test("the blank line over the load line goes before the tickets table", () => {
    // 80 columns, 3 slots: the title, the strip and the foot take 8 lines, a line each for the
    // workers 6, and the table its fewest 6.
    const view = { ...emptyView, totals: { ...emptyView.totals, slots: 3 } }
    expect(dashboardLayout(view, theme, 80, 21)).toMatchObject({ table: 6, gap: 1 })
    expect(dashboardLayout(view, theme, 80, 20)).toMatchObject({ table: 6, gap: 0 })
    expect(dashboardLayout(view, theme, 80, 19)).toMatchObject({ table: 0, gap: 1 })
  })
})

/** A transcript view's chrome: up to 12 lines a part, as a narrow pane and a long message make. */
const chromeArb: fc.Arbitrary<ViewChrome> = fc.record({
  above: fc.integer({ min: 0, max: 1 }),
  head: fc.integer({ min: 1, max: 4 }),
  headGap: fc.integer({ min: 0, max: 1 }),
  title: fc.integer({ min: 0, max: 2 }),
  ticketGap: fc.integer({ min: 0, max: 1 }),
  ticket: fc.integer({ min: 0, max: 12 }),
  ticketMore: fc.integer({ min: 0, max: 3 }),
  handBack: fc.constantFrom(0, 5),
  held: fc.integer({ min: 0, max: 1 }),
  line: fc.integer({ min: 0, max: 1 }),
  queued: fc.integer({ min: 0, max: 6 }),
  composer: fc.integer({ min: 1, max: 12 }),
  hint: fc.integer({ min: 1, max: 3 }),
})

describe("viewLayout", () => {
  test("its parts add up to the pane, none more than it needs", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 80 }),
        chromeArb,
        fc.integer({ min: 0, max: 60 }),
        (height, chrome, panel) => {
          const laid = viewLayout(height, chrome, panel)
          const parts = [
            laid.above,
            laid.head,
            laid.headGap,
            laid.title,
            laid.ticketGap,
            laid.ticket,
            laid.ticketMore,
            laid.rules[0],
            laid.transcript,
            laid.handBack,
            laid.panel,
            laid.rules[1],
            laid.held,
            laid.line,
            laid.queued,
            laid.composer,
            laid.hint,
          ]
          expect(parts.every((lines) => lines >= 0)).toBe(true)
          expect(parts.reduce((sum, lines) => sum + lines, 0)).toBe(height)
          for (const key of Object.keys(chrome) as ReadonlyArray<keyof ViewChrome>) {
            expect(laid[key]).toBeLessThanOrEqual(chrome[key])
          }
          expect(laid.panel).toBeLessThanOrEqual(panel)
          const chromeLines = Object.values(chrome).reduce((sum, lines) => sum + lines, 0)
          if (height >= chromeLines + 2 + transcriptRows + panel) {
            expect({ ...laid, transcript: 0 }).toEqual({
              ...chrome,
              rules: [1, 1],
              panel,
              transcript: 0,
            })
            expect(laid.transcript).toBe(height - chromeLines - 2 - panel)
          } else if (height >= chromeLines + 2) {
            expect(laid.transcript).toBeGreaterThanOrEqual(
              Math.min(transcriptRows, height - chromeLines - 2),
            )
          }
        },
      ),
    )
  })
})

const linesOf = (frame: Frame): ReadonlyArray<string> =>
  frame.chars.split("\n").map((line) => line.trimEnd())

describe("drawn", () => {
  test("the dashboard with more warnings than fit keeps Current's box and the hint whole", async () => {
    const view: RunView = {
      ...emptyView,
      totals: { ...emptyView.totals, slots: 2 },
      warnings: Array.from({ length: 12 }, (_, i) => `warning ${i + 1}`),
    }
    const frame = await renderFrame(
      <Root
        value={{
          view: external(view),
          screen: external<Screen>(Screen.Dashboard()),
          commands: Effect.runSync(makeCommands),
          appearance: external<Appearance>("dark"),
          themeOf,
          now: () => now,
        }}
      />,
      { width: 80, height: 16 },
    )
    const lines = linesOf(frame)
    const current = lines.findIndex((line) => line.trim() === "Current")
    expect(lines[current + 1]).toStartWith("╭")
    expect(lines[current + 2]).toContain("picking the next ticket…")
    expect(lines[current + 3]).toStartWith("╰")
    expect(lines.filter((line) => line.includes("warning"))).toEqual(
      lines.slice(current + 5, 15).filter((line) => line !== ""),
    )
    expect(lines[15]).toContain("? keys")
  })

  test("a worker view too short for its one request keeps the composer and the hint", async () => {
    const said: Item = {
      v: transcriptVersion,
      seq: 1,
      session: "0a4f5c3e-1111-4c8e-9a51-6f0d1f0b2a01",
      time: "2026-10-20T13:00:00.000Z",
      message: {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "One command to run." }] },
        parent_tool_use_id: null,
      } as unknown as SDKMessage,
    }
    const feed: TranscriptFeed = {
      open: (): OpenTranscript => {
        const state = external<TranscriptState>({ ...emptyTranscript, window: windowOf([said]) })
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
      workers: new Map([["t-1", WS.Idle({ at: began })]]),
      requests: [bash("r1", "t-1" as TicketId, 20)],
      status: { ...emptyStatus, version: "0.1.0", branch: "batch", began, concurrency: 1 },
      actions: new Map(),
    })
    // 40×16: the 20-line command's request is more than the panel's 4 lines, and is cut there.
    const frame = await renderFrame(
      <Root
        value={{
          view: external(view),
          screen: external<Screen>(Screen.Worker({ ticket: "t-1" as TicketId })),
          commands: Effect.runSync(makeCommands),
          appearance: external<Appearance>("dark"),
          themeOf,
          now: () => now,
          transcripts: feed,
        }}
      />,
      { width: 40, height: 16 },
      { treeSitter: "mock" },
    )
    const lines = linesOf(frame)
    expect(lines[0]).toContain("← Dashboard")
    const rule = lines.findLastIndex((line) => line.startsWith("────"))
    expect(lines.slice(rule - 4, rule).map((line) => line.slice(0, 10))).toEqual([
      "┏━━━━━━━━━",
      "┃ Bash: Ru",
      "┃ [ Deny ]",
      "┃ echo r1 ",
    ])
    expect(lines[rule + 1]).toContain("i to write to the worker")
    expect(lines.slice(rule + 2).join(" ")).toContain("Esc dashboard")
  })
})
