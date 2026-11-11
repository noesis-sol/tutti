// test/screen.ts, the helpers the tests read the drawn screen with: the cards, the hint, the tickets
// table and the side panel, read back from what src/ui draws, and the builders that write their text.
// A card's lines starting under its ticket is checked here, once, for every test that reads a card.

import { describe, expect, test } from "bun:test"
import { WorkerState } from "../src/agent/WorkerState.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, project, type RunView } from "../src/run/runView.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { marks } from "../src/text/marks.ts"
import { cardLines, compactLines } from "../src/ui/Card.tsx"
import { hintLines, hintSegments } from "../src/ui/Hint.tsx"
import { upNextLines } from "../src/ui/SidePanel.tsx"
import { ticketsLines } from "../src/ui/TicketsTable.tsx"
import { makeTheme, orchestra } from "../src/ui/theme.ts"
import { windDownSegments } from "../src/ui/WindDown.tsx"
import {
  boxLine,
  cardHead,
  cardLine,
  cardOn,
  cardsIn,
  hintAt,
  hintFrom,
  hintLine,
  hintOf,
  hintRows,
  insideOf,
  panelOf,
  pointedAt,
  rowsIn,
  screenLines,
  selectedRow,
} from "./screen.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })
const began = new Date(2026, 10, 7, 13, 0, 0).getTime()
const now = began + 67_000
const spin = "⣽"

const entryOf = (ticket: TicketId, phase: TicketPhase, row: number): Entry => ({
  ticket,
  title: `Title of ${ticket}`,
  phase,
  since: began,
  worker: row + 1,
  row,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
})

/** RunView of `phases`' tickets, t-1 on, their workers editing, t-1's latest action a Bash call. */
const viewOf = (phases: ReadonlyArray<TicketPhase>): RunView => {
  const tickets = phases.map((phase, i) => entryOf(`t-${i + 1}` as TicketId, phase, i))
  return project({
    ledger: {
      tickets: new Map(tickets.map((entry) => [entry.ticket, entry])),
      rows: tickets.length,
      windDown: null,
      bugs: [],
    },
    workers: new Map(
      tickets.map((entry) => [entry.ticket, WorkerState.Working({ doing: "editing" })]),
    ),
    requests: [],
    status: { ...emptyStatus, branch: "main", began, concurrency: phases.length },
    actions: new Map([["t-1", { text: "Bash(bun test)", denied: false }]]),
  })
}

const working = TicketPhase.Working()

describe("cardsIn", () => {
  const view = viewOf([working, TicketPhase.ToMerge({ place: 1 })])
  const [first, second] = view.cards
  if (first === undefined || second === undefined) throw new Error("no cards")

  test("reads a full card: its mark, ticket, status, time, title and action line", () => {
    const lines = cardLines(first, theme, { now, spin, width: 50, inside: 3, highlighted: false })
    expect(cardsIn(lines)).toEqual([
      {
        mark: spin,
        ticket: "t-1",
        status: "editing",
        steered: false,
        time: "1m07s",
        memory: null,
        title: "Title of t-1",
        action: `${marks.latest} Bash(bun test)`,
        lines: ["Title of t-1", `${marks.latest} Bash(bun test)`],
        compact: false,
        highlighted: false,
        pointed: false,
        line: 1,
        column: 0,
      },
    ])
  })

  test("a card's lines start under its ticket, past its mark", () => {
    const lines = screenLines(
      cardLines(first, theme, { now, spin, width: 50, inside: 3, highlighted: false }),
    )
    const [head = "", title = "", action = ""] = lines.slice(1)
    const ticketAt = head.indexOf("t-1")
    expect(ticketAt).toBeGreaterThan(head.indexOf(spin) + 1)
    expect(title.indexOf("Title of t-1")).toBe(ticketAt)
    expect(action.indexOf(marks.latest)).toBe(ticketAt)
  })

  test("reads the highlighted card, heavy, and the cards side by side", () => {
    const left = cardLines(first, theme, { now, spin, width: 40, inside: 3, highlighted: true })
    const right = cardLines(second, theme, { now, spin, width: 40, inside: 3, highlighted: false })
    const row = screenLines(left).map((line, i) => `${line}${screenLines(right)[i] ?? ""}`)
    expect(
      cardsIn(row).map((card) => [card.ticket, card.mark, card.highlighted, card.title]),
    ).toEqual([
      ["t-1", spin, true, "Title of t-1"],
      ["t-2", marks.toMerge, false, "Title of t-2"],
    ])
    expect(cardOn(row, "t-2")).toMatchObject({ status: "to merge (1st)", column: 40, line: 1 })
  })

  test("reads the compact box's lines, their titles on them", () => {
    const lines = compactLines(view.cards, theme, { now, spin, width: 80, highlighted: "t-2" })
    expect(
      cardsIn(lines).map((card) => [card.ticket, card.compact, card.status, card.highlighted]),
    ).toEqual([
      ["t-1", true, "editing", false],
      ["t-2", true, "to merge (1st)", true],
    ])
    expect(cardOn(lines, "t-2")).toMatchObject({ time: "1m07s", title: "Title of t-2", lines: [] })
  })

  test("reads steered, the memory, and the pointer before an attention card's title", () => {
    const screen = [
      "╭──────────────────────────────────────────────╮",
      boxLine(`${cardHead("•", "t-3")}  done  steered  1m07s  1.2 GB`, "┃"),
      boxLine(`${marks.selected}${cardLine("Title of t-3").slice(1)}`, "┃"),
      boxLine(cardLine("[ Deny ]  [ Allow ]"), "┃"),
      "╰──────────────────────────────────────────────╯",
    ]
    expect(cardOn(screen, "t-3")).toMatchObject({
      mark: "•",
      status: "done",
      steered: true,
      memory: "1.2 GB",
      title: "Title of t-3",
      lines: ["Title of t-3", "[ Deny ]  [ Allow ]"],
      highlighted: true,
      pointed: true,
    })
  })

  test("reads no card from the tickets table's rows, and throws for a ticket with none", () => {
    const table = ticketsLines(view.rows, theme, 80, { fill: false })
    expect(cardsIn(table)).toEqual([])
    expect(() => cardOn(table, "t-1")).toThrow("no card for t-1")
  })
})

