// Current's boxes keep a stable height (§ 7.2, tutti-pgl6): a full card is 3 lines inside its
// frame whether or not it has an action line yet, two cards side by side are as tall as each other,
// and the box with no worker is as tall as a card; an attention card still grows to show its
// request, and the compact layout is a line a card as before.

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { AttentionRequest } from "../src/agent/Attention.ts"
import { type WorkerState, WorkerState as WS } from "../src/agent/WorkerState.ts"
import { makeCommands } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { type Card, emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import {
  cardLines,
  compactLines,
  idleBox,
  idleText,
  layoutOf,
  sectionLines,
} from "../src/ui/Card.tsx"
import type { Segments } from "../src/ui/line.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type ShellValue, spinnerFrames } from "../src/ui/useRunView.ts"
import { type Frame, renderFrame } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")
const began = new Date(2026, 9, 27, 13, 0, 0).getTime()
const now = began + 25_000
const spin = spinnerFrames[0]

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

/** RunView of working `tickets`, with their workers' states, latest actions and open requests. */
const viewOf = (
  tickets: ReadonlyArray<string>,
  over: {
    readonly actions?: ReadonlyMap<string, { readonly text: string; readonly denied: boolean }>
    readonly requests?: ReadonlyArray<AttentionRequest>
  } = {},
): RunView =>
  project({
    ledger: {
      tickets: new Map(tickets.map((t, i) => [t as TicketId, entryOf(t as TicketId, i)])),
      rows: tickets.length,
      windDown: null,
      bugs: [],
    },
    workers: new Map<string, WorkerState>(
      tickets.map((t) => [t, WS.Working({ doing: "working" })]),
    ),
    requests: over.requests ?? [],
    status: { ...emptyStatus, version: "0.1.0", branch: "batch/2026-10-27", began, concurrency: 2 },
    actions: over.actions ?? new Map(),
  })

const action = (ticket: string) =>
  new Map([[ticket, { text: "Bash(sed -n 1,40p src/ui/Card.tsx)", denied: false }]])

const permission = (ticket: string): AttentionRequest => ({
  id: "r1",
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

const cardIn = (view: RunView, ticket: string): Card => {
  const card = view.cards.find((c) => c.ticket === ticket)
  if (card === undefined) throw new Error(`no card for ${ticket}`)
  return card
}

/** A card's lines as Current lays it out among `view`'s cards, `width` wide. */
const laidOut = (view: RunView, ticket: string, width = 50): ReadonlyArray<Segments> => {
  const layout = layoutOf(view.cards, width, 40)
  if (layout._tag !== "Cards") throw new Error(`laid out ${layout._tag}`)
  const card = cardIn(view, ticket)
  return cardLines(card, theme, { now, spin, width, inside: layout.inside, highlighted: false })
}

const textOf = (lines: ReadonlyArray<Segments>): string =>
  `\n${lines.map((line) => line.map((s) => s.text).join("")).join("\n")}\n`

const value = (view: RunView): ShellValue => ({
  view: external(view),
  screen: external<Screen>(Screen.Dashboard()),
  commands: Effect.runSync(makeCommands),
  appearance: external<Appearance>("dark"),
  themeOf,
  now: () => now,
})

/** The frame's lines from `Current` to the line before the hint. */
const currentOf = (frame: Frame): ReadonlyArray<string> => {
  const lines = frame.chars.split("\n").map((line) => line.trimEnd())
  const from = lines.findIndex((line) => line.trim() === "Current")
  const to = lines.findIndex((line, i) => i > from && /^\s+(Tab select|s stop)/.test(line))
  return lines.slice(from, to).filter((line) => line !== "")
}

describe("a full card", () => {
  test("is 5 lines while its worker starts, with no action, and stays 5 as its first comes", () => {
    const starting = laidOut(viewOf(["t-1"]), "t-1")
    expect(textOf(starting)).toMatchInlineSnapshot(`
      "
      ╭────────────────────────────────────────────────╮
      │ ⣾ t-1  working  25s                            │
      │   Title of t-1                                 │
      │                                                │
      ╰────────────────────────────────────────────────╯
      "
    `)
    const acting = laidOut(viewOf(["t-1"], { actions: action("t-1") }), "t-1")
    expect(textOf(acting)).toMatchInlineSnapshot(`
      "
      ╭────────────────────────────────────────────────╮
      │ ⣾ t-1  working  25s                            │
      │   Title of t-1                                 │
      │   ▸ Bash(sed -n 1,40p src/ui/Card.tsx)         │
      ╰────────────────────────────────────────────────╯
      "
    `)
    expect([starting.length, acting.length]).toEqual([5, 5])
  })

  test("is laid out 3 lines inside its frame whatever the cards' action lines", () => {
    for (const actions of [new Map(), action("t-1")]) {
      const layout = layoutOf(viewOf(["t-1"], { actions }).cards, 80, 40)
      expect(layout).toEqual({ _tag: "Cards", across: 1, inside: 3, rows: [5] })
    }
  })

  test("two side by side, one with an action and one without, are 5 lines each", async () => {
    const view = viewOf(["t-1", "t-2"], { actions: action("t-1") })
    expect(layoutOf(view.cards, 120, 40)).toEqual({
      _tag: "Cards",
      across: 2,
      inside: 3,
      rows: [5],
    })
    const frame = await renderFrame(<Root value={value(view)} />, { width: 120, height: 40 })
    const current = currentOf(frame)
    // Its label, then one row of two cards, both framed over the same 5 lines.
    expect(current).toHaveLength(6)
    expect(current[1]).toMatch(/^╭─+╮╭─+╮$/)
    expect(current[3]).toMatch(/Title of t-1 .*│ +Title of t-2/)
    expect(current[4]).toMatch(/▸ Bash\(sed -n 1,40p src\/ui\/Card\.tsx\) +││ +│$/)
    expect(current[5]).toMatch(/^╰─+╯╰─+╯$/)
  })
})

describe("the box with no worker", () => {
  test("is as tall as a full card, its text on its first line", async () => {
    const box = idleBox(idleText(false, null, now), theme, spin, 40)
    expect(textOf(box)).toMatchInlineSnapshot(`
      "
      ╭──────────────────────────────────────╮
      │ ⣾ picking the next ticket…           │
      │                                      │
      │                                      │
      ╰──────────────────────────────────────╯
      "
    `)
    expect(sectionLines({ _tag: "Idle" }, 0)).toBe(6)
    const frame = await renderFrame(<Root value={value(viewOf([]))} />, { width: 80, height: 30 })
    const current = currentOf(frame)
    expect(current).toHaveLength(6)
    expect(current[2]).toContain("picking the next ticket…")
  })

  test("says stopping… and the full check's step on its first line, as tall", () => {
    const fullCheck = { step: "check" as const, command: "scripts/check-full.sh", began }
    for (const text of [idleText(true, null, now), idleText(false, fullCheck, now)]) {
      const box = idleBox(text, theme, spin, 60)
      expect(box).toHaveLength(5)
      expect(textOf(box.slice(1, 2))).toContain(text)
    }
  })

  test("gives up its blank lines, not its text, in a room with fewer lines", () => {
    expect(
      [5, 4, 3, 2].map((lines) => idleBox("stopping…", theme, spin, 40, lines).length),
    ).toEqual([5, 4, 3, 3])
  })
})

describe("the exceptions", () => {
  test("an attention card grows to show its request; the cards beside it stay 5", () => {
    const view = viewOf(["t-1", "t-2", "t-3"], { requests: [permission("t-1")] })
    const layout = layoutOf(view.cards, 120, 40)
    if (layout._tag !== "Cards") throw new Error("not cards")
    expect(layout.rows[0]).toBeGreaterThan(5)
    expect(layout.rows[1]).toBe(5)
  })

  test("the compact layout is a line a card in one box, as before", () => {
    const view = viewOf(["t-1", "t-2"], { actions: action("t-1") })
    expect(layoutOf(view.cards, 80, 8)._tag).toBe("Compact")
    const lines = compactLines(view.cards, theme, { now, spin, width: 60, highlighted: null })
    expect(textOf(lines)).toMatchInlineSnapshot(`
      "
      ╭──────────────────────────────────────────────────────────╮
      │ ⣾ t-1  working  25s  Title of t-1                        │
      │ ⣾ t-2  working  25s  Title of t-2                        │
      ╰──────────────────────────────────────────────────────────╯
      "
    `)
  })
})
