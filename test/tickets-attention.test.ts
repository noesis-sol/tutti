// The dashboard's tickets table by attention (§ 5.1 "How the phases are shown", § 7.2): Blocked and
// Asked oldest first, set aside and the rest newest first; `+N earlier tickets` takes the oldest of
// the rest at the bottom and no row that wants you; the summary keeps the order tickets came to an
// end.

import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { Finished, TicketPhase, WaitFor } from "../src/run/phase.ts"
import { emptyStatus, project, type Row, type RunView } from "../src/run/runView.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { dashboardLayout } from "../src/ui/Dashboard.tsx"
import { paint, widthOf } from "../src/ui/line.tsx"
import { byAttention, shownRows, ticketsLines } from "../src/ui/TicketsTable.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { workersDoing } from "./activity.ts"
import { rowsIn } from "./screen.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

const blocked = TicketPhase.Blocked({ why: "MERGE_CONFLICT" })
const asked = TicketPhase.Asked({ question: "q-1" })
const deferred = TicketPhase.Deferred({ why: "gave up" })
const review = TicketPhase.Review({ why: "CHECKS_FAILED" })
const stopped = TicketPhase.Stopped({ why: "PAUSED" })
const merged = TicketPhase.Done({ outcome: Finished.Merged({ commit: "c0ffee0abcdef" }) })
const noChange = TicketPhase.Done({ outcome: Finished.NoChange() })