describe("the hint", () => {
  const keys = [
    { keys: "Esc", does: "back" },
    { keys: "arrows", does: "select" },
    { keys: "Enter", does: "open" },
    { keys: "?", does: "keys" },
  ]

  test("hintOf reads its keys, and hintRows them line by line as it wraps", () => {
    const one = [hintSegments(keys, theme, 80)]
    expect(hintOf(one)).toEqual(["Esc back", "arrows select", "Enter open", "? keys"])
    const wrapped = hintLines(keys, theme, 30)
    expect(wrapped.length).toBeGreaterThan(1)
    expect(hintRows(wrapped).flat()).toEqual([...hintOf(one)])
    expect(hintFrom(wrapped, "arrows select", 2)).toEqual(["arrows select", "Enter open"])
    expect(hintFrom(wrapped, "q quit", 2)).toEqual([])
  })

  test("keeps the rest of a key a wrap cut with it", () => {
    const long = [{ keys: "g", does: "request on a ticket whose ID is long" }, ...keys]
    const lines = hintLines(long, theme, 20)
    expect(hintOf(lines)[0]).toBe("g request on a ticket whose ID is long")
  })

  test("hintAt is the line it starts on, under the wind-down line and what else is above", () => {
    const view = { marks: [], running: 1 }
    const screen = [
      "╰──────╯",
      screenLines([windDownSegments(view, theme, 80)])[0] ?? "",
      ...screenLines(hintLines(keys, theme, 30)),
      "",
    ]
    expect(hintAt(screen)).toBe(2)
    expect(hintOf(screen)).toEqual(["Esc back", "arrows select", "Enter open", "? keys"])
  })

  test("hintLine writes it as the hint draws it", () => {
    expect(hintLine("Esc back", "arrows select", "Enter open", "? keys")).toBe(
      screenLines([hintSegments(keys, theme, 80)])[0] ?? "",
    )
  })
})

describe("the boxes under a label", () => {
  test("rowsIn reads the tickets table's rows, the pointer's row selected", () => {
    const view = viewOf([working, TicketPhase.Queued()])
    const table = ticketsLines(
      view.rows,
      theme,
      80,
      { fill: false },
      {
        highlighted: "t-2" as TicketId,
        target: () => undefined,
        idTarget: () => 0,
        copied: null,
      },
    )
    expect(rowsIn(table)).toEqual([
      expect.objectContaining({ ticket: "t-1", selected: false, note: "Title of t-1" }),
      expect.objectContaining({ ticket: "t-2", selected: true, note: "Title of t-2" }),
    ])
    expect(rowsIn(table)[0]?.state).toStartWith(marks.working)
    // The label and the table's top border above the first row.
    expect(rowsIn(table).map((row) => row.line)).toEqual([2, 3])
    expect(selectedRow(table)?.ticket).toBe("t-2")
    expect(pointedAt(table, "Title of t-2")).toBe(true)
    expect(pointedAt(table, "t-1")).toBe(false)
    expect(selectedRow(ticketsLines(view.rows, theme, 80, { fill: false }))).toBeUndefined()
  })

  test("panelOf reads the lines inside a panel, insideOf a box's line", () => {
    const view = viewOf([TicketPhase.Queued()])
    const panel = upNextLines(view.queue, view.totals, theme, 50, 7)
    expect(panelOf(panel, "Up next")[0]).toBe("Nothing needs you")
    expect(panelOf(panel, "Up next")[1]?.split(/ {2,}/)).toEqual(["t-1", "ready"])
    expect(insideOf(`${boxLine("t-1  ready")}   │`)).toBe("t-1  ready")
  })
})
