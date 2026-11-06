// With nothing chosen, only a Blocked or Asked row, or a need with no row, takes the panel by itself
// (§ 7.2, tutti-149z.6): a row only set aside leaves Up next showing. It is read by choosing it, and
// `Esc` goes back to automatic, which is Up next again. The table's order and the totals don't change.

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { WorkerState as WS } from "../src/agent/WorkerState.ts"
import { makeCommands } from "../src/run/commands.ts"
import { type Entry, emptyTallies } from "../src/run/ledger.ts"
import { TicketPhase } from "../src/run/phase.ts"
import { emptyStatus, type Need, project, type RunView, type Status } from "../src/run/runView.ts"
import { Screen } from "../src/run/screen.ts"
import type { TicketId } from "../src/services/Beads.ts"
import { Root } from "../src/ui/App.tsx"
import { marks } from "../src/ui/marks.ts"
import { selectedTicket } from "../src/ui/SidePanel.tsx"
import { byAttention } from "../src/ui/TicketsTable.tsx"
import { type Appearance, makeTheme, orchestra } from "../src/ui/theme.ts"
import { external, type Settable } from "../src/ui/useRunView.ts"
import { type Frame, pressEscape, type Rendered, withRender } from "./render.ts"

const theme = makeTheme(orchestra, { appearance: "dark", depth: "truecolor", noColor: false })

const began = new Date(2026, 9, 20, 13, 0, 0).getTime()

const deferred = TicketPhase.Deferred({ why: "by the worker" })
const review = TicketPhase.Review({ why: "CHECKS_FAILED" })
const stopped = TicketPhase.Stopped({ why: "PAUSED" })
const dirty = TicketPhase.Blocked({ why: "DIRTY_TREE" })
const conflict = TicketPhase.Blocked({ why: "MERGE_CONFLICT" })
const asked = TicketPhase.Asked({ question: "q-1" })

const entryOf = (
  ticket: string,
  row: number,
  phase: Entry["phase"],
  more: Partial<Entry> = {},
): Entry => ({
  ticket: ticket as TicketId,
  title: `Title of ${ticket}`,
  phase,
  since: began + row * 60_000,
  worker: null,
  row,
  rechecking: false,
  steered: false,
  lastMessage: null,
  tallies: emptyTallies,
  ...more,
})

const q1 = {
  id: "q-1" as TicketId,
  title: "Which flag name?",
  description: "",
  options: [{ label: "Use --flag", description: "" }],
  maintainerOnly: false,
  waiting: ["a-1" as TicketId],
}

const projected = (tickets: ReadonlyArray<Entry>, status: Partial<Status> = {}): RunView =>
  project({
    ledger: {
      tickets: new Map(tickets.map((each) => [each.ticket, each])),
      rows: tickets.length,
      windDown: null,
      bugs: [],
    },
    workers: new Map(
      tickets.flatMap((each) =>
        each.worker === null ? [] : [[each.ticket, WS.Idle({ at: began })] as const],
      ),
    ),
    requests: [],
    status: {
      ...emptyStatus,
      version: "0.1.0",
      branch: "batch",
      began,
      concurrency: 4,
      questions: new Map([["q-1", q1]]),
      ...status,
    },
    actions: new Map(),
  })

const press = (rendered: Rendered, ...keys: ReadonlyArray<string>) =>
  rendered.input(async (setup) => {
    for (const key of keys) {
      if (key === "tab") setup.mockInput.pressTab()
      else if (key === "enter") setup.mockInput.pressEnter()
      else if (key === "escape") await pressEscape(setup)
      else if (key === "up" || key === "down") setup.mockInput.pressArrow(key)
      else await setup.mockInput.typeText(key)
    }
  })

const scene = async (
  start: RunView,
  size: { readonly width: number; readonly height: number },
  body: (at: { readonly view: Settable<RunView>; readonly rendered: Rendered }) => Promise<void>,
) => {
  const view = external(start)
  const value = {
    view,
    screen: external<Screen>(Screen.Dashboard()),
    commands: Effect.runSync(makeCommands),
    appearance: external<Appearance>("dark"),
    themeOf: () => theme,
    now: () => began,
  }
  await withRender(<Root value={value} />, size, (rendered) => body({ view, rendered }))
}

const wide = { width: 155, height: 40 }
const narrow = { width: 100, height: 40 }

/** The panel's text on `frame`, unwrapped: what is right of the table, on one line. */
const panelOf = (frame: Frame): string =>
  frame.chars
    .split("\n")
    .map((line) =>
      line
        .slice(155 - 61)
        .replace(/[│┃]/g, "")
        .trim(),
    )
    .join(" ")
    .replace(/ +/g, " ")

