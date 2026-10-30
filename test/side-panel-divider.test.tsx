// The panel beside the tickets table lines up with the totals strip (§ 7.2, tutti-ebra, tutti-nsw2):
// from 130 columns the gap between the table and the panel is in the column of the strip's bar before
// In queue, the table's right border left of it and the panel's left border right of it, all read
// from Totals.tsx's queueDivider, and that bar stays put as Set aside's triage note comes in, the
// note cut to ` · ◆ n`, then left out, rather than widen its cell past its fifth.
import { describe, expect, test } from "bun:test"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { Finished, TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView, type Totals } from "../src/run/runView.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { dashboardLayout } from "../src/ui/Dashboard.tsx"
import type { Segments } from "../src/ui/line.tsx"
import { panelWidth } from "../src/ui/SidePanel.tsx"
import { queueDivider, totalsStrip } from "../src/ui/Totals.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

const textOf = (line: Segments) => line.map((each) => each.text).join("")

const began = new Date(2026, 9, 29, 13, 0, 0).getTime()

const entryOf = (ticket: string, phase: TicketPhase, row: number | null): Entry => ({
  ticket: ticket as TicketId,
  title: `Title of ${ticket}`,
  phase,
  since: began,
  worker: null,
  row,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

/** Two merged and two queued, the totals' Set aside and triage notes as `totals` says. */
const viewOf = (totals: Partial<Totals> = {}): RunView => {
  const entries = [
    entryOf("tutti-a1", TicketPhase.Done({ outcome: Finished.Merged({ commit: "d06bd5a1" }) }), 0),
    entryOf("tutti-a2", TicketPhase.Done({ outcome: Finished.Merged({ commit: "e5b090a1" }) }), 1),
    entryOf("tutti-b1", TicketPhase.Queued(), null),
    entryOf("tutti-b2", TicketPhase.Queued(), null),
  ]
  const view = project({
    ledger: {
      tickets: new Map(entries.map((each) => [each.ticket, each])),
      rows: 2,
      windDown: null,
      bugs: [],
    },
    workers: new Map(),
    requests: [],
    status: { ...emptyStatus, version: "0.5.0", branch: "main", began, concurrency: 4 },
    actions: new Map(),
  })
  return { ...view, totals: { ...view.totals, ...totals } }
}

/** One Set aside, triaged. */
const triaged: Partial<Totals> = { deferred: 1, triaged: 1 }

/** The column of the strip's bar before In queue, and the line it is on. */
const dividerOf = (view: RunView, width: number) => {
  const strip = dashboardLayout(view, theme, width, 36).totals.map(textOf)
  const line = strip[1] ?? ""
  return { line, column: line.lastIndexOf("│", line.indexOf("In queue")) }
}

/** The lines beside the panel, the tickets table's label's first. */
const besideLines = (view: RunView, width: number): ReadonlyArray<string> =>
  dashboardLayout(view, theme, width, 36).tickets.map(textOf)

/** What is in `column` on each of `lines` but the first, the labels' line. */
const columnOf = (lines: ReadonlyArray<string>, column: number): ReadonlyArray<string> =>
  lines.slice(1).map((line) => line[column] ?? "")

/** A rounded frame's side down `column`: its corners and its bars. */
const sideOf = (column: ReadonlyArray<string>, top: string, bottom: string) => [
  top,
  ...column.slice(1, -1).map(() => "│"),
  bottom,
]

describe("the gap between the tickets table and the panel", () => {
  for (const width of [130, 155, 250]) {
    for (const [what, totals] of [
      ["without a triage note", {}],
      ["with a triage note", triaged],
    ] as const) {
      test(`is under the strip's bar before In queue at ${width} columns, ${what}`, () => {
        const view = viewOf(totals)
        const { column } = dividerOf(view, width)
        expect(column).toBe(queueDivider(width))
        const lines = besideLines(view, width)
        expect(lines.length).toBeGreaterThan(3)
        // Blank on every line beside the table, the labels' line included.
        expect(lines.map((line) => line[column])).toEqual(lines.map(() => " "))
        // The table's right border is left of it, the panel's left border right of it.
        const table = columnOf(lines, column - 1)
        expect(table).toEqual(sideOf(table, "╮", "╯"))
        const panel = columnOf(lines, column + 1)
        expect(panel).toEqual(sideOf(panel, "╭", "╰"))
        // The panel reaches the pane's right edge.
        expect(width - panelWidth(width)).toBe(column + 1)
        const right = columnOf(lines, width - 1)
        expect(right).toEqual(sideOf(right, "╮", "╯"))
        for (const line of lines) expect(Bun.stringWidth(line)).toBe(width)
        // The panel's label is one column right of In queue's count, as Tickets' is over its box.
        expect(lines[0]?.indexOf("Up next")).toBe(
          dividerOf(view, width).line.indexOf("2 In queue") + 1,
        )
      })
    }
  }

  test("leaves the panel In queue's cell to the pane's right edge, less the gap, and keeps 44", () => {
    expect([130, 155, 180, 250].map(panelWidth)).toEqual([51, 61, 71, 99])
    expect(panelWidth(129)).toBe(0)
    for (let width = 130; width <= 400; width += 1) {
      expect(panelWidth(width)).toBeGreaterThanOrEqual(44)
      expect(width - panelWidth(width)).toBe(queueDivider(width) + 1)
    }
  })
})

describe("the strip beside the panel", () => {
  test("cuts Set aside's triage note to ` · ◆ n` at 130 columns, where it would widen its cell", () => {
    const { line } = dividerOf(viewOf(triaged), 130)
    expect(line).toContain("↷ 1 Set aside · ◆ 1 ")
    expect(line).not.toContain("triaged")
    // Without the panel, Set aside goes past its fifth to say it whole (tutti-iolm).
    expect(textOf(totalsStrip(viewOf(triaged).totals, theme, 130)?.[1] ?? [])).toContain("triaged")
  })

  test("says it whole at 155 columns, where it fits in the fifth", () => {
    expect(dividerOf(viewOf(triaged), 155).line).toContain("↷ 1 Set aside · ◆ 1 triaged")
  })

  test("leaves the note out where even ` · ◆ n` would widen Set aside's cell", () => {
    const many: Partial<Totals> = { deferred: 123456, triaged: 123456 }
    const strip = totalsStrip(viewOf(many).totals, theme, 130, undefined, true)?.map(textOf) ?? []
    expect(strip[1]).toContain("↷ 123456 Set aside ")
    expect(strip[1]).not.toContain("◆")
    expect(strip[1]?.lastIndexOf("│", strip[1].indexOf("In queue"))).toBe(queueDivider(130))
  })

  test("keeps the bar put however many are set aside and triaged", () => {
    for (const width of [130, 155, 250]) {
      for (const n of [0, 1, 9, 99, 999, 99999, 9999999]) {
        const t = viewOf({ deferred: n, triaged: n, needsYou: n, completed: n }).totals
        const line = textOf(totalsStrip(t, theme, width, undefined, true)?.[1] ?? [])
        expect(Bun.stringWidth(line)).toBe(width)
        expect(line.lastIndexOf("│", line.indexOf("In queue"))).toBe(queueDivider(width))
      }
    }
  })
})
