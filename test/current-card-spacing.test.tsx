// Current's cards are spaced alike across and down (§ 7.2, tutti-5sf0): side by side their frames
// meet with no blank column between them, and one row's frames meet the next's with no blank line
// between them, a card shorter than its row (a full card beside an attention card, or an attention
// card beside a taller one) stretched to the row's height, its frame drawn round blank lines, rather
// than leaving blank lines under it.

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import { type WorkerState, WorkerState as WS } from "../src/agent/WorkerState.ts"
import { tuttiScheme } from "../src/project/scheme.ts"
import { makeCommands } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { attentionLines } from "../src/ui/AttentionCard.tsx"
import { contentOf, layoutOf, twoUpWidth } from "../src/ui/Card.tsx"
import type { Segments } from "../src/ui/line.tsx"
import { type Appearance, makeTheme } from "../src/ui/theme.ts"
import { external, type ShellValue, spinnerFrames } from "../src/ui/useRunView.ts"
import { type Frame, renderFrame } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(tuttiScheme, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")
const began = new Date(2026, 9, 27, 13, 0, 0).getTime()
const now = began + 25_000

const entryOf = (ticket: TicketId, row: number): Entry => ({
  ticket,
  title: `Title of ${ticket}`,
  phase: TicketPhase.Working(),
  since: began,
  worker: row + 1,
  row,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

const permission = (ticket: string): AttentionRequest => ({
  id: `p-${ticket}`,
  ticket: ticket as TicketId,
  kind: {
    _tag: "Permission",
    tool: "Bash",
    input: { command: "rm -rf build" },
    suggestions: [],
    summary: "rm -rf build",
  },
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: 0,
})

/** A question with three options: an attention card taller than a permission request's. */
const question = (ticket: string): AttentionRequest => ({
  id: `q-${ticket}`,
  ticket: ticket as TicketId,
  kind: {
    _tag: "Question",
    questions: [
      {
        question: "Which way?",
        options: [{ label: "Left" }, { label: "Right" }, { label: "Neither" }],
        multiSelect: false,
      },
    ],
    input: {},
  },
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  createdAt: 0,
})

/** RunView of `count` working tickets, t-1 onwards, with `requests` open. */
const viewOf = (count: number, requests: ReadonlyArray<AttentionRequest> = []): RunView => {
  const tickets = Array.from({ length: count }, (_, i) => `t-${i + 1}` as TicketId)
  return project({
    ledger: {
      tickets: new Map(tickets.map((t, i) => [t, entryOf(t, i)])),
      rows: tickets.length,
      windDown: null,
      bugs: [],
    },
    workers: new Map<string, WorkerState>(
      tickets.map((t) => [t, WS.Working({ doing: "working" })]),
    ),
    requests,
    status: { ...emptyStatus, version: "0.1.0", branch: "batch/2026-11-03", began, concurrency: 4 },
    actions: new Map(),
  })
}

const value = (view: RunView): ShellValue => ({
  view: external(view),
  screen: external<Screen>(Screen.Dashboard()),
  commands: Effect.runSync(makeCommands),
  appearance: external<Appearance>("dark"),
  themeOf,
  now: () => now,
})

/** The frame's lines after the `Current` label, to the line before the hint. */
const currentOf = (frame: Frame): ReadonlyArray<string> => {
  const lines = frame.chars.split("\n")
  const from = lines.findIndex((line) => line.trim() === "Current")
  const to = lines.findIndex(
    (line, i) => i > from && /^\s+(Tab select|arrows panels|s stop)/.test(line),
  )
  return lines.slice(from + 1, to)
}

const tops = ["╭╮", "┏┓"]
const bottoms = ["╰╯", "┗┛"]
const sides = ["││", "┃┃"]

/**
 * Checks Current's cards in `lines`, `width` wide, laid out in `rows` of lines, `across` a row: each
 * card's frame spans its row's lines whole, its corners on the row's first and last line and its
 * sides on every line between, and the next card or row begins on the column or line after it.
 */
const expectMeeting = (
  lines: ReadonlyArray<string>,
  width: number,
  cards: number,
  across: number,
  rows: ReadonlyArray<number>,
) => {
  const first = Math.floor(width / across)
  let y = 0
  rows.forEach((tall, r) => {
    const inRow = Math.min(across, cards - r * across)
    for (let i = 0; i < inRow; i++) {
      // The card's columns: the next card's left side is the column after its right side.
      const [left, right] = i === 0 ? [0, first - 1] : [first, width - 1]
      const at = (line: number) => `${lines[y + line]?.[left]}${lines[y + line]?.[right]}`
      expect(tops).toContain(at(0))
      for (let line = 1; line < tall - 1; line++) expect(sides).toContain(at(line))
      expect(bottoms).toContain(at(tall - 1))
    }
    // The next row's tops are on the line after this row's bottoms.
    y += tall
  })
  // Nothing of Current below its last row.
  expect(lines.slice(y).every((line) => line.trim() === "")).toBe(true)
}

describe("Current's cards meet frame to frame across and down", () => {
  const cases: ReadonlyArray<readonly [string, number, ReadonlyArray<AttentionRequest>]> = [
    ["2 cards", 2, []],
    ["3 cards", 3, []],
    ["4 cards", 4, []],
    ["2 cards, the first waiting for you", 2, [permission("t-1")]],
    ["3 cards, the first waiting for you", 3, [permission("t-1")]],
    ["4 cards, the second waiting for you", 4, [permission("t-2")]],
    ["4 cards, the third waiting for you", 4, [permission("t-3")]],
    ["2 cards, both waiting for you, one taller", 2, [question("t-1"), permission("t-2")]],
  ]
  for (const width of [100, twoUpWidth, 121, 160]) {
    for (const [name, count, requests] of cases) {
      test(`${name}, ${width} columns`, async () => {
        const view = viewOf(count, requests)
        const layout = layoutOf(view.cards, width, 60)
        if (layout._tag !== "Cards") throw new Error(`laid out ${layout._tag}`)
        const frame = await renderFrame(<Root value={value(view)} />, { width, height: 60 })
        expectMeeting(currentOf(frame), width, count, layout.across, layout.rows)
      })
    }
  }

  test("a full card beside an attention card is drawn as tall, blank lines inside its frame", async () => {
    const view = viewOf(3, [permission("t-1")])
    const frame = await renderFrame(<Root value={value(view)} />, { width: 120, height: 40 })
    // The right-hand card of the first row, its spinner's frame as `*`.
    const right = currentOf(frame)
      .slice(0, 6)
      .map((line) =>
        line
          .slice(60)
          .trimEnd()
          .replace(/[\u2800-\u28ff]/, "*"),
      )
    expect(`\n${right.join("\n")}\n`).toMatchInlineSnapshot(`
      "
      ╭──────────────────────────────────────────────────────────╮
      │ *  t-2  working  25s                                     │
      │    Title of t-2                                          │
      │                                                          │
      │                                                          │
      ╰──────────────────────────────────────────────────────────╯
      "
    `)
  })
})

describe("an attention card", () => {
  const card = viewOf(1, [permission("t-1")]).cards[0]
  if (card === undefined) throw new Error("no card")
  const head = contentOf(card, theme, now, spinnerFrames[0]).slice(0, 2)
  const text = (lines: ReadonlyArray<Segments>) =>
    lines.map((line) => line.map((s) => s.text).join(""))

  test("is padded out below with blank lines to `inside` lines inside its frame", () => {
    const own = attentionLines(card, theme, head, { width: 40, highlighted: false, focus: 0 })
    const tall = attentionLines(card, theme, head, {
      width: 40,
      highlighted: false,
      focus: 0,
      inside: own.length,
    })
    expect(tall).toHaveLength(own.length + 2)
    expect(text(tall.slice(0, -3))).toEqual(text(own.slice(0, -1)))
    expect(text(tall.slice(-3, -1))).toEqual([`│${" ".repeat(38)}│`, `│${" ".repeat(38)}│`])
  })

  test("keeps its own lines when `inside` is fewer", () => {
    const own = attentionLines(card, theme, head, { width: 40, highlighted: false, focus: 0 })
    const fewer = attentionLines(card, theme, head, {
      width: 40,
      highlighted: false,
      focus: 0,
      inside: 1,
    })
    expect(text(fewer)).toEqual(text(own))
  })
})