const linesOf = (frame: Frame) => frame.chars.split("\n")

/** Whether the table's pointer is on a row of `frame` holding `text`. */
const pointed = (frame: Frame, text: string) =>
  linesOf(frame).some((line) => line.includes(`│ ${marks.selected}`) && line.includes(text))

/** Whether a span of `text` on `frame` has the focus's fill. */
const lit = (frame: Frame, text: string) =>
  frame.spans.lines.some((line) =>
    line.spans.some(
      (span) =>
        span.text.includes(text) &&
        Bun.deepEquals(span.bg.toInts(), theme.form.focusedButton.bg?.toInts()),
    ),
  )

/** The top-left of `text`'s first place on `frame`. */
const where = (frame: Frame, text: string) => {
  const lines = linesOf(frame)
  const y = lines.findIndex((line) => line.includes(text))
  if (y === -1) throw new Error(`no line holds ${text}`)
  return { x: (lines[y] ?? "").indexOf(text), y }
}

/** What the totals strip says, on `frame`: its line of counts. */
const totalsOf = (frame: Frame) =>
  linesOf(frame).find((line) => line.includes("Set aside") && line.includes("Needs you")) ?? ""

const aside = [
  entryOf("s-1", 0, deferred),
  entryOf("r-1", 1, review, { checkLog: "/repo/.tutti/run/workers/r-1/checks/fast-1.log" }),
  entryOf("t-1", 2, stopped),
]

describe("with only set-aside rows and nothing chosen", () => {
  test("nothing is selected, of a Deferred, a Review or a Stopped row", () => {
    for (const entry of aside) {
      const { rows, needs } = projected([entry])
      expect(selectedTicket(rows, null, needs, needs)).toBeNull()
    }
  })

  test("the panel shows Up next, under Nothing needs you, and no row's detail", async () => {
    const queued = entryOf("n-1", 3, TicketPhase.Queued(), { row: null })
    await scene(projected([...aside, queued]), wide, async ({ rendered }) => {
      const panel = panelOf(await rendered.capture())
      expect(panel).toContain("Up next")
      expect(panel).toContain("Nothing needs you")
      expect(panel).toContain("n-1 ready")
      for (const detail of ["s-1 deferred", "r-1 review", "t-1 stopped", "Needs you · 0"]) {
        expect(panel).not.toContain(detail)
      }
    })
  })

  test("the last ticket that wanted you leaves Up next, not a set-aside row", async () => {
    const start = [...aside, entryOf("b-1", 3, dirty)]
    await scene(projected(start), wide, async ({ view, rendered }) => {
      expect(panelOf(await rendered.capture())).toContain("b-1 blocked: DIRTY_TREE")
      await rendered.input(() => view.set(projected(aside)))
      expect(panelOf(await rendered.capture())).toContain("Up next")
    })
  })

  test("a question answered here leaves Up next at once, not a set-aside row", () => {
    const { rows, needs } = projected([...aside, entryOf("a-1", 3, asked)])
    expect(selectedTicket(rows, null, needs, needs)).toBe("a-1" as TicketId)
    expect(selectedTicket(rows, null, [], needs)).toBeNull()
  })
})

describe("a Blocked or Asked row beside set-aside rows", () => {
  test("is still selected by itself, wherever it is among the rows", () => {
    for (const [ticket, phase] of [
      ["b-1", dirty],
      ["a-1", asked],
    ] as const) {
      const { rows, needs } = projected([...aside, entryOf(ticket, 3, phase)])
      for (const order of [rows, [...rows].reverse(), byAttention(rows)]) {
        expect(selectedTicket(order, null, needs, needs)).toBe(ticket as TicketId)
      }
    }
  })

  test("takes the panel, its detail showing", async () => {
    await scene(projected([...aside, entryOf("b-1", 3, dirty)]), wide, async ({ rendered }) => {
      expect(panelOf(await rendered.capture())).toContain("b-1 blocked: DIRTY_TREE")
    })
    await scene(projected([...aside, entryOf("a-1", 3, asked)]), wide, async ({ rendered }) => {
      expect(panelOf(await rendered.capture())).toContain("Which flag name?")
    })
  })

  test("a need with no row is selected too, its card in Current", () => {
    const view = projected([
      entryOf("s-1", 0, deferred),
      entryOf("h-1", 1, conflict, { worker: 1, handBack: true }),
    ])
    const rows = view.rows.filter((row) => row.ticket === "s-1")
    expect(view.needs.map((need: Need) => need.ticket)).toEqual(["h-1"] as Array<TicketId>)
    expect(selectedTicket(rows, null, view.needs, view.needs)).toBe("h-1" as TicketId)
  })
})

