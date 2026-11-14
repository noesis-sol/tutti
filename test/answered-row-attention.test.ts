// A question answered, its ticket waiting for a slot, asks nothing of you (tutti-hv7z, § 5.1): its
// `↻ answered` row sorts with the rest, below what wants you and set-aside tickets, newest first,
// and may fold into `+N earlier tickets`, until a later look finds it not answered after all.

import { describe, expect, test } from "bun:test"
import { tuttiScheme } from "../src/project/scheme.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { Finished, TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type Row, type Status } from "../src/run/runView.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { dashboardLayout } from "../src/ui/Dashboard.tsx"
import { byAttention, shownRows, ticketsLines } from "../src/ui/TicketsTable.tsx"
import { makeTheme } from "../src/ui/theme.ts"
import { rowsIn } from "./screen.ts"

const theme = makeTheme(tuttiScheme, { appearance: "dark", depth: "truecolor", noColor: false })

const blocked = TicketPhase.Blocked({ why: "MERGE_CONFLICT" })
const deferred = TicketPhase.Deferred({ why: "gave up" })
const merged = TicketPhase.Done({ outcome: Finished.Merged({ commit: "c0ffee0abcdef" }) })
const asked = (question: string) => TicketPhase.Asked({ question })

const viewOf = (
  tickets: ReadonlyArray<readonly [string, TicketPhase, number]>,
  status: Partial<Status> = {},
) =>
  project({
    ledger: {
      tickets: new Map(
        tickets.map(([ticket, phase, since], row): [TicketId, Entry] => [
          ticket as TicketId,
          {
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
          },
        ]),
      ),
      rows: tickets.length,
      windDown: null,
      bugs: [],
    },
    workers: new Map(),
    requests: [],
    status: {
      ...emptyStatus,
      version: "0.1.0",
      branch: "main",
      began: 0,
      concurrency: 3,
      ...status,
    },
    actions: new Map(),
  })

const ids = (rows: ReadonlyArray<Row>) => rows.map((row) => row.ticket as string)
const answered = (...questions: ReadonlyArray<string>) => ({ answered: new Set(questions) })

const fabrica: ReadonlyArray<readonly [string, TicketPhase, number]> = [
  ["done", merged, 2],
  ["aside", deferred, 3],
  ["open", asked("q-open"), 4],
  ["told", asked("q-told"), 1],
  ["conflict", blocked, 5],
]

describe("an answered row in the tickets table", () => {
  test("sorts below what wants you and what is set aside, with the rest", () => {
    const view = viewOf(fabrica, answered("q-told"))
    expect(view.rows.find((row) => row.ticket === "told")?.attention).toBe("rest")
    expect(ids(byAttention(view.rows))).toEqual(["conflict", "open", "aside", "done", "told"])
  })

  test("is newest first among the rest, where it was oldest first among the asked", () => {
    const tickets: ReadonlyArray<readonly [string, TicketPhase, number]> = [
      ["older", asked("q-older"), 1],
      ["done", merged, 2],
      ["newer", asked("q-newer"), 3],
    ]
    const told = viewOf(tickets, answered("q-older", "q-newer"))
    expect(ids(byAttention(told.rows))).toEqual(["newer", "done", "older"])
    expect(ids(byAttention(viewOf(tickets).rows))).toEqual(["older", "newer", "done"])
  })

  test("goes back among the asked when a later look doesn't find it answered", () => {
    const again = viewOf(fabrica)
    expect(again.rows.find((row) => row.ticket === "told")?.attention).toBe("asked")
    expect(ids(byAttention(again.rows))).toEqual(["conflict", "told", "open", "aside", "done"])
  })

  test("the same under a stop, where the next run takes it back", () => {
    const view = viewOf(fabrica, { ...answered("q-told"), stopping: true })
    expect(ids(byAttention(view.rows))).toEqual(["conflict", "open", "aside", "done", "told"])
  })

  test("folds into +N earlier tickets, and an open question beside it doesn't", () => {
    const view = viewOf(
      [
        ["told", asked("q-told"), 1],
        ["open", asked("q-open"), 2],
        ["done", merged, 3],
        ["done-2", merged, 4],
      ],
      answered("q-told"),
    )
    // 6 lines: the label, the frame, and 3 rows.
    expect(ids(shownRows(view.rows, { lines: 6 }))).toEqual(["open", "done-2"])
    const lines = ticketsLines(view.rows, theme, 80, { lines: 6 }).map((line) =>
      line.map((each) => each.text).join(""),
    )
    expect(rowsIn(lines)[2]).toMatchObject({
      state: "",
      ticket: "+2",
      note: "earlier tickets, see the log",
    })
  })

  test("doesn't count among the rows that say how many more want you", () => {
    const view = viewOf(
      [
        ["b-1", blocked, 1],
        ["b-2", blocked, 2],
        ["b-3", blocked, 3],
        ["told", asked("q-told"), 4],
      ],
      answered("q-told"),
    )
    const lines = ticketsLines(view.rows, theme, 80, { lines: 6 }).map((line) =>
      line.map((each) => each.text).join(""),
    )
    expect(ids(shownRows(view.rows, { lines: 6 }))).toEqual(["b-1", "b-2", "b-3"])
    expect(lines.join("\n")).not.toContain("more:")
  })

  test("the dashboard's rows, which its clicks reach, have it in that place", () => {
    const view = viewOf(fabrica, answered("q-told"))
    expect(ids(dashboardLayout(view, theme, 80, 35).rows)).toEqual([
      "conflict",
      "open",
      "aside",
      "done",
      "told",
    ])
  })

  test("the view's rows keep the order tickets ended, for the summary", () => {
    expect(ids(viewOf(fabrica, answered("q-told")).rows)).toEqual(ids(viewOf(fabrica).rows))
  })
})
