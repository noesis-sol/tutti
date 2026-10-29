// The panel beside the tickets table lines up with the totals strip (§ 7.2, tutti-ebra): from 130
// columns its left border is in the column of the strip's bar before In queue, both read from
// Totals.tsx's queueDivider, and that bar stays put as Set aside's triage note comes in, the note cut
// to ` · ◆ n`, then left out, rather than widen its cell past its fifth.
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

/** What is in `column` on the lines beside the tickets table but its label's. */
const besideAt = (view: RunView, width: number, column: number): ReadonlyArray<string> =>
  dashboardLayout(view, theme, width, 36)
    .tickets.slice(1)
    .map((line) => textOf(line)[column] ?? "")

describe("the panel's left border and the strip's bar before In queue", () => {
  for (const width of [130, 155, 250]) {
    for (const [what, totals] of [
      ["without a triage note", {}],
      ["with a triage note", triaged],
    ] as const) {
      test(`are in one column at ${width} columns, ${what}`, () => {
        const view = viewOf(totals)
        const { column } = dividerOf(view, width)
        expect(column).toBe(queueDivider(width))
        expect(width - panelWidth(width)).toBe(column)
        const borders = besideAt(view, width, column)
        expect(borders.length).toBeGreaterThan(2)
        expect(borders).toEqual(["╭", ...borders.slice(1, -1).map(() => "│"), "╰"])
      })
    }
  }

  test("the panel is as wide as In queue's cell, to the pane's right edge, and keeps 44", () => {
    expect([130, 155, 180, 250].map(panelWidth)).toEqual([52, 62, 72, 100])
    expect(panelWidth(129)).toBe(0)
    for (let width = 130; width <= 400; width += 1) {
      expect(panelWidth(width)).toBeGreaterThanOrEqual(44)
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