describe("a set-aside row you choose", () => {
  test("shows its detail, with ↑↓ inside Tickets, and Esc returns to Up next", async () => {
    await scene(projected(aside), wide, async ({ rendered }) => {
      // Newest first: t-1, r-1, s-1. Going in lands on the first.
      await press(rendered, "enter")
      const first = await rendered.capture()
      expect(pointed(first, "t-1")).toBe(true)
      expect(panelOf(first)).toContain("The next run resumes it.")
      await press(rendered, "down")
      const second = panelOf(await rendered.capture())
      expect(second).toContain("r-1 review: CHECKS_FAILED")
      expect(second).toContain("Check log: /repo/.tutti/run/workers/r-1/checks/fast-1.log")
      expect(second).not.toContain("Up next")
      await press(rendered, "down")
      expect(panelOf(await rendered.capture())).toContain("Run bd undefer s-1 to bring it back.")
      await press(rendered, "escape")
      const back = panelOf(await rendered.capture())
      expect(back).toContain("Up next")
      expect(back).toContain("Nothing needs you")
      expect(back).not.toContain("s-1 deferred")
    })
  })

  test("shows its detail on a click, triage's verdict included, and Esc returns to Up next", async () => {
    const verdicts = new Map([["s-1", "environment · high · retry it"]])
    await scene(projected(aside, { verdicts }), wide, async ({ rendered }) => {
      // Its verdict is in its row, in its note's place, and off its ID, which a click copies.
      const { x, y } = where(await rendered.capture(), "◆ environment")
      await rendered.input((setup) => setup.mockMouse.click(x + 1, y))
      const panel = panelOf(await rendered.capture())
      expect(panel).toContain("s-1 deferred: by the worker")
      expect(panel).toContain("◆ environment · high · retry it")
      await press(rendered, "escape")
      expect(panelOf(await rendered.capture())).toContain("Up next")
    })
  })

  test("Tab still reaches it, and Esc returns to Up next", async () => {
    await scene(projected(aside), wide, async ({ rendered }) => {
      await press(rendered, "tab")
      const frame = await rendered.capture()
      expect(pointed(frame, "t-1")).toBe(true)
      expect(panelOf(frame)).toContain("The next run resumes it.")
      await press(rendered, "escape")
      expect(panelOf(await rendered.capture())).toContain("Up next")
    })
  })

  test("stays chosen as a Blocked row comes in, and Esc goes to that row", async () => {
    await scene(projected(aside), wide, async ({ view, rendered }) => {
      await press(rendered, "enter")
      await rendered.input(() => view.set(projected([...aside, entryOf("b-1", 3, dirty)])))
      expect(panelOf(await rendered.capture())).toContain("The next run resumes it.")
      await press(rendered, "escape")
      expect(panelOf(await rendered.capture())).toContain("b-1 blocked: DIRTY_TREE")
    })
  })
})

describe("what doesn't change", () => {
  test("the table's order and the totals are as they were", async () => {
    await scene(projected(aside), wide, async ({ rendered }) => {
      const frame = await rendered.capture()
      const places = ["t-1", "r-1", "s-1"].map((ticket) => where(frame, ticket).y)
      expect(places).toEqual([...places].sort((a, b) => a - b))
      expect(totalsOf(frame)).toContain("0 Needs you")
      expect(totalsOf(frame)).toContain("2 Set aside")
    })
  })

  test("in a narrow pane, the totals' Needs you cell lists what needs you", async () => {
    await scene(projected(aside), narrow, async ({ rendered }) => {
      const before = await rendered.capture()
      expect(before.chars).not.toContain("Up next")
      expect(totalsOf(before)).toContain("0 Needs you")
      await press(rendered, "up")
      expect(lit(await rendered.capture(), "Needs you")).toBe(true)
    })
    const both = projected([...aside, entryOf("b-1", 3, dirty)])
    await scene(both, narrow, async ({ rendered }) => {
      await press(rendered, "tab")
      expect(lit(await rendered.capture(), "Needs you")).toBe(true)
      await press(rendered, "enter")
      expect((await rendered.capture()).chars).toContain("b-1 blocked: DIRTY_TREE")
    })
  })

  test("in a narrow pane, Tab goes to a set-aside row, and Enter opens its box", async () => {
    await scene(projected(aside), narrow, async ({ rendered }) => {
      await press(rendered, "tab")
      expect(pointed(await rendered.capture(), "t-1")).toBe(true)
      await press(rendered, "enter")
      expect((await rendered.capture()).chars).toContain("The next run resumes it.")
    })
  })
})
