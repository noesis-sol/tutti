// The dashboard's Current section with more cards than slots (§ 7.2): tickets waiting to merge or
// merging have cards without a worker's slot, so Current is kept a line for each card, the table
// gives way before the cards overflow, and a box too short for a line each ends in `+N more`, never
// drawing over the wind-down line or the hint.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fc from "fast-check"
import { makeCommands } from "../src/run/commands.ts"
import { type Entry, emptyTallies, type WindDown } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import { Root } from "../src/ui/App.tsx"
import { compactLines, compactShown, keptLines } from "../src/ui/Card.tsx"
import { dashboardLayout } from "../src/ui/Dashboard.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type ShellValue } from "../src/ui/useRunView.ts"
import { type Frame, renderFrame, type Size } from "./render.ts"

const themeOf = (appearance: Appearance) =>
  makeTheme(orchestra, { appearance, depth: "truecolor", noColor: false })
const theme = themeOf("dark")

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()
const now = began + 67_000

const entryOf = (
  ticket: string,
  phase: TicketPhase,
  worker: number | null,
  row: number,
): Entry => ({
  ticket,
  title: `Title of ${ticket}`,
  phase,
  since: began,
  worker,
  row,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

/**
 * RunView of `working` tickets at work and `merging` waiting to merge or merging, the run having
 * room for `concurrency` workers, winding down or not.
 */
const viewOf = (
  working: number,
  merging: number,
  concurrency: number,
  windDown: WindDown | null = null,
): RunView => {
  const entries = [
    ...Array.from({ length: working }, (_, i) =>
      entryOf(`tut-w${i + 1}`, TicketPhase.Working({ activity: "working" }), i + 1, i),
    ),
    ...Array.from({ length: merging }, (_, i) =>
      entryOf(
        `tut-m${i + 1}`,
        i === 0 ? TicketPhase.Merging({ step: "check" }) : TicketPhase.ToMerge({ place: i }),
        working + i + 1,
        working + i,
      ),
    ),
  ]
  return project({
    ledger: {
      tickets: new Map(entries.map((each) => [each.ticket, each])),
      rows: entries.length,
      windDown,
      bugs: [],
    },
    workers: new Map(),
    requests: [],
    status: {
      ...emptyStatus,
      version: "0.1.0",
      branch: "batch/2026-10-20",
      began,
      concurrency,
    },
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

const linesOf = (frame: Frame): ReadonlyArray<string> =>
  frame.chars
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((_, i, all) => i < all.length - 1 || all[i] !== "")

const draw = async (view: RunView, size: Size) =>
  linesOf(await renderFrame(<Root value={value(view)} />, size))

/** The lines from `Current` to the line before the foot's first. */
const currentOf = (lines: ReadonlyArray<string>, foot: number): ReadonlyArray<string> =>
  lines.slice(
    lines.findIndex((line) => line.trim() === "Current"),
    lines.length - foot,
  )

const windDown: WindDown = { since: began, tickets: ["tut-w1"] }

describe("Current with more cards than slots", () => {
  for (const { name, size, view } of [
    {
      name: "80×24, 4 slots, 4 working and 4 merging, winding down",
      size: { width: 80, height: 24 },
      view: viewOf(4, 4, 4, windDown),
    },
    {
      name: "60×16, 3 slots and 6 cards, winding down",
      size: { width: 60, height: 16 },
      view: viewOf(3, 3, 3, windDown),
    },
    {
      name: "80×50, 16 slots and a full merge train, winding down",
      size: { width: 80, height: 50 },
      view: viewOf(16, 16, 16, windDown),
    },
  ]) {
    test(`${name}: the box closes above the foot, which is drawn whole`, async () => {
      const lines = await draw(view, size)
      expect(lines).toHaveLength(size.height)
      const hint = lines[size.height - 1] ?? ""
      expect(hint).toContain("Tab select")
      expect(hint).toContain("? keys")
      expect(lines[size.height - 2]).toContain("Winding down · 1 running, no new tickets")
      const current = currentOf(lines, 2)
      // The box's bottom border is the last line Current draws, above the wind-down line.
      const bottom = current.findLastIndex((line) => line.startsWith("╰"))
      expect(bottom).toBeGreaterThan(0)
      expect(current.slice(bottom + 1).every((line) => line === "")).toBe(true)
      // Every card has its line, or is counted in `+N more`.
      const drawn = current.filter((line) => line.includes("tut-")).length
      const more = Number(current.join("\n").match(/\+(\d+) more/)?.[1] ?? 0)
      expect(drawn + more).toBe(view.cards.length)
    })
  }

  test("4 slots and 8 cards at 80×24 give up the tickets table, not a card's line", async () => {
    const lines = await draw(viewOf(4, 4, 4, windDown), { width: 80, height: 24 })
    expect(lines.some((line) => line.trim() === "Tickets")).toBe(false)
    const current = currentOf(lines, 2)
    expect(current.filter((line) => line.includes("tut-"))).toHaveLength(8)
    expect(current.join("\n")).not.toContain("more")
  })
})

describe("Current's budget", () => {
  test("is kept a line for each card where the cards outnumber the slots", () => {
    // 16 slots at 80 columns keep 6 full cards, 31 lines; 32 cards want a line each and the frame.
    expect(keptLines(80, 16, 0)).toBe(31)
    expect(keptLines(80, 16, 32)).toBe(35)
    // Cards within the slots move nothing: the table stays put as workers come and go.
    expect(keptLines(80, 4, 8)).toBe(keptLines(80, 4, 0))
    const table = (view: RunView) => dashboardLayout(view, theme, 80, 50).table
    expect(table(viewOf(16, 16, 16))).toBeLessThan(table(viewOf(0, 0, 16)))
  })
})

describe("the compact box in fewer lines than its cards", () => {
  const view = viewOf(4, 4, 4)
  const options = { now, spin: "⣯", width: 60, highlighted: null }

  test("keeps the highlighted card, and counts the rest in +N more", () => {
    const shown = compactShown(view.cards, "tut-m4", 6)
    expect(shown.map((card) => card.ticket)).toEqual(["tut-w1", "tut-w2", "tut-m4"])
    const text = compactLines(view.cards, theme, { ...options, highlighted: "tut-m4", lines: 6 })
      .map((line) => line.map((s) => s.text).join(""))
      .join("\n")
    expect(text).toContain("+5 more")
    expect(text).toContain("tut-m4")
  })

  test("never takes more lines than it is given, from 3, and draws a line for each card that fits", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 8 }), fc.integer({ min: 3, max: 14 }), (n, lines) => {
        const cards = view.cards.slice(0, n)
        const drawn = compactLines(cards, theme, { ...options, lines })
        expect(drawn.length).toBeLessThanOrEqual(Math.max(lines, cards.length === 0 ? 2 : 3))
        if (n + 2 <= lines) expect(drawn).toHaveLength(n + 2)
      }),
    )
  })
})