const entry = (ticket: string, phase: TicketPhase, since: number, row: number): Entry => ({
  ticket: ticket as TicketId,
  title: `Title of ${ticket}`,
  phase,
  since,
  worker: null,
  row,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

/** RunView of `tickets`, each `[its ID, its phase, when its phase began]`, in the order they ended. */
const viewOf = (
  tickets: ReadonlyArray<readonly [string, TicketPhase, number]>,
  doing: ReadonlyArray<readonly [string, "allow"]> = [],
): RunView => {
  const { workers, requests } = workersDoing(doing)
  return project({
    ledger: {
      tickets: new Map(
        tickets.map(([ticket, phase, since], row) => [
          ticket as TicketId,
          entry(ticket, phase, since, row),
        ]),
      ),
      rows: tickets.length,
      windDown: null,
      bugs: [],
    },
    workers: new Map(workers),
    requests,
    status: { ...emptyStatus, version: "0.1.0", branch: "main", began: 0, concurrency: 3 },
    actions: new Map(),
  })
}

const ids = (rows: ReadonlyArray<Row>) => rows.map((row) => row.ticket as string)

/** The table's lines, as text, at `lines` lines and 80 columns. */
const drawn = (rows: ReadonlyArray<Row>, lines: number) =>
  ticketsLines(rows, theme, 80, { lines }).map((line) => line.map((each) => each.text).join(""))

describe("the order", () => {
  test("Blocked, Asked, set aside, then the rest", () => {
    const view = viewOf([
      ["done", merged, 1],
      ["aside", deferred, 2],
      ["question", asked, 3],
      ["conflict", blocked, 4],
    ])
    expect(ids(byAttention(view.rows))).toEqual(["conflict", "question", "aside", "done"])
  })

  test("Blocked and Asked are oldest first, the one waiting longest on top", () => {
    const view = viewOf([
      ["b-new", blocked, 30],
      ["a-new", asked, 40],
      ["b-old", blocked, 10],
      ["a-old", asked, 20],
    ])
    expect(ids(byAttention(view.rows))).toEqual(["b-old", "b-new", "a-old", "a-new"])
  })

  test("set aside and the rest are newest first", () => {
    const view = viewOf([
      ["s-old", deferred, 10],
      ["r-old", merged, 20],
      ["s-new", review, 30],
      ["r-new", noChange, 40],
    ])
    expect(ids(byAttention(view.rows))).toEqual(["s-new", "s-old", "r-new", "r-old"])
  })

  test("at the same moment, the order they ended settles it, each group its own way", () => {
    const view = viewOf([
      ["b-1", blocked, 5],
      ["b-2", blocked, 5],
      ["r-1", merged, 5],
      ["r-2", merged, 5],
    ])
    expect(ids(byAttention(view.rows))).toEqual(["b-1", "b-2", "r-2", "r-1"])
  })

  test("a stopped ticket is left undone as one set aside is", () => {
    const view = viewOf([
      ["done", merged, 3],
      ["cut", stopped, 2],
      ["aside", deferred, 1],
    ])
    expect(ids(byAttention(view.rows))).toEqual(["cut", "aside", "done"])
  })

  test("a worker's request wants you as an Asked ticket does", () => {
    const view = viewOf(
      [
        ["done", merged, 3],
        ["asks", TicketPhase.Working(), 2],
        ["aside", deferred, 1],
      ],
      [["asks", "allow"]],
    )
    expect(ids(byAttention(view.rows))).toEqual(["asks", "aside", "done"])
  })

  test("a row moves group as its phase changes", () => {
    const rest: ReadonlyArray<readonly [string, TicketPhase, number]> = [
      ["old", merged, 1],
      ["new", merged, 3],
      ["other", deferred, 2],
    ]
    const at = (phase: TicketPhase, since: number) =>
      ids(byAttention(viewOf([...rest, ["t", phase, since]]).rows))
    expect(at(TicketPhase.Waiting({ for: WaitFor.Blockers({ ids: [] }) }), 4)).toEqual([
      "other",
      "t",
      "new",
      "old",
    ])
    expect(at(blocked, 4)).toEqual(["t", "other", "new", "old"])
    expect(at(asked, 4)).toEqual(["t", "other", "new", "old"])
    expect(at(deferred, 4)).toEqual(["t", "other", "new", "old"])
    expect(at(merged, 4)).toEqual(["other", "t", "new", "old"])
  })

  test("the view's rows stay in the order tickets ended, and the sort keeps each row", () => {
    const view = viewOf([
      ["done", merged, 1],
      ["conflict", blocked, 2],
    ])
    expect(ids(view.rows)).toEqual(["done", "conflict"])
    const sorted = byAttention(view.rows)
    expect(sorted[0]).toBe(view.rows[1] as Row)
  })
})

describe("folding", () => {
  const done = (count: number) =>
    Array.from(
      { length: count },
      (_, i) => [`d-${i}`, merged, i + 100] as readonly [string, TicketPhase, number],
    )

  test("a Blocked row older than every done one stays, and the oldest done rows fold", () => {
    const view = viewOf([["fab-mgi", blocked, 1], ...done(55)])
    // 6 lines: the label, the frame, and 3 rows.
    const rows = shownRows(view.rows, { lines: 6 })
    expect(ids(rows)).toEqual(["fab-mgi", "d-54"])
    const lines = drawn(view.rows, 6)
    expect(lines[2]).toContain("fab-mgi")
    expect(lines[3]).toContain("d-54")
    expect(rowsIn(lines)[2]).toMatchObject({
      state: "",
      ticket: "+54",
      note: "earlier tickets, see the log",
    })
  })

  test("all the rows that fit show, and no folded row", () => {
    const view = viewOf(done(3))
    const lines = drawn(view.rows, 6)
    expect(lines.join("\n")).not.toContain("earlier")
    expect(ids(shownRows(view.rows, { lines: 6 }))).toEqual(["d-2", "d-1", "d-0"])
  })

  test("more wanting you than there is room says how many, of what, with the earlier ones", () => {
    const view = viewOf([
      ["b-1", blocked, 1],
      ["b-2", blocked, 2],
      ["b-3", blocked, 3],
      ["q-1", asked, 4],
      ["s-1", deferred, 5],
      ["s-2", review, 6],
      ...done(2),
    ])
    const lines = drawn(view.rows, 6)
    expect(lines[2]).toContain("b-1")
    expect(lines[3]).toContain("b-2")
    expect(rowsIn(lines)[2]).toMatchObject({
      state: "",
      ticket: "+4",
      note: "more: 1 blocked, 1 asked, 2 set aside, +2 earlier",
    })
  })

  test("rows that want you and just fill the table keep every line, the rest unsaid", () => {
    const view = viewOf([["b-1", blocked, 1], ["q-1", asked, 2], ["s-1", deferred, 3], ...done(4)])
    expect(ids(shownRows(view.rows, { lines: 6 }))).toEqual(["b-1", "q-1", "s-1"])
    const lines = drawn(view.rows, 6)
    expect(lines).toHaveLength(6)
    expect(lines[4]).toContain("s-1")
    expect(lines.join("\n")).not.toContain("earlier")
  })

  test("rows out of room are drawn as waiting on you, or as set aside where only those are", () => {
    const view = viewOf([
      ["b-1", blocked, 1],
      ["b-2", blocked, 2],
      ["s-1", deferred, 3],
    ])
    const lines = ticketsLines(view.rows, theme, 80, { lines: 5 })
    const text = lines.map((line) => line.map((each) => each.text).join(""))
    expect(rowsIn(text)[1]?.ticket).toBe("+2")
    expect(rowsIn(text)[1]?.note).toStartWith("more: 1 blocked, 1 set aside")
    expect(paint(lines[3] ?? [])).toContain(theme.styles.stop.paint("+2"))
    const set = viewOf([
      ["b-1", blocked, 1],
      ["s-1", deferred, 2],
      ["s-2", deferred, 3],
    ])
    const folded = ticketsLines(set.rows, theme, 80, { lines: 5 })[3] ?? []
    const looks = paint(folded)
    expect(looks).toContain(theme.styles.deferred.paint("+2"))
  })

  test("a narrow table still says how many, cut to its last column", () => {
    const view = viewOf([["b-1", blocked, 1], ["b-2", blocked, 2], ["b-3", blocked, 3], ...done(9)])
    const lines = ticketsLines(view.rows, theme, 40, { lines: 5 })
    for (const line of lines) expect(widthOf(line)).toBeLessThanOrEqual(40)
    expect(lines[3]?.map((each) => each.text).join("")).toContain("+2")
  })

  test("no row that wants you folds while there is room for it, whatever the rows", () => {
    const phases = [blocked, asked, deferred, review, merged, noChange]
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 5 }), fc.nat(1000)), { maxLength: 40 }),
        fc.integer({ min: 4, max: 13 }),
        (tickets, lines) => {
          const view = viewOf(
            tickets.map(([phase, since], i) => [`t-${i}`, phases[phase] ?? merged, since]),
          )
          const shown = shownRows(view.rows, { lines })
          const wanting = view.rows.filter((row) => row.attention !== "rest")
          const room = lines - 3
          if (wanting.length <= room) {
            for (const row of wanting) expect(shown).toContain(row)
          }
          // The rows shown lead the order, and what isn't shown is said.
          expect(shown).toEqual(byAttention(view.rows).slice(0, shown.length))
          const text = drawn(view.rows, lines).join("\n")
          if (shown.length < Math.min(view.rows.length, room)) {
            const hidden = view.rows.length - shown.length
            const folded = view.rows.filter((row) => !shown.includes(row))
            const earlier = folded.filter((row) => row.attention === "rest").length
            expect(text).toContain(earlier === hidden ? `+${hidden} ` : `+${hidden - earlier} `)
          }
          expect(drawn(view.rows, lines)).toHaveLength(lines)
        },
      ),
    )
  })
})

describe("elsewhere", () => {
  test("the dashboard's rows, which its clicks reach, are in the table's order", () => {
    const view = viewOf([
      ["done", merged, 1],
      ["aside", deferred, 2],
      ["question", asked, 3],
      ["conflict", blocked, 4],
    ])
    const laid = dashboardLayout(view, theme, 80, 35)
    expect(ids(laid.rows)).toEqual(["conflict", "question", "aside", "done"])
    const at = (id: string) => laid.tickets.findIndex((line) => paint(line).includes(id))
    expect(at("conflict")).toBeLessThan(at("question"))
    expect(at("question")).toBeLessThan(at("aside"))
    expect(at("aside")).toBeLessThan(at("done"))
  })

  test("the summary's table keeps the order it is given, every row", () => {
    const view = viewOf([
      ["done", merged, 1],
      ["conflict", blocked, 2],
      ["aside", deferred, 3],
    ])
    expect(shownRows(view.rows, { fill: false })).toEqual(view.rows)
    const lines = ticketsLines(view.rows, theme, 80, { fill: false }).map((line) =>
      line.map((each) => each.text).join(""),
    )
    expect(lines[2]).toContain("done")
    expect(lines[3]).toContain("conflict")
    expect(lines[4]).toContain("aside")
  })
})
